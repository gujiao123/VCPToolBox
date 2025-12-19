// WebSocketServer.js
// 引入 'ws' 库，这是一个轻量级的 WebSocket 实现，是 Node.js 生态中最常用的 WebSocket 库。
// WebSocket 协议 (ws://) 是建立在 TCP 之上的长连接协议，允许服务器主动给客户端发消息
const WebSocket = require('ws');
const url = require('url');

let wssInstance;
let pluginManager = null; // 为 PluginManager 实例占位
// 服务器配置对象
let serverConfig = {
    debugMode: false, // 是否开启调试日志
    vcpKey: null      // 认证密钥，非常重要！防止未授权的人连接进来控制服务器
};


// === 客户端分类存储池 (Client Pools) ===
// Map 是 ES6 新增的数据结构，类似于对象，但更适合做键值对存储，性能更好。
// 键通常是 clientId (字符串)，值是 WebSocket 连接对象 (ws)。
const clients = new Map(); // VCPLog 等普通客户端
// 这些是其他的 VCP 实例，它们连接到本机，贡献自己的插件能力。
const distributedServers = new Map(); // 分布式服务器客户端
// 比如你在手机网页上发指令控制电脑浏览器的客户端。
const chromeControlClients = new Map(); // ChromeControl 客户端
// 这是一个运行在 Chrome 里的插件脚本，时刻向 VCP 汇报当前网页在干嘛。
const chromeObserverClients = new Map(); // 新增：ChromeObserver 客户端
// 5. 管理员面板 (AdminPanel)
// 拥有最高权限的监控端。
const adminPanelClients = new Map(); // 新增：管理面板客户端
// === 请求状态管理 ===

// 跨服务器调用时，是异步的。
// VCP 发出请求 -> 等对方处理 -> 对方发回结果。
// 这个 Map 用来暂存“我发出了请求，正在等结果”的状态。
// Key: requestId, Value: { resolve, reject, timeoutTimer }
const pendingToolRequests = new Map(); // 跨服务器工具调用的待处理请求
// 存储分布式服务器的 IP 地址信息，用于网络拓扑感知
const distributedServerIPs = new Map(); // 新增：存储分布式服务器的IP信息
// 存储那些发起了命令，正在眼巴巴等着浏览器页面刷新信息的请求
// Key: clientId, Value: requestId
const waitingControlClients = new Map(); // 新增：存储等待页面更新的ChromeControl客户端 (clientId -> requestId)







//me 功能：生成一个相对独一无二的客户端/请求 ID。
function generateClientId() {
    // 用于生成客户端ID和请求ID
    return `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 9)}`;
}



// --- 辅助函数：写日志 ---
async function writeLog(message) {
    // 只有在开启调试模式时才输出到控制台，避免生产环境刷屏
    if (serverConfig.debugMode) {
        // new Date().toISOString(): 生成标准格式的时间字符串，例如 "2023-10-27T10:00:00.000Z"
        console.log(`[WebSocketServer] ${new Date().toISOString()} - ${message}`);
    }
}





//me 初始化 WebSocket 层并绑定到提供的 HTTP server 的 upgrade 事件；解析路径完成认证与路由不同客户端类型。
// --- 核心函数：初始化服务器 ---
// httpServer: 从主程序传进来的原生 Node.js HTTP 服务器实例
function initialize(httpServer, config) {
    if (!httpServer) {
        console.error('[WebSocketServer] Cannot initialize without an HTTP server instance.');
        return;
    }
    // 合并配置：... (展开运算符) 将默认配置和传入的 config 合并
    serverConfig = { ...serverConfig, ...config };

    if (!serverConfig.vcpKey && serverConfig.debugMode) {
        console.warn('[WebSocketServer] VCP_Key not set. WebSocket connections will not be authenticated if default path is used.');
    }
    //me 创建 wssInstance = new WebSocket.Server({ noServer: true })。
    // 创建 WebSocket 服务器实例
    // noServer: true 表示这个 WS 服务器不自己监听端口，而是依附于现有的 HTTP 服务器。
    // 这样 HTTP 和 WS 可以共用同一个端口（如 3000）。
    wssInstance = new WebSocket.Server({ noServer: true });
    //监听 httpServer.on('upgrade', ...)，根据请求路径匹配客户端类型（VCPlog、vcpinfo、vcp-distributed-server、vcp-chrome-control、vcp-chrome-observer、vcp-admin-panel），校验 VCP_Key（从 path 提取）与 serverConfig.vcpKey 对比。


    // === 协议升级 (Protocol Upgrade) ===
    // 当浏览器发起 `ws://` 请求时，实际上是先发一个 HTTP 请求，头里带着 "Upgrade: websocket"。
    // 我们要监听这个 upgrade 事件，手动处理握手。

    httpServer.on('upgrade', (request, socket, head) => {
        // 解析请求 URL
        const parsedUrl = url.parse(request.url, true);
        const pathname = parsedUrl.pathname;
        // 定义不同客户端类型的 URL 路径规则 (Regex 正则表达式)
        // 必须匹配 /路径/VCP_Key=密钥 这种格式
        const vcpLogPathRegex = /^\/VCPlog\/VCP_Key=(.+)$/;
        const vcpInfoPathRegex = /^\/vcpinfo\/VCP_Key=(.+)$/; // 新增：VCPInfo 通道
        const distServerPathRegex = /^\/vcp-distributed-server\/VCP_Key=(.+)$/;
        const chromeControlPathRegex = /^\/vcp-chrome-control\/VCP_Key=(.+)$/;
        const chromeObserverPathRegex = /^\/vcp-chrome-observer\/VCP_Key=(.+)$/;
        const adminPanelPathRegex = /^\/vcp-admin-panel\/VCP_Key=(.+)$/; // 新增
        // 尝试匹配当前请求路径

        const vcpMatch = pathname.match(vcpLogPathRegex);
        const vcpInfoMatch = pathname.match(vcpInfoPathRegex); // 新增匹配
        const distMatch = pathname.match(distServerPathRegex);
        const chromeControlMatch = pathname.match(chromeControlPathRegex);
        const chromeObserverMatch = pathname.match(chromeObserverPathRegex);
        const adminPanelMatch = pathname.match(adminPanelPathRegex); // 新增

        let isAuthenticated = false;
        let clientType = null;
        let connectionKey = null;
        // === 路由分发与类型识别 ===
        if (vcpMatch && vcpMatch[1]) {
            clientType = 'VCPLog';
            connectionKey = vcpMatch[1];
            writeLog(`VCPLog client attempting to connect.`);
        } else if (vcpInfoMatch && vcpInfoMatch[1]) { // 新增 VCPInfo 客户端处理
            clientType = 'VCPInfo';
            connectionKey = vcpInfoMatch[1];
            writeLog(`VCPInfo client attempting to connect.`);
        } else if (distMatch && distMatch[1]) {
            clientType = 'DistributedServer';
            connectionKey = distMatch[1];
            writeLog(`Distributed Server attempting to connect.`);
        } else if (chromeObserverMatch && chromeObserverMatch[1]) {
            clientType = 'ChromeObserver';
            connectionKey = chromeObserverMatch[1];
            writeLog(`ChromeObserver client attempting to connect.`);
        } else if (chromeControlMatch && chromeControlMatch[1]) {
            clientType = 'ChromeControl';
            connectionKey = chromeControlMatch[1];
            writeLog(`Temporary ChromeControl client attempting to connect.`);
        } else if (adminPanelMatch && adminPanelMatch[1]) {
            clientType = 'AdminPanel';
            connectionKey = adminPanelMatch[1];
            writeLog(`Admin Panel client attempting to connect.`);
        } else {
            writeLog(`WebSocket upgrade request for unhandled path: ${pathname}. Ignoring.`);
            socket.destroy();
            return;
        }
        // === 鉴权 (Authentication) ===
        // 比较 URL 里的 Key 和服务器配置的 Key 是否一致
        if (serverConfig.vcpKey && connectionKey === serverConfig.vcpKey) {
            isAuthenticated = true;
        } else {
            // 如果路径都不匹配，直接拒绝连接并销毁 socket
            writeLog(`${clientType} connection denied. Invalid or missing VCP_Key.`);
            socket.destroy();
            return;
        }

        // === 连接握手 ===

        if (isAuthenticated) {
            // 调用 ws 库的 handleUpgrade 完成 HTTP 到 WebSocket 的协议升级
            wssInstance.handleUpgrade(request, socket, head, (ws) => {
                // 连接成功后，给这个 socket 对象打上标签
                const clientId = generateClientId();
                ws.clientId = clientId; // 绑定 ID
                ws.clientType = clientType; // 绑定类型


                // 根据不同类型，放入不同的 Map 池子，并做特定初始化

                if (clientType === 'DistributedServer') {
                    // 分布式服务器除了存 ws，还要存它提供了哪些工具、它的 IP 是啥
                    const serverId = `dist-${clientId}`;
                    ws.serverId = serverId;
                    distributedServers.set(serverId, { ws, tools: [], ips: {} }); // 初始化ips字段
                    writeLog(`Distributed Server ${serverId} authenticated and connected.`);
                } else if (clientType === 'ChromeObserver') {

                    // ... (ChromeObserver 的初始化逻辑，包括调用插件模块的钩子函数 handleNewClient) ...
                    // 这里涉及到底层插件 (ChromeBridge/ChromeObserver) 的动态加
                    console.log(`[WebSocketServer FORCE LOG] A client with type 'ChromeObserver' (ID: ${clientId}) has connected.`); // 强制日志
                    chromeObserverClients.set(clientId, ws); // 将客户端存入Map
                    writeLog(`ChromeObserver client ${clientId} connected and stored.`);

                    // 优先尝试 ChromeBridge，回退到 ChromeObserver
                    // 尝试通知业务插件：“喂，有个浏览器连上来了，你要不要做点什么？”
                    const chromeBridgeModule = pluginManager.getServiceModule('ChromeBridge');
                    const chromeObserverModule = pluginManager.getServiceModule('ChromeObserver');

                    if (chromeBridgeModule && typeof chromeBridgeModule.handleNewClient === 'function') {
                        console.log(`[WebSocketServer] ✅ Found ChromeBridge module. Calling handleNewClient...`);
                        chromeBridgeModule.handleNewClient(ws);
                    } else if (chromeObserverModule && typeof chromeObserverModule.handleNewClient === 'function') {
                        console.log(`[WebSocketServer] Found ChromeObserver module. Calling handleNewClient...`);
                        chromeObserverModule.handleNewClient(ws);
                    } else {
                        writeLog(`Warning: ChromeObserver client connected, but neither ChromeBridge nor ChromeObserver module found.`);
                        console.log(`[WebSocketServer FORCE LOG] Neither ChromeBridge nor ChromeObserver module found or handleNewClient is missing.`);
                    }
                } else if (clientType === 'ChromeControl') {
                    chromeControlClients.set(clientId, ws);
                    writeLog(`Temporary ChromeControl client ${clientId} connected.`);
                } else if (clientType === 'AdminPanel') {
                    adminPanelClients.set(clientId, ws);
                    writeLog(`Admin Panel client ${clientId} connected.`);
                } else {
                    clients.set(clientId, ws);
                    writeLog(`Client ${clientId} (Type: ${clientType}) authenticated and connected.`);
                }
                // 触发 WebSocket 服务器的 'connection' 事件，开始下一步处理
                wssInstance.emit('connection', ws, request);
            });
        }
    });




    // === 连接建立后的主逻辑 ===
    wssInstance.on('connection', (ws, request) => {
        if (serverConfig.debugMode) {
            console.log(`[WebSocketServer] Client ${ws.clientId} connected.`);
        }

        // 1. 发送连接确认 (ACK)
        // 这是一个友好的设计，让客户端知道“我已经连上了，可以开始发数据了”。

        // 发送连接确认消息给特定类型的客户端
        if (ws.clientType === 'VCPLog') {
            ws.send(JSON.stringify({ type: 'connection_ack', message: 'WebSocket connection successful for VCPLog.' }));
        } else if (ws.clientType === 'VCPInfo') { // 新增 VCPInfo 确认消息
            ws.send(JSON.stringify({ type: 'connection_ack', message: 'WebSocket connection successful for VCPInfo.' }));
        }
        // 可以根据 ws.clientType 或其他标识符发送不同的欢迎消息
        // 2. 监听消息事件 (Message Handling)
        ws.on('message', (message) => {
            const messageString = message.toString();

            try {
                const parsedMessage = JSON.parse(message);

                // 强制日志：ChromeObserver 的消息

                if (ws.clientType === 'ChromeObserver') {
                    console.log(`[WebSocketServer] 📨 收到 ChromeObserver 消息，类型: ${parsedMessage.type}`);
                }

                if (serverConfig.debugMode) {
                    console.log(`[WebSocketServer] Received message from ${ws.clientId} (${ws.clientType}): ${messageString.substring(0, 300)}...`);
                }


                // === 消息路由 (Routing) ===
                // 根据发消息的人是谁，决定交给谁处理

                // A. 如果是分布式服务器发来的
                if (ws.clientType === 'DistributedServer') {
                    // 交给专门的处理函数 handleDistributedServerMessage
                    handleDistributedServerMessage(ws.serverId, parsedMessage);
                } else if (ws.clientType === 'ChromeObserver') {
                    // B. 如果是浏览器插件发来的
                    // 心跳检测：保持连接活跃
                    if (parsedMessage.type === 'heartbeat') {
                        // 收到心跳包，发送确认
                        ws.send(JSON.stringify({ type: 'heartbeat_ack', timestamp: Date.now() }));
                        if (serverConfig.debugMode) {
                            console.log(`[WebSocketServer] Received heartbeat from ChromeObserver client ${ws.clientId}, sent ack.`);
                        }
                        // 命令执行结果：浏览器执行完操作了，把结果发回来
                    } else if (parsedMessage.type === 'command_result' && parsedMessage.data && parsedMessage.data.sourceClientId) {
                        // 如果是命令结果，则将其路由回原始的ChromeControl客户端
                        // 把结果“搬运”回最初发起命令的那个控制端 (Relay)
                        const sourceClientId = parsedMessage.data.sourceClientId;

                        // 为ChromeControl客户端重新构建消息
                        const resultForClient = {
                            type: 'command_result',
                            data: {
                                requestId: parsedMessage.data.requestId,
                                status: parsedMessage.data.status,
                            }
                        };
                        if (parsedMessage.data.status === 'success') {
                            // 直接透传 message 字段，保持与 content_script 的一致性
                            resultForClient.data.message = parsedMessage.data.message;
                        } else {
                            resultForClient.data.error = parsedMessage.data.error;
                        }

                        const sent = sendMessageToClient(sourceClientId, resultForClient);
                        if (!sent) {
                            writeLog(`Warning: Could not find original ChromeControl client ${sourceClientId} to send command result.`);
                        }
                    }

                    // 无论如何，都让Chrome服务插件处理消息（优先ChromeBridge，回退ChromeObserver）
                    // 业务处理：交给插件模块处理（比如网页内容更新了，插件需要分析一下）
                    const chromeBridgeModule = pluginManager.getServiceModule('ChromeBridge');
                    const chromeObserverModule = pluginManager.getServiceModule('ChromeObserver');
                    const activeModule = chromeBridgeModule || chromeObserverModule;

                    if (activeModule && typeof activeModule.handleClientMessage === 'function') {
                        // 避免将命令结果再次传递给状态处理器
                        if (parsedMessage.type !== 'command_result' && parsedMessage.type !== 'heartbeat') {
                            activeModule.handleClientMessage(ws.clientId, parsedMessage);

                            // 新增：检查是否有等待的Control客户端，并转发页面信息
                            if (parsedMessage.type === 'pageInfoUpdate') {
                                console.log(`[WebSocketServer] 🔔 收到 pageInfoUpdate, 当前等待客户端数: ${waitingControlClients.size}`);

                                if (waitingControlClients.size > 0) {
                                    const pageInfoMarkdown = parsedMessage.data.markdown;
                                    console.log(`[WebSocketServer] 📤 准备转发页面信息，markdown 长度: ${pageInfoMarkdown?.length || 0}`);

                                    // 遍历所有等待的客户端
                                    waitingControlClients.forEach((requestId, clientId) => {
                                        console.log(`[WebSocketServer] 🎯 尝试转发给客户端 ${clientId}, requestId: ${requestId}`);
                                        const messageForControl = {
                                            type: 'page_info_update',
                                            data: {
                                                requestId: requestId, // 关联到原始请求
                                                markdown: pageInfoMarkdown
                                            }
                                        };
                                        const sent = sendMessageToClient(clientId, messageForControl);
                                        if (sent) {
                                            console.log(`[WebSocketServer] ✅ 成功转发页面信息给客户端 ${clientId}`);
                                            // 发送后即从等待列表移除
                                            waitingControlClients.delete(clientId);
                                        } else {
                                            console.log(`[WebSocketServer] ❌ 转发失败，客户端 ${clientId} 可能已断开`);
                                        }
                                    });
                                } else {
                                    console.log(`[WebSocketServer] ⚠️ 收到 pageInfoUpdate 但没有等待的客户端`);
                                }
                            }
                        }
                    }
                    // C. 如果是控制端发来的
                } else if (ws.clientType === 'ChromeControl') {
                    // ChromeControl客户端只应该发送'command'类型的消息
                    // 找到目前连接的浏览器插件
                    if (parsedMessage.type === 'command') {
                        const observerClient = Array.from(chromeObserverClients.values())[0]; // 假设只有一个Observer
                        if (observerClient) {
                            // 附加源客户端ID以便结果可以被路由回来
                            parsedMessage.data.sourceClientId = ws.clientId;

                            // 新增：如果命令请求等待页面信息，则注册该客户端
                            if (parsedMessage.data.wait_for_page_info) {
                                waitingControlClients.set(ws.clientId, parsedMessage.data.requestId);
                                console.log(`[WebSocketServer] 📝 客户端 ${ws.clientId} 注册等待页面信息，requestId: ${parsedMessage.data.requestId}`);
                                console.log(`[WebSocketServer] 📋 当前等待列表大小: ${waitingControlClients.size}`);
                            }

                            observerClient.send(JSON.stringify(parsedMessage));
                        } else {
                            // 如果没有找到浏览器插件，立即返回错误
                            ws.send(JSON.stringify({ type: 'command_result', data: { requestId: parsedMessage.data.requestId, status: 'error', error: 'No active Chrome browser extension found.' } }));
                        }
                    }
                } else {
                    // 未来处理其他客户端类型的消息
                }
            } catch (e) {
                console.error(`[WebSocketServer] Failed to parse message from client ${ws.clientId}:`, message.toString(), e);
            }
        });
        // 3. 监听断开事件 (Close Handling)
        ws.on('close', () => {
            if (ws.clientType === 'DistributedServer') {
                if (pluginManager) {
                    pluginManager.unregisterAllDistributedTools(ws.serverId);
                }
                distributedServers.delete(ws.serverId);
                distributedServerIPs.delete(ws.serverId); // 新增：移除IP信息
                writeLog(`Distributed Server ${ws.serverId} disconnected. Its tools and IP info have been unregistered.`);
            } else if (ws.clientType === 'ChromeObserver') {
                chromeObserverClients.delete(ws.clientId);
                writeLog(`ChromeObserver client ${ws.clientId} disconnected and removed.`);
            } else if (ws.clientType === 'ChromeControl') {
                chromeControlClients.delete(ws.clientId);
                waitingControlClients.delete(ws.clientId); // 新增：确保客户端断开连接时被清理
                writeLog(`ChromeControl client ${ws.clientId} disconnected and removed.`);
            } else if (ws.clientType === 'AdminPanel') {
                adminPanelClients.delete(ws.clientId);
                writeLog(`Admin Panel client ${ws.clientId} disconnected and removed.`);
            } else {
                clients.delete(ws.clientId);
            }
            if (serverConfig.debugMode) {
                console.log(`[WebSocketServer] Client ${ws.clientId} (${ws.clientType}) disconnected.`);
            }
        });

        ws.on('error', (error) => {
            console.error(`[WebSocketServer] Error with client ${ws.clientId}:`, error);
            writeLog(`WebSocket error for client ${ws.clientId}: ${error.message}`);
            // 确保在出错时也从 clients Map 中移除
            if (ws.clientId) clients.delete(ws.clientId);
        });
    });

    if (serverConfig.debugMode) {
        console.log(`[WebSocketServer] Initialized. Waiting for HTTP server upgrades.`);
    }
}

















// 广播给所有已连接且认证的客户端，或者根据 clientType 筛选
function broadcast(data, targetClientType = null, abortController = null) {
    // 新增：检查中止信号，如果请求已被中止，则跳过广播
    if (abortController && abortController.signal && abortController.signal.aborted) {
        if (serverConfig.debugMode) {
            writeLog(`[Abort Check] Broadcast skipped due to aborted request.`);
        }
        return;
    }

    if (!wssInstance) return;
    const messageString = JSON.stringify(data);

    const clientsToBroadcast = new Map([
        ...clients,
        ...Array.from(distributedServers.values()).map(ds => [ds.ws.clientId, ds.ws])
    ]);

    clientsToBroadcast.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            if (targetClientType === null || clientWs.clientType === targetClientType) {
                clientWs.send(messageString);
            }
        }
    });
    writeLog(`Broadcasted (Target: ${targetClientType || 'All'}): ${messageString.substring(0, 200)}...`);
}











// 新增：专门广播给 VCPInfo 客户端
function broadcastVCPInfo(data) {
    broadcast(data, 'VCPInfo');
}















// 发送给特定客户端
function sendMessageToClient(clientId, data) {
    // Check all client maps
    const clientWs = clients.get(clientId) ||
        (Array.from(distributedServers.values()).find(ds => ds.ws.clientId === clientId) || {}).ws ||
        chromeObserverClients.get(clientId) ||
        chromeControlClients.get(clientId);

    if (clientWs && clientWs.readyState === WebSocket.OPEN) {
        clientWs.send(JSON.stringify(data));
        writeLog(`Sent message to client ${clientId}: ${JSON.stringify(data)}`);
        return true;
    }
    writeLog(`Failed to send message to client ${clientId}: Not found or not open.`);
    return false;
}













function shutdown() {
    if (serverConfig.debugMode) {
        console.log('[WebSocketServer] Shutting down...');
    }
    if (wssInstance) {
        wssInstance.clients.forEach(client => {
            client.close();
        });
        wssInstance.close(() => {
            if (serverConfig.debugMode) {
                console.log('[WebSocketServer] Server closed.');
            }
        });
    }
    writeLog('WebSocketServer shutdown.');
}












// --- 新增分布式服务器相关函数 ---

function setPluginManager(pm) {
    pluginManager = pm;
    if (serverConfig.debugMode) console.log('[WebSocketServer] PluginManager instance has been set.');
}







// 定义函数：处理来自分布式服务器的消息
// 参数 serverId: 发送消息的那个服务器的 ID (例如 "dist-x1y2z3")
// 参数 message: 发送过来的具体数据对象 (JSON 解析后的)
//!! 处理分布式服务器发来的消息，根据 message.type 做不同处理。 插件注册、IP 报告等。
function handleDistributedServerMessage(serverId, message) {

    // 1. 检查人力资源部（PluginManager）是否在岗
    // 如果插件管理器还没准备好，我们没法登记分公司的工具，只能拒收。

    if (!pluginManager) {
        console.error('[WebSocketServer] PluginManager not set, cannot handle distributed server message.');
        return;
    }
    // 2. 登记收信日志
    // 在控制台记一笔：收到了来自 serverId 的信，内容大概是什么（截取前200个字符防止刷屏）。

    writeLog(`Received message from Distributed Server ${serverId}: ${JSON.stringify(message).substring(0, 200)}...`);

    // 3. 核心分拣逻辑 (Switch 语句)
    // 根据信件的“类型”(type) 来决定怎么处理。
    // switch 就像一个多岔路口，message.type 是路标。


    switch (message.type) {
        // === 情况 A：分公司发来“工具清单” ===
        // 剧情：分公司刚连上，它说：“我有计算器、天气查询这两个工具，总公司可以用。”

        case 'register_tools':
            // 从花名册（Map）里找到这个分公司的档案
            const serverEntry = distributedServers.get(serverId);
            // 确保分公司档案存在，且信里确实有工具列表数组
            if (serverEntry && message.data && Array.isArray(message.data.tools)) {
                // 过滤掉内部工具，不让它们显示在插件列表中
                // [过滤操作] 
                // .filter(): 筛选数组。
                // 这里的逻辑是：去掉名字叫 'internal_request_file' 的工具。
                // 为什么要去掉？因为这是系统内部传文件用的，不是给 AI 聊天的，别让 AI 看到它犯迷糊。
                const externalTools = message.data.tools.filter(t => t.name !== 'internal_request_file');
                // [注册操作]
                // 告诉人力资源部（PluginManager）：记下来，serverId 这个分公司提供了这些工具。
                // 这样以后 AI 就可以调用这些工具了。
                pluginManager.registerDistributedTools(serverId, externalTools);
                // [更新档案]
                // 在 WebSocketServer 自己的记录里，也更新一下这个分公司拥有的工具名列表。
                // .map(t => t.name): 把工具对象数组变成纯名字数组 ['Calculator', 'Weather']
                serverEntry.tools = externalTools.map(t => t.name);
                // 把更新后的档案存回 Map
                distributedServers.set(serverId, serverEntry);
                writeLog(`Registered ${externalTools.length} external tools from server ${serverId}.`);
            }
            break;
        // === 情况 B：分公司汇报“地址信息” ===
        // 剧情：分公司说：“我的 IP 地址变了，记一下，方便以后找我。”
        case 'report_ip':
            // 获取分公司档案
            const serverInfo = distributedServers.get(serverId);
            // 确保档案存在且有数据
            if (serverInfo && message.data) {
                // 整理 IP 数据包
                const ipData = {
                    localIPs: message.data.localIPs || [], // 局域网 IP (比如 192.168.1.5)
                    publicIP: message.data.publicIP || null, // 公网 IP (如果有的话)
                    serverName: message.data.serverName || serverId // 分公司的名字 (比如 "书房电脑")
                };
                // 存入专门的 IP 地址簿 (distributedServerIPs)
                distributedServerIPs.set(serverId, ipData);

                // 将 serverName 也存储在主连接对象中，以便通过名字查找
                serverInfo.serverName = ipData.serverName;
                distributedServers.set(serverId, serverInfo);

                // 强制日志记录，无论debug模式如何
                // 打印一条日志，告诉管理员分公司的 IP 是多少
                console.log(`[IP Tracker] Received IP report from Distributed Server '${ipData.serverName}': Local IPs: [${ipData.localIPs.join(', ')}], Public IP: [${ipData.publicIP || 'N/A'}]`);
            }
            break;
        // === 情况 C：分公司同步“环境数据” ===
        // 剧情：分公司说：“我这边的 CPU 温度是 50度。”
        // 这样总公司的 AI 就能在提示词里用 {{书房电脑_CPU温度}} 这种变量了。
        case 'update_static_placeholders':
            // 新增：处理分布式服务器发送的静态占位符更新
            if (message.data && message.data.placeholders) {
                const serverName = message.data.serverName || serverId;
                const placeholders = message.data.placeholders;

                if (serverConfig.debugMode) {
                    console.log(`[WebSocketServer] Received static placeholder update from ${serverName} with ${Object.keys(placeholders).length} placeholders.`);
                }

                // 将分布式服务器的静态占位符更新推送到主服务器的插件管理器
                // 呼叫 PluginManager 去更新全局变量表
                // 这样 messageProcessor.js 在解析 {{...}} 时就能读到这些数据了
                pluginManager.updateDistributedStaticPlaceholders(serverId, serverName, placeholders);
            }
            break;
        // === 情况 D：分公司交“任务作业” (最重要！) ===
        // 剧情：
        // 1. 几十秒前，总公司派了一个任务给分公司（比如“执行 cmd 命令”）。
        // 2. 当时总公司在 pendingToolRequests 里留了一个“等待条”（Promise）。
        // 3. 现在分公司做完了，把结果发回来了。
        case 'tool_result':
            // 根据信里的 requestId (任务单号)，去抽屉里找那个正在等的 Promise

            const pending = pendingToolRequests.get(message.data.requestId);
            // 如果找到了（说明我们确实在等这个结果）
            if (pending) {
                // 1. 关掉闹钟
                // 之前设置了超时计时器（比如60秒没结果就报错），现在结果来了，先把计时器取消。
                clearTimeout(pending.timeout);

                // 2. 判断任务是成功还是失败
                if (message.data.status === 'success') {
                    // 成功！调用 resolve，把结果交给当初调用 await executeDistributedTool 的代码
                    // 这会让那边卡住的代码继续往下跑。
                    pending.resolve(message.data.result);
                } else {
                    pending.reject(new Error(message.data.error || 'Distributed tool execution failed.'));
                }
                // 3. 销毁等待条
                // 任务结束，把这个记录删掉，释放内存。
                pendingToolRequests.delete(message.data.requestId);
            }
            break;
        default:
            writeLog(`Unknown message type '${message.type}' from server ${serverId}.`);
    }
}









//!! 异步执行分布式工具函数，向指定分公司发送任务请求，并返回结果。
async function executeDistributedTool(serverIdOrName, toolName, toolArgs, timeout) {
    // 优先从插件 manifest 获取超时设置
    const plugin = pluginManager.getPlugin(toolName);
    const defaultTimeout = plugin?.communication?.timeout || 60000;
    const effectiveTimeout = timeout ?? defaultTimeout;

    let server = distributedServers.get(serverIdOrName); // 优先尝试通过 ID 查找

    // 如果通过 ID 找不到，则遍历并尝试通过 name 查找
    if (!server) {
        for (const srv of distributedServers.values()) {
            if (srv.serverName === serverIdOrName) {
                server = srv;
                break;
            }
        }
    }

    if (!server || server.ws.readyState !== WebSocket.OPEN) {
        throw new Error(`Distributed server ${serverIdOrName} is not connected or ready.`);
    }

    const requestId = generateClientId();
    const payload = {
        type: 'execute_tool',
        data: {
            requestId,
            toolName,
            toolArgs
        }
    };

    return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
            pendingToolRequests.delete(requestId);
            reject(new Error(`Request to distributed tool ${toolName} on server ${serverIdOrName} timed out after ${effectiveTimeout / 1000}s.`));
        }, effectiveTimeout);

        pendingToolRequests.set(requestId, { resolve, reject, timeout: timeoutId });

        server.ws.send(JSON.stringify(payload));
        writeLog(`Sent tool execution request ${requestId} for ${toolName} to server ${serverIdOrName}.`);
    });
}












function findServerByIp(ip) {
    for (const [serverId, ipInfo] of distributedServerIPs.entries()) {
        if (ipInfo.publicIP === ip || (ipInfo.localIPs && ipInfo.localIPs.includes(ip))) {
            return ipInfo.serverName || serverId;
        }
    }
    return null;
}










// 新增：专门广播给管理面板
function broadcastToAdminPanel(data) {
    if (!wssInstance) return;
    const messageString = JSON.stringify(data);

    adminPanelClients.forEach(clientWs => {
        if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(messageString);
        }
    });
    if (serverConfig.debugMode) {
        writeLog(`Broadcasted to Admin Panel: ${messageString.substring(0, 200)}...`);
    }
}












module.exports = {
    initialize,
    setPluginManager,
    broadcast,
    broadcastVCPInfo, // 导出新的广播函数
    broadcastToAdminPanel, // 导出给管理面板的广播函数
    sendMessageToClient,
    executeDistributedTool,
    findServerByIp,
    shutdown

};
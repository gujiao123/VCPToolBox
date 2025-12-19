// Plugin.js
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const schedule = require('node-schedule');
const dotenv = require('dotenv'); // Ensures dotenv is available
const FileFetcherServer = require('./FileFetcherServer.js');
const express = require('express'); // For plugin API routing
const chokidar = require('chokidar');
const { getAuthCode } = require('./modules/captchaDecoder'); // 导入统一的解码函数

const PLUGIN_DIR = path.join(__dirname, 'Plugin');
const manifestFileName = 'plugin-manifest.json';
const PREPROCESSOR_ORDER_FILE = path.join(__dirname, 'preprocessor_order.json');

class PluginManager {
    constructor() {
        this.plugins = new Map(); // 存储所有插件（本地和分布式）
        this.staticPlaceholderValues = new Map();
        this.scheduledJobs = new Map();
        this.messagePreprocessors = new Map();
        this.preprocessorOrder = []; // 新增：用于存储预处理器的最终加载顺序
        this.serviceModules = new Map(); // 服务插件模块
        this.projectBasePath = null; // 项目根目录
        this.individualPluginDescriptions = new Map(); // New map for individual descriptions
        this.debugMode = (process.env.DebugMode || "False").toLowerCase() === "true";
        this.webSocketServer = null; // 为 WebSocketServer 实例占位
        this.isReloading = false;
        this.reloadTimeout = null;
        this.vectorDBManager = null; // 向量数据库管理器
    }

    setWebSocketServer(wss) {
        this.webSocketServer = wss;
        if (this.debugMode) console.log('[PluginManager] WebSocketServer instance has been set.');
    }

    setVectorDBManager(vdbManager) {
        this.vectorDBManager = vdbManager;
        if (this.debugMode) console.log('[PluginManager] VectorDBManager instance has been set.');
    }

    async _getDecryptedAuthCode() {
        try {
            const authCodePath = path.join(__dirname, 'Plugin', 'UserAuth', 'code.bin');
            // 使用正确的 getAuthCode 函数，并传递文件路径
            return await getAuthCode(authCodePath);
        } catch (error) {
            if (this.debugMode) {
                console.error('[PluginManager] Failed to read or decrypt auth code for plugin execution:', error.message);
            }
            return null; // Return null if code cannot be obtained
        }
    }

    setProjectBasePath(basePath) {
        this.projectBasePath = basePath;
        if (this.debugMode) console.log(`[PluginManager] Project base path set to: ${this.projectBasePath}`);
    }
    //配置合并机制 (_getPluginConfig) - 合并全局和插件特定的环境变量
    _getPluginConfig(pluginManifest) {
        const config = {};
        const globalEnv = process.env;
        const pluginSpecificEnv = pluginManifest.pluginSpecificEnvConfig || {};

        if (pluginManifest.configSchema) {
            for (const key in pluginManifest.configSchema) {
                const schemaEntry = pluginManifest.configSchema[key];
                // 兼容两种格式：对象格式 { type: "string", ... } 和简单字符串格式 "string"
                const expectedType = (typeof schemaEntry === 'object' && schemaEntry !== null)
                    ? schemaEntry.type
                    : schemaEntry;
                let rawValue;

                if (pluginSpecificEnv.hasOwnProperty(key)) {
                    rawValue = pluginSpecificEnv[key];
                } else if (globalEnv.hasOwnProperty(key)) {
                    rawValue = globalEnv[key];
                } else {
                    continue;
                }

                let value = rawValue;
                if (expectedType === 'integer') {
                    value = parseInt(value, 10);
                    if (isNaN(value)) {
                        if (this.debugMode) console.warn(`[PluginManager] Config key '${key}' for ${pluginManifest.name} expected integer, got NaN from raw value '${rawValue}'. Using undefined.`);
                        value = undefined;
                    }
                } else if (expectedType === 'boolean') {
                    value = String(value).toLowerCase() === 'true';
                }
                config[key] = value;
            }
        }

        //     API_KEY: "global_key",       // 从全局继承
        //         GOOGLE_SEARCH_API: "plugin_specific_key",  // 插件特定
        //             GOOGLE_CX: "your_cx_id",     // 插件特定
        //                 DebugMode: false,            // 插件特定覆盖全局
        //                     PORT: 6005                   // 从全局继承

        if (pluginSpecificEnv.hasOwnProperty('DebugMode')) {
            config.DebugMode = String(pluginSpecificEnv.DebugMode).toLowerCase() === 'true';
        } else if (globalEnv.hasOwnProperty('DebugMode')) {
            config.DebugMode = String(globalEnv.DebugMode).toLowerCase() === 'true';
        } else if (!config.hasOwnProperty('DebugMode')) {
            config.DebugMode = false;
        }
        return config;
    }





    getResolvedPluginConfigValue(pluginName, configKey) {
        const pluginManifest = this.plugins.get(pluginName);
        if (!pluginManifest) {
            return undefined;
        }
        const effectiveConfig = this._getPluginConfig(pluginManifest);
        return effectiveConfig ? effectiveConfig[configKey] : undefined;
    }

    async _executeStaticPluginCommand(plugin) {
        if (!plugin || plugin.pluginType !== 'static' || !plugin.entryPoint || !plugin.entryPoint.command) {
            console.error(`[PluginManager] Invalid static plugin or command for execution: ${plugin ? plugin.name : 'Unknown'}`);
            return Promise.reject(new Error(`Invalid static plugin or command for ${plugin ? plugin.name : 'Unknown'}`));
        }

        return new Promise((resolve, reject) => {
            const pluginConfig = this._getPluginConfig(plugin);
            const envForProcess = { ...process.env };
            for (const key in pluginConfig) {
                if (pluginConfig.hasOwnProperty(key) && pluginConfig[key] !== undefined) {
                    envForProcess[key] = String(pluginConfig[key]);
                }
            }
            if (this.projectBasePath) { // Add projectBasePath for static plugins too if needed
                envForProcess.PROJECT_BASE_PATH = this.projectBasePath;
            }


            const [command, ...args] = plugin.entryPoint.command.split(' ');
            const pluginProcess = spawn(command, args, { cwd: plugin.basePath, shell: true, env: envForProcess, windowsHide: true });
            let output = '';
            let errorOutput = '';
            let processExited = false;
            const timeoutDuration = plugin.communication?.timeout || 60000; // 增加默认超时时间到 1 分钟

            const timeoutId = setTimeout(() => {
                if (!processExited) {
                    console.log(`[PluginManager] Static plugin "${plugin.name}" has completed its work cycle (${timeoutDuration}ms), terminating background process.`);
                    pluginProcess.kill('SIGKILL');
                    // 超时不作为错误 - static 插件完成工作周期后返回已收集的输出
                    resolve(output.trim());
                }
            }, timeoutDuration);

            pluginProcess.stdout.on('data', (data) => { output += data.toString(); });
            pluginProcess.stderr.on('data', (data) => { errorOutput += data.toString(); });

            pluginProcess.on('error', (err) => {
                processExited = true;
                clearTimeout(timeoutId);
                console.error(`[PluginManager] Failed to start static plugin ${plugin.name}: ${err.message}`);
                reject(err);
            });

            pluginProcess.on('exit', (code, signal) => {
                processExited = true;
                clearTimeout(timeoutId);
                if (signal === 'SIGKILL') {
                    // 被 SIGKILL 终止（超时），已经在 timeout 回调中 resolve 了，这里直接返回
                    return;
                }
                if (code !== 0) {
                    const errMsg = `Static plugin ${plugin.name} exited with code ${code}. Stderr: ${errorOutput.trim()}`;
                    console.error(`[PluginManager] ${errMsg}`);
                    reject(new Error(errMsg));
                } else {
                    if (errorOutput.trim() && this.debugMode) {
                        console.warn(`[PluginManager] Static plugin ${plugin.name} produced stderr output: ${errorOutput.trim()}`);
                    }
                    resolve(output.trim());
                }
            });
        });
    }

    async _updateStaticPluginValue(plugin) {
        let newValue = null;
        let executionError = null;
        try {
            if (this.debugMode) console.log(`[PluginManager] Updating static plugin: ${plugin.name}`);
            newValue = await this._executeStaticPluginCommand(plugin);
        } catch (error) {
            console.error(`[PluginManager] Error executing static plugin ${plugin.name} script:`, error.message);
            executionError = error;
        }

        if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
            plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                const placeholderKey = ph.placeholder;
                const currentValueEntry = this.staticPlaceholderValues.get(placeholderKey);
                const currentValue = currentValueEntry ? currentValueEntry.value : undefined;

                if (newValue !== null && newValue.trim() !== "") {
                    this.staticPlaceholderValues.set(placeholderKey, { value: newValue.trim(), serverId: 'local' });
                    if (this.debugMode) console.log(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} updated with value: "${(newValue.trim()).substring(0, 70)}..."`);
                } else if (executionError) {
                    const errorMessage = `[Error updating ${plugin.name}: ${executionError.message.substring(0, 100)}...]`;
                    if (!currentValue || (currentValue && currentValue.startsWith("[Error"))) {
                        this.staticPlaceholderValues.set(placeholderKey, { value: errorMessage, serverId: 'local' });
                        if (this.debugMode) console.warn(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to error state: ${errorMessage}`);
                    } else {
                        if (this.debugMode) console.warn(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} failed to update. Keeping stale value: "${(currentValue || "").substring(0, 70)}..."`);
                    }
                } else {
                    if (this.debugMode) console.warn(`[PluginManager] Static plugin ${plugin.name} produced no new output for ${placeholderKey}. Keeping stale value (if any).`);
                    if (!currentValueEntry) {
                        this.staticPlaceholderValues.set(placeholderKey, { value: `[${plugin.name} data currently unavailable]`, serverId: 'local' });
                        if (this.debugMode) console.log(`[PluginManager] Placeholder ${placeholderKey} for ${plugin.name} set to 'unavailable'.`);
                    }
                }
            });
        }
    }





    //初始化静态插件
    async initializeStaticPlugins() {
        console.log('[PluginManager] Initializing static plugins...');
        for (const plugin of this.plugins.values()) {
            if (plugin.pluginType === 'static') {
                // 3. 【关键步骤】立即设置“加载中”状态 (Loading State)
                // 为什么要这么做？
                // VCP 启动后，用户可能立刻就会开始聊天。此时插件的第一次数据抓取（如爬取新闻）可能还没完成。
                // 如果不预设一个值，AI 的 Prompt 里就会出现 {{VCPDailyHot}} 这种未替换的原始字符，导致幻觉。
                if (plugin.capabilities && plugin.capabilities.systemPromptPlaceholders) {
                    plugin.capabilities.systemPromptPlaceholders.forEach(ph => {
                        // 这里设置了一个临时的 value。
                        // 有趣的细节：`a-zheng-zai-jia-zai-zhong` 是“正在加载中”的拼音。
                        // 这是 VCP 为了让开发者在 Debug 时一眼看出状态，同时又不至于让 AI 产生严重误解的占位符。
                        this.staticPlaceholderValues.set(ph.placeholder, { value: `[${plugin.displayName} a-zheng-zai-jia-zai-zhong... ]`, serverId: 'local' });
                    });
                }

                // 4. 【核心设计】触发首次更新 (Fire and Forget)
                // 注意：这里调用了 _updateStaticPluginValue 但没有使用 'await'！
                // 架构思考：
                // 如果我们在这里 await，服务器启动会被卡住。假设天气插件超时 30秒，整个服务器就得等30秒才能启动。
                // 所以这里是异步触发，让它在后台跑，主程序继续往下走。
                this._updateStaticPluginValue(plugin).catch(err => {
                    console.error(`[PluginManager] Initial background update for ${plugin.name} failed: ${err.message}`);
                });

                // 5. 设置定时任务 (Cron Job)
                // 读取 manifest 中的 refreshIntervalCron 字段（例如 "0 * * * *" 每小时一次）
                if (plugin.refreshIntervalCron) {
                    // 防御性编程：如果这个插件已经有任务在跑了（比如热重载时），先取消旧的，防止任务堆积。
                    if (this.scheduledJobs.has(plugin.name)) {
                        this.scheduledJobs.get(plugin.name).cancel();
                    }
                    try {
                        // 使用 node-schedule 创建定时任务
                        const job = schedule.scheduleJob(plugin.refreshIntervalCron, () => {
                            if (this.debugMode) console.log(`[PluginManager] Scheduled update for static plugin: ${plugin.name}`);
                            // 定时触发更新逻辑
                            this._updateStaticPluginValue(plugin).catch(err => {
                                console.error(`[PluginManager] Scheduled background update for ${plugin.name} failed: ${err.message}`);
                            });
                        });
                        // 将任务句柄存入 scheduledJobs Map，以便后续（如关机、重载时）能找到并取消它
                        this.scheduledJobs.set(plugin.name, job);
                        if (this.debugMode) console.log(`[PluginManager] Scheduled ${plugin.name} with cron: ${plugin.refreshIntervalCron}`);
                    } catch (e) {
                        console.error(`[PluginManager] Invalid cron string for ${plugin.name}: ${plugin.refreshIntervalCron}. Error: ${e.message}`);
                    }
                }
            }
        }
        // 6. 初始化流程结束
        console.log('[PluginManager] Static plugins initialization process has been started (updates will run in the background).');
    }


















    async prewarmPythonPlugins() {
        console.log('[PluginManager] Checking for Python plugins to pre-warm...');
        if (this.plugins.has('SciCalculator')) {
            console.log('[PluginManager] SciCalculator found. Starting pre-warming of Python scientific libraries in the background.');
            try {
                const command = 'python';
                const args = ['-c', 'import sympy, scipy.stats, scipy.integrate, numpy'];
                const prewarmProcess = spawn(command, args, {
                    // 移除 shell: true
                    windowsHide: true
                });

                prewarmProcess.on('error', (err) => {
                    console.warn(`[PluginManager] Python pre-warming process failed to start. Is Python installed and in the system's PATH? Error: ${err.message}`);
                });

                prewarmProcess.stderr.on('data', (data) => {
                    console.warn(`[PluginManager] Python pre-warming process stderr: ${data.toString().trim()}`);
                });

                prewarmProcess.on('exit', (code) => {
                    if (code === 0) {
                        console.log('[PluginManager] Python scientific libraries pre-warmed successfully.');
                    } else {
                        console.warn(`[PluginManager] Python pre-warming process exited with code ${code}. Please ensure required libraries are installed (pip install sympy scipy numpy).`);
                    }
                });
            } catch (e) {
                console.error(`[PluginManager] An exception occurred while spawning the Python pre-warming process: ${e.message}`);
            }
        } else {
            if (this.debugMode) console.log('[PluginManager] SciCalculator not found, skipping Python pre-warming.');
        }
    }




    getPlaceholderValue(placeholder) {
        // First, try the modern, clean key (e.g., "VCPChromePageInfo")
        let entry = this.staticPlaceholderValues.get(placeholder);

        // If not found, try the legacy key with brackets (e.g., "{{VCPChromePageInfo}}")
        if (entry === undefined) {
            entry = this.staticPlaceholderValues.get(`{{${placeholder}}}`);
        }

        // If still not found, return the "not found" message
        if (entry === undefined) {
            return `[Placeholder ${placeholder} not found]`;
        }

        // Now, handle the value format
        // Modern format: { value: "...", serverId: "..." }
        if (typeof entry === 'object' && entry !== null && entry.hasOwnProperty('value')) {
            return entry.value;
        }

        // Legacy format: raw string
        if (typeof entry === 'string') {
            return entry;
        }

        // Fallback for unexpected formats
        return `[Invalid value format for placeholder ${placeholder}]`;
    }



    async executeMessagePreprocessor(pluginName, messages) {
        const processorModule = this.messagePreprocessors.get(pluginName);
        const pluginManifest = this.plugins.get(pluginName);
        if (!processorModule || !pluginManifest) {
            console.error(`[PluginManager] Message preprocessor plugin "${pluginName}" not found.`);
            return messages;
        }
        if (typeof processorModule.processMessages !== 'function') {
            console.error(`[PluginManager] Plugin "${pluginName}" does not have 'processMessages' function.`);
            return messages;
        }
        try {
            if (this.debugMode) console.log(`[PluginManager] Executing message preprocessor: ${pluginName}`);
            const pluginSpecificConfig = this._getPluginConfig(pluginManifest);
            const processedMessages = await processorModule.processMessages(messages, pluginSpecificConfig);
            if (this.debugMode) console.log(`[PluginManager] Message preprocessor ${pluginName} finished.`);
            return processedMessages;
        } catch (error) {
            console.error(`[PluginManager] Error in message preprocessor ${pluginName}:`, error);
            return messages;
        }
    }




    async shutdownAllPlugins() {
        console.log('[PluginManager] Shutting down all plugins...'); // Keep

        // --- Shutdown VectorDBManager first to stop background processing ---
        if (this.vectorDBManager && typeof this.vectorDBManager.shutdown === 'function') {
            try {
                if (this.debugMode) console.log('[PluginManager] Calling shutdown for VectorDBManager...');
                await this.vectorDBManager.shutdown();
            } catch (error) {
                console.error('[PluginManager] Error during shutdown of VectorDBManager:', error);
            }
        }

        for (const [name, pluginModuleData] of this.messagePreprocessors) {
            const pluginModule = pluginModuleData.module || pluginModuleData;
            if (pluginModule && typeof pluginModule.shutdown === 'function') {
                try {
                    if (this.debugMode) console.log(`[PluginManager] Calling shutdown for ${name}...`);
                    await pluginModule.shutdown();
                } catch (error) {
                    console.error(`[PluginManager] Error during shutdown of plugin ${name}:`, error); // Keep error
                }
            }
        }
        for (const [name, serviceData] of this.serviceModules) {
            if (serviceData.module && typeof serviceData.module.shutdown === 'function') {
                try {
                    if (this.debugMode) console.log(`[PluginManager] Calling shutdown for service plugin ${name}...`);
                    await serviceData.module.shutdown();
                } catch (error) {
                    console.error(`[PluginManager] Error during shutdown of service plugin ${name}:`, error); // Keep error
                }
            }
        }
        for (const job of this.scheduledJobs.values()) {
            job.cancel();
        }
        this.scheduledJobs.clear();
        console.log('[PluginManager] All plugin shutdown processes initiated and scheduled jobs cancelled.'); // Keep
    }










    /**
     * 异步发现、加载并初始化所有插件。
     *
     * 此函数执行完整的插件加载生命周期：
     * 1. **状态清理**：清除现有的本地插件、预处理器、静态占位符和服务模块状态（保留分布式插件）。
     * 2. **文件扫描**：遍历 `Plugin` 目录，读取每个子目录下的 `plugin-manifest.json` 和 `config.env`。
     * 3. **模块加载**：对于协议为 `direct` 的 Node.js 插件（如预处理器和服务），直接 `require` 并加载其模块。
     * 4. **依赖注入**：为加载的模块注入核心依赖（如 `vectorDBManager`、日志函数、全局配置等）。
     * 5. **排序与初始化**：根据 `preprocessor_order.json` 确定预处理器的执行顺序，并按序调用模块的 `initialize` 方法。
     * 6. **构建描述**：更新系统对所有可用 VCP 工具的描述索引。
     *
     * @returns {Promise<void>} 当所有插件加载和初始化完成时解决的 Promise。
     */
    async loadPlugins() {
        console.log('[PluginManager] Starting plugin discovery...');
        // 1. 清理现有插件状态
        // 1️⃣ 清理现有状态 (保留分布式插件)
        const localPlugins = new Map();
        for (const [name, manifest] of this.plugins.entries()) {
            if (!manifest.isDistributed) {
                localPlugins.set(name, manifest);
            }
        }


        this.plugins = localPlugins; // 把“仅包含云端插件”的名单赋回给主注册表。本地插件现在被清空了。
        this.messagePreprocessors.clear(); // 清空消息预处理器（比如 ImageProcessor）
        this.staticPlaceholderValues.clear(); // 清空静态占位符（比如 {{VCPWeather}}）
        this.serviceModules.clear(); // 清空服务模块（比如 VCPLog）



        // 3. 临时存储 discoveredPreprocessors
        const discoveredPreprocessors = new Map();
        // 4. 待初始化队列 modulesToInitialize
        const modulesToInitialize = [];

        try {
            // 2. 发现并加载所有插件模块，但不初始化
            // 2️⃣ 扫描Plugin目录
            const pluginFolders = await fs.readdir(PLUGIN_DIR, { withFileTypes: true });
            for (const folder of pluginFolders) {
                if (folder.isDirectory()) {
                    const pluginPath = path.join(PLUGIN_DIR, folder.name);
                    const manifestPath = path.join(pluginPath, manifestFileName);
                    try {
                        const manifestContent = await fs.readFile(manifestPath, 'utf-8');
                        // 7. 核心变量 manifest (插件的灵魂)
                        const manifest = JSON.parse(manifestContent);
                        // 作用：这是插件的“身份证”。包含 name(ID), displayName(昵称), pluginType(工种), entryPoint(怎么干活)。
                        // 来源：plugin-manifest.json 文件。
                        if (!manifest.name || !manifest.pluginType || !manifest.entryPoint) continue;
                        if (this.plugins.has(manifest.name)) continue;

                        manifest.basePath = pluginPath;
                        manifest.pluginSpecificEnvConfig = {};
                        try {
                            // 3️⃣ 读取插件特定配置 (config.env
                            const pluginEnvContent = await fs.readFile(path.join(pluginPath, 'config.env'), 'utf-8');
                            // 8. 运行时配置 manifest.pluginSpecificEnvConfig
                            manifest.pluginSpecificEnvConfig = dotenv.parse(pluginEnvContent);
                            // 作用：这是插件的“私有小金库”。
                            // 逻辑：读取插件目录下的 config.env。
                            // 意义：实现了环境隔离。比如 SunoGen 的 Key 存在这里，不会和全局 Key 冲突。
                        } catch (envError) {
                            if (envError.code !== 'ENOENT') console.warn(`[PluginManager] Error reading config.env for ${manifest.name}:`, envError.message);
                        }
                        // 存储manifest

                        // 9. 注册插件
                        this.plugins.set(manifest.name, manifest);
                        // 动作：正式把这个插件录入 VCP 的名册。此时它还不能干活，只是“报到”了。
                        console.log(`[PluginManager] Loaded manifest: ${manifest.displayName} (${manifest.name}, Type: ${manifest.pluginType})`);
                        // 4️⃣ 对于direct协议的service/hybridservice/messagePreprocessor插件，加载模块


                        // 第四阶段：加载“原生”模块(Node.js Module Loading)
                        // 10. 类型判断标志
                        // 是不是预处理器？
                        const isPreprocessor = manifest.pluginType === 'messagePreprocessor' || manifest.pluginType === 'hybridservice';
                        // 是不是服务？
                        const isService = manifest.pluginType === 'service' || manifest.pluginType === 'hybridservice';

                        if ((isPreprocessor || isService) && manifest.entryPoint.script && manifest.communication?.protocol === 'direct') {
                            try {
                                const scriptPath = path.join(pluginPath, manifest.entryPoint.script);
                                // 11. 模块实例 module
                                const module = require(scriptPath);
                                // 作用：真正加载 JS 代码。此时 module 就是插件导出的对象（包含 initialize, processMessages 等函数）。
                                // 关键：这是 Node.js 的 require，代码被读入内存了。
                                // 12. 填充队列
                                modulesToInitialize.push({ manifest, module });// 加入待初始化队列

                                if (isPreprocessor && typeof module.processMessages === 'function') {
                                    discoveredPreprocessors.set(manifest.name, module);// 暂存到预处理器池
                                }
                                if (isService) {
                                    // 12. 服务模块 serviceModules
                                    this.serviceModules.set(manifest.name, { manifest, module });// 存入服务注册表
                                }
                            } catch (e) {
                                console.error(`[PluginManager] Error loading module for ${manifest.name}:`, e);
                            }
                        }
                    } catch (error) {
                        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) {
                            console.error(`[PluginManager] Error loading plugin from ${folder.name}:`, error);
                        }
                    }
                }
            }

            // 3. 确定预处理器加载顺序
            // 13. 可用插件集合 availablePlugins
            const availablePlugins = new Set(discoveredPreprocessors.keys());
            let finalOrder = [];
            // 14. 最终顺序 finalOrder
            try {
                const orderContent = await fs.readFile(PREPROCESSOR_ORDER_FILE, 'utf-8');
                const savedOrder = JSON.parse(orderContent);
                if (Array.isArray(savedOrder)) {
                    // 逻辑：
                    // A. 先读取 preprocessor_order.json (用户自定义的顺序)。
                    // B. 把用户指定的插件按顺序放入 finalOrder，并从 availablePlugins 移除。
                    // C. 把剩下的（用户没排序的）插件按字母顺序追加到 finalOrder 后面。
                    savedOrder.forEach(pluginName => {
                        if (availablePlugins.has(pluginName)) {
                            finalOrder.push(pluginName);
                            availablePlugins.delete(pluginName);
                        }
                    });
                }
            } catch (error) {
                if (error.code !== 'ENOENT') console.error(`[PluginManager] Error reading existing ${PREPROCESSOR_ORDER_FILE}:`, error);
            }

            finalOrder.push(...Array.from(availablePlugins).sort());

            // 4. 注册预处理器
            // 15. 正式注册 this.messagePreprocessors
            for (const pluginName of finalOrder) {
                this.messagePreprocessors.set(pluginName, discoveredPreprocessors.get(pluginName));
            }

            // 16. 初始化顺序 initializationOrder

            this.preprocessorOrder = finalOrder;
            if (finalOrder.length > 0) console.log('[PluginManager] Final message preprocessor order: ' + finalOrder.join(' -> '));

            // 5. VectorDBManager 应该已经由 server.js 初始化，这里不再重复初始化
            if (!this.vectorDBManager) {
                console.warn('[PluginManager] VectorDBManager not set! Plugins requiring it may fail.');
            }

            // 6. 按顺序初始化所有模块
            // 6️⃣ 按顺序初始化所有模块
            const allModulesMap = new Map(modulesToInitialize.map(m => [m.manifest.name, m]));
            const initializationOrder = [...this.preprocessorOrder];
            allModulesMap.forEach((_, name) => {
                if (!initializationOrder.includes(name)) {
                    initializationOrder.push(name);
                }
            });




            // 16. 初始化顺序 initializationOrder
            //对于每一个插件
            for (const pluginName of initializationOrder) {
                const item = allModulesMap.get(pluginName);
                if (!item || typeof item.module.initialize !== 'function') continue;

                const { manifest, module } = item;
                try {
                    const initialConfig = this._getPluginConfig(manifest);
                    initialConfig.PORT = process.env.PORT;
                    initialConfig.Key = process.env.Key;
                    initialConfig.PROJECT_BASE_PATH = this.projectBasePath;

                    // getVCPLogFunctions 返回的是 VCPLog 插件的推送接口。为什么要注入而不是 import？因为 VCPLog 本身也是一个插件！通过这种方式，我们解耦了具体实现。任何插件只要拿到这个 dependencies，就能直接向前端 WebSocket 推送日志，而不需要关心 WebSocket 服务器是谁。
                    //让插件能调用日志推送函数
                    const dependencies = { vcpLogFunctions: this.getVCPLogFunctions() };

                    // --- 注入 VectorDBManager ---
                    if (manifest.name === 'RAGDiaryPlugin') {
                        // 背景：vectorDBManager（即 KnowledgeBaseManager.js 的实例）在 server.js 中就已经被初始化并连接了 SQLite 数据库。

                        // 解读：RAGDiaryPlugin 是 VCP 记忆系统的大脑，它需要操作数据库。但我们不希望它自己去 new 一个数据库连接（那样会导致多连接冲突和锁死）。所以，服务器把自己持有的那个唯一的、珍贵的数据库连接实例，通过 dependencies 亲手交给了 RAGDiaryPlugin。

                        // 结果：RAGDiaryPlugin 现在拥有了操作底层向量数据库的全部权限。
                        dependencies.vectorDBManager = this.vectorDBManager;
                    }

                    // --- LightMemo 特殊依赖注入 ---
                    if (manifest.name === 'LightMemo') {
                        // 1. 寻找大哥：尝试获取已经加载的 RAGDiaryPlugin 实例
                        const ragPluginModule = this.messagePreprocessors.get('RAGDiaryPlugin');
                        // 2. 检查能力：确认大哥是否健康，且拥有数据库连接和向量化能力
                        if (ragPluginModule && ragPluginModule.vectorDBManager && typeof ragPluginModule.getSingleEmbedding === 'function') {
                            // 3. 注入数据库：LightMemo 直接复用同一个数据库连接
                            dependencies.vectorDBManager = ragPluginModule.vectorDBManager;
                            // 4. 注入算法：LightMemo 不需要自己写 Embedding API 调用逻辑！
                            // 它直接“借用”了 RAGDiaryPlugin 里的 getSingleEmbedding 方法。
                            // .bind(ragPluginModule) 非常关键：确保方法运行时，'this' 依然指向 RAG 插件实例，
                            // 这样 LightMemo 就能蹭到 RAG 插件里的缓存（embeddingCache）配置。
                            dependencies.getSingleEmbedding = ragPluginModule.getSingleEmbedding.bind(ragPluginModule);
                            if (this.debugMode) console.log(`[PluginManager] Injected VectorDBManager and getSingleEmbedding into LightMemo.`);
                        } else {
                            console.error(`[PluginManager] Critical dependency failure: RAGDiaryPlugin or its components not available for LightMemo injection.`);
                        }
                    }
                    // --- 注入结束 ---

                    // 18. 执行初始化
                    await module.initialize(initialConfig, dependencies);
                    // 动作：调用插件代码里的 initialize 函数。
                    // 意义：插件此时拿到配置和依赖，开始连接数据库、启动定时任务、注册路由等。
                } catch (e) {
                    console.error(`[PluginManager] Error initializing module for ${manifest.name}:`, e);
                }
            }
            // 7️⃣ 构建VCP工具描述
            this.buildVCPDescription();
            console.log(`[PluginManager] Plugin discovery finished. Loaded ${this.plugins.size} plugins.`);
        } catch (error) {
            if (error.code === 'ENOENT') console.error(`[PluginManager] Plugin directory ${PLUGIN_DIR} not found.`);
            else console.error('[PluginManager] Error reading plugin directory:', error);
        }
    }











    buildVCPDescription() {
        this.individualPluginDescriptions.clear(); // Clear previous descriptions
        let overallLog = ['[PluginManager] Building individual VCP descriptions:'];

        for (const plugin of this.plugins.values()) {
            if (plugin.capabilities && plugin.capabilities.invocationCommands && plugin.capabilities.invocationCommands.length > 0) {
                let pluginSpecificDescriptions = [];
                plugin.capabilities.invocationCommands.forEach(cmd => {
                    if (cmd.description) {
                        let commandDescription = `- ${plugin.displayName} (${plugin.name}) - 命令: ${cmd.command || 'N/A'}:\n`; // Assuming cmd might have a 'command' field or similar identifier
                        const indentedCmdDescription = cmd.description.split('\n').map(line => `    ${line}`).join('\n');
                        commandDescription += `${indentedCmdDescription}`;

                        if (cmd.example) {
                            const exampleHeader = `\n  调用示例:\n`;
                            const indentedExample = cmd.example.split('\n').map(line => `    ${line}`).join('\n');
                            commandDescription += exampleHeader + indentedExample;
                        }
                        pluginSpecificDescriptions.push(commandDescription);
                    }
                });

                if (pluginSpecificDescriptions.length > 0) {
                    const placeholderKey = `VCP${plugin.name}`;
                    const fullDescriptionForPlugin = pluginSpecificDescriptions.join('\n\n');
                    this.individualPluginDescriptions.set(placeholderKey, fullDescriptionForPlugin);
                    overallLog.push(`  - Generated description for {{${placeholderKey}}} (Length: ${fullDescriptionForPlugin.length})`);
                }
            }
        }

        if (this.individualPluginDescriptions.size === 0) {
            overallLog.push("  - No VCP plugins with invocation commands found to generate descriptions for.");
        }
        if (this.debugMode) console.log(overallLog.join('\n'));
    }



    // New method to get all individual descriptions
    getIndividualPluginDescriptions() {
        return this.individualPluginDescriptions;
    }


    // getVCPDescription() { // This method is no longer needed as VCPDescription is deprecated
    //     return this.vcpDescription;
    // }



    getPlugin(name) {
        return this.plugins.get(name);
    }



    getServiceModule(name) {
        return this.serviceModules.get(name)?.module;
    }


    // 新增：获取 VCPLog 插件的推送函数，供其他插件依赖注入
    //让其他插件能调用日志推送函数发日志
    getVCPLogFunctions() {
        const vcpLogModule = this.getServiceModule('VCPLog');
        if (vcpLogModule) {
            return {
                pushVcpLog: vcpLogModule.pushVcpLog,
                pushVcpInfo: vcpLogModule.pushVcpInfo
            };
        }
        return { pushVcpLog: () => { }, pushVcpInfo: () => { } };
    }



    async processToolCall(toolName, toolArgs, requestIp = null) {
        const plugin = this.plugins.get(toolName);
        if (!plugin) {
            throw new Error(`[PluginManager] Plugin "${toolName}" not found for tool call.`);
        }

        // Helper function to generate a timestamp string
        const _getFormattedLocalTimestamp = () => {
            const date = new Date();
            const year = date.getFullYear();
            const month = (date.getMonth() + 1).toString().padStart(2, '0');
            const day = date.getDate().toString().padStart(2, '0');
            const hours = date.getHours().toString().padStart(2, '0');
            const minutes = date.getMinutes().toString().padStart(2, '0');
            const seconds = date.getSeconds().toString().padStart(2, '0');
            const milliseconds = date.getMilliseconds().toString().padStart(3, '0');
            const timezoneOffsetMinutes = date.getTimezoneOffset();
            const offsetSign = timezoneOffsetMinutes > 0 ? "-" : "+";
            const offsetHours = Math.abs(Math.floor(timezoneOffsetMinutes / 60)).toString().padStart(2, '0');
            const offsetMinutes = Math.abs(timezoneOffsetMinutes % 60).toString().padStart(2, '0');
            const timezoneString = `${offsetSign}${offsetHours}:${offsetMinutes}`;
            return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}.${milliseconds}${timezoneString}`;
        };

        const maidNameFromArgs = toolArgs && toolArgs.maid ? toolArgs.maid : null;
        const pluginSpecificArgs = { ...toolArgs };
        if (maidNameFromArgs) {
            // The 'maid' parameter is intentionally passed through for plugins like DeepMemo.
            // delete pluginSpecificArgs.maid;
        }

        try {
            let resultFromPlugin;
            if (plugin.isDistributed) {
                // --- 分布式插件调用逻辑 ---
                if (!this.webSocketServer) {
                    throw new Error('[PluginManager] WebSocketServer is not initialized. Cannot call distributed tool.');
                }
                if (this.debugMode) console.log(`[PluginManager] Processing distributed tool call for: ${toolName} on server ${plugin.serverId}`);
                resultFromPlugin = await this.webSocketServer.executeDistributedTool(plugin.serverId, toolName, pluginSpecificArgs);
                // 分布式工具的返回结果应该已经是JS对象了
            } else if (toolName === 'ChromeControl' && plugin.communication?.protocol === 'direct') {
                // --- ChromeControl 特殊处理逻辑 ---
                if (!this.webSocketServer) {
                    throw new Error('[PluginManager] WebSocketServer is not initialized. Cannot call ChromeControl tool.');
                }
                if (this.debugMode) console.log(`[PluginManager] Processing direct WebSocket tool call for: ${toolName}`);
                const command = pluginSpecificArgs.command;
                delete pluginSpecificArgs.command;
                resultFromPlugin = await this.webSocketServer.forwardCommandToChrome(command, pluginSpecificArgs);

            } else if (plugin.pluginType === 'hybridservice' && plugin.communication?.protocol === 'direct') {
                // --- 混合服务插件直接调用逻辑 ---
                if (this.debugMode) console.log(`[PluginManager] Processing direct tool call for hybrid service: ${toolName}`);
                const serviceModule = this.getServiceModule(toolName);
                if (serviceModule && typeof serviceModule.processToolCall === 'function') {
                    resultFromPlugin = await serviceModule.processToolCall(pluginSpecificArgs);
                } else {
                    throw new Error(`[PluginManager] Hybrid service plugin "${toolName}" does not have a processToolCall function.`);
                }
            } else {
                // --- 本地插件调用逻辑 (现有逻辑) ---
                if (!((plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') && plugin.communication?.protocol === 'stdio')) {
                    throw new Error(`[PluginManager] Local plugin "${toolName}" (type: ${plugin.pluginType}) is not a supported stdio plugin for direct tool call.`);
                }

                let executionParam = null;
                if (Object.keys(pluginSpecificArgs).length > 0) {
                    executionParam = JSON.stringify(pluginSpecificArgs);
                }

                const logParam = executionParam ? (executionParam.length > 100 ? executionParam.substring(0, 100) + '...' : executionParam) : null;
                if (this.debugMode) console.log(`[PluginManager] Calling local executePlugin for: ${toolName} with prepared param:`, logParam);

                const pluginOutput = await this.executePlugin(toolName, executionParam, requestIp); // Returns {status, result/error}

                if (pluginOutput.status === "success") {
                    if (typeof pluginOutput.result === 'string') {
                        try {
                            // If the result is a string, try to parse it as JSON.
                            resultFromPlugin = JSON.parse(pluginOutput.result);
                        } catch (parseError) {
                            // If parsing fails, wrap it. This is for plugins that return plain text.
                            if (this.debugMode) console.warn(`[PluginManager] Local plugin ${toolName} result string was not valid JSON. Original: "${pluginOutput.result.substring(0, 100)}"`);
                            resultFromPlugin = { original_plugin_output: pluginOutput.result };
                        }
                    } else {
                        // If the result is already an object (as with our new image plugins), use it directly.
                        resultFromPlugin = pluginOutput.result;
                    }
                } else {
                    // 检查是否是文件未找到的特定错误
                    if (pluginOutput.code === 'FILE_NOT_FOUND_LOCALLY' && pluginOutput.fileUrl && requestIp) {
                        if (this.debugMode) console.log(`[PluginManager] Plugin '${toolName}' reported local file not found. Attempting to fetch via FileFetcherServer...`);

                        try {
                            const { buffer, mimeType } = await FileFetcherServer.fetchFile(pluginOutput.fileUrl, requestIp);
                            const base64Data = buffer.toString('base64');
                            const dataUri = `data:${mimeType};base64,${base64Data}`;

                            if (this.debugMode) console.log(`[PluginManager] Successfully fetched file as data URI. Retrying plugin call...`);

                            // 新的重试逻辑：精确替换失败的参数
                            const newToolArgs = { ...toolArgs };
                            const failedParam = pluginOutput.failedParameter; // e.g., "image_url1"

                            if (failedParam && newToolArgs[failedParam]) {
                                // 删除旧的 file:// url 参数
                                delete newToolArgs[failedParam];

                                // 添加新的 base64 参数。我们使用一个新的键来避免命名冲突，
                                // 并且让插件知道这是一个已经处理过的 base64 数据。
                                // e.g., "image_base64_1"
                                // 关键修复：确保正确地从 "image_url_1" 提取出 "1"
                                const paramIndex = failedParam.replace('image_url_', '');
                                const newParamKey = `image_base64_${paramIndex}`;
                                newToolArgs[newParamKey] = dataUri;

                                if (this.debugMode) console.log(`[PluginManager] Retrying with '${failedParam}' replaced by '${newParamKey}'.`);

                            } else {
                                // 旧的后备逻辑，用于兼容单个 image_url 的情况
                                delete newToolArgs.image_url;
                                newToolArgs.image_base64 = dataUri;
                                if (this.debugMode) console.log(`[PluginManager] 'failedParameter' not specified. Falling back to replacing 'image_url' with 'image_base64'.`);
                            }

                            // 直接返回重试调用的结果
                            return await this.processToolCall(toolName, newToolArgs, requestIp);

                        } catch (fetchError) {
                            throw new Error(JSON.stringify({
                                plugin_error: `Plugin reported local file not found, but remote fetch failed: ${fetchError.message}`,
                                original_plugin_error: pluginOutput.error
                            }));
                        }
                    } else {
                        throw new Error(JSON.stringify({ plugin_error: pluginOutput.error || `Plugin "${toolName}" reported an unspecified error.` }));
                    }
                }
            }

            // --- 通用结果处理 ---
            let finalResultObject = (typeof resultFromPlugin === 'object' && resultFromPlugin !== null) ? resultFromPlugin : { original_plugin_output: resultFromPlugin };

            if (maidNameFromArgs) {
                finalResultObject.MaidName = maidNameFromArgs;
            }
            finalResultObject.timestamp = _getFormattedLocalTimestamp();

            return finalResultObject;

        } catch (e) {
            console.error(`[PluginManager processToolCall] Error during execution for plugin ${toolName}:`, e.message);
            let errorObject;
            try {
                errorObject = JSON.parse(e.message);
            } catch (jsonParseError) {
                errorObject = { plugin_execution_error: e.message || 'Unknown plugin execution error' };
            }

            if (maidNameFromArgs && !errorObject.MaidName) {
                errorObject.MaidName = maidNameFromArgs;
            }
            if (!errorObject.timestamp) {
                errorObject.timestamp = _getFormattedLocalTimestamp();
            }
            throw new Error(JSON.stringify(errorObject));
        }
    }






































    /**
     * executePlugin - 执行 stdio 协议的同步/异步插件
     * 
     * @param {string} pluginName - 插件名称
     * @param {string|null} inputData - JSON字符串形式的输入参数
     * @param {string|null} requestIp - 请求来源IP（用于文件获取等）
     * @returns {Promise<Object>} 返回 {status: 'success'|'error', result: any}
     */
    async executePlugin(pluginName, inputData, requestIp = null) {
        // ============================================================
        // 第一阶段：验证插件存在性和类型
        // ============================================================

        const plugin = this.plugins.get(pluginName);
        // 检查1: 插件是否存在
        if (!plugin) {
            // This case should ideally be caught by processToolCall before calling executePlugin
            throw new Error(`[PluginManager executePlugin] Plugin "${pluginName}" not found.`);
        }
        // 检查2: 插件类型必须是 synchronous 或 asynchronous
        // 检查3: 通信协议必须是 stdio
        // 语法解释: && 是逻辑与运算符，|| 是逻辑或运算符，?. 是可选链操作符（防止 undefined.protocol 报错）

        // Validations for pluginType, communication, entryPoint remain important
        if (!((plugin.pluginType === 'synchronous' || plugin.pluginType === 'asynchronous') && plugin.communication?.protocol === 'stdio')) {
            throw new Error(
                `[PluginManager executePlugin] Plugin "${pluginName}" (type: ${plugin.pluginType}, protocol: ${plugin.communication?.protocol}) is not a supported stdio plugin. Expected synchronous or asynchronous stdio plugin.`);
        }


        // 检查4: 必须有入口点命令
        if (!plugin.entryPoint || !plugin.entryPoint.command) {
            throw new Error(`[PluginManager executePlugin] Entry point command undefined for plugin "${pluginName}".`);
        }

        // ============================================================
        // 第二阶段：构建环境变量（配置注入）
        // ============================================================

        // 1️⃣ 合并配置
        const pluginConfig = this._getPluginConfig(plugin);
        // 语法解释: { ...process.env } 是展开运算符（spread operator）
        // 创建 process.env 的浅拷贝，避免直接修改全局环境变量
        const envForProcess = { ...process.env };
        // 将插件配置注入到环境变量
        // 语法解释: for...in 循环遍历对象的可枚举属性
        for (const key in pluginConfig) {
            // hasOwnProperty 检查属性是否是对象自己的（非继承的）
            if (pluginConfig.hasOwnProperty(key) && pluginConfig[key] !== undefined) {
                // 环境变量必须是字符串，所以用 String() 转换
                envForProcess[key] = String(pluginConfig[key]);
            }
        }
        // 2️⃣ 注入额外环境变量 就是给插件额外的信息
        const additionalEnv = {};
        // 注入项目根目录路径
        if (this.projectBasePath) {
            additionalEnv.PROJECT_BASE_PATH = this.projectBasePath;
        } else {
            if (this.debugMode) console.warn("[PluginManager executePlugin] projectBasePath not set, PROJECT_BASE_PATH will not be available to plugins.");
        }

        // 如果插件需要管理员权限，则获取解密后的验证码并注入环境变量
        if (plugin.requiresAdmin) {
            // await 关键字：等待异步函数完成
            const decryptedCode = await this._getDecryptedAuthCode();
            if (decryptedCode) {
                additionalEnv.DECRYPTED_AUTH_CODE = decryptedCode;
                if (this.debugMode) console.log(`[PluginManager] Injected DECRYPTED_AUTH_CODE for admin-required plugin: ${pluginName}`);
            } else {
                if (this.debugMode) console.warn(`[PluginManager] Could not get decrypted auth code for admin-required plugin: ${pluginName}. Execution will proceed without it.`);
            }
        }
        // 将 requestIp 添加到环境变量
        if (requestIp) {
            additionalEnv.VCP_REQUEST_IP = requestIp;
        }
        // 注入服务器端口
        if (process.env.PORT) {
            additionalEnv.SERVER_PORT = process.env.PORT;
        }
        // 注入图像服务器密钥
        const imageServerKey = this.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (imageServerKey) {
            additionalEnv.IMAGESERVER_IMAGE_KEY = imageServerKey;
        }


        // 3️⃣ 异步插件特殊处理：注入回调URL
        // Pass CALLBACK_BASE_URL and PLUGIN_NAME to asynchronous plugins
        if (plugin.pluginType === 'asynchronous') {
            // 优先使用插件特定的 CALLBACK_BASE_URL，否则使用全局的
            const callbackBaseUrl = pluginConfig.CALLBACK_BASE_URL || process.env.CALLBACK_BASE_URL; // Prefer plugin-specific, then global
            if (callbackBaseUrl) {
                additionalEnv.CALLBACK_BASE_URL = callbackBaseUrl;
            } else {
                if (this.debugMode) console.warn(`[PluginManager executePlugin] CALLBACK_BASE_URL not configured for asynchronous plugin ${pluginName}. Callback functionality might be impaired.`);
            }
            // 传递插件名称，用于回调时识别
            additionalEnv.PLUGIN_NAME_FOR_CALLBACK = pluginName; // Pass the plugin's name
        }


        // 4️⃣ 强制 Python 使用 UTF-8 编码（解决中文乱码问题）
        // Force Python stdio encoding to UTF-8
        additionalEnv.PYTHONIOENCODING = 'utf-8';
        // 5️⃣ 合并所有环境变量
        // 语法解释: 后面的对象会覆盖前面的同名属性
        const finalEnv = { ...envForProcess, ...additionalEnv };
        // 调试模式：打印异步插件的最终环境变量（截取前500字符）
        if (this.debugMode && plugin.pluginType === 'asynchronous') {
            console.log(`[PluginManager executePlugin] Final ENV for async plugin ${pluginName}:`, JSON.stringify(finalEnv, null, 2).substring(0, 500) + "...");
        }

        // ============================================================
        // 第三阶段：创建子进程并执行插件（核心逻辑）
        // ============================================================


        // 4️⃣ 返回Promise
        // 语法解释: new Promise((resolve, reject) => {...}) 创建一个异步操作
        // resolve: 成功时调用，reject: 失败时调用
        return new Promise((resolve, reject) => {
            // 调试输出：显示将要执行的命令
            if (this.debugMode) console.log(`[PluginManager executePlugin Internal] For plugin "${pluginName}", manifest entryPoint command is: "${plugin.entryPoint.command}"`);

            //!! 例如: "node search.js" -> command='node', args=['search.js']
            // 语法解释: .split(' ') 按空格分割字符串
            //          [command, ...args] 是解构赋值 + rest参数
            //          第一个元素赋给 command，剩余元素组成数组赋给 args
            const [command, ...args] = plugin.entryPoint.command.split(' ');


            if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Attempting to spawn command: "${command}" with args: [${args.join(', ')}] in cwd: ${plugin.basePath}`);
            // 🚀 创建子进程（核心）
            // 语法解释: spawn 来自 child_process 模块，用于创建新进程
            const pluginProcess = spawn(command, args, {
                cwd: plugin.basePath,      // 工作目录：插件所在目录
                shell: true,               // 通过 shell 执行（支持环境变量等）
                env: finalEnv,             // 注入的环境变量
                windowsHide: true          // Windows 下隐藏命令行窗口
            });

            // 📦 初始化状态变量
            let outputBuffer = '';          // 累积 stdout 输出
            let errorOutput = '';           // 累积 stderr 输出
            let processExited = false;      // 进程是否已退出
            let initialResponseSent = false; // 异步插件：初始响应是否已发送

            // 判断是否为异步插件
            const isAsyncPlugin = plugin.pluginType === 'asynchronous';



            // ⏱️ 设置超时时间
            // 优先使用 manifest 中配置的 timeout
            // 异步插件默认 30分钟，同步插件默认 1分钟
            const timeoutDuration = plugin.communication.timeout || (isAsyncPlugin ? 1800000 : 60000); // Use manifest timeout, or 30min for async, 1min for sync
            // 设置超时定时器

            const timeoutId = setTimeout(() => {
                // 场景1: 异步插件的初始响应超时
                if (!processExited && !initialResponseSent && isAsyncPlugin) {
                    // For async, if initial response not sent by timeout, it's an error for that phase
                    console.error(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" initial response timed out after ${timeoutDuration}ms.`);
                    pluginProcess.kill('SIGKILL'); // Kill if no initial response
                    reject(new Error(`Plugin "${pluginName}" initial response timed out.`));
                } else if (!processExited && !isAsyncPlugin) {
                    // 场景2: 同步插件执行超时
                    // For sync plugins, or if async initial response was sent but process hangs
                    console.error(`[PluginManager executePlugin Internal] Plugin "${pluginName}" execution timed out after ${timeoutDuration}ms.`);
                    pluginProcess.kill('SIGKILL');
                    reject(new Error(`Plugin "${pluginName}" execution timed out.`));
                } else if (!processExited && isAsyncPlugin && initialResponseSent) {
                    // 场景3: 异步插件初始响应已发送，但进程仍在运行（正常情况）
                    // Async plugin's initial response was sent, but the process is still running (e.g. for background tasks)
                    // We let it run, but log if it exceeds the overall timeout.
                    // The process will be managed by its own non-daemon threads.
                    if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" process is still running in background after timeout. This is expected for non-daemon threads.`);
                }
            }, timeoutDuration);

            // ============================================================
            // 监听子进程的 stdout（标准输出）
            // ============================================================
            // 设置编码为 UTF-8
            // 'data' 事件：每次接收到输出数据时触发
            // 语法解释: .on() 是事件监听器，(data) => {...} 是箭头函数
            pluginProcess.stdout.setEncoding('utf8');

            pluginProcess.stdout.on('data', (data) => {
                // 如果进程已退出，或者异步插件已发送初始响应，则忽略后续输出
                if (processExited || (isAsyncPlugin && initialResponseSent)) {
                    // If async and initial response sent, or process exited, ignore further stdout for this Promise.
                    // The plugin's background task might still log to its own stdout, but we don't collect it here.
                    if (this.debugMode && isAsyncPlugin && initialResponseSent) console.log(`[PluginManager executePlugin Internal] Async plugin ${pluginName} (initial response sent) produced more stdout: ${data.substring(0, 100)}...`);
                    return;
                }


                // 5️⃣ 监听 stdout：累积输出
                outputBuffer += data;
                try {
                    // 🔍 尝试从缓冲区解析 JSON
                    // 正则表达式解释:
                    // /(\{[\s\S]*?\})(?:\s|$)/
                    // \{ 匹配左花括号
                    // [\s\S]*? 匹配任意字符（包括换行），非贪婪模式
                    // \} 匹配右花括号
                    // (?:\s|$) 匹配空白字符或字符串结尾（非捕获组）
                    const potentialJsonMatch = outputBuffer.match(/(\{[\s\S]*?\})(?:\s|$)/);
                    if (potentialJsonMatch && potentialJsonMatch[1]) {
                        const jsonString = potentialJsonMatch[1];
                        const parsedOutput = JSON.parse(jsonString);

                        if (parsedOutput && (parsedOutput.status === "success" || parsedOutput.status === "error")) {
                            // 尝试解析 JSON
                            if (isAsyncPlugin) { // 🔀 异步插件的处理
                                if (!initialResponseSent) {
                                    if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" sent initial JSON response. Resolving promise.`);
                                    initialResponseSent = true;
                                    // 💡 关键：异步插件收到第一个有效 JSON 后立即 resolve
                                    // 让进程继续在后台运行（如果有非守护线程）
                                    resolve(parsedOutput);
                                    // 注意：这里不 return，不清空 outputBuffer
                                    // 因为可能还有数据是同步插件的完整 JSON 输出的一部分
                                }
                            } else {   // 🔀 同步插件的处理
                                // 对于同步插件，在 'exit' 事件中统一处理
                                // 这里只是验证输出格式是否正确
                                if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Sync plugin "${pluginName}" current output buffer contains a potential JSON.`);
                            }
                        }
                    }
                } catch (e) {
                    // JSON 解析失败（不完整或格式错误）
                    // 继续等待更多数据或 'exit' 事件
                    if (this.debugMode && outputBuffer.length > 2) console.log(`[PluginManager executePlugin Internal] Plugin "${pluginName}" stdout buffer not yet a complete JSON or invalid. Buffer: ${outputBuffer.substring(0, 100)}...`);
                }
            });

            pluginProcess.stderr.setEncoding('utf8');
            pluginProcess.stderr.on('data', (data) => {
                errorOutput += data;
                if (this.debugMode) console.warn(`[PluginManager executePlugin Internal stderr] Plugin "${pluginName}": ${data.trim()}`);
            });
            // ============================================================
            // 监听子进程的 stderr（标准错误输出）
            // ============================================================
            pluginProcess.on('error', (err) => {
                processExited = true; clearTimeout(timeoutId);
                if (!initialResponseSent) { // Only reject if initial response (for async) or any response (for sync) hasn't been sent
                    reject(new Error(`Failed to start plugin "${pluginName}": ${err.message}`));
                } else if (this.debugMode) {
                    console.error(`[PluginManager executePlugin Internal] Error after initial response for async plugin "${pluginName}": ${err.message}. Process might have been expected to continue.`);
                }
            });
            // 语法解释: (code, signal) 是退出码和信号
            // code: 进程退出码，0 表示成功
            // signal: 进程被哪个信号杀死（如 'SIGKILL'）
            pluginProcess.on('exit', (code, signal) => {
                processExited = true;
                clearTimeout(timeoutId);; // 清除超时定时器
                // 🔀 异步插件且已发送初始响应
                if (isAsyncPlugin && initialResponseSent) {
                    // 只记录日志，不再 resolve/reject（已经在 data 事件中 resolve 了）
                    if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Async plugin "${pluginName}" process exited with code ${code}, signal ${signal} after initial response was sent.`);
                    return; // 提前返回
                }


                // 如果执行到这里，说明：
                // 1. 同步插件正常退出
                // 2. 异步插件在发送初始响应前就退出了

                // 🚫 被 SIGKILL 杀死（通常是超时）

                if (signal === 'SIGKILL') {
                    if (!initialResponseSent) reject(new Error(`Plugin "${pluginName}" execution timed out or was killed.`));
                    return;
                }
                // 🔍 尝试解析最终的输出
                try {
                    // 语法解释: .trim() 去除首尾空白字符
                    const parsedOutput = JSON.parse(outputBuffer.trim()); // Use accumulated outputBuffer
                    if (parsedOutput && (parsedOutput.status === "success" || parsedOutput.status === "error")) {
                        // ⚠️ 退出码和 JSON 状态不一致的警告
                        if (code !== 0 && parsedOutput.status === "success" && this.debugMode) {
                            console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" exited with code ${code} but reported success in JSON. Trusting JSON.`);
                        }
                        if (code === 0 && parsedOutput.status === "error" && this.debugMode) {
                            console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" exited with code 0 but reported error in JSON. Trusting JSON.`);
                        }    // 📎 附加 stderr 输出（如果有）
                        if (errorOutput.trim()) parsedOutput.pluginStderr = errorOutput.trim();
                        // ✅ 成功解析，resolve
                        if (!initialResponseSent) resolve(parsedOutput); // Ensure resolve only once
                        else if (this.debugMode) console.log(`[PluginManager executePlugin Internal] Plugin ${pluginName} exited, initial async response already sent.`);
                        return;
                    }
                    // JSON 格式不正确
                    if (this.debugMode) console.warn(`[PluginManager executePlugin Internal] Plugin "${pluginName}" final stdout was not in the expected JSON format: ${outputBuffer.trim().substring(0, 100)}`);
                } catch (e) {
                    // JSON 解析失败
                    if (this.debugMode) console.warn(`[PluginManager executePlugin Internal] Failed to parse final stdout JSON from plugin "${pluginName}". Error: ${e.message}. Stdout: ${outputBuffer.trim().substring(0, 100)}`);
                }
                // ❌ 无法解析有效输出，reject
                if (!initialResponseSent) { // Only reject if no response has been sent yet
                    if (code !== 0) {
                        let detailedError = `Plugin "${pluginName}" exited with code ${code}.`;
                        if (outputBuffer.trim()) detailedError += ` Stdout: ${outputBuffer.trim().substring(0, 200)}`;
                        if (errorOutput.trim()) detailedError += ` Stderr: ${errorOutput.trim().substring(0, 200)}`;
                        reject(new Error(detailedError));
                    } else {
                        // Exit code 0, but no valid initial JSON response was sent/parsed.
                        reject(new Error(`Plugin "${pluginName}" exited successfully but did not provide a valid initial JSON response. Stdout: ${outputBuffer.trim().substring(0, 200)}`));
                    }
                }
            });
            // ============================================================
            // 通过 stdin 发送输入数据到子进程
            // ============================================================
            try {
                // 语法解释: !== 是严格不等于，检查类型和值
                if (inputData !== undefined && inputData !== null) {
                    // 将输入数据写入子进程的标准输入
                    pluginProcess.stdin.write(inputData.toString());
                }
                // 关闭 stdin（表示没有更多数据）
                pluginProcess.stdin.end();
            } catch (e) {
                console.error(`[PluginManager executePlugin Internal] Stdin write error for "${pluginName}": ${e.message}`);
                // 只有在未发送响应时才 reject
                if (!initialResponseSent) { // Only reject if no response has been sent yet
                    reject(new Error(`Stdin write error for "${pluginName}": ${e.message}`));
                }
            }
        });
    }

























    /**
     * initializeServices - 初始化所有服务类插件，注册它们的API路由
     * 
     * @param {Object} app - Express 应用实例
     * @param {Object} adminApiRouter - 管理API路由实例
     * @param {string} projectBasePath - 项目基础路径
     * @returns {Promise<Object>} 返回 {status: 'success'|'error', result: any}
     */
    //!!这里才是开始初始化服务插件的地方
    initializeServices(app, adminApiRouter, projectBasePath) {

        //1. 入场安检：参数校验
        if (!app) {
            console.error('[PluginManager] Cannot initialize services without Express app instance.');
            return;
        }
        if (!adminApiRouter) {
            console.error('[PluginManager] Cannot initialize services without adminApiRouter instance.');
            return;
        }
        if (!projectBasePath) {
            console.error('[PluginManager] Cannot initialize services without projectBasePath.'); // Keep error
            return;
        }


        //2. 遍历商家：核心循环
        console.log('[PluginManager] Initializing service plugins...'); // Keep
        // 2. 遍历所有已加载的服务模块
        for (const [name, serviceData] of this.serviceModules) {
            try {
                // 3. 准备“水电”：获取该插件专属的配置和清单
                const pluginConfig = this._getPluginConfig(serviceData.manifest);
                const manifest = serviceData.manifest;
                const module = serviceData.module;


                //3. 现代化装修：命名空间路由注册 (The Modern Way)
                // 新的、带命名空间的API路由注册机制
                // 检查插件是否声明了 "hasApiRoutes": true，并且代码里有没有 registerApiRoutes 函数
                if (manifest.hasApiRoutes && typeof module.registerApiRoutes === 'function') {
                    if (this.debugMode) console.log(`[PluginManager] Registering namespaced API routes for service plugin: ${name}`);
                    // A. 创建一个独立的子路由对象 (Router)
                    const pluginRouter = express.Router();
                    // B. 让插件在这个子路由上折腾 (注册它自己的接口)

                    //一句话解释：就是给每个插件分配一个专属的 URL 前缀（子目录），防止大家抢同一个网址。
                    // 我们把 webSocketServer 也传进去了，这样插件就能拥有实时通讯能力
                    // 2. 让插件在这个小本本上写路由，而不是写在大黑板(app)上
                    module.registerApiRoutes(pluginRouter, pluginConfig, projectBasePath, this.webSocketServer);
                    // 统一挂载到带命名空间的前缀下
                    // C. 【关键】统一挂载！
                    // 比如插件叫 "MyService"，它的所有接口都会被自动加上前缀 "/api/plugins/MyService"
                    app.use(`/api/plugins/${name}`, pluginRouter);
                    if (this.debugMode) console.log(`[PluginManager] Mounted API routes for ${name} at /api/plugins/${name}`);
                }





                //4. 特权通道：VCPLog 的依赖注入
                // VCPLog 特殊处理：注入 WebSocketServer 的广播函数
                if (name === 'VCPLog' && this.webSocketServer && typeof module.setBroadcastFunctions === 'function') {
                    // 检查 WebSocketServer 是否具备广播能力
                    if (typeof this.webSocketServer.broadcastVCPInfo === 'function') {
                        // 动作：把 WebSocketServer 里的 broadcastVCPInfo 函数拿出来
                        // 硬塞给 VCPLog 模块里的 setBroadcastFunctions 方法
                        module.setBroadcastFunctions(this.webSocketServer.broadcastVCPInfo);
                        if (this.debugMode) console.log(`[PluginManager] Injected broadcastVCPInfo into VCPLog.`);
                    } else {
                        console.warn(`[PluginManager] WebSocketServer is missing broadcastVCPInfo function. VCPInfo will not be broadcastable.`);
                    }
                }




                //5. 兼容老旧设施：Legacy 路由注册
                // 兼容旧的、直接在 app 上注册的 service 插件
                if (typeof module.registerRoutes === 'function') {
                    if (this.debugMode) console.log(`[PluginManager] Registering legacy routes for service plugin: ${name}`);
                    // 判断函数的参数个数 (length 属性)，来决定传哪些参数
                    if (module.registerRoutes.length >= 4) {
                        // 新版 Legacy：支持 adminApiRouter
                        if (this.debugMode) console.log(`[PluginManager] Calling new-style legacy registerRoutes for ${name} (4+ args).`);
                        module.registerRoutes(app, adminApiRouter, pluginConfig, projectBasePath);
                    } else {
                        // 旧版 Legacy：只支持 app
                        if (this.debugMode) console.log(`[PluginManager] Calling legacy-style registerRoutes for ${name} (3 args).`);
                        module.registerRoutes(app, pluginConfig, projectBasePath);
                    }
                }

            } catch (e) {
                console.error(`[PluginManager] Error initializing service plugin ${name}:`, e); // Keep error
            }
        }
        console.log('[PluginManager] Service plugins initialized.'); // Keep
    }


























    // --- 新增分布式插件管理方法 ---
    registerDistributedTools(serverId, tools) {
        if (this.debugMode) console.log(`[PluginManager] Registering ${tools.length} tools from distributed server: ${serverId}`);
        for (const toolManifest of tools) {
            if (!toolManifest.name || !toolManifest.pluginType || !toolManifest.entryPoint) {
                if (this.debugMode) console.warn(`[PluginManager] Invalid manifest from ${serverId} for tool '${toolManifest.name}'. Skipping.`);
                continue;
            }
            if (this.plugins.has(toolManifest.name)) {
                if (this.debugMode) console.warn(`[PluginManager] Distributed tool '${toolManifest.name}' from ${serverId} conflicts with an existing tool. Skipping.`);
                continue;
            }

            // 标记为分布式插件并存储其来源服务器ID
            toolManifest.isDistributed = true;
            toolManifest.serverId = serverId;

            // 在显示名称前加上[云端]前缀
            toolManifest.displayName = `[云端] ${toolManifest.displayName || toolManifest.name}`;

            this.plugins.set(toolManifest.name, toolManifest);
            console.log(`[PluginManager] Registered distributed tool: ${toolManifest.displayName} (${toolManifest.name}) from ${serverId}`);
        }
        // 注册后重建描述，以包含新插件
        this.buildVCPDescription();
    }


















    unregisterAllDistributedTools(serverId) {
        if (this.debugMode) console.log(`[PluginManager] Unregistering all tools from distributed server: ${serverId}`);
        let unregisteredCount = 0;
        for (const [name, manifest] of this.plugins.entries()) {
            if (manifest.isDistributed && manifest.serverId === serverId) {
                this.plugins.delete(name);
                unregisteredCount++;
                if (this.debugMode) console.log(`  - Unregistered: ${name}`);
            }
        }
        if (unregisteredCount > 0) {
            console.log(`[PluginManager] Unregistered ${unregisteredCount} tools from server ${serverId}.`);
            // 注销后重建描述
            this.buildVCPDescription();
        }

        // 新增：清理分布式静态占位符
        this.clearDistributedStaticPlaceholders(serverId);
    }

























    // 新增：更新分布式静态占位符
    updateDistributedStaticPlaceholders(serverId, serverName, placeholders) {
        if (this.debugMode) {
            console.log(`[PluginManager] Updating static placeholders from distributed server ${serverName} (${serverId})`);
        }

        for (const [placeholder, value] of Object.entries(placeholders)) {
            // 为分布式占位符添加服务器来源标识
            this.staticPlaceholderValues.set(placeholder, { value: value, serverId: serverId });

            if (this.debugMode) {
                console.log(`[PluginManager] Updated distributed placeholder ${placeholder} from ${serverName}: ${value.substring(0, 100)}${value.length > 100 ? '...' : ''}`);
            }
        }

        // 强制日志记录分布式静态占位符更新
        console.log(`[PluginManager] Updated ${Object.keys(placeholders).length} static placeholders from distributed server ${serverName}.`);
    }

























    // 新增：清理分布式静态占位符
    clearDistributedStaticPlaceholders(serverId) {
        const placeholdersToRemove = [];

        for (const [placeholder, entry] of this.staticPlaceholderValues.entries()) {
            if (entry && entry.serverId === serverId) {
                placeholdersToRemove.push(placeholder);
            }
        }

        for (const placeholder of placeholdersToRemove) {
            this.staticPlaceholderValues.delete(placeholder);
            if (this.debugMode) {
                console.log(`[PluginManager] Removed distributed placeholder ${placeholder} from disconnected server ${serverId}`);
            }
        }

        if (placeholdersToRemove.length > 0) {
            console.log(`[PluginManager] Cleared ${placeholdersToRemove.length} static placeholders from disconnected server ${serverId}.`);
        }
    }






































    // --- 新增方法 ---
    async hotReloadPluginsAndOrder() {
        console.log('[PluginManager] Hot reloading plugins and preprocessor order...');
        // 重新加载所有插件，这将自动应用新的顺序
        await this.loadPlugins();
        console.log('[PluginManager] Hot reload complete.');
        return this.getPreprocessorOrder();
    }




















    getPreprocessorOrder() {
        // 返回所有已发现、已排序的预处理器信息
        return this.preprocessorOrder.map(name => {
            const manifest = this.plugins.get(name);
            return {
                name: name,
                displayName: manifest ? manifest.displayName : name,
                description: manifest ? manifest.description : 'N/A'
            };
        });
    }


















    startPluginWatcher() {
        if (this.debugMode) console.log('[PluginManager] Starting plugin file watcher...');

        const pathsToWatch = [
            path.join(PLUGIN_DIR, '**/plugin-manifest.json'),
            path.join(PLUGIN_DIR, '**/plugin-manifest.json.block')
        ];

        const watcher = chokidar.watch(pathsToWatch, {
            persistent: true,
            ignoreInitial: true, // Don't fire on initial scan
            awaitWriteFinish: {
                stabilityThreshold: 500,
                pollInterval: 100
            }
        });

        watcher
            .on('add', filePath => this.handlePluginManifestChange('add', filePath))
            .on('change', filePath => this.handlePluginManifestChange('change', filePath))
            .on('unlink', filePath => this.handlePluginManifestChange('unlink', filePath));

        console.log(`[PluginManager] Chokidar is now watching for manifest changes in: ${PLUGIN_DIR}`);
    }


















    handlePluginManifestChange(eventType, filePath) {
        if (this.isReloading) {
            if (this.debugMode) console.log(`[PluginManager] Already reloading, skipping event '${eventType}' for: ${filePath}`);
            return;
        }

        clearTimeout(this.reloadTimeout);

        if (this.debugMode) console.log(`[PluginManager] Debouncing plugin reload trigger due to '${eventType}' event on: ${path.basename(filePath)}`);

        this.reloadTimeout = setTimeout(async () => {
            this.isReloading = true;
            console.log(`[PluginManager] Manifest file change detected ('${eventType}'). Hot-reloading plugins...`);

            try {
                await this.loadPlugins();
                console.log('[PluginManager] Hot-reload complete.');

                if (this.webSocketServer && typeof this.webSocketServer.broadcastToAdminPanel === 'function') {
                    this.webSocketServer.broadcastToAdminPanel({
                        type: 'plugins-reloaded',
                        message: 'Plugin list has been updated due to file changes.'
                    });
                    if (this.debugMode) console.log('[PluginManager] Notified admin panel about plugin reload.');
                }
            } catch (error) {
                console.error('[PluginManager] Error during hot-reload:', error);
            } finally {
                this.isReloading = false;
            }
        }, 500); // 500ms debounce window
    }


}










const pluginManager = new PluginManager();



// 2. 在 VCP 架构中的用途
// 这个函数通常被用于以下两个场景：

// Web 管理面板(Admin Panel) 的状态监控：

// 当你打开 VCP 的管理后台，查看“系统变量”或“调试”页面时，后台需要列出当前所有可用的变量（时间、天气、热搜等）及其当前值。

// 这个函数就是后端 API 调用的接口，它把内存里乱七八糟的数据整理好，发送给前端展示。

// 调试与日志(ShowVCP 模式)：

// 当开启 ShowVCP = true 调试模式时，系统可能会打印当前所有变量的状态，帮助开发者排查为什么某个插件（比如 WeatherReporter）没有正确更新天气信息。
// 新增：获取所有静态占位符值


pluginManager.getAllPlaceholderValues = function () {
    const valuesMap = new Map();
    //获得所有静态占位符的值 
    for (const [key, entry] of this.staticPlaceholderValues.entries()) {
        // Sanitize the key to remove legacy brackets for consistency
        const sanitizedKey = key.replace(/^{{|}}$/g, '');

        let value;
        // Handle modern object format
        if (typeof entry === 'object' && entry !== null && entry.hasOwnProperty('value')) {
            value = entry.value;
            // Handle legacy raw string format
        } else if (typeof entry === 'string') {
            value = entry;
        } else {
            // Fallback for any other unexpected format
            value = `[Invalid format for placeholder ${sanitizedKey}]`;
        }

        valuesMap.set(sanitizedKey, value || `[Placeholder ${sanitizedKey} has no value]`);
    }
    return valuesMap;
};



module.exports = pluginManager;
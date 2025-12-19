# DailyHot 插件 - 详细架构文档

## 📋 目录
1. [插件概述](#插件概述)
2. [项目结构](#项目结构)
3. [VCP系统调用流程](#vcp系统调用流程)
4. [核心代码详解](#核心代码详解)
5. [爬虫知识与技术](#爬虫知识与技术)
6. [数据流转过程](#数据流转过程)

---

## 插件概述

DailyHot 是一个**静态类型(static)插件**，用于周期性获取各大主流平台的热榜信息，并通过占位符 `{{VCPDailyHot}}` 提供给 VCP 系统。

### 核心特性
- 🔄 **周期性更新**: 通过 Cron 表达式 `0 */4 * * *` 每4小时自动更新一次
- 🌐 **多平台支持**: 支持50+个平台（微博、知乎、B站、GitHub等）
- 💾 **智能缓存**: 支持 Redis + NodeCache 双层缓存机制
- 🚀 **并发请求**: 使用 Promise.allSettled 并发获取所有数据源
- 📝 **Markdown输出**: 生成结构化的 Markdown 格式热榜

---

## 项目结构

```
DailyHot/
├── plugin-manifest.json          # 插件配置清单（VCP系统识别插件的入口）
├── daily-hot.js                  # 主入口文件（执行逻辑）
├── dailyhot_cache.md             # 缓存文件（存储上次获取的热榜数据）
├── dist/
│   ├── config.js                 # 全局配置（超时时间、缓存TTL等）
│   ├── routes/                   # 各平台爬虫实现
│   │   ├── weibo.js             # 微博热搜榜
│   │   ├── bilibili.js          # B站热榜
│   │   ├── zhihu.js             # 知乎热榜
│   │   ├── github.js            # GitHub Trending
│   │   └── ... (50+个平台)
│   └── utils/                    # 工具函数
│       ├── getData.js           # HTTP请求封装（GET/POST）
│       ├── cache.js             # 缓存管理（Redis + NodeCache）
│       ├── getTime.js           # 时间格式化
│       ├── getNum.js            # 数字格式化
│       ├── logger.js            # 日志工具
│       └── getToken/            # 各平台Token获取
│           ├── bilibili.js      # B站WBI签名
│           ├── coolapk.js       # 酷安Token
│           └── ...
└── 我的readme.md                 # 本文档
```

### 关键文件夹说明

#### 📄 `plugin-manifest.json` - 插件身份证
这是VCP系统识别插件的核心文件，定义了插件的元数据和行为：
- **name**: 插件唯一标识符（`DailyHot`）
- **pluginType**: `static` 表示静态类型插件
- **entryPoint**: `{ type: "nodejs", command: "node daily-hot.js" }` 定义如何启动插件
- **communication.protocol**: `stdio` 表示通过标准输入输出与VCP通信
- **refreshIntervalCron**: Cron表达式，定义自动刷新的时间间隔
- **capabilities.systemPromptPlaceholders**: 声明占位符 `{{VCPDailyHot}}`

#### 📂 `dist/routes/` - 爬虫路由目录
每个文件对应一个平台的爬虫实现，都遵循统一接口：
```javascript
exports.handleRoute = async (req, noCache) => {
    // 返回统一格式的数据
    return {
        name: "平台名",
        title: "显示标题",
        type: "榜单类型",
        data: [{ id, title, url, hot, ... }]
    }
}
```

#### 🛠️ `dist/utils/` - 工具函数库
- **getData.js**: 封装了 axios 的 HTTP 请求，自动处理缓存
- **cache.js**: 双层缓存（Redis优先，降级到NodeCache）
- **getToken/**: 处理需要签名/认证的平台（如B站的WBI签名）

---

## VCP系统调用流程

### 1️⃣ **插件发现阶段**（Plugin Discovery）
```
VCPToolBox启动
    ↓
PluginManager.loadPlugins()
    ↓
扫描 Plugin/ 目录
    ↓
读取 DailyHot/plugin-manifest.json
    ↓
识别 pluginType: "static"
    ↓
注册到 plugins Map
```

**关键代码位置**: `VCPToolBox/Plugin.js:16-31`

### 2️⃣ **定时调度阶段**（Scheduled Execution）
```
PluginManager 读取 refreshIntervalCron: "0 */4 * * *"
    ↓
使用 node-schedule 创建定时任务
    ↓
每4小时触发一次 _updateStaticPluginValue(plugin)
    ↓
调用 _executeStaticPluginCommand(plugin)
```

**关键代码位置**: `VCPToolBox/Plugin.js:122-186`

### 3️⃣ **命令执行阶段**（Command Execution）
```
spawn("node", ["daily-hot.js"], { cwd: pluginBasePath })
    ↓
启动子进程，执行 daily-hot.js
    ↓
监听 stdout (标准输出)
    ↓
设置超时 120000ms (2分钟)
    ↓
收集输出数据
```

**通信协议**: stdio（标准输入输出）
- VCP通过 `stdout` 读取插件输出
- 插件通过 `process.stdout.write()` 返回数据

### 4️⃣ **占位符更新阶段**（Placeholder Update）
```
_updateStaticPluginValue() 获取到输出
    ↓
遍历 capabilities.systemPromptPlaceholders
    ↓
更新 staticPlaceholderValues Map
    ↓
占位符 {{VCPDailyHot}} -> 热榜Markdown数据
```

**关键代码位置**: `VCPToolBox/Plugin.js:188-200`

### 5️⃣ **使用阶段**（Usage in System Prompt）
```
用户发送消息
    ↓
消息处理器替换占位符
    ↓
{{VCPDailyHot}} -> "# 每日热榜综合\n\n## 微博 - 热搜榜\n1. ..."
    ↓
包含热榜数据的 System Prompt 发送给 AI
```

---

## 核心代码详解

### 🎯 主入口文件 `daily-hot.js`

#### **整体流程**
```javascript
(async () => {
    // 1. 设置超时保护（30秒）
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Internal script timeout')), INTERNAL_TIMEOUT_MS)
    );

    // 2. 竞速执行：数据获取 vs 超时
    const result = await Promise.race([
        fetchAndProcessData(),  // 获取数据
        timeoutPromise          // 超时保护
    ]);

    // 3. 处理结果
    if (result.success) {
        output = result.data;   // 使用新数据
    } else {
        output = await readCacheOnError();  // 降级到缓存
    }

    // 4. 输出到 stdout（VCP系统通过这里获取数据）
    process.stdout.write(output, () => {
        process.exit(0);
    });
})();
```

#### **数据获取函数 `fetchAndProcessData()`**
```javascript
async function fetchAndProcessData() {
    // 1. 扫描所有路由文件
    const routesDir = path.join(__dirname, 'dist', 'routes');
    const files = await fs.readdir(routesDir);
    const allSources = files.filter(file => file.endsWith('.js'))
                           .map(file => path.basename(file, '.js'));

    // 2. 并发请求所有数据源（性能优化关键）
    const promises = allSources.map(source => fetchSource(source));
    const results = await Promise.allSettled(promises);

    // 3. 收集成功的结果
    results.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            allResults.push(...result.value);
        }
    });

    // 4. 按分类分组
    const groupedByCategory = allResults.reduce((acc, item) => {
        if (!acc[item.category]) acc[item.category] = [];
        acc[item.category].push(item);
        return acc;
    }, {});

    // 5. 生成 Markdown 输出
    let markdownOutput = "# 每日热榜综合\n\n";
    for (const category in groupedByCategory) {
        markdownOutput += `## ${category}\n\n`;
        groupedByCategory[category].forEach((item, index) => {
            markdownOutput += `${index + 1}. [${item.title}](${item.url})\n`;
        });
        markdownOutput += `\n`;
    }

    // 6. 写入缓存
    await fs.writeFile(CACHE_FILE_PATH, markdownOutput, 'utf-8');

    return { success: true, data: markdownOutput };
}
```

**关键技术点**：
- **Promise.allSettled**: 即使部分平台失败也不影响其他平台
- **动态加载路由**: 自动发现 `dist/routes/` 下的所有爬虫
- **缓存降级**: 获取失败时自动使用缓存数据

#### **单个平台抓取 `fetchSource(source)`**
```javascript
async function fetchSource(source) {
    // 1. 动态加载路由处理器
    const routePath = path.join(__dirname, 'dist', 'routes', `${source}.js`);
    const routeHandler = require(routePath);

    // 2. 调用路由处理器（传入 noCache=true 强制刷新）
    const resultData = await routeHandler.handleRoute({}, true);

    // 3. 标准化数据格式
    return resultData.data.map(item => ({
        category: item.category || `${resultData.title} - ${resultData.type}`,
        title: item.title,
        url: item.url
    }));
}
```

---

### 🌐 路由示例 `dist/routes/weibo.js`

#### **微博热搜榜实现**
```javascript
const handleRoute = async (_, noCache) => {
    // 1. 获取列表数据
    const listData = await getList(noCache);

    // 2. 返回标准格式
    return {
        name: "weibo",
        title: "微博",
        type: "热搜榜",
        description: "实时热点，每分钟更新一次",
        link: "https://s.weibo.com/top/summary/",
        total: listData.data?.length || 0,
        ...listData,  // 包含 data 数组
    };
};

const getList = async (noCache) => {
    // 1. 定义API地址
    const url = `https://weibo.com/ajax/side/hotSearch`;

    // 2. 通过 getData 工具获取数据（自动缓存）
    const result = await get({
        url,
        noCache,    // 是否跳过缓存
        ttl: 60     // 缓存时间60秒（热搜变化快）
    });

    // 3. 解析响应数据
    const list = result.data.data.realtime;

    // 4. 数据转换与标准化
    return {
        fromCache: result.fromCache,      // 是否来自缓存
        updateTime: result.updateTime,    // 更新时间
        data: list.map((v) => ({
            id: v.mid,
            title: v.word,                // 热搜词
            desc: v.note || `#${v.word}`,
            author: v.flag_desc,          // 标签（如"热"、"新"）
            timestamp: getTime(v.onboard_time),
            hot: v.num,                   // 热度值
            url: `https://s.weibo.com/weibo?q=${encodeURIComponent(key)}`,
            mobileUrl: `https://s.weibo.com/weibo?q=${encodeURIComponent(key)}`
        }))
    };
};
```

**爬虫要点**：
- **API识别**: 微博使用 `/ajax/side/hotSearch` 接口
- **数据映射**: 将平台字段映射到统一格式
- **URL编码**: 使用 `encodeURIComponent` 处理特殊字符

---

### 🔧 工具函数 `dist/utils/getData.js`

#### **HTTP请求封装**
```javascript
const request = axios.create({
    timeout: config.REQUEST_TIMEOUT,      // 6000ms 超时
    withCredentials: true,                // 携带Cookie
    headers: {
        'User-Agent': 'Mozilla/5.0 ...'   // 模拟浏览器
    }
});

// GET请求函数
const get = async (options) => {
    const { url, headers, params, noCache, ttl = 3600 } = options;

    // 1. 检查缓存
    if (noCache) {
        await delCache(url);
    } else {
        const cachedData = await getCache(url);
        if (cachedData) {
            console.log("💾 [CACHE] The request is cached");
            return {
                fromCache: true,
                updateTime: cachedData.updateTime,
                data: cachedData.data
            };
        }
    }

    // 2. 发起请求
    const response = await request.get(url, { headers, params });
    const responseData = response?.data || response;

    // 3. 存储缓存
    const updateTime = new Date().toISOString();
    await setCache(url, { data: responseData, updateTime }, ttl);

    // 4. 返回数据
    return { fromCache: false, updateTime, data: responseData };
};
```

**设计亮点**：
- **缓存优先**: 减少请求次数，避免被封IP
- **超时控制**: 6秒超时防止长时间等待
- **错误隔离**: 单个平台失败不影响其他平台

---

### 💾 缓存管理 `dist/utils/cache.js`

#### **双层缓存架构**
```javascript
// 1. Redis缓存（优先级高，跨进程共享）
const redis = new Redis({
    host: config.REDIS_HOST,
    port: config.REDIS_PORT,
    password: config.REDIS_PASSWORD,
    retryStrategy: (times) => Math.min(times * 50, 2000)
});

// 2. NodeCache缓存（备用，进程内存）
const cache = new NodeCache({
    stdTTL: config.CACHE_TTL,   // 默认3600秒
    checkperiod: 600,           // 10分钟检查一次过期
    useClones: false,           // 性能优化
    maxKeys: 100                // 最多100个键
});

// 获取缓存逻辑
const getCache = async (key) => {
    // 1. 优先尝试Redis
    if (isRedisAvailable) {
        try {
            const redisResult = await redis.get(key);
            if (redisResult) {
                return parse(redisResult);  // 使用flatted解析循环引用
            }
        } catch (error) {
            console.error('Redis获取失败，降级到NodeCache');
        }
    }

    // 2. 降级到NodeCache
    return cache.get(key);
};
```

**缓存策略**：
- **Redis优先**: 支持分布式部署，多实例共享缓存
- **自动降级**: Redis不可用时自动切换到NodeCache
- **过期清理**: 定期清理过期缓存，节省内存

---

### 🔑 B站爬虫特殊处理 `dist/routes/bilibili.js`

B站有**风控机制**，需要WBI签名才能访问API：

```javascript
const getList = async (options, noCache) => {
    const { type } = options;

    // 1. 获取WBI签名参数（反爬虫关键）
    const wbiData = await getBilibiliToken();

    // 2. 构造带签名的URL
    const url = `https://api.bilibili.com/x/web-interface/ranking/v2?rid=${type}&type=all&${wbiData}`;

    // 3. 设置完整的浏览器Headers（模拟真实浏览器）
    const result = await get({
        url,
        headers: {
            'Referer': 'https://www.bilibili.com/ranking/all',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ...',
            'Accept': 'text/html,application/xhtml+xml,...',
            'Sec-Ch-Ua': '"Google Chrome";v="123"',
            'Sec-Fetch-Dest': 'document',
            // ... 完整的浏览器指纹
        },
        noCache: false
    });

    // 4. 检查是否触发风控
    if (result.data?.data?.list?.length > 0) {
        console.log('bilibili 新接口正常');
        return processNewApi(result);
    } else {
        // 5. 降级到备用接口
        console.log('bilibili 触发风控，使用备用接口');
        return processBackupApi();
    }
};
```

**反爬虫对策**：
- **WBI签名**: B站特有的签名算法（在 `utils/getToken/bilibili.js` 实现）
- **完整Headers**: 模拟真实浏览器的所有特征
- **备用接口**: 主接口失败时自动切换

---

## 爬虫知识与技术

### 🎯 爬虫基础概念

#### **什么是爬虫？**
爬虫（Web Scraper）是自动化获取网页数据的程序。本插件使用的是**API爬虫**（而非HTML解析）：
- **优势**: 数据结构化、速度快、不易出错
- **劣势**: API可能变更、需要处理反爬虫

#### **本项目的爬虫类型**
1. **公开API爬虫**（如微博、知乎）
   - 直接请求JSON接口
   - 无需登录即可访问

2. **需签名API爬虫**（如B站、酷安）
   - 需要计算签名参数
   - 模拟APP或浏览器行为

3. **RSS爬虫**（部分平台）
   - 使用 `utils/parseRSS.js` 解析
   - 标准化格式，易于处理

---

### 🛡️ 反爬虫技术与应对

#### **1. User-Agent检测**
**原理**: 服务器检查请求头中的User-Agent，拒绝非浏览器请求

**应对**:
```javascript
headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
}
```

#### **2. Referer检测**
**原理**: 检查请求来源，防止外部盗链

**应对**:
```javascript
headers: {
    'Referer': 'https://www.bilibili.com/ranking/all'
}
```

#### **3. 请求频率限制**
**原理**: 同一IP短时间内请求过多会被封禁

**应对**:
- **缓存**: 使用Redis/NodeCache减少请求
- **TTL设置**: 不同平台设置不同缓存时间（微博60秒，其他3600秒）
- **并发控制**: 使用 Promise.allSettled 而非 Promise.all，失败不影响其他

#### **4. 签名验证（WBI签名）**
**原理**: 请求参数需要用密钥计算签名，防止参数篡改

**应对**: 参考 `utils/getToken/bilibili.js`
```javascript
// 简化的WBI签名流程
async function getBilibiliToken() {
    // 1. 获取签名密钥
    const keys = await fetchWbiKeys();

    // 2. 对参数排序并拼接
    const sortedParams = Object.keys(params).sort().map(k => `${k}=${params[k]}`);

    // 3. 计算MD5签名
    const sign = md5(sortedParams.join('&') + keys.wbi_sign);

    // 4. 返回带签名的查询字符串
    return `${sortedParams.join('&')}&sign=${sign}`;
}
```

#### **5. Cookie验证**
**原理**: 需要登录态才能访问完整数据

**应对**:
```javascript
// 知乎需要Cookie才能获取完整热榜
headers: {
    Cookie: config.ZHIHU_COOKIE  // 从配置文件读取
}
```

---

### 📊 数据处理技巧

#### **1. 统一数据格式**
不同平台返回的数据结构不同，需要标准化：
```javascript
// 原始数据（微博）
{
    "mid": "12345",
    "word": "热搜标题",
    "num": 1234567
}

// 标准化后
{
    "id": "12345",
    "title": "热搜标题",
    "hot": 1234567,
    "url": "https://...",
    "category": "微博 - 热搜榜"
}
```

#### **2. 错误处理**
```javascript
try {
    const routeHandler = require(routePath);
    const resultData = await routeHandler.handleRoute({}, true);

    // 验证数据格式
    if (!resultData || !Array.isArray(resultData.data)) {
        return { source, error: '返回的数据格式不正确' };
    }

    return resultData.data.map(...);
} catch (e) {
    console.error(`处理 '${source}' 数据时发生错误: ${e.message}`);
    return { source, error: `处理数据时发生错误: ${e.message}` };
}
```

#### **3. 并发优化**
```javascript
// ❌ 错误：顺序执行，耗时 = 平台数 × 单次耗时
for (const source of allSources) {
    await fetchSource(source);
}

// ✅ 正确：并发执行，耗时 ≈ 最慢的单次耗时
const promises = allSources.map(source => fetchSource(source));
const results = await Promise.allSettled(promises);
```

---

### 🔍 爬虫调试技巧

#### **1. 查看原始响应**
```javascript
// 在 getData.js 中添加日志
console.log('Response:', JSON.stringify(response.data, null, 2));
```

#### **2. 检查Headers**
```javascript
// 查看请求是否正确发送
request.interceptors.request.use((config) => {
    console.log('Request Headers:', config.headers);
    return config;
});
```

#### **3. 缓存调试**
```javascript
// 强制跳过缓存
await getData({ url, noCache: true });

// 清除特定缓存
await delCache('https://weibo.com/ajax/side/hotSearch');
```

#### **4. 单独测试路由**
```javascript
// 在命令行运行
node -e "
const handler = require('./dist/routes/weibo.js');
handler.handleRoute({}, true).then(console.log);
"
```

---

## 数据流转过程

### 完整数据流程图

```
┌─────────────────────────────────────────────────────────────┐
│                    VCP 系统启动                              │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  PluginManager 扫描 Plugin/ 目录                             │
│  ├─ 读取 plugin-manifest.json                                │
│  ├─ 识别 pluginType: "static"                                │
│  └─ 注册定时任务: "0 */4 * * *" (每4小时)                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  定时任务触发 (Cron: 每4小时)                                │
│  └─ PluginManager._updateStaticPluginValue()                 │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  执行插件命令                                                 │
│  spawn("node", ["daily-hot.js"], {                           │
│      cwd: "f:/VCP/VCPToolBox/Plugin/DailyHot",               │
│      timeout: 120000  // 2分钟超时                           │
│  })                                                          │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  daily-hot.js 主流程                                         │
│  ├─ 1. 扫描 dist/routes/ 目录                                │
│  │     └─ 发现 50+ 个平台文件 (weibo.js, bilibili.js, ...)   │
│  ├─ 2. 并发请求所有平台                                       │
│  │     ├─ Promise.allSettled([                               │
│  │     │     fetchSource('weibo'),                           │
│  │     │     fetchSource('bilibili'),                        │
│  │     │     fetchSource('zhihu'),                           │
│  │     │     ... (50+个)                                     │
│  │     └─ ])                                                 │
│  ├─ 3. 收集成功结果                                           │
│  ├─ 4. 按分类分组                                             │
│  └─ 5. 生成 Markdown 输出                                     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  单个平台抓取流程 (以微博为例)                                │
│  ├─ require('./dist/routes/weibo.js')                        │
│  ├─ routeHandler.handleRoute({}, true)                       │
│  │     ├─ getList(noCache)                                   │
│  │     │     ├─ getData.get({                                │
│  │     │     │     url: 'https://weibo.com/ajax/side/...',   │
│  │     │     │     noCache: true,                            │
│  │     │     │     ttl: 60                                   │
│  │     │     │   })                                          │
│  │     │     │     ├─ 检查缓存 (cache.getCache)              │
│  │     │     │     ├─ 发起HTTP请求 (axios.get)               │
│  │     │     │     └─ 存储缓存 (cache.setCache)              │
│  │     │     └─ 数据转换 .map(v => ({                        │
│  │     │           id: v.mid,                                │
│  │     │           title: v.word,                            │
│  │     │           url: '...',                               │
│  │     │           category: '微博 - 热搜榜'                  │
│  │     │         }))                                         │
│  │     └─ return { data: [...] }                             │
│  └─ 返回 [{ category, title, url }, ...]                     │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  缓存处理 (utils/cache.js)                                   │
│  ├─ 尝试从 Redis 获取                                         │
│  │     ├─ 成功 ✓ → 返回缓存数据                               │
│  │     └─ 失败 ✗ → 降级到 NodeCache                           │
│  └─ NodeCache 查找                                            │
│        ├─ 命中 → 返回缓存                                     │
│        └─ 未命中 → 返回 null (触发实际请求)                    │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  HTTP请求 (utils/getData.js)                                 │
│  ├─ axios.get(url, { headers, timeout: 6000 })               │
│  ├─ 成功响应 → 解析JSON                                       │
│  ├─ 存储到缓存 (TTL: 60秒~3600秒)                            │
│  └─ 返回 { fromCache: false, data, updateTime }              │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  数据汇总与格式化 (daily-hot.js)                              │
│  ├─ 按 category 分组                                          │
│  │     {                                                     │
│  │       "微博 - 热搜榜": [{ title, url }, ...],              │
│  │       "知乎 - 热榜": [{ title, url }, ...],                │
│  │       ...                                                 │
│  │     }                                                     │
│  ├─ 生成 Markdown                                             │
│  │     # 每日热榜综合                                          │
│  │                                                            │
│  │     ## 微博 - 热搜榜                                        │
│  │     1. [热搜1](url1)                                       │
│  │     2. [热搜2](url2)                                       │
│  │     ...                                                   │
│  ├─ 写入缓存文件 (dailyhot_cache.md)                          │
│  └─ 返回 Markdown 字符串                                      │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  输出到 stdout                                                │
│  process.stdout.write(markdownOutput, () => {                │
│      process.exit(0);                                        │
│  });                                                         │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  PluginManager 接收输出                                       │
│  ├─ 监听子进程 stdout                                          │
│  ├─ 收集完整输出                                               │
│  └─ output = "# 每日热榜综合\n\n## ..."                       │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  更新占位符                                                    │
│  staticPlaceholderValues.set(                                 │
│      "{{VCPDailyHot}}",                                       │
│      output  // Markdown格式的热榜数据                         │
│  )                                                            │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  用户发送消息                                                  │
│  └─ "帮我看看今天的热点"                                       │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  消息处理器                                                    │
│  ├─ 替换占位符                                                 │
│  │     System Prompt: "你是VCP助手... {{VCPDailyHot}}"        │
│  │     ↓                                                     │
│  │     System Prompt: "你是VCP助手...                         │
│  │                     # 每日热榜综合                          │
│  │                     ## 微博 - 热搜榜                        │
│  │                     1. [xxx](url)                         │
│  │                     ..."                                  │
│  └─ 发送给 AI 模型                                             │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  AI 响应                                                      │
│  └─ "根据最新热榜,今天的热点主要是..."                         │
└─────────────────────────────────────────────────────────────┘
```

---

### 关键时间节点

| 阶段 | 耗时 | 说明 |
|------|------|------|
| **插件启动** | 0-1秒 | spawn子进程 |
| **并发请求** | 5-30秒 | 取决于网络和平台数量 |
| **数据处理** | 0.5-2秒 | JSON解析、分组、Markdown生成 |
| **写入缓存** | 0.1秒 | 文件IO |
| **总耗时** | 10-60秒 | 通常30秒内完成 |
| **超时限制** | 120秒 | 超时则返回缓存数据 |

---

### 缓存策略详解

#### **三级缓存架构**
```
Level 1: Redis缓存 (分布式共享)
    ├─ TTL: 3600秒 (1小时)
    ├─ 跨进程访问
    └─ 持久化存储
        ↓ (降级)
Level 2: NodeCache (进程内存)
    ├─ TTL: 3600秒
    ├─ 最大100个键
    └─ 快速访问
        ↓ (降级)
Level 3: dailyhot_cache.md (文件缓存)
    ├─ 永久存储
    ├─ 失败时最后防线
    └─ 插件重启后可用
```

#### **缓存更新时机**
```javascript
// 定时更新 (每4小时)
refreshIntervalCron: "0 */4 * * *"
    ↓
fetchSource(source, noCache=true)  // 强制刷新
    ↓
旧缓存失效 → 发起新请求 → 更新所有三级缓存
```

---

## 总结

### 🎯 核心亮点
1. **模块化设计**: 每个平台独立文件，易于维护和扩展
2. **智能缓存**: 三级缓存架构，性能与可靠性兼顾
3. **并发优化**: Promise.allSettled实现高效并发
4. **容错机制**: 单个平台失败不影响整体，自动降级到缓存
5. **反爬虫对策**: 完整的Headers模拟、签名计算、频率控制

### 📚 学习价值
- **Node.js进程间通信**: stdio协议的实践
- **爬虫技术**: API爬虫、反爬虫、缓存策略
- **异步编程**: Promise并发控制、错误处理
- **系统设计**: 插件化架构、占位符系统

### 🔧 扩展建议
1. **添加新平台**: 在 `dist/routes/` 下新建文件，实现 `handleRoute` 接口
2. **自定义缓存时间**: 修改各路由的 `ttl` 参数
3. **启用Redis**: 配置 `REDIS_HOST`、`REDIS_PORT` 环境变量
4. **调整更新频率**: 修改 `refreshIntervalCron` (Cron表达式)

---

**文档版本**: v1.0
**最后更新**: 2025-11-27
**作者**: Claude Code + Kilo Code & Roo

const path = require('path');
const fs = require('fs').promises;

// 定义缓存文件路径，位于当前插件目录下的 dailyhot_cache.md
const CACHE_FILE_PATH = path.join(__dirname, 'dailyhot_cache.md');
// 定义整个脚本的最大运行时间（90秒），给网络请求足够时间
// 50+个平台并发请求，30秒太短了，改为90秒
//me ai建议90秒
const INTERNAL_TIMEOUT_MS = 90000;


//这是最底层的“工兵”函数，负责加载并执行具体的抓取逻辑（比如抓知乎、抓微博）。

//me  它接收一个 source 名称，动态加载对应的路由模块，执行抓取，并返回标准化的数据格式。
async function fetchSource(source) {
    let routeHandler;
    try {
        // 动态加载：根据 source 名称（如 'zhihu'）去 dist/routes/ 下找对应的 js 文件
        // 注意：你之前遇到的 'chalk' 缺失错误，通常就是在这里 require 具体路由文件时，
        // 那个路由文件内部引用了 chalk 导致的。
        const routePath = path.join(__dirname, 'dist', 'routes', `${source}.js`);
        routeHandler = require(routePath);
    } catch (e) {
        // 模块加载失败（比如文件不存在或依赖缺失），记录错误但不崩贵
        console.error(`[DailyHot] 加载 '${source}' 模块失败: ${e.message}`);
        return { source, error: `模块加载失败: ${e.message}` };
    }
    // 防御性编程：确保加载的模块里真的有 handleRoute 这个函数
    if (typeof routeHandler.handleRoute !== 'function') {
        return { source, error: `模块未导出 'handleRoute' 函数` };
    }

    try {
        // 创建一个模拟的请求对象，模拟 Hono 框架的 context 对象
        // 很多路由需要 c.req.query() 方法来获取参数，我们提供一个返回 undefined 的假方法
        //me ai的意思是要加一个req 而不是直接传空对象
        const mockContext = {
            req: {
                query: (key) => undefined  // 返回 undefined，让路由使用默认值
            }
        };
        const resultData = await routeHandler.handleRoute(mockContext, true);


        //const resultData = await routeHandler.handleRoute({}, true);

        if (!resultData || !Array.isArray(resultData.data)) {
            return { source, error: `返回的数据格式不正确` };
        }
        const title = resultData.title || source.charAt(0).toUpperCase() + source.slice(1);
        // 数据清洗与标准化
        // 如果源没有提供标题，就用文件名首字母大写代替
        const type = resultData.type || '热榜';
        const defaultCategory = `${title} - ${type}`;
        // 映射数据：只保留我们需要的三要素：分类、标题、链接
        return resultData.data.map(item => ({
            // 如果条目自带分类，则使用自带的，否则使用默认分类
            category: item.category || defaultCategory,
            title: item.title,
            url: item.url
        }));
    } catch (e) {
        //这里有问题
        console.error(`[DailyHot] 处理 '${source}' 数据时发生错误: ${e.message}`);
        return { source, error: `处理数据时发生错误: ${e.message}` };
    }
}


//这个函数负责调度所有工兵，并发执行，然后汇总结果。
async function fetchAndProcessData() {
    let allSources = [];
    try {
        // 1. 扫描 dist/routes 目录，自动发现所有可用的数据源
        const routesDir = path.join(__dirname, 'dist', 'routes');
        const files = await fs.readdir(routesDir);
        // 过滤出 .js 文件并去掉后缀，得到源列表 ['zhihu', 'weibo', ...]
        allSources = files.filter(file => file.endsWith('.js')).map(file => path.basename(file, '.js'));
    } catch (e) {
        console.error(`[DailyHot] 无法读取数据源目录: ${e.message}`);
        return { success: false, data: null, error: e };
    }

    if (allSources.length === 0) {
        console.error('[DailyHot] 在 dist/routes 目录中没有找到任何数据源。');
        return { success: false, data: null, error: new Error('No sources found') };
    }

    const allResults = [];
    // 2. 将所有源映射为 Promise 任务
    const promises = allSources.map(source => fetchSource(source));
    // 3. 关键并发：使用 Promise.allSettled 而不是 Promise.all
    // 这意味着：即使微博抓取失败了，也不会影响知乎的结果。所有任务都会执行完。
    const results = await Promise.allSettled(promises);
    // 4. 处理结果
    results.forEach(result => {
        if (result.status === 'fulfilled' && Array.isArray(result.value)) {
            // 成功的，加入总结果池
            allResults.push(...result.value);
        } else if (result.status === 'fulfilled' && result.value.error) {
            console.error(`[DailyHot] 获取源失败: ${result.value.source} - ${result.value.error}`);
        } else if (result.status === 'rejected') {
            console.error(`[DailyHot] Promise for a source was rejected:`, result.reason);
        }
    });

    if (allResults.length > 0) {
        // 5. 生成 Markdown
        let markdownOutput = "# 每日热榜综合\n\n";
        const groupedByCategory = allResults.reduce((acc, item) => {
            if (!acc[item.category]) acc[item.category] = [];
            acc[item.category].push(item);
            return acc;
        }, {});

        for (const category in groupedByCategory) {
            markdownOutput += `## ${category}\n\n`;
            groupedByCategory[category].forEach((item, index) => {
                markdownOutput += `${index + 1}. [${item.title}](${item.url})\n`;
            });
            markdownOutput += `\n`;
        }
        // 6. 写入缓存：即使下次断网，也能用这份旧数据
        try {
            await fs.writeFile(CACHE_FILE_PATH, markdownOutput, 'utf-8');
            console.log(`[DailyHot] 成功更新缓存文件: ${CACHE_FILE_PATH}`);
        } catch (e) {
            console.error(`[DailyHot] 写入缓存文件失败: ${e.message}`);
        }
        return { success: true, data: markdownOutput, error: null };
    } else {
        return { success: false, data: null, error: new Error('Failed to fetch data from any source') };
    }
}
//当所有抓取都失败，或者脚本超时时，调用此函数读取上次成功的缓存文件。
async function readCacheOnError() {
    try {
        const cachedData = await fs.readFile(CACHE_FILE_PATH, 'utf-8');
        console.log(`[DailyHot] 成功从缓存文件 ${CACHE_FILE_PATH} 提供数据。`);
        return cachedData;
    } catch (e) {
        const errorMessage = '# 每日热榜\n\n获取热榜数据失败，且本地无可用缓存。';
        console.error(`[DailyHot] 读取缓存文件失败: ${e.message}`);
        return errorMessage;
    }
}



//这是脚本实际运行的地方，包含了一个超时竞态机制。
(async () => {
    // 创建一个 30秒 后自动 Reject 的 Promise
    const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Internal script timeout')), INTERNAL_TIMEOUT_MS)
    );

    let output;
    try {
        // Promise.race：抓取任务 vs 超时计时器，谁先完成算谁的
        const result = await Promise.race([
            fetchAndProcessData(),
            timeoutPromise
        ]);

        if (result.success) {
            output = result.data;
        } else {
            console.error(`[DailyHot] Fetch and process failed: ${result.error.message}. Falling back to cache.`);
            output = await readCacheOnError();
        }
    } catch (e) {
        console.error(`[DailyHot] Operation timed out or failed critically: ${e.message}. Falling back to cache.`);
        output = await readCacheOnError();
    }
    // 最终输出！
    // VCP 的 PluginManager 会监听 stdout，把这里打印的内容作为占位符 {{VCPDailyHot}} 的值
    process.stdout.write(output, () => {
        // Ensure all output is written before exiting.
        process.exit(0);
    });
})();
// modules/tvsManager.js
// 引入文件系统（Promise版），用于异步读取文件
const fs = require('fs').promises;
// 引入路径处理模块，确保在 Windows/Linux 下路径拼接不出错
const path = require('path');
// 引入 chokidar，这是一个比 Node 原生 fs.watch 更强大、更稳定的文件监听库
const chokidar = require('chokidar');
// 定义 TVS 文件的根目录
const TVS_DIR = path.join(__dirname, '..', 'TVStxt');

class TvsManager {
    constructor() {
        // 结构：{ 'lore.txt': '很久很久以前...', 'rules.txt': '第一条...' }
        this.contentCache = new Map();
        this.debugMode = false;
    }
    // 初始化函数，通常在服务器启动时调用

    initialize(debugMode = false) {
        this.debugMode = debugMode;
        console.log('[TvsManager] Initializing...');// 系统启动日志
        // 启动文件监听器，开始盯着文件夹
        this.watchFiles();
    }
    // 【核心逻辑】文件监听器（管理员盯着书架）
    watchFiles() {
        try {
            // 使用 chokidar 监视 TVS_DIR 文件夹
            const watcher = chokidar.watch(TVS_DIR, {
                ignored: /(^|[\/\\])\../,// 忽略点开头的文件（如 .DS_Store, .gitkeep 隐藏文件）
                persistent: true,// 持续监听，不要退出的
                ignoreInitial: true, // 启动时不触发 'add' 事件（因为刚启动缓存本来就是空的，不需要清空）
            });

            watcher
                // 监听 'change' 事件：文件被修改了
                .on('change', (filePath) => {
                    const filename = path.basename(filePath); // 从完整路径提取文件名 (例如 "myLore.txt")
                    // 如果缓存里有这个文件的数据，说明它过期了
                    if (this.contentCache.has(filename)) {
                        this.contentCache.delete(filename);// ❌ 立即删除旧缓存
                        console.log(`[TvsManager] Cache for '${filename}' cleared due to file change.`);
                    }
                    // 注意：这里删掉缓存后，不急着去读新内容。
                    // 采用“懒加载”策略：等下一次有人真正请求这个文件时，再去读取最新的。
                })
                // 监听 'unlink' 事件：文件被删除了
                .on('unlink', (filePath) => {
                    const filename = path.basename(filePath);
                    if (this.contentCache.has(filename)) {
                        this.contentCache.delete(filename); // ❌ 删除缓存
                        console.log(`[TvsManager] Cache for '${filename}' cleared due to file deletion.`);
                    }
                    
                })
                .on('error', (error) => console.error(`[TvsManager] Watcher error: ${error}`));

            if (this.debugMode) {
                console.log(`[TvsManager] Watching for changes in: ${TVS_DIR}`);
            }
        } catch (error) {
            console.error(`[TvsManager] Failed to set up file watcher:`, error);
        }
    }
    // 【业务接口】获取文件内容（读者来借书了）
    // 输入 filename: "world_setting.txt"
    // 返回: 文件里的文本内容
    async getContent(filename) {
        if (this.contentCache.has(filename)) {
            if (this.debugMode) {
                console.log(`[TvsManager] Cache hit for '${filename}'.`);
            }
            return this.contentCache.get(filename);
        }
        // 2. 缓存没命中（可能是第一次读取，或者文件刚被修改过导致缓存被清空）
        if (this.debugMode) {
            console.log(`[TvsManager] Cache miss for '${filename}'. Reading from disk.`);
        }

        try {
            const filePath = path.join(TVS_DIR, filename);
            // 3. 硬盘读取（IO操作，相对较慢，毫秒级）
            const content = await fs.readFile(filePath, 'utf8');
            // 4. 读取成功后，存入缓存！下次就快了
            this.contentCache.set(filename, content);
            return content;
        } catch (error) {
            // 错误处理
            // 注意：不要缓存错误！如果这次读取失败（比如文件被占用），不应该把错误存进 Map。
            // 这样下次请求时，还会尝试重新读取，也许那时候文件就好了。
            // Don't cache errors, so it can be retried if the file appears later.
            console.error(`[TvsManager] Error reading file '${filename}':`, error.message);
            if (error.code === 'ENOENT') {
                return `[变量文件 (${filename}) 未找到]`;
            }
            return `[处理变量文件 (${filename}) 时出错]`;
        }
    }
}
// 单例模式 (Singleton Pattern)
// 直接导出一个 new 出来的实例。
// 这意味着整个 VCPToolBox 程序里，只有一个 TvsManager 实例，
// 所有的请求都共享同一个缓存池 contentCache。
const tvsManager = new TvsManager();
module.exports = tvsManager;
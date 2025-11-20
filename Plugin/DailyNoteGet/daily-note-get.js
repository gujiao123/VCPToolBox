const fs = require('fs').promises;
const path = require('path');

// 1. 确定工作路径
// 获取主程序传入的项目根目录。如果没有传，就用当前脚本往上两级目录作为兜底。
// 目标目录是：projectBasePath/dailynote
const projectBasePath = process.env.PROJECT_BASE_PATH;
const dailyNoteRootPath = projectBasePath ? path.join(projectBasePath, 'dailynote') : path.join(__dirname, '..', '..', 'dailynote'); // Fallback if env var not set
// 2. 调试模式配置
// 从环境变量读取 DebugMode，如果是 "true" 则开启日志
const DEBUG_MODE = (process.env.DebugMode || "false").toLowerCase() === "true";

function debugLog(message, ...args) {
    if (DEBUG_MODE) {
        // 注意：这里用 console.error 而不是 console.log
        // 为什么要用 stderr？因为 stdout (标准输出) 被用来传输最终的 JSON 数据。
        // 如果把调试信息打印到 stdout，会破坏 JSON 格式，导致主程序解析失败。
        console.error(`[DailyNoteGet][Debug] ${message}`, ...args); // Log debug to stderr
    }
}
// --- 核心函数：获取所有角色日记 ---
async function getAllCharacterDiaries() {
    const allDiaries = {};// 最终结果容器，格式 { "小雨": "内容...", "Jack": "内容..." }
    debugLog(`Starting diary scan in: ${dailyNoteRootPath}`);

    try {
        // 3. 读取根目录下的所有子文件夹（每个文件夹代表一个角色）
        // withFileTypes: true 让我们可以直接判断是不是目录
        const characterDirs = await fs.readdir(dailyNoteRootPath, { withFileTypes: true });

        for (const dirEntry of characterDirs) {
            if (dirEntry.isDirectory()) {
                const characterName = dirEntry.name;// 文件夹名就是角色名
                const characterDirPath = path.join(dailyNoteRootPath, characterName);
                let characterDiaryContent = '';
                debugLog(`Scanning directory for character: ${characterName}`);

                try {
                    // 4. 读取角色文件夹下的所有文件
                    const files = await fs.readdir(characterDirPath);
                    // 5. 过滤文件：只要 .txt 和 .md
                    const relevantFiles = files.filter(file => {
                        const lowerCaseFile = file.toLowerCase();
                        return lowerCaseFile.endsWith('.txt') || lowerCaseFile.endsWith('.md');
                    }).sort();// 排序，保证日记按文件名顺序拼接（比如 2023-10-01.txt 在 2023-10-02.txt 前面）
                    debugLog(`Found ${relevantFiles.length} relevant files (.txt, .md) for ${characterName}`);

                    if (relevantFiles.length > 0) {
                        // 6. 并发读取所有日记文件的内容
                        const fileContents = await Promise.all(
                            relevantFiles.map(async (file) => {
                                const filePath = path.join(characterDirPath, file);
                                try {
                                    const content = await fs.readFile(filePath, 'utf-8');
                                    debugLog(`Read content from ${file} (length: ${content.length})`);
                                    return content;
                                } catch (readErr) {
                                    console.error(`[DailyNoteGet] Error reading diary file ${filePath}:`, readErr.message);
                                    return `[Error reading file: ${file}]`; // Include error marker in content
                                }
                            })
                        );
                        // 7. 拼接内容
                        // 使用分割线 "\n\n---\n\n" 将不同文件的日记隔开
                        // Combine content with separators, similar to server.js logic
                        characterDiaryContent = fileContents.join('\n\n---\n\n');
                    } else {
                        characterDiaryContent = `[${characterName}日记本内容为空]`; // Explicitly state if empty
                        debugLog(`No .txt or .md files found for ${characterName}, setting content to empty marker.`);
                    }
                } catch (charDirError) {
                    console.error(`[DailyNoteGet] Error reading character directory ${characterDirPath}:`, charDirError.message);
                    characterDiaryContent = `[Error reading ${characterName}'s diary directory]`;
                }
                // 8. 存入大对象
                //me 现在的 allDiaries 结构是 { "小雨": "内容...", "Jack": "内容..." }
                allDiaries[characterName] = characterDiaryContent;
            }
        }
        debugLog(`Finished diary scan. Found diaries for ${Object.keys(allDiaries).length} characters.`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.error(`[DailyNoteGet] Error: Daily note root directory not found at ${dailyNoteRootPath}`);
        } else {
            console.error(`[DailyNoteGet] Error reading daily note root directory ${dailyNoteRootPath}:`, error.message);
        }
        // Output empty JSON if root directory fails
        return '{}';
    }

    // 9. 返回最终的 JSON 字符串
    return JSON.stringify(allDiaries);
}
// --- 脚本入口 ---
(async () => {
    try {
        const resultJsonString = await getAllCharacterDiaries();
        process.stdout.write(resultJsonString); // Write JSON string to stdout
        debugLog('Successfully wrote diary JSON to stdout.');
    } catch (e) {
        console.error("[DailyNoteGet] Fatal error during execution:", e);
        // Output empty JSON on fatal error to prevent breaking PluginManager
        process.stdout.write('{}');
        process.exit(1); // Exit with error code
    }
})();
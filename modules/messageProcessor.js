// modules/messageProcessor.js
const fs = require('fs').promises;
const path = require('path');
const lunarCalendar = require('chinese-lunar-calendar');
const agentManager = require('./agentManager.js'); // 引入新的Agent管理器
const tvsManager = require('./tvsManager.js'); // 引入新的TVS管理器

const DEFAULT_TIMEZONE = process.env.DEFAULT_TIMEZONE || 'Asia/Shanghai';
const REPORT_TIMEZONE = process.env.REPORT_TIMEZONE || 'Asia/Shanghai'; // 新增：用于控制 AI 报告的时间，默认回退到中国时区
const AGENT_DIR = path.join(__dirname, '..', 'Agent');
const TVS_DIR = path.join(__dirname, '..', 'TVStxt');
const VCP_ASYNC_RESULTS_DIR = path.join(__dirname, '..', 'VCPAsyncResults');

async function resolveAllVariables(text, model, role, context, processingStack = new Set()) {
    // 1. 基础防错：如果文本是 null/undefined，返回空字符串
    if (text == null) return '';
    let processedText = String(text);

    // 通用正则表达式，匹配所有 {{...}} 格式的占位符
    const placeholderRegex = /\{\{([a-zA-Z0-9_:]+)\}\}/g;
    const matches = [...processedText.matchAll(placeholderRegex)];

    // 3. 提取并标准化别名
    // match[1] 是花括号里面的内容。
    // .replace(/^agent:/, '') 的作用是归一化：把 {{agent:Alice}} 和 {{Alice}} 都视为 "Alice"
    const allAliases = new Set(matches.map(match => match[1].replace(/^agent:/, '')));
    // 4. 遍历所有发现的变量名
    for (const alias of allAliases) {
        // 关键：使用 agentManager 来判断这是否是一个真正的Agent
        if (agentManager.isAgent(alias)) {
            if (processingStack.has(alias)) {
                console.error(`[AgentManager] Circular dependency detected! Stack: [${[...processingStack].join(' -> ')} -> ${alias}]`);
                const errorMessage = `[Error: Circular agent reference detected for '${alias}']`;
                processedText = processedText.replaceAll(`{{${alias}}}`, errorMessage).replaceAll(`{{agent:${alias}}}`, errorMessage);
                continue;// 跳过当前 Agent，继续下一个
            }
            // 6. 获取 Agent 的原始内容 (Prompt)
            const agentContent = await agentManager.getAgentPrompt(alias);

            processingStack.add(alias);
            // 【核心】：Agent 的内容里可能还包含其他变量，所以递归调用 resolveAllVariables 自身！
            // 注意把 processingStack 传下去，保持状态
            const resolvedAgentContent = await resolveAllVariables(agentContent, model, role, context, processingStack);
            processingStack.delete(alias);

            // 替换两种可能的Agent占位符格式
            // 8. 文本替换
            // 将解析好的内容填回去。支持两种写法：{{Name}} 和 {{agent:Name}}
            processedText = processedText.replaceAll(`{{${alias}}}`, resolvedAgentContent);
            processedText = processedText.replaceAll(`{{agent:${alias}}}`, resolvedAgentContent);
        }
    }

    // 在所有Agent都被递归展开后，处理剩余的非Agent占位符
    processedText = await replacePriorityVariables(processedText, context, role);
    processedText = await replaceOtherVariables(processedText, model, role, context);

    return processedText;
}

async function replaceOtherVariables(text, model, role, context) {
    const { pluginManager, cachedEmojiLists, detectors, superDetectors, DEBUG_MODE } = context;
    if (text == null) return '';
    let processedText = String(text);

    if (role === 'system') {
        for (const envKey in process.env) {
            if (envKey.startsWith('Tar') || envKey.startsWith('Var')) {
                const placeholder = `{{${envKey}}}`;
                if (processedText.includes(placeholder)) {
                    const value = process.env[envKey];
                    if (value && typeof value === 'string' && value.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(value);
                        // 检查内容是否表示错误
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            processedText = processedText.replaceAll(placeholder, fileContent);
                        } else {
                            const resolvedContent = await replaceOtherVariables(fileContent, model, role, context);
                            processedText = processedText.replaceAll(placeholder, resolvedContent);
                        }
                    } else {
                        processedText = processedText.replaceAll(placeholder, value || `[未配置 ${envKey}]`);
                    }
                }
            }
        }

        let sarPromptToInject = null;
        const modelToPromptMap = new Map();
        for (const envKey in process.env) {
            if (/^SarModel\d+$/.test(envKey)) {
                const index = envKey.substring(8);
                const promptKey = `SarPrompt${index}`;
                let promptValue = process.env[promptKey];
                const models = process.env[envKey];

                if (promptValue && models) {
                    if (typeof promptValue === 'string' && promptValue.toLowerCase().endsWith('.txt')) {
                        const fileContent = await tvsManager.getContent(promptValue);
                        // 检查内容是否表示错误
                        if (fileContent.startsWith('[变量文件') || fileContent.startsWith('[处理变量文件')) {
                            promptValue = fileContent;
                        } else {
                            promptValue = await replaceOtherVariables(fileContent, model, role, context);
                        }
                    }
                    const modelList = models.split(',').map(m => m.trim()).filter(m => m);
                    for (const m of modelList) {
                        modelToPromptMap.set(m, promptValue);
                    }
                }
            }
        }

        if (model && modelToPromptMap.has(model)) {
            sarPromptToInject = modelToPromptMap.get(model);
        }

        const sarPlaceholderRegex = /\{\{Sar[a-zA-Z0-9_]+\}\}/g;
        if (sarPromptToInject !== null) {
            processedText = processedText.replaceAll(sarPlaceholderRegex, sarPromptToInject);
        } else {
            processedText = processedText.replaceAll(sarPlaceholderRegex, '');
        }

        const now = new Date();
        if (DEBUG_MODE) {
            console.log(`[TimeVar] Raw Date: ${now.toISOString()}`);
            console.log(`[TimeVar] Default Timezone (for internal use): ${DEFAULT_TIMEZONE}`);
            console.log(`[TimeVar] Report Timezone (for AI prompt): ${REPORT_TIMEZONE}`);
        }
        // 使用 REPORT_TIMEZONE 替换时间占位符
        const date = now.toLocaleDateString('zh-CN', { timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Date\}\}/g, date);
        const time = now.toLocaleTimeString('zh-CN', { timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Time\}\}/g, time);
        const today = now.toLocaleDateString('zh-CN', { weekday: 'long', timeZone: REPORT_TIMEZONE });
        processedText = processedText.replace(/\{\{Today\}\}/g, today);
        const year = now.getFullYear();
        const month = now.getMonth() + 1;
        const day = now.getDate();
        const lunarDate = lunarCalendar.getLunar(year, month, day);
        let yearName = lunarDate.lunarYear.replace('年', '');
        let festivalInfo = `${yearName}${lunarDate.zodiac}年${lunarDate.dateStr}`;
        if (lunarDate.solarTerm) festivalInfo += ` ${lunarDate.solarTerm}`;
        processedText = processedText.replace(/\{\{Festival\}\}/g, festivalInfo);

        const staticPlaceholderValues = pluginManager.getAllPlaceholderValues(); // Use the getter
        if (staticPlaceholderValues && staticPlaceholderValues.size > 0) {
            for (const [placeholder, value] of staticPlaceholderValues.entries()) {
                const placeholderRegex = new RegExp(placeholder.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'g');
                // The getter now returns the correct string value
                processedText = processedText.replace(placeholderRegex, value || `[${placeholder} 信息不可用]`);
            }
        }

        const individualPluginDescriptions = pluginManager.getIndividualPluginDescriptions();
        if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
            for (const [placeholderKey, description] of individualPluginDescriptions) {
                processedText = processedText.replaceAll(`{{${placeholderKey}}}`, description || `[${placeholderKey} 信息不可用]`);
            }
        }

        if (processedText.includes('{{VCPAllTools}}')) {
            const vcpDescriptionsList = [];
            if (individualPluginDescriptions && individualPluginDescriptions.size > 0) {
                for (const description of individualPluginDescriptions.values()) {
                    vcpDescriptionsList.push(description);
                }
            }
            const allVcpToolsString = vcpDescriptionsList.length > 0 ? vcpDescriptionsList.join('\n\n---\n\n') : '没有可用的VCP工具描述信息';
            processedText = processedText.replaceAll('{{VCPAllTools}}', allVcpToolsString);
        }

        if (process.env.PORT) {
            processedText = processedText.replaceAll('{{Port}}', process.env.PORT);
        }
        const effectiveImageKey = pluginManager.getResolvedPluginConfigValue('ImageServer', 'Image_Key');
        if (processedText && typeof processedText === 'string' && effectiveImageKey) {
            processedText = processedText.replaceAll('{{Image_Key}}', effectiveImageKey);
        } else if (processedText && typeof processedText === 'string' && processedText.includes('{{Image_Key}}')) {
            if (DEBUG_MODE) console.warn('[replaceOtherVariables] {{Image_Key}} placeholder found in text, but ImageServer plugin or its Image_Key is not resolved. Placeholder will not be replaced.');
        }
        for (const rule of detectors) {
            if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
                processedText = processedText.replaceAll(rule.detector, rule.output);
            }
        }
    }

    for (const rule of superDetectors) {
        if (typeof rule.detector === 'string' && rule.detector.length > 0 && typeof rule.output === 'string') {
            processedText = processedText.replaceAll(rule.detector, rule.output);
        }
    }

    const asyncResultPlaceholderRegex = /\{\{VCP_ASYNC_RESULT::([a-zA-Z0-9_.-]+)::([a-zA-Z0-9_-]+)\}\}/g;
    let asyncMatch;
    let tempAsyncProcessedText = processedText;
    const promises = [];

    while ((asyncMatch = asyncResultPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = asyncMatch[0];
        const pluginName = asyncMatch[1];
        const requestId = asyncMatch[2];

        promises.push(
            (async () => {
                const resultFilePath = path.join(VCP_ASYNC_RESULTS_DIR, `${pluginName}-${requestId}.json`);
                try {
                    const fileContent = await fs.readFile(resultFilePath, 'utf-8');
                    const callbackData = JSON.parse(fileContent);
                    let replacementText = `[任务 ${pluginName} (ID: ${requestId}) 已完成]`;
                    if (callbackData && callbackData.message) {
                        replacementText = callbackData.message;
                    } else if (callbackData && callbackData.status === 'Succeed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 已成功完成。详情: ${JSON.stringify(callbackData.data || callbackData.result || callbackData)}`;
                    } else if (callbackData && callbackData.status === 'Failed') {
                        replacementText = `任务 ${pluginName} (ID: ${requestId}) 处理失败。原因: ${callbackData.reason || JSON.stringify(callbackData.data || callbackData.error || callbackData)}`;
                    }
                    tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, replacementText);
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[任务 ${pluginName} (ID: ${requestId}) 结果待更新...]`);
                    } else {
                        console.error(`[replaceOtherVariables] Error processing async placeholder ${placeholder}:`, error);
                        tempAsyncProcessedText = tempAsyncProcessedText.replace(placeholder, `[获取任务 ${pluginName} (ID: ${requestId}) 结果时出错]`);
                    }
                }
            })()
        );
    }

    await Promise.all(promises);
    processedText = tempAsyncProcessedText;

    return processedText;
}

async function replacePriorityVariables(text, context, role) {
    const { pluginManager, cachedEmojiLists, DEBUG_MODE } = context;
    if (text == null) return '';
    //me processedText 就是人物设定{{某某日记本}}这样的文本
    let processedText = String(text);

    // 只在 system role 中处理
    if (role !== 'system') {
        return processedText;
    }

    // --- 表情包处理 ---
    const emojiPlaceholderRegex = /\{\{(.+?表情包)\}\}/g;
    let emojiMatch;
    while ((emojiMatch = emojiPlaceholderRegex.exec(processedText)) !== null) {
        const placeholder = emojiMatch[0];
        const emojiName = emojiMatch[1];
        const emojiList = cachedEmojiLists.get(emojiName);
        processedText = processedText.replaceAll(placeholder, emojiList || `[${emojiName}列表不可用]`);
    }

    // --- 日记本处理 (已修复循环风险) ---
    //处理{{这样的日记本}}占位符
    const diaryPlaceholderRegex = /\{\{(.+?)日记本\}\}/g;
    let allDiariesData = {};
    // 4.1 获取总账本
    // 向 PluginManager 索要那个包含了所有角色日记的 JSON 字符串 (就是上一个问题里那个脚本生成的)
    const allDiariesDataString = pluginManager.getPlaceholderValue("{{AllCharacterDiariesData}}");
    // 4.2 解析 JSON
    // 检查拿到的数据是不是有效的 JSON 字符串，而不是 "[Placeholder...]" 这种未初始化的占位符
    if (allDiariesDataString && !allDiariesDataString.startsWith("[Placeholder")) {
        try {
            // 把字符串解析成 JS 对象：{ "小雨日记本": "内容...", "Alice日记本": "内容..." }
            //!! 注意现在还是文件夹名字为key
            allDiariesData = JSON.parse(allDiariesDataString);
        } catch (e) {
            console.error(`[replacePriorityVariables] Failed to parse AllCharacterDiariesData JSON: ${e.message}. Data: ${allDiariesDataString.substring(0, 100)}...`);
        }
    } else if (allDiariesDataString && allDiariesDataString.startsWith("[Placeholder")) {
        if (DEBUG_MODE) console.warn(`[replacePriorityVariables] Placeholder {{AllCharacterDiariesData}} not found or not yet populated. Value: ${allDiariesDataString}`);
    }

    // === 4.3 安全替换策略 (防止死循环) ===

    // 步骤 1：扫描并去重
    // 使用 matchAll 找出文本中所有的日记标签，然后用 Set 去重。
    // 结果示例：matches=['{{小雨日记本}}', '{{Alice日记本}}']
    // [
    //     // 第一个匹配项：{{可可的知识}}
    //     [
    //         "{{可可的知识}}",    // 下标 0: 匹配到的完整字符串
    //         "可可的知识",       // 下标 1: 捕获组的内容（去掉了花括号，正是你需要的 key）
    //         index: 4,           // 匹配开始的索引位置
    //         input: "我正在看{{可可的知识}}的日记...", // 原始文本
    //         groups: undefined   // 命名捕获组（通常未定义）
    //     ],

    //     // 第二个匹配项：{{Jack}}
    //     [
    //         "{{Jack}}",         // 下标 0
    //         "Jack",             // 下标 1
    //         index: 18,
    //         input: "我正在看{{可可的知识}}的日记...",
    //         groups: undefined
    //     ]
    // ]
    const matches = [...processedText.matchAll(diaryPlaceholderRegex)];
    //me uniquePlaceholders=['{{小雨日记本}}', '{{Alice日记本}}']
    const uniquePlaceholders = [...new Set(matches.map(match => match[0]))];

    // 步骤 2：遍历去重后的清单进行替换
    // 注意：这里遍历的是 uniquePlaceholders 这个固定的数组，而不是在 processedText 上做 while 循环查找。
    for (const placeholder of uniquePlaceholders) {
        // Extract character name from placeholder like "{{小雨日记本}}" -> "小雨"\
        //me 拿到你本地文件夹的名字 必须是{{某某日记本}}这样的文件夹名字  卧槽我在agent里面定义的时候必须是某某日记本才能匹配成功
        //!!比如{{jack日记本}}
        //!!只需要agent里面提示词 有{{Nova日记本}} 并创建了对应的{{Nova日记本}}这样的文件夹就行了
        //?文件夹的名字必须是 Nova，而不能是 Nova日记本。
        //@characterNameMatch =[
        //         "{{可可日记本}}", // 第 0 项：完整的匹配结果
        //             "可可",          // 第 1 项：捕获组 (.+?) 提取出的内容
        //             index: 0,
        //                 input: "{{可可日记本}}",
        //                     groups: undefined
        // ]
        const characterNameMatch = placeholder.match(/\{\{(.+?)日记本\}\}/);


        if (characterNameMatch && characterNameMatch[1]) {
            //me characterName 就是 可可 这样的名字
            const characterName = characterNameMatch[1];
            // 准备替换内容，默认是空提示
            let diaryContent = `[${characterName}日记本内容为空或未从插件获取]`;

            // 如果总账本里有这个人的日记，就取出来
            if (allDiariesData.hasOwnProperty(characterName)) {
                diaryContent = allDiariesData[characterName];
            }
            // Replace all instances of this specific placeholder.
            // This is safe because we are iterating over a pre-determined list, not re-scanning the string.
            processedText = processedText.replaceAll(placeholder, diaryContent);
        }
    }

    return processedText;
}

module.exports = {
    // 导出主函数，并重命名旧函数以供内部调用
    replaceAgentVariables: resolveAllVariables,
    replaceOtherVariables,
    replacePriorityVariables
};
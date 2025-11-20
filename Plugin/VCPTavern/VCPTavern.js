// VCPTavern.js
const fs = require('fs').promises;
const path = require('path');
const express = require('express');
//me 定义预设文件存储的目录，位于当前插件目录下的 'presets' 文件夹
const PRESETS_DIR = path.join(__dirname, 'presets');

class VCPTavern {
    constructor() {
        this.presets = new Map();
        this.debugMode = false;
    }

    async initialize(config) {
        this.debugMode = config.DebugMode || false;
        await this._loadPresets();
        console.log('[VCPTavern] 插件已初始化。');
    }
    //me 内部方法：加载预设文件夹中的所有 .json 文件
    async _loadPresets() {
        try {
            // 确保目录存在，如果不存在则创建（recursive: true）
            await fs.mkdir(PRESETS_DIR, { recursive: true });
            const presetFiles = await fs.readdir(PRESETS_DIR);
            this.presets.clear();
            for (const file of presetFiles) {
                if (file.endsWith('.json')) {
                    // 解析 JSON 并存入 Map
                    const presetName = path.basename(file, '.json');
                    try {
                        const content = await fs.readFile(path.join(PRESETS_DIR, file), 'utf-8');
                        this.presets.set(presetName, JSON.parse(content));
                        if (this.debugMode) console.log(`[VCPTavern] 已加载预设: ${presetName}`);
                    } catch (e) {
                        console.error(`[VCPTavern] 加载预设文件失败 ${file}:`, e);
                    }
                }
            }
        } catch (error) {
            console.error('[VCPTavern] 加载预设目录失败:', error);
        }
    }

    // 作为 messagePreprocessor 的核心方法
    // --- 核心逻辑区 ---
    // 这是一个消息预处理器。在发送给 AI 之前，拦截并修改消息列表。
    async processMessages(messages, config) {
        // 1. 基础校验：如果没有消息，直接返回
        if (!messages || messages.length === 0) return messages;
        // 2. 寻找 System Message（系统提示词），通常是规则定义的地方
        const systemMessage = messages.find(m => m.role === 'system');
        if (!systemMessage || typeof systemMessage.content !== 'string') {
            return messages;
        }
        // 3. 检测触发器：正则匹配 {{VCPTavern::预设名}}
        const triggerRegex = /\{\{VCPTavern::(.+?)\}\}/;
        const match = systemMessage.content.match(triggerRegex);
        // 如果没匹配到触发器，原样返回，不做任何修改
        if (!match) {
            return messages;
        }
        // 4. 获取预设名并清理标签
        const presetName = match[1];
        // 从 System Prompt 中删掉这个标签，避免 AI 看到乱码
        systemMessage.content = systemMessage.content.replace(triggerRegex, '').trim();
        if (this.debugMode) console.log(`[VCPTavern] 检测到触发器，使用预设: ${presetName}`);
        // 5. 从内存中获取预设内容
        const preset = this.presets.get(presetName);
        if (!preset || !Array.isArray(preset.rules)) {
            console.warn(`[VCPTavern] 预设 "${presetName}" 未找到或其 'rules' 格式无效。`);
            return messages;
        }
        // 复制一份消息数组，避免直接修改原始引用（虽然这里浅拷贝对象引用仍在，但对数组结构的修改是安全的）
        let newMessages = [...messages];

        // 6. 注入逻辑分类
        //先相对后深度
        // relativeRules: 相对注入（例如：插在 system 后面，或者最后一条 user 消息前面）
        const relativeRules = preset.rules.filter(r => r.enabled && r.type === 'relative').sort((a, b) => (a.position === 'before' ? -1 : 1));
        // depthRules: 深度注入（例如：插在倒数第 3 条消息位置）
        const depthRules = preset.rules.filter(r => r.enabled && r.type === 'depth').sort((a, b) => b.depth - a.depth);

        // === 处理相对注入 (Relative Injection) ===
        for (const rule of relativeRules) {
            const contentToInject = rule.content;
            if (rule.target === 'system') {
                const systemIndex = newMessages.findIndex(m => m.role === 'system');
                if (systemIndex !== -1) {
                    if (rule.position === 'before') {
                        newMessages.splice(systemIndex, 0, contentToInject);
                    } else { // after
                        newMessages.splice(systemIndex + 1, 0, contentToInject);
                    }
                }
            } else if (rule.target === 'last_user') {
                let lastUserIndex = -1;
                for (let i = newMessages.length - 1; i >= 0; i--) {
                    if (newMessages[i].role === 'user') {
                        lastUserIndex = i;
                        break;
                    }
                }
                if (lastUserIndex !== -1) {
                    if (rule.position === 'after') {
                        newMessages.splice(lastUserIndex + 1, 0, contentToInject);
                    } else { // before
                        newMessages.splice(lastUserIndex, 0, contentToInject);
                    }
                }
            }
        }

        // === 处理深度注入 (Depth Injection) ===
        for (const rule of depthRules) {
            if (rule.depth > 0) {
                // 如果消息长度足以支持深度注入，则按深度注入
                if (rule.depth < newMessages.length) {
                    const injectionIndex = newMessages.length - rule.depth;
                    newMessages.splice(injectionIndex, 0, rule.content);
                } else {
                    // 否则，作为兜底，注入到 system prompt 之后
                    const systemIndex = newMessages.findIndex(m => m.role === 'system');
                    if (systemIndex !== -1) {
                        newMessages.splice(systemIndex + 1, 0, rule.content);
                    }
                }
            }
        }

        if (this.debugMode) {
            console.log(`[VCPTavern] 原始消息数量: ${messages.length}, 注入后消息数量: ${newMessages.length}`);
        }

        return newMessages;
    }
    // --- API 路由区 ---
    // 注册 Express 路由，用于前端页面管理预设（增删改查）
    // 作为 service 插件的核心方法
    registerRoutes(app, adminApiRouter, config, projectBasePath) {
        const router = express.Router();
        // 允许较大的 JSON body，防止预设内容过多导致报错
        router.use(express.json({ limit: '10mb' }));

        // 获取所有预设名称
        router.get('/presets', (req, res) => {
            res.json(Array.from(this.presets.keys()));
        });

        // 获取特定预设的详细内容
        router.get('/presets/:name', (req, res) => {
            const preset = this.presets.get(req.params.name);
            if (preset) {
                res.json(preset);
            } else {
                res.status(404).json({ error: 'Preset not found' });
            }
        });

        // 保存/更新预设
        router.post('/presets/:name', async (req, res) => {
            const presetName = req.params.name.replace(/[^a-zA-Z0-9_-]/g, ''); // Sanitize
            if (!presetName) {
                return res.status(400).json({ error: 'Invalid preset name.' });
            }
            const presetData = req.body;
            try {
                const filePath = path.join(PRESETS_DIR, `${presetName}.json`);
                await fs.writeFile(filePath, JSON.stringify(presetData, null, 2));
                this.presets.set(presetName, presetData);
                if (this.debugMode) console.log(`[VCPTavern] 预设已保存: ${presetName}`);
                res.status(200).json({ message: 'Preset saved', name: presetName });
            } catch (error) {
                console.error(`[VCPTavern] 保存预设失败 ${presetName}:`, error);
                res.status(500).json({ error: 'Failed to save preset' });
            }
        });

        // 删除预设
        router.delete('/presets/:name', async (req, res) => {
            const presetName = req.params.name;
            try {
                const filePath = path.join(PRESETS_DIR, `${presetName}.json`);
                await fs.unlink(filePath);
                this.presets.delete(presetName);
                if (this.debugMode) console.log(`[VCPTavern] 预设已删除: ${presetName}`);
                res.status(200).json({ message: 'Preset deleted' });
            } catch (error) {
                if (error.code === 'ENOENT') {
                    return res.status(404).json({ error: 'Preset not found' });
                }
                console.error(`[VCPTavern] 删除预设失败 ${presetName}:`, error);
                res.status(500).json({ error: 'Failed to delete preset' });
            }
        });

        // 将路由挂载到传入的 adminApiRouter 上
        adminApiRouter.use('/vcptavern', router);

        if (this.debugMode) console.log('[VCPTavern] API 路由已通过 adminApiRouter 注册到 /vcptavern');
    }

    async shutdown() {
        console.log('[VCPTavern] 插件已卸载。');
    }
}
// 单例模式：创建实例
const vcPTavernInstance = new VCPTavern();
// 导出标准接口，供插件加载器调用
// 使得插件能被 Plugin.js 正确加载和初始化
module.exports = {
    initialize: (config) => vcPTavernInstance.initialize(config),
    processMessages: (messages, config) => vcPTavernInstance.processMessages(messages, config),
    registerRoutes: (app, adminApiRouter, config, projectBasePath) => vcPTavernInstance.registerRoutes(app, adminApiRouter, config, projectBasePath),
    shutdown: () => vcPTavernInstance.shutdown(),
};

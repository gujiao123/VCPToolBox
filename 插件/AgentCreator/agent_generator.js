const fs = require('fs').promises;
const path = require('path');

class AgentGenerator {
    constructor() {
        this.projectRoot = path.resolve(__dirname, '..', '..');
        this.agentDir = path.join(this.projectRoot, 'Agent');
        this.configPath = path.join(this.projectRoot, 'config.env');
        this.agentAssistantConfigPath = path.join(this.projectRoot, 'Plugin', 'AgentAssistant', 'config.env');
        this.roleTemplates = {
            'professional': { title: '专业顾问', characteristics: ['专业严谨', '逻辑清晰', '实践导向'], defaultPersonality: '专业,严谨,可靠' },
            'teacher': { title: '教师导师', characteristics: ['循循善诱', '因材施教', '富有耐心'], defaultPersonality: '耐心,启发,鼓励' },
            'assistant': { title: '生活助手', characteristics: ['细致周到', '温暖贴心', '实用至上'], defaultPersonality: '温暖,细心,实用' },
            'creative': { title: '创意伙伴', characteristics: ['天马行空', '灵感丰富', '勇于创新'], defaultPersonality: '创意,灵感,开放' },
            'analyst': { title: '分析专家', characteristics: ['深度思考', '数据驱动', '洞察敏锐'], defaultPersonality: '理性,深度,洞察' },
            'companion': { title: '陪伴伙伴', characteristics: ['善解人意', '情感丰富', '真诚关怀'], defaultPersonality: '温暖,共情,真诚' },
            'specialist': { title: '领域专家', characteristics: ['权威专业', '经验丰富', '前沿敏锐'], defaultPersonality: '权威,前沿,深度' },
            'coach': { title: '教练指导', characteristics: ['激励鼓舞', '目标导向', '行动驱动'], defaultPersonality: '激励,坚定,支持' },
            'consultant': { title: '咨询顾问', characteristics: ['战略思维', '解决方案', '客观中立'], defaultPersonality: '客观,战略,解决导向' }
        };
        this.interactionStyles = {
            'formal': { desc: '正式专业', tone: '使用专业术语和正式表达' },
            'friendly': { desc: '友善亲切', tone: '温暖友好，平易近人' },
            'humorous': { desc: '幽默风趣', tone: '适度幽默，轻松活泼' },
            'encouraging': { desc: '鼓励支持', tone: '积极正面，鼓舞人心' },
            'analytical': { desc: '分析理性', tone: '逻辑清晰，理性分析' },
            'creative': { desc: '创意发散', tone: '想象丰富，创意无限' }
        };
        this.expertiseTools = {
            '数据分析': ['VCPTavilySearch', 'VCPSciCalculator'], '编程开发': ['VCPTavilySearch', 'VCPUrlFetch'], '设计创意': ['VCPFluxGen', 'VCPTavilySearch'],
            '教学培训': ['VCPTavilySearch', 'VCPSciCalculator'], '健身运动': ['VCPTavilySearch', 'VCPWeatherInfo'], '心理咨询': ['VCPTavilySearch'],
            '医疗健康': ['VCPTavilySearch'], '投资理财': ['VCPTavilySearch', 'VCPSciCalculator'], '法律咨询': ['VCPTavilySearch'],
            '营销推广': ['VCPTavilySearch', 'VCPFluxGen'], '音乐艺术': ['VCPSunoGen', 'VCPTavilySearch'], '写作编辑': ['VCPTavilySearch'],
            '翻译语言': ['TranslateHelper', 'VCPTavilySearch'], '旅游规划': ['VCPTavilySearch', 'VCPWeatherInfo']
        };
    }

    generateAgent(params) {
        const { agent_name, display_name, role_type, expertise_area, model_id = 'gemini-2.5-flash', add_to_assistant = false, personality_traits = '', interaction_style = 'friendly', special_skills = '', target_audience = '通用用户', available_tools = '', background_story = '', catchphrase = '', include_examples = true, include_daily_note = true, include_vars = '' } = params;
        if (!agent_name || !display_name || !role_type || !expertise_area) throw new Error('Missing required params: agent_name, display_name, role_type, expertise_area');
        const roleTemplate = this.roleTemplates[role_type];
        if (!roleTemplate) throw new Error(`Unsupported role_type: ${role_type}`);
        const agentConfig = {
            name: agent_name, displayName: display_name, roleType: role_type, roleTitle: roleTemplate.title, expertiseArea: expertise_area,
            personality: (personality_traits || roleTemplate.defaultPersonality).split(',').map(t => t.trim()).filter(t => t),
            interactionStyle: interaction_style, specialSkills: special_skills ? special_skills.split(',').map(s => s.trim()).filter(s => s) : [],
            targetAudience: target_audience, availableTools: this.getRecommendedTools(expertise_area, available_tools), backgroundStory: background_story, catchphrase: catchphrase,
            characteristics: roleTemplate.characteristics, modelId: model_id
        };
        const agentContent = this.generateAgentFileContent(agentConfig, include_examples, include_daily_note, include_vars);
        return { config: agentConfig, content: agentContent, filename: `${agent_name}.txt`, configPath: `Agent${agent_name}=${agent_name}.txt` };
    }

    async generateAndSaveAgent(params) {
        const { auto_save = false, auto_update_config = false, add_to_assistant = false } = params;
        const result = this.generateAgent(params);
        let savedPath = null, configUpdated = false, assistantConfigUpdated = false, operationLog = [];
        if (auto_save) {
            try {
                savedPath = await this.saveAgentFile(result.filename, result.content);
                operationLog.push(`✅ Agent file saved: ${savedPath}`);
                if (auto_update_config) {
                    await this.updateMainConfig(result.config.name, result.filename, 'add');
                    configUpdated = true;
                    operationLog.push(`✅ Main config.env updated.`);
                }
                if (add_to_assistant) {
                    await this.updateAgentAssistantConfig(result.config, 'add');
                    assistantConfigUpdated = true;
                    operationLog.push(`✅ AgentAssistant config.env updated.`);
                }
            } catch (error) {
                operationLog.push(`❌ Operation failed: ${error.message}`);
            }
        }
        return { ...result, savedPath, configUpdated, assistantConfigUpdated, operationLog };
    }

    async deleteAgent(params) {
        const { agent_name } = params;
        if (!agent_name) throw new Error('Missing required param: agent_name');
        const filename = `${agent_name}.txt`;
        const agentFilePath = path.join(this.agentDir, filename);
        let operationLog = [];
        try {
            await fs.unlink(agentFilePath);
            operationLog.push(`✅ Agent file deleted: ${agentFilePath}`);
        } catch (error) {
            if (error.code === 'ENOENT') operationLog.push(`⚠️ Agent file not found: ${agentFilePath}`);
            else operationLog.push(`❌ Failed to delete agent file: ${error.message}`);
        }
        await this.updateMainConfig(agent_name, filename, 'remove').then(() => operationLog.push('✅ Main config.env updated.')).catch(e => operationLog.push(`❌ ${e.message}`));
        await this.updateAgentAssistantConfig({ name: agent_name }, 'remove').then(() => operationLog.push('✅ AgentAssistant config.env updated.')).catch(e => operationLog.push(`❌ ${e.message}`));
        return { operationLog, agentName: agent_name };
    }

    async updateMainConfig(agentName, filename, action) {
        let lines = [];
        try {
            lines = (await fs.readFile(this.configPath, 'utf-8')).split(/\r?\n/);
        } catch (error) {
            if (error.code === 'ENOENT') throw new Error('Main config.env not found.');
            throw error;
        }
        const configLine = `Agent${agentName}=${filename}`;
        const lineIndex = lines.findIndex(line => line.startsWith(`Agent${agentName}=`));
        if (action === 'add') {
            if (lineIndex !== -1) lines[lineIndex] = configLine;
            else {
                const sectionIndex = lines.findIndex(line => line.trim() === '# [Agent配置]');
                if (sectionIndex !== -1) lines.splice(sectionIndex + 1, 0, configLine);
                else lines.push(configLine);
            }
        } else { // remove
            if (lineIndex !== -1) lines.splice(lineIndex, 1);
        }
        await fs.writeFile(this.configPath, lines.join('\n'), 'utf-8');
    }

    async updateAgentAssistantConfig(agentConfig, action) {
        let lines = [];
        try {
            lines = (await fs.readFile(this.agentAssistantConfigPath, 'utf-8')).split(/\r?\n/);
        } catch (error) {
            if (error.code !== 'ENOENT' && action === 'add') throw new Error('AgentAssistant config.env not found.');
            else if (error.code !== 'ENOENT') throw error;
        }
        const startMarker = `# --- Agent: ${agentConfig.name} ---`;
        const endMarker = `# --- End Agent: ${agentConfig.name} ---`;
        const startIndex = lines.findIndex(line => line.trim() === startMarker);
        if (action === 'add') {
            const { name, displayName, modelId } = agentConfig;
            const baseName = name.toUpperCase();
            const newBlock = [startMarker, `AGENT_${baseName}_MODEL_ID="${modelId}"`, `AGENT_${baseName}_CHINESE_NAME="${displayName}"`, `AGENT_${baseName}_SYSTEM_PROMPT={{${name}}}`, `AGENT_${baseName}_MAX_OUTPUT_TOKENS=8000`, `AGENT_${baseName}_TEMPERATURE=0.7`, `AGENT_${baseName}_DESCRIPTION="由AgentGenerator自动生成的 ${displayName}。"`, endMarker];
            if (startIndex !== -1) {
                const endIndex = lines.findIndex((line, i) => i > startIndex && line.trim() === endMarker);
                lines.splice(startIndex, (endIndex > -1 ? endIndex - startIndex + 1 : 1), ...newBlock);
            } else {
                lines.push('', ...newBlock);
            }
        } else { // remove
            if (startIndex !== -1) {
                const endIndex = lines.findIndex((line, i) => i > startIndex && line.trim() === endMarker);
                lines.splice(startIndex, (endIndex > -1 ? endIndex - startIndex + 1 : 1));
            }
        }
        await fs.writeFile(this.agentAssistantConfigPath, lines.join('\n'), 'utf-8');
    }

    getRecommendedTools(expertiseArea, availableTools) {
        if (availableTools) return [...new Set(availableTools.split(',').map(t => t.trim()).filter(t => t))];
        for (const [area, tools] of Object.entries(this.expertiseTools)) {
            if (expertiseArea.includes(area)) return [...new Set(tools)];
        }
        return ['VCPTavilySearch'];
    }

    async saveAgentFile(filename, content) {
        await fs.mkdir(this.agentDir, { recursive: true }).catch(e => { throw new Error(`Failed to create agent directory: ${e.message}`) });
        await fs.writeFile(path.join(this.agentDir, filename), content, 'utf-8').catch(e => { throw new Error(`Failed to save agent file: ${e.message}`) });
        return path.join(this.agentDir, filename);
    }

    generateAgentFileContent(config, includeExamples, includeDailyNote, includeVars) {
        const { displayName, roleTitle, expertiseArea, personality, interactionStyle, specialSkills, targetAudience, availableTools, backgroundStory, catchphrase, characteristics } = config;
        let content = `# ${displayName} - ${roleTitle}\n\n你是一位${roleTitle}，名字叫\"${displayName}\"。你专精于${expertiseArea}，以${personality.join('、')}的特点为人所知。\n\n`;
        content += `## 核心身份\n- **姓名**: ${displayName}\n- **职业**: ${roleTitle}\n- **专长**: ${expertiseArea}\n- **性格**: ${personality.join('、')}\n- **服务对象**: ${targetAudience}\n\n`;
        if (specialSkills.length > 0) content += `## 专业技能\n${specialSkills.map(s => `- **${s}**: 提供专业的${s}服务`).join('\n')}\n\n`;
        content += `## 角色特征\n${characteristics.map((c, i) => `${i+1}. **${c}**: ${this.getCharacteristicDescription(c)}`).join('\n')}\n\n`;
        const styleInfo = this.interactionStyles[interactionStyle] || this.interactionStyles['friendly'];
        content += `## 交互风格\n你采用${styleInfo.desc}的交互方式，${styleInfo.tone}。在与用户交流时，你会${this.getInteractionDescription(interactionStyle)}。\n\n`;
        if (backgroundStory) content += `## 背景故事\n${backgroundStory}\n\n`;
        if (catchphrase) content += `## 座右铭\n\"${catchphrase}\"\n\n`;
        if (availableTools.length > 0) content += `## 可用工具\n${availableTools.map(t => `- **${t}**: ${this.getToolDescription(t)}`).join('\n')}\n\n`;
        content += `{{TarSysPrompt}}\n\n`;
        content += `## 工作流程\n当与用户交流时，我会：\n1. **理解需求**: 仔细倾听并理解用户的具体需要\n2. **专业分析**: 运用我的专业知识进行深入分析\n`;
        if (availableTools.includes('VCPTavilySearch')) content += `3. **信息查询**: 使用搜索工具获取最新相关信息\n`;
        content += `4. **解决方案**: 提供切实可行的解决方案或建议\n5. **跟进支持**: 确保用户满意并提供后续支持\n`;
        if (includeDailyNote) content += `6. **记录总结**: 将重要信息记录到日记中供后续参考\n`;
        content += `\n`;
        if (includeExamples) content += `## 服务示例\n${this.generateExamples(config)}\n`;
        content += `## 服务承诺\n我承诺：\n- 始终以用户需求为中心\n- 提供专业、准确的建议\n- 保持${personality.join('、')}的服务态度\n- 持续学习，不断提升服务质量\n\n`;
        content += this.generateClosingMessage(config);
        if (includeVars) content += `\n\n## 系统变量注入\n${includeVars.split(',').map(v => v.trim()).filter(v => v).map(v => `{{${v}}}`).join('\n')}`;
        return content;
    }

    getCharacteristicDescription(char) {
        const descs = { '专业严谨': '坚持专业标准', '循循善诱': '善于引导学习', '细致周到': '关注细节', '天马行空': '思维发散', '深度思考': '透过现象看本质', '善解人意': '理解用户情感', '权威专业': '具备权威知识', '激励鼓舞': '激发用户潜能', '战略思维': '从全局角度思考' };
        return `${descs[char] || '提供优质服务'}。`;
    }

    getInteractionDescription(style) {
        const descs = { 'formal': '保持专业表达', 'friendly': '以温暖友好的语调交流', 'humorous': '适当加入幽默元素', 'encouraging': '用积极正面的语言鼓励', 'analytical': '以逻辑清晰的方式分析', 'creative': '用富有创意的表达激发新思考' };
        return descs[style] || descs['friendly'];
    }

    getToolDescription(tool) {
        const descs = { 'VCPTavilySearch': '搜索最新信息', 'VCPSciCalculator': '进行科学计算', 'VCPFluxGen': '生成创意图片', 'VCPSunoGen': '创作音乐', 'VCPWeatherInfo': '获取天气预报', 'TranslateHelper': '提供多语言翻译', 'VCPUrlFetch': '获取网页内容', 'SystemMonitor': '监控系统状态', 'PasswordGenerator': '生成安全密码' };
        return descs[tool] || '专用工具';
    }

    generateExamples(config) {
        const { expertiseArea, roleType } = config;
        if (roleType === 'teacher') return `**教学指导示例**:\n用户: \"我想学习${expertiseArea}，但不知道从哪里开始？\"
我会: 评估用户基础，制定个性化学习计划，提供循序渐进的指导。\n\n`;
        if (roleType === 'professional' || roleType === 'consultant') return `**专业咨询示例**:\n用户: \"在${expertiseArea}方面遇到了问题，需要专业建议。\"
我会: 深入了解问题背景，运用专业知识分析，提供具体可行的解决方案。\n\n`;
        if (roleType === 'coach') return `**指导训练示例**:\n用户: \"想要在${expertiseArea}方面有所提升。\"
我会: 评估现状，设定明确目标，制定训练计划，持续激励和指导。\n\n`;
        return '';
    }

    generateClosingMessage(config) {
        const { displayName, expertiseArea, personality } = config;
        return `无论你在${expertiseArea}方面有什么需求，我都会以${personality.join('、')}的态度为你提供最好的服务。让我们一起在${expertiseArea}的道路上不断前进！\n\n记住：每一个问题都是成长的机会，每一次交流都是进步的开始。让我们携手创造更美好的未来！ 🌟`;
    }

    formatOutput(result, outputFormat) {
        const { config, content, filename, configPath, operationLog = [], savedPath, configUpdated, assistantConfigUpdated } = result;
        let logSection = '';
        if (operationLog.length > 0) {
            logSection = `\n\n📋 操作日志:\n${'-'.repeat(30)}\n${operationLog.join('\n')}`;
            if (savedPath) logSection += `\n\n💡 提示: Agent文件已保存到 ${savedPath}`;
            if (configUpdated || assistantConfigUpdated) logSection += `\n💡 提示: 请重启VCPToolBox服务以加载新的Agent配置`;
        }

        if (outputFormat === 'json') return JSON.stringify(result, null, 2);
        if (outputFormat === 'config') {
            let output = `🤖 Agent配置信息\n${'='.repeat(40)}\n\n📝 Agent名称: ${config.name}\n🎭 显示名称: ${config.displayName}\n👤 角色类型: ${config.roleTitle} (${config.roleType})\n💼 专业领域: ${config.expertiseArea}\n🎨 个性特点: ${config.personality.join(', ')}\n`;
            const styleInfo = this.interactionStyles[config.interactionStyle] || this.interactionStyles['friendly'];
            output += `💬 交互风格: ${styleInfo.desc}\n🎯 目标用户: ${config.targetAudience}\n`;
            if (config.specialSkills.length > 0) output += `⚡ 特殊技能: ${config.specialSkills.join(', ')}\n`;
            if (config.availableTools.length > 0) output += `🛠️ 可用工具: ${config.availableTools.join(', ')}\n`;
            output += `\n📁 文件名: ${filename}\n⚙️ 配置行: ${configPath}${logSection}`;
            return output;
        }
        if (outputFormat === 'both') return `${this.formatOutput(result, 'config')}\n\n📄 Agent文件内容:\n${'='.repeat(50)}\n\n${content}`;
        return content + logSection;
    }
}

async function main() {
    try {
        let inputData = '';
        process.stdin.on('data', chunk => { inputData += chunk; });
        process.stdin.on('end', async () => {
            try {
                if (!inputData.trim()) process.exit(0);
                const args = JSON.parse(inputData.trim());
                const generator = new AgentGenerator();
                const command = args.command || 'GenerateAgent';
                let result, formattedResult;

                if (command === 'DeleteAgent') {
                    result = await generator.deleteAgent(args);
                    formattedResult = result.operationLog.join('\n');
                } else {
                    result = await generator.generateAndSaveAgent(args);
                    formattedResult = generator.formatOutput(result, args.output_format || 'file');
                }
                
                console.log(JSON.stringify({ status: 'success', result: formattedResult }));
                process.exit(0);
            } catch (error) {
                console.log(JSON.stringify({ status: 'error', error: `Agent操作失败: ${error.message}` }));
                process.exit(1);
            }
        });
    } catch (error) {
        console.log(JSON.stringify({ status: 'error', error: `Agent生成失败: ${error.message}` }));
        process.exit(1);
    }
}

process.stdin.setEncoding('utf8');
main();
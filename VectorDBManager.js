// VectorDBManager.js
const { Worker } = require('worker_threads');
const fs = require('fs').promises;
const path = require('path');
const chokidar = require('chokidar');
const { HierarchicalNSW } = require('hnswlib-node');
const crypto = require('crypto');
const { chunkText } = require('./TextChunker.js');
const WorkerPool = require('./WorkerPool.js');
const VectorDBStorage = require('./VectorDBStorage.js');
const TagVectorManager = require('./TagVectorManager.js');
const TagExpander = require('./TagExpander.js');

// --- Constants ---
const DIARY_ROOT_PATH = path.join(__dirname, 'dailynote'); // Your diary root directory
const VECTOR_STORE_PATH = path.join(__dirname, 'VectorStore'); // Directory to store vector indices

/**
 * LRU Cache with TTL for search results
 */
class SearchCache {
    constructor(maxSize = 100, ttl = 60000) { // 1-minute TTL
        this.cache = new Map();
        this.maxSize = maxSize;
        this.ttl = ttl;
        this.hits = 0;
        this.misses = 0;
    }

    getCacheKey(diaryName, queryVector, k) {
        const vectorHash = crypto.createHash('md5')
            .update(JSON.stringify(queryVector))
            .digest('hex');
        return `${diaryName}-${vectorHash}-${k}`;
    }

    get(diaryName, queryVector, k) {
        const key = this.getCacheKey(diaryName, queryVector, k);
        const entry = this.cache.get(key);

        if (entry && Date.now() - entry.timestamp < this.ttl) {
            this.hits++;
            return entry.result;
        }

        this.cache.delete(key);
        this.misses++;
        return null;
    }

    set(diaryName, queryVector, k, result) {
        const key = this.getCacheKey(diaryName, queryVector, k);

        if (this.cache.size >= this.maxSize) {
            const firstKey = this.cache.keys().next().value;
            this.cache.delete(firstKey);
        }

        this.cache.set(key, {
            result,
            timestamp: Date.now()
        });
    }

    getStats() {
        const total = this.hits + this.misses;
        return {
            hits: this.hits,
            misses: this.misses,
            hitRate: total > 0 ? (this.hits / total * 100).toFixed(2) + '%' : '0%',
            size: this.cache.size,
            maxSize: this.maxSize
        };
    }
}

/**
 * Manages the creation, synchronization, and searching of vector databases for diaries.
 */
class VectorDBManager {
    constructor(config = {}) {
        this.config = {
            changeThreshold: parseFloat(process.env.VECTORDB_CHANGE_THRESHOLD) || 0.5,
            maxMemoryUsage: (parseInt(process.env.VECTORDB_MAX_MEMORY_MB) || 500) * 1024 * 1024,
            cacheSize: parseInt(process.env.VECTORDB_CACHE_SIZE) || 100,
            cacheTTL: parseInt(process.env.VECTORDB_CACHE_TTL_MS) || 60000,
            retryAttempts: parseInt(process.env.VECTORDB_RETRY_ATTEMPTS) || 3,
            retryBaseDelay: parseInt(process.env.VECTORDB_RETRY_BASE_DELAY_MS) || 1000,
            retryMaxDelay: parseInt(process.env.VECTORDB_RETRY_MAX_DELAY_MS) || 10000,
            preWarmCount: parseInt(process.env.VECTORDB_PREWARM_COUNT) || 5,
            efSearch: parseInt(process.env.VECTORDB_EF_SEARCH) || 150,
            rateLimitPauseMs: parseInt(process.env.VECTORDB_RATE_LIMIT_PAUSE_MS) || 120000, // 默认2分钟
            debug: process.env.VECTORDB_DEBUG === 'true',
        };

        this.apiKey = process.env.API_Key;
        this.apiUrl = process.env.API_URL;
        this.embeddingModel = process.env.WhitelistEmbeddingModel;

        this.indices = new Map();
        this.chunkMaps = new Map();
        this.activeWorkers = new Set();
        this.lruCache = new Map();
        this.searchCache = new SearchCache(this.config.cacheSize, this.config.cacheTTL);
        this.searchWorkerPool = new WorkerPool(path.resolve(__dirname, 'vectorSearchWorker.js'));
        this.fileLocks = new Map();

        // ✅ SQLite存储层
        this.storage = new VectorDBStorage(VECTOR_STORE_PATH);

        // ✅ Tag向量管理器
        this.tagVectorManager = null;
        this.tagVectorEnabled = false;
<<<<<<< HEAD
        
        // 🌟 Tag扩展器（毛边网络）
        this.tagExpander = null;
        this.tagExpanderEnabled = false;
        
=======

>>>>>>> 0b10395 (我的第一次提交VCPtoolbox)
        // ✅ 批量写入优化
        this.usageStatsBuffer = new Map();
        this.usageStatsFlushTimer = null;
        this.usageStatsFlushDelay = 5000; // 5秒防抖
        this.isShuttingDown = false;

        this.stats = {
            totalIndices: 0,
            totalChunks: 0,
            totalSearches: 0,
            avgSearchTime: 0,
            lastUpdateTime: null,
        };

        console.log('[VectorDB] Initialized with config:', {
            changeThreshold: this.config.changeThreshold,
            maxMemoryMB: this.config.maxMemoryUsage / 1024 / 1024,
            cacheSize: this.config.cacheSize,
            cacheTTL: this.config.cacheTTL,
            retryAttempts: this.config.retryAttempts,
        });
    }

    debugLog(message, ...args) {
        if (this.config.debug) {
            console.log(`[VectorDB][DEBUG] ${message}`, ...args);
        }
    }

    /**
     * 获取文件锁（带超时）
     * @param {string} diaryName - 日记本名称
     */
    async acquireLock(diaryName) {
        const lockKey = `lock_${diaryName}`;
        let attempts = 0;
        const maxAttempts = 100; // 5秒超时（100 * 50ms）

        while (this.fileLocks.get(lockKey)) {
            if (attempts++ >= maxAttempts) {
                const lock = this.fileLocks.get(lockKey);
                const heldDuration = Date.now() - (lock?.acquiredAt || 0);
                throw new Error(
                    `[VectorDB] Failed to acquire lock for "${diaryName}" after ${maxAttempts * 50}ms.\n` +
                    `Lock acquired at: ${new Date(lock?.acquiredAt).toISOString()}\n` +
                    `Held for: ${heldDuration}ms`
                );
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }

        this.fileLocks.set(lockKey, {
            acquiredAt: Date.now(),
            stack: new Error().stack // ✅ 调试用：记录调用栈
        });

        this.debugLog(`Lock acquired for "${diaryName}"`);
    }

    /**
     * 释放文件锁
     * @param {string} diaryName - 日记本名称
     */
    releaseLock(diaryName) {
        const lockKey = `lock_${diaryName}`;
        const lock = this.fileLocks.get(lockKey);

        if (lock) {
            const heldDuration = Date.now() - lock.acquiredAt;
            this.fileLocks.delete(lockKey);
            this.debugLog(`Lock released for "${diaryName}" (held for ${heldDuration}ms)`);
        } else {
            console.warn(`[VectorDB] Attempted to release non-existent lock for "${diaryName}"`);
        }
    }

    /**
     * 记录性能指标
     */
    recordMetric(type, duration) {
        if (type === 'search_success') {
            this.stats.totalSearches++;
            this.stats.avgSearchTime =
                (this.stats.avgSearchTime * (this.stats.totalSearches - 1) + duration)
                / this.stats.totalSearches;
        }
    }

    getHealthStatus() {
        const totalChunks = Array.from(this.chunkMaps.values()).reduce((sum, map) => sum + Object.keys(map).length, 0);
        const healthStatus = {
            status: 'healthy',
            stats: {
                ...this.stats,
                totalIndices: this.indices.size,
                totalChunks: totalChunks,
                workerQueueLength: this.activeWorkers.size,
                memoryUsage: process.memoryUsage().heapUsed,
            },
            activeWorkers: Array.from(this.activeWorkers),
            loadedIndices: Array.from(this.indices.keys()),
            dbStats: this.storage.getStats(),
            cacheStats: this.searchCache.getStats(),
        };

        // ✅ 添加Tag向量统计
        if (this.tagVectorEnabled && this.tagVectorManager) {
            healthStatus.tagStats = this.tagVectorManager.getStats();
        }
<<<<<<< HEAD
        
        // 🌟 添加Tag扩展器统计
        if (this.tagExpanderEnabled && this.tagExpander) {
            healthStatus.tagExpanderStats = this.tagExpander.getStats();
        }
        
=======

>>>>>>> 0b10395 (我的第一次提交VCPtoolbox)
        return healthStatus;
    }

    async initialize() {
        console.log('[VectorDB] Initializing Vector Database Manager...');
        await fs.mkdir(VECTOR_STORE_PATH, { recursive: true });
        await this.storage.initialize();

        // ✅ 初始化Tag向量管理器（异步后台，不阻塞启动）
        this.initializeTagVectorManager(); // ⚠️ 不使用 await，让它在后台运行

        await this.scanAndSyncAll();
        await this.cacheDiaryNameVectors();
        await this.preWarmIndices();
        this.watchDiaries();//me 在这里监听日记文件夹的变化 关键步骤
        console.log('[VectorDB] Initialization complete. Now monitoring diary files for changes.');
    }

    /**
     * ✅ 初始化Tag向量管理器（异步后台构建）
     */
    async initializeTagVectorManager() {
        try {
            console.log('[VectorDB] Initializing Tag Vector Manager...');

            this.tagVectorManager = new TagVectorManager({
                diaryRootPath: DIARY_ROOT_PATH,
                vectorStorePath: VECTOR_STORE_PATH
            });

            // 传入embedding函数
            const embeddingFunction = async (texts) => {
                return await this.getEmbeddingsWithRetry(texts);
            };

            // ✅ 异步初始化：不阻塞服务器启动
            console.log('[VectorDB] Tag Vector Manager will build in background...');
            this.tagVectorManager.initialize(embeddingFunction).then(() => {
                this.tagVectorEnabled = true;
                const stats = this.tagVectorManager.getStats();
                console.log(`[VectorDB] ✅ Tag Vector Manager ready:`, {
                    totalTags: stats.totalTags,
                    vectorizedTags: stats.vectorizedTags,
                    blacklistedTags: stats.blacklistedTags
                });
                console.log('[VectorDB] 🎉 Tag-based search is now available!');
                
                // 🌟 初始化Tag扩展器（在Tag向量管理器就绪后）
                this.initializeTagExpander();
            }).catch(error => {
                console.error('[VectorDB] Tag Vector Manager build failed:', error);
                this.tagVectorEnabled = false;
            });

            // 立即返回，不等待构建完成
            console.log('[VectorDB] Tag Vector Manager is building in background, server continues...');

        } catch (error) {
            console.error('[VectorDB] Failed to start Tag Vector Manager:', error);
            console.warn('[VectorDB] Tag-based search will be disabled');
            this.tagVectorEnabled = false;
        }
    }

    /**
     * 🌟 初始化Tag扩展器（异步后台）
     */
    async initializeTagExpander() {
        try {
            console.log('[VectorDB] Initializing Tag Expander...');
            
            this.tagExpander = new TagExpander({
                debug: this.config.debug
            });
            
            // 🌟 从共现数据库导出权重矩阵并加载到内存
            if (this.tagVectorManager?.cooccurrenceDB) {
                const weightMatrix = this.tagVectorManager.cooccurrenceDB.exportWeightMatrix();
                await this.tagExpander.loadWeightMatrix(weightMatrix);
                this.tagExpanderEnabled = true;
                
                const expanderStats = this.tagExpander.getStats();
                console.log('[VectorDB] ✅ Tag Expander ready:', {
                    totalTags: expanderStats.totalTags,
                    totalEdges: expanderStats.totalEdges,
                    avgDegree: expanderStats.avgDegree
                });
                console.log('[VectorDB] 🎉 Tag graph expansion is now available!');
            } else {
                console.warn('[VectorDB] Cooccurrence DB not available, Tag Expander disabled');
                this.tagExpanderEnabled = false;
            }
            
        } catch (error) {
            console.error('[VectorDB] Failed to initialize Tag Expander:', error);
            this.tagExpanderEnabled = false;
        }
    }

    async scanAndSyncAll() {
        console.log('[VectorDB] Scanning all diary books for updates...');
        const diaryBooks = await fs.readdir(DIARY_ROOT_PATH, { withFileTypes: true });

        // ✅ 批量处理，避免并发问题
        const updateTasks = [];

        // ✅ 新增：收集当前存在的日记本名称
        const currentDiaryNames = new Set();

        for (const dirent of diaryBooks) {
            if (dirent.isDirectory()) {
                const diaryName = dirent.name;
                if (diaryName.startsWith('已整理') || diaryName === 'VCP论坛') {
                    console.log(`[VectorDB] Ignoring folder "${diaryName}" as it is in the exclusion list.`);
                    continue;
                }

                currentDiaryNames.add(diaryName);
                const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);

                const needsUpdate = await this.checkIfUpdateNeeded(diaryName, diaryPath);
                if (needsUpdate) {
                    console.log(`[VectorDB] Changes detected in "${diaryName}", will schedule update.`);
                    updateTasks.push(diaryName);
                } else {
                    console.log(`[VectorDB] "${diaryName}" is up-to-date. Index will be loaded on demand.`);
                }
            }
        }

        // ✅ 新增：清理数据库中已删除的日记本
        const dbDiaryNames = this.storage.getAllDiaryNames();
        for (const dbDiaryName of dbDiaryNames) {
            if (!currentDiaryNames.has(dbDiaryName)) {
                console.log(`[VectorDB] Found orphaned database entry for deleted diary "${dbDiaryName}". Cleaning up...`);
                await this.cleanupDeletedDiary(dbDiaryName);
            }
        }

        // ✅ 统一调度更新任务
        console.log(`[VectorDB] Scheduling ${updateTasks.length} diary books for update.`);
        for (const diaryName of updateTasks) {
            this.scheduleDiaryBookProcessing(diaryName);
        }
    }

    async checkIfUpdateNeeded(diaryName, diaryPath) {
        // ✅ 检查是否在暂停期
        if (this.storage.isRebuildPaused(diaryName)) {
            this.debugLog(`[VectorDB] Update check for "${diaryName}" is paused`);
            return false;
        }

        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
        const indexExists = await this.fileExists(indexPath);

        // ✅ 步骤1：检查数据库是否有数据
        const chunkMap = this.storage.getChunkMap(diaryName);
        const dbChunkCount = Object.keys(chunkMap).length;

        // ✅ 情况1：数据库为空 → Full Rebuild（第一次构建）
        if (dbChunkCount === 0) {
            console.log(`[VectorDB] Database empty for "${diaryName}" → Full Rebuild (first build)`);
            return true;
        }

        // ✅ 步骤2：数据库有数据，检查索引文件
        if (!indexExists) {
            console.log(`[VectorDB] Index file missing for "${diaryName}" but database has ${dbChunkCount} chunks`);
            console.log(`[VectorDB] → Atomic repair: rebuilding index from database`);
            await this.rebuildIndexFromDatabase(diaryName);
            return false; // 修复完成，无需update
        }

        // ✅ 步骤3：检查数据一致性（索引 vs 数据库）
        // ⚠️ 关键优化：根据差异大小决定修复策略
        try {
            const dimensions = 768;
            const tempIndex = new HierarchicalNSW('l2', dimensions);
            tempIndex.readIndexSync(indexPath);
            const indexElementCount = tempIndex.getCurrentCount();

            if (Math.abs(indexElementCount - dbChunkCount) > 0) {
                const diff = Math.abs(indexElementCount - dbChunkCount);
                const diffRatio = dbChunkCount > 0 ? diff / dbChunkCount : 1.0;
                
                console.warn(`[VectorDB] Data inconsistency for "${diaryName}": index=${indexElementCount}, db=${dbChunkCount} (diff=${diff}, ${(diffRatio*100).toFixed(1)}%)`);
                
                // ✅ 根据差异大小决定策略
                if (diffRatio > 0.1) {
                    // 差异>10%：删除索引，触发完整重建
                    console.log(`[VectorDB] → Large inconsistency (${(diffRatio*100).toFixed(1)}%), deleting index to trigger rebuild`);
                    try {
                        await fs.unlink(indexPath);
                        console.log(`[VectorDB] ✅ Stale index deleted, will trigger full rebuild`);
                    } catch (unlinkError) {
                        console.error(`[VectorDB] Failed to delete index:`, unlinkError.message);
                    }
                    return true; // 触发重建
                } else {
                    // 差异≤10%：通过diff修复（信任数据库，同步索引）
                    console.log(`[VectorDB] → Minor inconsistency (${diff} chunks), will sync index with database through diff`);
                    // ✅ 同步修复，确保完成后再继续
                    try {
                        await this.syncIndexWithDatabase(diaryName);
                        console.log(`[VectorDB] ✅ Index synced successfully for "${diaryName}"`);
                        return false; // 修复完成，无需触发更新
                    } catch (err) {
                        console.error(`[VectorDB] Failed to sync index for "${diaryName}":`, err.message);
                        console.log(`[VectorDB] → Will trigger full rebuild as fallback`);
                        return true; // 修复失败，触发完整重建
                    }
                }
            }
        } catch (error) {
            console.error(`[VectorDB] Failed to read index for "${diaryName}":`, error.message);
            console.log(`[VectorDB] → Deleting corrupted index file`);
            
            // ✅ 索引损坏：删除并触发重建
            try {
                await fs.unlink(indexPath);
                console.log(`[VectorDB] ✅ Corrupted index deleted, will trigger rebuild`);
            } catch (unlinkError) {
                if (unlinkError.code !== 'ENOENT') {
                    console.error(`[VectorDB] Failed to delete index:`, unlinkError.message);
                }
            }
            
            return true; // 触发重建
        }

        // ✅ 步骤4：检查文件变化（用于判断是否需要增量更新）
        const diaryManifest = this.storage.getFileHashes(diaryName);
        const files = await fs.readdir(diaryPath);
        const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

        if (Object.keys(diaryManifest).length !== relevantFiles.length) {
            console.log(`[VectorDB] File count changed for "${diaryName}": ${Object.keys(diaryManifest).length} → ${relevantFiles.length}`);
            return true; // 有变化，进入scheduleDiaryBookProcessing判断增量/全量
        }

        for (const file of relevantFiles) {
            const oldFileHash = diaryManifest[file];
            if (!oldFileHash) {
                console.log(`[VectorDB] New file detected: "${file}" in "${diaryName}"`);
                return true;
            }

            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            const currentFileHash = crypto.createHash('md5').update(content).digest('hex');

            if (oldFileHash !== currentFileHash) {
                console.log(`[VectorDB] File changed: "${file}" in "${diaryName}"`);
                return true;
            }
        }

        this.debugLog(`[VectorDB] "${diaryName}" is up-to-date`);
        return false;
    }

    async calculateChanges(diaryName) {
        const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);

        // ✅ 再次检查（防御性编程）- 处理所有访问错误
        try {
            await fs.access(diaryPath);
        } catch (error) {
            // ✅ 修复：处理所有可能的目录不存在/无权限错误
            if (error.code === 'ENOENT' || error.code === 'EPERM' || error.code === 'EACCES') {
                console.log(`[VectorDB][calculateChanges] Directory "${diaryName}" is not accessible (${error.code}). Treating as deleted.`);
                // ✅ 返回特殊标记，表示目录已删除
                return {
                    diaryName,
                    chunksToAdd: [],
                    labelsToDelete: [],
                    newFileHashes: {},
                    directoryDeleted: true  // ✅ 添加标记
                };
            }
            throw error;
        }

        const newFileHashes = {};
        const oldChunkMap = this.storage.getChunkMap(diaryName);
<<<<<<< HEAD
        
        // ✅ 检查数据完整性：收集损坏条目对应的源文件
        // 让这些损坏文件进入正常的diff流程，由变化率判断是否触发重建
        const corruptedSourceFiles = new Set();
        let corruptedCount = 0;
        
        for (const [label, data] of Object.entries(oldChunkMap)) {
            // 检查必需字段是否存在且有效
            if (!data || !data.text || !data.sourceFile || !data.chunkHash) {
                corruptedCount++;
                if (data && data.sourceFile) {
                    corruptedSourceFiles.add(data.sourceFile);
                }
                this.debugLog(`Corrupted entry at label ${label}:`, {
                    hasText: !!data?.text,
                    hasSourceFile: !!data?.sourceFile,
                    hasChunkHash: !!data?.chunkHash
                });
            }
=======

        const oldChunkHashToLabel = new Map(Object.entries(oldChunkMap).map(([label, data]) => [data.chunkHash, Number(label)]));

        // ✅ 修复：防御性检查, 防止 undefined key 导致 size 异常
        if (oldChunkHashToLabel.has(undefined)) {
            oldChunkHashToLabel.delete(undefined);
>>>>>>> 0b10395 (我的第一次提交VCPtoolbox)
        }
        
        if (corruptedCount > 0) {
            const totalEntries = Object.keys(oldChunkMap).length;
            console.warn(`[VectorDB] Found ${corruptedCount}/${totalEntries} corrupted entries in "${diaryName}"`);
            console.warn(`[VectorDB] Will rebuild ${corruptedSourceFiles.size} affected files through diff: ${Array.from(corruptedSourceFiles).slice(0, 5).join(', ')}${corruptedSourceFiles.size > 5 ? '...' : ''}`);
        }
        // ✅ 修复：基于(sourceFile + chunkIndex)来判断变化，而非hash去重
        // 构建当前文件的chunk列表：file -> chunks[]
        const currentFileChunks = new Map(); // file -> [{text, chunkHash, index}]
        const files = await fs.readdir(diaryPath);
        const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

        for (const file of relevantFiles) {
            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            newFileHashes[file] = crypto.createHash('md5').update(content).digest('hex');
            const chunks = chunkText(content);

            const fileChunkList = [];
            for (let i = 0; i < chunks.length; i++) {
                const chunk = chunks[i];
                const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');
                fileChunkList.push({
                    text: chunk,
                    chunkHash: chunkHash,
                    index: i
                });
            }
            currentFileChunks.set(file, fileChunkList);
        }

        // ✅ 构建旧数据的文件->chunks映射
        const oldFileChunks = new Map(); // file -> Map(label -> chunkData)
        for (const [label, data] of Object.entries(oldChunkMap)) {
            if (!oldFileChunks.has(data.sourceFile)) {
                oldFileChunks.set(data.sourceFile, new Map());
            }
            oldFileChunks.get(data.sourceFile).set(Number(label), data);
        }

        const chunksToAdd = [];
        const labelsToDelete = [];

        // ✅ 检测需要删除的：旧文件不再存在，文件内容变化，或文件数据损坏
        for (const [file, oldLabels] of oldFileChunks.entries()) {
            const currentChunks = currentFileChunks.get(file);

            if (!currentChunks) {
                // 文件已删除，删除所有相关chunks
                for (const label of oldLabels.keys()) {
                    labelsToDelete.push(label);
                }
            } else {
                // 文件存在，检查文件hash是否变化，或者该文件有损坏的数据
                const oldFileHash = this.storage.getFileHashes(diaryName)[file];
                const newFileHash = newFileHashes[file];
<<<<<<< HEAD
                const isCorrupted = corruptedSourceFiles.has(file);
                
                if (oldFileHash !== newFileHash || isCorrupted) {
                    // 文件内容变化或数据损坏，删除所有旧chunks（后面会重新添加）
                    if (isCorrupted) {
                        console.log(`[VectorDB] Rebuilding corrupted file "${file}" in "${diaryName}"`);
                    }
=======

                if (oldFileHash !== newFileHash) {
                    // 文件内容变化，删除所有旧chunks（后面会重新添加）
>>>>>>> 0b10395 (我的第一次提交VCPtoolbox)
                    for (const label of oldLabels.keys()) {
                        labelsToDelete.push(label);
                    }
                }
            }
        }

        // ✅ 检测需要添加的：新文件，文件内容变化，或文件数据损坏需修复
        for (const [file, currentChunks] of currentFileChunks.entries()) {
            const oldFileHash = this.storage.getFileHashes(diaryName)[file];
            const newFileHash = newFileHashes[file];
<<<<<<< HEAD
            const isCorrupted = corruptedSourceFiles.has(file);
            
            if (!oldFileHash || oldFileHash !== newFileHash || isCorrupted) {
                // 新文件、文件内容变化，或数据损坏需修复，添加所有chunks
=======

            if (!oldFileHash || oldFileHash !== newFileHash) {
                // 新文件或文件内容变化，添加所有chunks
>>>>>>> 0b10395 (我的第一次提交VCPtoolbox)
                for (const chunkData of currentChunks) {
                    chunksToAdd.push({
                        text: chunkData.text,
                        sourceFile: file,
                        chunkHash: chunkData.chunkHash
                    });
                }
            }
        }

        return { diaryName, chunksToAdd, labelsToDelete, newFileHashes };
    }

    async getEmbeddings(chunks) {
        return getEmbeddingsInWorker(chunks, {
            apiKey: this.apiKey,
            apiUrl: this.apiUrl,
            embeddingModel: this.embeddingModel,
        });
    }

    async getEmbeddingsWithRetry(chunks) {
        let lastError;
        for (let attempt = 1; attempt <= this.config.retryAttempts; attempt++) {
            try {
                return await this.getEmbeddings(chunks);
            } catch (error) {
                lastError = error;
                console.log(`[VectorDB] Embedding attempt ${attempt} failed:`, error.message);
                if (attempt < this.config.retryAttempts) {
                    const delay = Math.min(this.config.retryBaseDelay * Math.pow(2, attempt - 1), this.config.retryMaxDelay);
                    console.log(`[VectorDB] Retrying in ${delay}ms...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        throw new Error(`Failed to get embeddings after ${this.config.retryAttempts} attempts: ${lastError.message}`);
    }

    //me 读取 可可的日记 文件夹下的所有 .txt 和 .md 文件，将它们切块、向量化，并构建或更新一个名为 可可的日记.bin 的向量索引文件。
    async scheduleDiaryBookProcessing(diaryName) {
        // ✅ 修复：统一在入口处管理 activeWorkers
        // 快速检查（无锁，快速拒绝）
        //me 函数定义：接收一个日记本名称作为参数。
        if (this.activeWorkers.has(diaryName)) {
            console.log(`[VectorDB] Processing for "${diaryName}" is already in progress. Skipping.`);
            return;
        }

        // ✅ 使用独立的调度锁，防止并发调度
        const lockKey = `schedule_${diaryName}`;
        await this.acquireLock(lockKey);
        try {
            // 双重检查（持有锁后再检查一次）
            if (this.activeWorkers.has(diaryName)) {
                return;
            }

            // ✅ 立即标记为活动状态，防止重复调度
            this.activeWorkers.add(diaryName);
            console.log(`[VectorDB] Marked "${diaryName}" as active worker`);
        } finally {
            this.releaseLock(lockKey);
        }

        // ✅ Bug修复4：追踪Worker是否接管管理
        let workerTookOver = false;
        
        // ✅ 无论后续执行什么路径，都要确保清理 activeWorkers
        try {
            const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);

            try {
                await fs.access(diaryPath);
            } catch (error) {
                if (error.code === 'ENOENT') {
                    console.log(`[VectorDB] Directory "${diaryName}" no longer exists. Cleaning up resources...`);
                    await this.cleanupDeletedDiary(diaryName);
                    return;
                }
                throw error;
            }

            // ✅ 从数据库读取旧chunk数量
            const oldChunkMap = this.storage.getChunkMap(diaryName);
            let totalOldChunks = Object.keys(oldChunkMap).length;

            console.log(`[VectorDB] Calculating changes for "${diaryName}"...`);
            const changeset = await this.calculateChanges(diaryName);
            const { chunksToAdd, labelsToDelete, forceFullRebuild, directoryDeleted } = changeset;

            // ✅ 新增：检查目录是否已被删除
            if (directoryDeleted) {
                console.log(`[VectorDB] Directory "${diaryName}" was deleted during processing. Cleaning up...`);
                await this.cleanupDeletedDiary(diaryName);
                return;
            }

            if (forceFullRebuild) {
                console.log(`[VectorDB] Full rebuild forced for "${diaryName}" due to data integrity issues.`);
                // ✅ Bug修复4：删除后立即转交
                this.activeWorkers.delete(diaryName);
                const workerStarted = this.runFullRebuildWorker(diaryName);
                if (workerStarted) {
                    workerTookOver = true; // ✅ Worker接管管理
                }
                return;
            }

            const changeRatio = totalOldChunks > 0 ? (chunksToAdd.length + labelsToDelete.length) / totalOldChunks : 1.0;

            if (totalOldChunks === 0 || changeRatio > this.config.changeThreshold) {
                console.log(`[VectorDB] Major changes detected (${(changeRatio * 100).toFixed(1)}%). Scheduling a full rebuild for "${diaryName}".`);
                // ✅ Bug修复4：删除后立即转交
                this.activeWorkers.delete(diaryName);
                const workerStarted = this.runFullRebuildWorker(diaryName);
                if (workerStarted) {
                    workerTookOver = true; // ✅ Worker接管管理
                }
                return;
            } else if (chunksToAdd.length > 0 || labelsToDelete.length > 0) {
                console.log(`[VectorDB] Minor changes detected. Applying incremental update for "${diaryName}".`);
                // ✅ activeWorkers已经在入口处添加了，直接执行
                await this.applyChangeset(changeset);
                // ✅ 成功后在finally块统一清理
            } else {
                console.log(`[VectorDB] No effective changes detected for "${diaryName}". Nothing to do.`);
                // ✅ 无操作，在finally块统一清理
            }
        } catch (error) {
            console.error(`[VectorDB] Failed to process diary book "${diaryName}":`, error);
            // ✅ 错误会在finally块统一清理
        } finally {
            // ✅ Bug修复4：只有非Worker分支才清理
            if (!workerTookOver && this.activeWorkers.has(diaryName)) {
                this.activeWorkers.delete(diaryName);
                console.log(`[VectorDB] Cleared activeWorker for "${diaryName}"`);
            }
        }
    }

    runFullRebuildWorker(diaryName) {
        // ✅ 防止重复启动 Worker（双重检查）
        // 注意：调用者应该已经检查过activeWorkers，但这里再检查一次以防万一
        if (this.activeWorkers.has(diaryName)) {
            console.log(`[VectorDB] Full rebuild worker for "${diaryName}" is already active. Skipping duplicate request.`);
            return false; // ✅ 返回false表示未启动
        }

        console.log(`[VectorDB] Preparing to start full rebuild worker for "${diaryName}"`);

        // ✅ 验证配置
        if (!this.apiKey || !this.apiUrl || !this.embeddingModel) {
            console.error(`[VectorDB] ❌ Missing required config for worker:`);
            console.error(`  API Key: ${this.apiKey ? 'Present' : 'MISSING'}`);
            console.error(`  API URL: ${this.apiUrl || 'MISSING'}`);
            console.error(`  Embedding Model: ${this.embeddingModel || 'MISSING'}`);
            this.storage.recordFailedRebuild(diaryName, 'Missing API configuration');
            return false; // ✅ 返回false表示未启动
        }

        const workerConfig = {
            apiKey: this.apiKey,
            apiUrl: this.apiUrl,
            embeddingModel: this.embeddingModel,
            retryAttempts: this.config.retryAttempts,
            retryBaseDelay: this.config.retryBaseDelay,
            retryMaxDelay: this.config.retryMaxDelay,
        };

        console.log(`[VectorDB] Worker config:`, {
            apiUrl: workerConfig.apiUrl,
            embeddingModel: workerConfig.embeddingModel,
            apiKeyPresent: !!workerConfig.apiKey,
            retryAttempts: workerConfig.retryAttempts,
        });

        // ✅ 创建Worker（创建成功后立即标记为活动）
        let worker;
        try {
            worker = new Worker(path.resolve(__dirname, 'vectorizationWorker.js'), {
                workerData: {
                    task: 'fullRebuild',
                    diaryName,
                    config: workerConfig
                }
            });

            // ✅ Worker创建成功，立即标记为活动（防止重复创建）
            // 这个标记会在Worker的exit事件中清理
            this.activeWorkers.add(diaryName);
            console.log(`[VectorDB] ✅ Worker thread created and marked active for "${diaryName}"`);
        } catch (createError) {
            console.error(`[VectorDB] ❌ Failed to create worker for "${diaryName}":`, createError);
            this.storage.recordFailedRebuild(diaryName, `Worker creation failed: ${createError.message}`);
            // ✅ 创建失败，不需要清理activeWorkers（因为从未添加）
            return false;
        }

        worker.on('message', (message) => {
            console.log(`[VectorDB] Received message from worker for "${diaryName}":`, {
                status: message.status,
                task: message.task,
                error: message.error || 'none'
            });

            if (message.status === 'success' && message.task === 'fullRebuild') {
                this.storage.updateFileHashes(message.diaryName, message.newManifestEntry);
                // ✅ 清除失败重建记录
                this.storage.clearFailedRebuild(message.diaryName);

                // ✅ 关键修复：清除内存中的索引，强制下次搜索时重新加载
                this.indices.delete(message.diaryName);
                this.chunkMaps.delete(message.diaryName);
                console.log(`[VectorDB] Cleared in-memory cache for "${message.diaryName}" to force reload`);

                this.stats.lastUpdateTime = new Date().toISOString();
                console.log(`[VectorDB] ✅ Worker successfully completed full rebuild for "${message.diaryName}".`);
            } else if (message.status === 'error') {
                // ✅ 检查是否是限流导致的暂停
                if (message.isPauseError) {
                    const pauseMinutes = Math.round(this.config.rateLimitPauseMs / 60000);
                    console.warn(`[VectorDB] ⏸️ Worker paused due to rate limit for "${message.diaryName}"`);
                    console.warn(`[VectorDB] Progress: ${message.processedFiles}/${message.totalFiles} files completed`);
                    console.warn(`[VectorDB] 😴 Taking a ${pauseMinutes}-minute break to let API quota recover...`);

                    // ✅ 核心改进：休息后自动重启Worker继续工作
                    setTimeout(() => {
                        console.log(`[VectorDB] ⏰ Break time over! Resuming work on "${message.diaryName}"...`);
                        this.runFullRebuildWorker(message.diaryName);
                    }, this.config.rateLimitPauseMs);
                } else {
                    console.error(`[VectorDB] ❌ Worker failed for "${message.diaryName}":`, message.error);
                    console.error(`[VectorDB] Error stack:`, message.stack);
                    this.storage.recordFailedRebuild(message.diaryName, message.error);
                }
            } else {
                console.error(`[VectorDB] ❌ Worker returned unknown status for "${message.diaryName}":`, message);
                this.storage.recordFailedRebuild(diaryName, 'Unknown worker failure');
            }
        });

        worker.on('error', (error) => {
            // ✅ 检查是否是限流导致的暂停
            if (error.isPauseError) {
                console.warn(`[VectorDB] ⏸️ Worker paused due to rate limit for "${diaryName}"`);
                console.warn(`[VectorDB] This is not an error - progress has been saved`);
            } else {
                console.error(`[VectorDB] ❌ Worker error for "${diaryName}":`, error);
                console.error(`[VectorDB] Error stack:`, error.stack);
                console.error(`[VectorDB] Error name:`, error.name);
                console.error(`[VectorDB] Error code:`, error.code);
                this.storage.recordFailedRebuild(diaryName, error.message);
            }
            // ✅ Worker 停止时清理
            this.activeWorkers.delete(diaryName);
        });

        worker.on('exit', (code) => {
            // ✅ 确保清理（幂等操作）
            this.activeWorkers.delete(diaryName);
            const exitTime = new Date().toISOString();
            console.log(`[VectorDB] Worker exited for "${diaryName}" at ${exitTime} with code: ${code}`);
            if (code !== 0) {
                // ✅ 退出码1通常表示限流暂停（正常情况）
                // 只有其他退出码才记录为失败
                if (code === 1) {
                    console.log(`[VectorDB] ⏸️ Worker paused for "${diaryName}" (likely due to rate limit)`);
                } else {
                    console.error(`[VectorDB] ❌ Worker exited with non-zero code ${code} for "${diaryName}"`);
                    this.storage.recordFailedRebuild(diaryName, `Worker exit code ${code}`);
                }
            } else {
                console.log(`[VectorDB] ✅ Worker exited normally for "${diaryName}"`);
            }
        });

        // ✅ 返回true表示Worker已启动
        return true;
    }

    /**
     * ✅ 新增方法：清理已删除日记本的所有资源
     */
    async cleanupDeletedDiary(diaryName) {
        await this.acquireLock(diaryName); // ✅ 加锁
        try {
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            // ⚠️ 保留对旧JSON文件的清理（向后兼容）
            const mapPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}_map.json`);

            // 1. 从内存中删除索引和块映射
            this.indices.delete(diaryName);
            this.chunkMaps.delete(diaryName);
            this.lruCache.delete(diaryName);
            this.activeWorkers.delete(diaryName); // ✅ 添加这行！
            console.log(`[VectorDB] Removed "${diaryName}" from in-memory indices.`);

            // 2. 删除向量存储文件
            const deletePromises = [];

            if (await this.fileExists(indexPath)) {
                deletePromises.push(
                    fs.unlink(indexPath)
                        .then(() => console.log(`[VectorDB] Deleted index file for "${diaryName}".`))
                        .catch(e => console.warn(`[VectorDB] Failed to delete index file:`, e.message))
                );
            }

            if (await this.fileExists(mapPath)) {
                deletePromises.push(
                    fs.unlink(mapPath)
                        .then(() => console.log(`[VectorDB] Deleted map file for "${diaryName}".`))
                        .catch(e => console.warn(`[VectorDB] Failed to delete map file:`, e.message))
                );
            }

            await Promise.all(deletePromises);

            // 3. 从数据库中删除所有相关数据
            this.storage.deleteDiary(diaryName);
            console.log(`[VectorDB] Removed "${diaryName}" from database.`);

            console.log(`[VectorDB] Successfully cleaned up all resources for deleted diary "${diaryName}".`);
        } catch (error) {
            console.error(`[VectorDB] Error during cleanup of "${diaryName}":`, error);
        } finally {
            this.releaseLock(diaryName); // ✅ 释放锁
        }
    }

    watchDiaries() {
        console.log(`[VectorDB] Setting up file watcher for: ${DIARY_ROOT_PATH}`);

        const watcher = chokidar.watch(DIARY_ROOT_PATH, {
            ignored: /(^|[\/\\])\../,
            //me 4. 忽略初始事件：
            //    - `ignoreInitial: true`: 监视器启动时，不会为所有已存在的文件触发 "add" 事件。
            //      它只关心启动 *之后* 发生的变动。
            persistent: true,
            ignoreInitial: true,
            depth: 1,
        });

        const pendingChanges = new Map(); // diaryName → timeoutId

        // ✅ 添加监控器状态日志
        watcher.on('ready', () => {
            console.log(`[VectorDB] File watcher is ready and monitoring for changes`);
            const watched = watcher.getWatched();
            console.log(`[VectorDB] Watching ${Object.keys(watched).length} directories`);
            this.debugLog(`Watched paths:`, watched);
        });

        watcher.on('error', (error) => {
            console.error(`[VectorDB] File watcher error:`, error);
        });

        const handleFileChange = (filePath) => {
            console.log(`[VectorDB] File change detected: ${filePath}`);
            const diaryName = path.basename(path.dirname(filePath));
            console.log(`[VectorDB] Extracted diary name: "${diaryName}" from path: ${filePath}`);

            //me 8. 过滤（黑名单）：
            //    - 如果目录名以 "已整理" 开头，或是 "VCP论坛"，则忽略此次变动，直接返回。
            if (diaryName.startsWith('已整理') || diaryName === 'VCP论坛') {
                console.log(`[VectorDB] Ignoring excluded diary: "${diaryName}"`);
                return;
            }

            // ✅ 如果已经在处理中，忽略文件变更
            if (this.activeWorkers.has(diaryName)) {
                console.log(`[VectorDB] File change ignored for "${diaryName}" - already processing`);
                return;
            }

            // ✅ 如果已经有待处理的定时器，忽略新的变更（除非已经超过2秒）
            const existing = pendingChanges.get(diaryName);
            if (existing) {
                const elapsed = Date.now() - existing.startTime;
                if (elapsed < 2000) {
                    // 在2秒内的多次变更，清除旧定时器，重新开始计时
                    clearTimeout(existing.timeoutId);
                    console.log(`[VectorDB] Cleared previous debounce timer for "${diaryName}" (elapsed: ${elapsed}ms)`);
                } else {
                    // 超过2秒了，让原定时器继续执行
                    console.log(`[VectorDB] Keeping existing debounce timer for "${diaryName}" (elapsed: ${elapsed}ms)`);
                    return;
                }
            }

            // 设置新的定时器（500ms 防抖）
            const startTime = Date.now();
            console.log(`[VectorDB] Setting debounce timer for "${diaryName}" (500ms)`);
            const timeoutId = setTimeout(async () => {
                // ✅ 修复：在执行前再次检查目录是否存在
                const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
                try {
                    await fs.access(diaryPath);
                    // 目录存在，正常处理
                    pendingChanges.delete(diaryName);
                    console.log(`[VectorDB] Debounce completed for "${diaryName}", starting processing`);
                    this.scheduleDiaryBookProcessing(diaryName);
                    this.cacheDiaryNameVectors();
                } catch (error) {
                    // ✅ 目录已被删除，取消处理并清理资源
                    if (error.code === 'ENOENT' || error.code === 'EPERM' || error.code === 'EACCES') {
                        pendingChanges.delete(diaryName);
                        console.log(`[VectorDB] Directory "${diaryName}" no longer exists after debounce. Cleaning up...`);
                        this.cleanupDeletedDiary(diaryName).catch(err => {
                            console.error(`[VectorDB] Error cleaning up "${diaryName}":`, err);
                        });
                        this.cacheDiaryNameVectors();
                    } else {
                        console.error(`[VectorDB] Unexpected error checking directory "${diaryName}":`, error);
                    }
                }
            }, 500);

            pendingChanges.set(diaryName, { timeoutId, startTime });
        };

        const handleDirUnlink = (dirPath) => {
            const diaryName = path.basename(dirPath);
            if (diaryName.startsWith('已整理') || diaryName === 'VCP论坛') {
                return;
            }

            // 取消待处理的更新
            if (pendingChanges.has(diaryName)) {
                clearTimeout(pendingChanges.get(diaryName));
                pendingChanges.delete(diaryName);
            }

            console.log(`[VectorDB] Directory deleted: ${diaryName}`);
            this.cleanupDeletedDiary(diaryName).catch(err => {
                console.error(`[VectorDB] Error cleaning up "${diaryName}":`, err);
            });
            this.cacheDiaryNameVectors();
        };
        //me 19. "add": 当有新文件被创建时，调用 `handleFileChange`。
        watcher
            .on('add', (filePath) => {
                console.log(`[VectorDB] Event: 'add' - ${filePath}`);
                handleFileChange(filePath);
            })
            .on('change', (filePath) => {
                console.log(`[VectorDB] Event: 'change' - ${filePath}`);
                handleFileChange(filePath);
            })
            .on('unlink', (filePath) => {
                console.log(`[VectorDB] Event: 'unlink' - ${filePath}`);
                handleFileChange(filePath);
            })
            .on('unlinkDir', (dirPath) => {
                console.log(`[VectorDB] Event: 'unlinkDir' - ${dirPath}`);
                handleDirUnlink(dirPath);
            });

        console.log(`[VectorDB] File watcher event handlers registered`);
    }

    /**
     * 智能清理文本中的无意义emoji和特殊字符
     * 保留有语义价值的符号
     */
    prepareTextForEmbedding(text) {
        // 1. 移除纯装饰性emoji
        const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;

        // 2. 保留有语义的标点和符号（！？。，等）
        let cleaned = text.replace(decorativeEmojis, ' ');

        // 3. 清理多余空格
        cleaned = cleaned.replace(/\s+/g, ' ').trim();

        // 4. 如果清理后为空，返回占位符
        if (cleaned.length === 0) {
            return '[EMPTY_CONTENT]';
        }

        return cleaned;
    }

    /**
     * ✅ 通用原子写入方法（Windows 兼容 + 防并发冲突）
     */
    async atomicWriteFile(filePath, data) {
        // ✅ 使用时间戳+随机数避免并发冲突
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 8);
        const tempPath = `${filePath}.tmp.${timestamp}.${random}`;

        try {
            // ✅ 确保父目录存在
            const dir = path.dirname(filePath);
            await fs.mkdir(dir, { recursive: true });

            // 写入临时文件
            await fs.writeFile(tempPath, data);

            // 验证写入成功
            if (!await this.fileExists(tempPath)) {
                throw new Error(`Failed to create temp file: ${tempPath}`);
            }

            const stats = await fs.stat(tempPath);
            if (stats.size === 0 && data.length > 0) {
                throw new Error(`Temp file is empty: ${tempPath}`);
            }

            // ✅ Windows 兼容：先删除再重命名
            try {
                await fs.unlink(filePath);
            } catch (e) {
                if (e.code !== 'ENOENT') {
                    throw e;
                }
            }

            // 重命名临时文件
            await fs.rename(tempPath, filePath);

            // 验证最终文件存在
            if (!await this.fileExists(filePath)) {
                throw new Error(`Final file was not created: ${filePath}`);
            }

            this.debugLog(`Atomically wrote to ${path.basename(filePath)}`);

        } catch (error) {
            console.error(`[VectorDB] Failed to write ${filePath}:`, {
                path: tempPath,
                dest: filePath,
                error: error.message,
                code: error.code
            });

            // 清理临时文件
            try {
                if (await this.fileExists(tempPath)) {
                    await fs.unlink(tempPath);
                }
            } catch (e) { /* ignore */ }

            throw error;
        }
    }

    async loadIndexForSearch(diaryName, dimensions) {
        if (this.indices.has(diaryName)) {
            // ✅ 直接 set，Map 的 set 操作是原子的
            this.lruCache.set(diaryName, { lastAccessed: Date.now() });
            return true;
        }

        await this.acquireLock(diaryName);
        try {
            // 双重检查（double-check locking）
            if (this.indices.has(diaryName)) {
                return true;
            }

            await this.manageMemory();

            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);

            // ✅ 修复：只检查索引文件，不检查JSON文件
            await fs.access(indexPath);

            if (!dimensions) {
                const dummyEmbeddings = await this.getEmbeddingsWithRetry(["."]);
                if (!dummyEmbeddings || dummyEmbeddings.length === 0) {
                    throw new Error("Could not dynamically determine embedding dimensions.");
                }
                dimensions = dummyEmbeddings[0].length;
            }

            const index = new HierarchicalNSW('l2', dimensions);
            index.readIndexSync(indexPath);

            // ✅ 从SQLite数据库读取chunkMap
            const chunkMap = this.storage.getChunkMap(diaryName);

            if (Object.keys(chunkMap).length === 0) {
                console.warn(`[VectorDB] ChunkMap is empty for "${diaryName}", index file exists but no data in database`);
                return false;
            }

            this.indices.set(diaryName, index);
            this.chunkMaps.set(diaryName, chunkMap);
            this.lruCache.set(diaryName, { lastAccessed: Date.now() });
            console.log(`[VectorDB] Lazily loaded index for "${diaryName}" into memory (${Object.keys(chunkMap).length} chunks).`);
            return true;
        } catch (error) {
            console.error(`[VectorDB] Failed to load index for "${diaryName}":`, error.message);
            return false;
        } finally {
            this.releaseLock(diaryName);
        }
    }

    async applyChangeset(changeset) {
        const { diaryName, chunksToAdd, labelsToDelete, newFileHashes } = changeset;

        await this.acquireLock(diaryName);

        // ✅ 定义标志，判断是否需要触发全量重建
        let shouldTriggerFullRebuild = false;

        try {
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            
            // ✅ 关键修复：检查索引文件是否存在
            const indexExists = await this.fileExists(indexPath);
            
            // ✅ 使用时间戳命名备份文件，避免冲突
            const timestamp = Date.now();
            const backupIndexPath = `${indexPath}.backup.${timestamp}`;

            // 第一阶段：创建索引备份（只备份索引文件，不再备份JSON）
            let hasBackup = false;
            try {
                if (indexExists) {
                    await fs.copyFile(indexPath, backupIndexPath);
                    hasBackup = true;
                    this.debugLog(`Created backup: ${path.basename(backupIndexPath)}`);
                }
            } catch (e) {
                this.debugLog(`Backup creation failed (probably first creation):`, e.message);
                hasBackup = false;
            }

            // ✅ 从内存或数据库加载索引和chunkMap
            let index = this.indices.get(diaryName);
            let chunkMap = this.chunkMaps.get(diaryName);

            // 如果内存中没有，尝试从数据库加载
            if (!index || !chunkMap) {
                // ✅ 从数据库加载chunkMap（总是可用）
                chunkMap = this.storage.getChunkMap(diaryName);
                
                if (indexExists) {
                    this.debugLog(`Found existing index file for "${diaryName}", will load if needed.`);
                } else {
                    this.debugLog(`No index file for "${diaryName}", will create new one.`);
                }
            }

            // ✅ 统一深拷贝（无论来源是内存还是文件）
            chunkMap = JSON.parse(JSON.stringify(chunkMap || {}));

            const originalChunkMap = JSON.parse(JSON.stringify(chunkMap));

            // ✅ 预处理：先过滤再决定操作
            let validChunksToAdd = [];
            let validTextsForEmbedding = [];

            if (chunksToAdd.length > 0) {
                const textsForEmbedding = chunksToAdd.map(c => this.prepareTextForEmbedding(c.text));
                validChunksToAdd = chunksToAdd.filter((_, i) => textsForEmbedding[i] !== '[EMPTY_CONTENT]');
                validTextsForEmbedding = validChunksToAdd.map(c => this.prepareTextForEmbedding(c.text));

                if (validChunksToAdd.length < chunksToAdd.length) {
                    console.warn(`[VectorDB] Filtered out ${chunksToAdd.length - validChunksToAdd.length} empty/emoji-only chunks for "${diaryName}"`);
                }
            }

            // ✅ 修复：如果索引文件缺失但数据库有数据，强制重建索引
            const dbHasData = Object.keys(chunkMap).length > 0;
            
            if (validChunksToAdd.length === 0 && labelsToDelete.length === 0) {
                // 检查是否需要修复缺失的索引文件
                if (!indexExists && dbHasData) {
                    console.log(`[VectorDB] Index file missing for "${diaryName}" but database has ${Object.keys(chunkMap).length} chunks. Rebuilding index...`);
                    // ✅ 触发原子修复（不阻塞，标记为需要处理）
                    shouldTriggerFullRebuild = true;
                    return; // 提前返回，让finally块处理
                } else {
                    console.log(`[VectorDB] No valid changes for "${diaryName}". Updating database only.`);
                    this.storage.updateFileHashes(diaryName, newFileHashes);
                    return;
                }
            }

            // 初始化索引（如果需要）
            if (!index) {
                const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
                const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);

                // 尝试加载现有索引
                try {
                    await fs.access(indexPath);

                    // 获取dimensions
                    let dimensions;
                    if (validTextsForEmbedding.length > 0) {
                        const tempVector = await this.getEmbeddingsWithRetry([validTextsForEmbedding[0]]);
                        dimensions = tempVector[0].length;
                    } else {
                        const dummyEmbeddings = await this.getEmbeddingsWithRetry(["."]);
                        dimensions = dummyEmbeddings[0].length;
                    }

                    index = new HierarchicalNSW('l2', dimensions);
                    index.readIndexSync(indexPath);
                    this.indices.set(diaryName, index);
                    this.lruCache.set(diaryName, { lastAccessed: Date.now() });
                    console.log(`[VectorDB] Loaded existing index for "${diaryName}" in applyChangeset.`);
                } catch (e) {
                    // ✅ 索引文件不存在，但数据库有数据 → 数据不一致，需要full rebuild
                    console.warn(`[VectorDB] Index file missing for "${diaryName}" but database has data - triggering full rebuild`);
                    shouldTriggerFullRebuild = true;
                    return; // ✅ 提前返回，让finally块触发重建
                }
            }

            // 第二阶段：删除操作
            if (labelsToDelete.length > 0) {
                console.log(`[VectorDB] Deleting ${labelsToDelete.length} vectors from "${diaryName}".`);
                labelsToDelete.forEach(label => {
                    try {
                        index.markDelete(label);
                        delete chunkMap[label];
                    } catch (e) {
                        console.warn(`[VectorDB] Failed to delete label ${label}:`, e.message);
                    }
                });
            }

            // 第三阶段：获取embeddings
            let vectors = [];
            if (validTextsForEmbedding.length > 0) {
                try {
                    vectors = await this.getEmbeddingsWithRetry(validTextsForEmbedding);

                    if (vectors.length !== validTextsForEmbedding.length) {
                        throw new Error(`Embedding count mismatch: expected ${validTextsForEmbedding.length}, got ${vectors.length}`);
                    }
                } catch (error) {
                    console.error(`[VectorDB] Embedding failed for "${diaryName}":`, error.message);

                    // ✅ embedding失败时，数据库尚未修改，只需回滚内存
                    this.chunkMaps.set(diaryName, originalChunkMap);

                    if (await this.fileExists(backupIndexPath)) {
                        await fs.copyFile(backupIndexPath, indexPath);
                        this.indices.delete(diaryName);
                    }

                    throw error;
                }
            }

            // 第四阶段：添加新向量
            if (vectors.length > 0) {
                console.log(`[VectorDB] Adding ${vectors.length} new vectors to "${diaryName}".`);
                let maxLabel = Object.keys(chunkMap).reduce((max, label) => Math.max(max, Number(label)), -1);

                // ✅ 修复：手动计算当前数量
                const currentCount = Object.keys(chunkMap).length;
                const requiredCapacity = currentCount + vectors.length;
                const currentCapacity = index.getMaxElements();

                if (requiredCapacity > currentCapacity) {
                    const newCapacity = Math.ceil(Math.max(requiredCapacity, currentCapacity * 1.2));
                    console.log(`[VectorDB] Resizing index from ${currentCapacity} to ${newCapacity}`);
                    index.resizeIndex(newCapacity);
                }

                for (let i = 0; i < vectors.length; i++) {
                    const newLabel = ++maxLabel;
                    const chunk = validChunksToAdd[i];
                    try {
                        index.addPoint(vectors[i], newLabel);
                        chunkMap[newLabel] = {
                            text: chunk.text,
                            sourceFile: chunk.sourceFile,
                            chunkHash: chunk.chunkHash
                        };
                    } catch (e) {
                        console.error(`[VectorDB] Failed to add point ${newLabel}:`, e.message);
                    }
                }
            }

            // 第五阶段：保存索引文件和数据库（事务性操作）
            const timestamp2 = Date.now();
            const tempIndexPath = `${indexPath}.tmp.${timestamp2}`;

            let writeSuccess = false;

            try {
                // Step 1: 写入临时索引文件
                this.debugLog(`Writing to temp index: ${path.basename(tempIndexPath)}`);
                await index.writeIndex(tempIndexPath);

                // Step 2: 验证索引文件
                if (!await this.fileExists(tempIndexPath)) {
                    throw new Error(`Index file was not created at ${tempIndexPath}`);
                }
                const indexStats = await fs.stat(tempIndexPath);
                if (indexStats.size === 0) {
                    throw new Error(`Index file is empty: ${tempIndexPath}`);
                }

                // Step 3: 保存到数据库（事务性操作）
                this.debugLog(`Saving chunkMap to database`);
                this.storage.saveChunks(diaryName, chunkMap);

                // Step 4: 验证数据库保存
                const savedChunkMap = this.storage.getChunkMap(diaryName);
                if (Object.keys(savedChunkMap).length !== Object.keys(chunkMap).length) {
                    throw new Error(`Database save verification failed: expected ${Object.keys(chunkMap).length}, got ${Object.keys(savedChunkMap).length}`);
                }

                // Step 5: 替换索引文件（Windows 兼容方式）
                this.debugLog(`Replacing old index file`);
                try {
                    if (await this.fileExists(indexPath)) {
                        await fs.unlink(indexPath);
                    }
                } catch (unlinkError) {
                    // ✅ 忽略ENOENT错误（文件已不存在）
                    if (unlinkError.code !== 'ENOENT') {
                        throw unlinkError;
                    }
                    this.debugLog(`Index file doesn't exist, skipping unlink`);
                }
                await fs.rename(tempIndexPath, indexPath);

                writeSuccess = true;
                this.debugLog(`Index and database update completed successfully`);

            } catch (writeError) {
                console.error(`[VectorDB] Write operation failed for "${diaryName}":`, {
                    error: writeError.message,
                    tempIndex: tempIndexPath
                });

                // ✅ 修复：回滚数据库（因为索引文件保存失败）
                try {
                    console.log(`[VectorDB] Rolling back database changes for "${diaryName}"`);
                    this.storage.saveChunks(diaryName, originalChunkMap);
                    console.log(`[VectorDB] Database rollback successful`);
                } catch (dbRollbackError) {
                    console.error(`[VectorDB] Failed to rollback database:`, dbRollbackError.message);
                }

                // 清理临时文件
                try {
                    if (await this.fileExists(tempIndexPath)) {
                        await fs.unlink(tempIndexPath);
                        this.debugLog(`Cleaned up temp index file`);
                    }
                } catch (cleanupError) {
                    console.warn(`[VectorDB] Failed to cleanup temp file:`, cleanupError.message);
                }

                throw writeError;
            }

            // ✅ 只有在写入成功后才清理备份
            if (writeSuccess && hasBackup) {
                try {
                    if (await this.fileExists(backupIndexPath)) {
                        await fs.unlink(backupIndexPath);
                    }
                    this.debugLog(`Cleaned up backup file`);
                } catch (e) {
                    console.warn(`[VectorDB] Failed to cleanup backup file:`, e.message);
                }
            }

            // 第六阶段：更新文件哈希
            this.storage.updateFileHashes(diaryName, newFileHashes);

            // ✅ 更新内存中的引用
            this.chunkMaps.set(diaryName, chunkMap);

            this.stats.lastUpdateTime = new Date().toISOString();
            console.log(`[VectorDB] Incremental update for "${diaryName}" completed successfully.`);

        } catch (error) {
            console.error(`[VectorDB] Critical error during changeset application for "${diaryName}":`, error);
            
            // ✅ 修复死锁Bug：不在锁内调用rebuildIndexFromDatabase
            console.log(`[VectorDB] Will schedule atomic repair after releasing lock`);
            
            // ✅ 标记需要原子修复，在finally块释放锁后执行
            shouldTriggerFullRebuild = true;
        } finally {
            this.releaseLock(diaryName); // ✅ 先释放锁
        }
        
        // ✅ Bug修复：在锁外执行修复，避免死锁
        if (shouldTriggerFullRebuild) {
            console.log(`[VectorDB] Attempting atomic repair for "${diaryName}" after failed incremental update.`);
            
            // ✅ 先尝试原子修复（从数据库重建索引）
            try {
                await this.rebuildIndexFromDatabase(diaryName);
                console.log(`[VectorDB] Successfully rebuilt index from database for "${diaryName}"`);
            } catch (rebuildError) {
                console.error(`[VectorDB] Atomic repair failed for "${diaryName}":`, rebuildError);
                console.log(`[VectorDB] Scheduling full rebuild worker as fallback`);
                
                // ✅ 原子修复失败，启动Worker进行完整重建
                const workerStarted = this.runFullRebuildWorker(diaryName);
                if (!workerStarted) {
                    // Worker启动失败，需要清理activeWorkers
                    this.activeWorkers.delete(diaryName);
                    console.log(`[VectorDB] Worker failed to start, cleared activeWorker for "${diaryName}"`);
                }
            }
        }
    }

    /**
     * 统一搜索入口
     * @param {string} diaryName - 日记本名称
     * @param {Array} queryVector - 查询向量
     * @param {number} k - 返回结果数量
     * @param {number|null} tagWeight - Tag权重 (0-1之间)，null表示不启用Tag检索
     * @returns {Array} - 搜索结果
     */
    async search(diaryName, queryVector, k = 3, tagWeight = null) {
        // ✅ 如果传入了tagWeight参数，使用Tag增强搜索
        if (tagWeight !== null && tagWeight !== undefined) {
            return await this.searchWithTagBoost(diaryName, queryVector, k, tagWeight);
        }

        // 否则使用普通向量搜索
        const startTime = performance.now();
        const cached = this.searchCache.get(diaryName, queryVector, k);
        if (cached) {
            console.log(`[VectorDB][Search] Cache hit for "${diaryName}"`);
            this.recordMetric('search_success', performance.now() - startTime);
            return cached;
        }

        console.log(`[VectorDB][Search] Received async search request for "${diaryName}".`);
        await this.trackUsage(diaryName);

        // --- Bug Fix: K-value Sanity Check ---
        // 1. Ensure the index is loaded to check its size.
        const loaded = await this.loadIndexForSearch(diaryName);
        if (!loaded) {
            console.error(`[VectorDB][Search] Index for "${diaryName}" could not be loaded. Aborting search.`);
            return [];
        }

        const index = this.indices.get(diaryName);
        const maxElements = index.getMaxElements();

        // 2. If the index is empty, no search is possible.
        if (maxElements === 0) {
            console.log(`[VectorDB][Search] Index for "${diaryName}" is empty. Returning no results.`);
            return [];
        }

        // 3. Clamp the k-value to be no larger than the number of elements in the index.
        const finalK = Math.min(k, maxElements);
        if (finalK !== k) {
            console.warn(`[VectorDB][Search] Requested k=${k} is greater than max elements (${maxElements}) for "${diaryName}". Clamping to k=${finalK}.`);
        }
        // --- End of Bug Fix ---

        try {
            console.log(`[VectorDB][Search] Queuing search task for "${diaryName}" in worker pool.`);
            const workerData = {
                diaryName,
                queryVector,
                k: finalK, // Use the sanitized k-value
                efSearch: this.config.efSearch,
                vectorStorePath: VECTOR_STORE_PATH,
            };

            const message = await this.searchWorkerPool.execute(workerData);

            console.log(`[VectorDB][Search] Received message from worker for "${diaryName}". Status: ${message.status}`);
            if (message.status === 'success') {
                const searchResults = message.results;
                this.searchCache.set(diaryName, queryVector, k, searchResults); // Cache with original k
                this.recordMetric('search_success', performance.now() - startTime);
                console.log(`[VectorDB][Search] Worker found ${searchResults.length} matching chunks for "${diaryName}".`);
                return searchResults;
            } else {
                console.error(`[VectorDB][Search] Worker returned an error for "${diaryName}":`, message.error);
                return [];
            }
        } catch (error) {
            console.error(`[VectorDB][Search] Worker pool task for "${diaryName}" encountered a critical error:`, error);
            return [];
        }
    }

    /**
     * 🌟 带Tag权重的搜索方法（向量融合版 - 不依赖chunk的tag标记）
     * @param {string} diaryName - 日记本名称
     * @param {Array} queryVector - 查询向量
     * @param {number} k - 返回结果数量
     * @param {number} tagWeight - Tag权重/alpha (0-1之间，默认0.65)
     * @returns {Array} - 搜索结果
     */
    async searchWithTagBoost(diaryName, queryVector, k = 3, tagWeight = 0.65) {
        const startTime = performance.now();

        // 如果Tag功能未启用，回退到普通搜索
        if (!this.tagVectorEnabled || !this.tagVectorManager) {
            console.log(`[VectorDB][TagSearch] Tag search disabled, fallback to normal search`);
            return await this.search(diaryName, queryVector, k);
        }

        console.log(`[VectorDB][TagSearch] Starting Tag-enhanced vector search for "${diaryName}" (α=${tagWeight})`);

        try {
            // Step 1: Tag层 - 获取语义相关的tags及其向量
            // ✅ 优化：增加Tag召回数量，形成更密集的知识网络
            // 测试范围：50-100个Tag（从原来的10-20个提升）
            const baseTagCount = 50;  // 基础召回数量
            const scaledTagCount = k * 10;  // 根据k值动态缩放
            const topTagCount = Math.min(Math.max(baseTagCount, scaledTagCount), 100);  // 上限100
            
            console.log(`[VectorDB][TagSearch] Recalling ${topTagCount} tags for network search (k=${k})`);
            const matchedTags = await this.tagVectorManager.searchSimilarTags(queryVector, topTagCount);

            if (matchedTags.length === 0) {
                console.log(`[VectorDB][TagSearch] No matched tags, fallback to normal search`);
                return await this.search(diaryName, queryVector, k);
            }

            console.log(`[VectorDB][TagSearch] Matched ${matchedTags.length} tags:`,
                matchedTags.slice(0, 5).map(t => `${t.tag}(${t.score.toFixed(3)})`).join(', '));

            // 🌟 Step 1.5: Tag图扩展 - 使用共现网络扩展相关tags
            let expandedTags = matchedTags;
            if (this.tagExpanderEnabled && this.tagExpander) {
                try {
                    const seedTags = matchedTags.slice(0, 20).map(t => t.tag); // 取前20个作为种子
                    const maxExpansion = parseInt(process.env.TAG_EXPAND_MAX_COUNT) || 30;
                    const minWeight = parseInt(process.env.TAG_EXPAND_MIN_WEIGHT) || 2;
                    
                    console.log(`[VectorDB][TagSearch] Expanding ${seedTags.length} seed tags via co-occurrence graph (max: ${maxExpansion})...`);
                    const graphExpanded = await this.tagExpander.expandTags(seedTags, maxExpansion);
                    
                    if (graphExpanded.length > 0) {
                        console.log(`[VectorDB][TagSearch] Graph expansion found ${graphExpanded.length} related tags:`,
                            graphExpanded.slice(0, 5).map(t => `${t.tag}(w:${t.weight})`).join(', '));
                        
                        // 🌟 合并向量匹配的tags和图扩展的tags
                        // 过滤掉权重过低的扩展tags
                        const validExpanded = graphExpanded.filter(t => t.weight >= minWeight);
                        
                        // 为图扩展的tags获取向量（如果存在）
                        const expandedWithVectors = [];
                        for (const expTag of validExpanded) {
                            const tagData = this.tagVectorManager.globalTags.get(expTag.tag);
                            if (tagData && tagData.vector) {
                                // 归一化权重到0-1范围（假设权重范围是2-50）
                                const normalizedScore = Math.min(expTag.weight / 50, 1.0);
                                expandedWithVectors.push({
                                    tag: expTag.tag,
                                    score: normalizedScore * 0.8, // 降低扩展tags的权重（相比向量匹配）
                                    frequency: tagData.frequency,
                                    diaryCount: tagData.diaries.size,
                                    diaries: Array.from(tagData.diaries),
                                    isExpanded: true, // 标记为扩展tag
                                    cooccurrenceWeight: expTag.weight
                                });
                            }
                        }
                        
                        console.log(`[VectorDB][TagSearch] Added ${expandedWithVectors.length} graph-expanded tags with vectors`);
                        
                        // 合并原始匹配tags和扩展tags（去重）
                        const allTagsMap = new Map();
                        matchedTags.forEach(t => allTagsMap.set(t.tag, t));
                        expandedWithVectors.forEach(t => {
                            if (!allTagsMap.has(t.tag)) {
                                allTagsMap.set(t.tag, t);
                            }
                        });
                        
                        expandedTags = Array.from(allTagsMap.values());
                        console.log(`[VectorDB][TagSearch] Total tags after expansion: ${expandedTags.length} (${matchedTags.length} vector + ${expandedWithVectors.length} graph)`);
                    } else {
                        console.log(`[VectorDB][TagSearch] No additional tags from graph expansion`);
                    }
                } catch (expandError) {
                    console.error(`[VectorDB][TagSearch] Graph expansion failed:`, expandError.message);
                    // 继续使用原始matchedTags
                }
            }

            // Step 2: 向量融合 - 构建Tag增强的查询向量（使用扩展后的tags）
            // 收集匹配tags的向量（加权平均）
            const tagVectors = [];
            const tagWeights = [];
            
            for (const tagInfo of expandedTags) {
                const tagData = this.tagVectorManager.globalTags.get(tagInfo.tag);
                if (tagData && tagData.vector) {
                    tagVectors.push(tagData.vector);
                    tagWeights.push(tagInfo.score); // 使用相似度作为权重
                }
            }

            if (tagVectors.length === 0) {
                console.warn(`[VectorDB][TagSearch] No tag vectors available after expansion, fallback`);
                return await this.search(diaryName, queryVector, k);
            }

            console.log(`[VectorDB][TagSearch] Using ${tagVectors.length} tag vectors for fusion (${expandedTags.length} total tags)`);

            // 计算tag向量的加权平均
            const dimensions = queryVector.length;
            const avgTagVector = new Array(dimensions).fill(0);
            let totalWeight = 0;

            for (let i = 0; i < tagVectors.length; i++) {
                const weight = tagWeights[i];
                totalWeight += weight;
                for (let j = 0; j < dimensions; j++) {
                    avgTagVector[j] += tagVectors[i][j] * weight;
                }
            }

            // 归一化
            if (totalWeight > 0) {
                for (let j = 0; j < dimensions; j++) {
                    avgTagVector[j] /= totalWeight;
                }
            }

            // 🌟 核心融合公式：enhancedQuery = (1-α)×query + α×tagAvg
            const enhancedQueryVector = new Array(dimensions);
            for (let i = 0; i < dimensions; i++) {
                enhancedQueryVector[i] = (1 - tagWeight) * queryVector[i] + tagWeight * avgTagVector[i];
            }

            console.log(`[VectorDB][TagSearch] Query vector enhanced with ${tagVectors.length} tag vectors (α=${tagWeight})`);

            // Step 3: 使用增强后的向量搜索
            const searchResults = await this.search(diaryName, enhancedQueryVector, k);

            console.log(`[VectorDB][TagSearch] Tag-enhanced search completed in ${(performance.now() - startTime).toFixed(2)}ms`);
            console.log(`[VectorDB][TagSearch] Found ${searchResults.length} results with tag semantic boost`);

            // ✅ 在结果中附加tag信息（包含图扩展信息）
            const enhancedResults = searchResults.map(result => {
                // 计算Tag匹配分数（归一化的平均相似度）
                const avgTagScore = expandedTags.length > 0
                    ? expandedTags.reduce((sum, t) => sum + t.score, 0) / expandedTags.length
                    : 0;
                
                // 计算提权倍数：基于Tag权重和匹配数量
                const boostFactor = 1 + (tagWeight * avgTagScore * Math.min(expandedTags.length, 10) / 10);
                
                // 分离向量匹配的tags和图扩展的tags
                const vectorMatchedTags = expandedTags.filter(t => !t.isExpanded);
                const graphExpandedTags = expandedTags.filter(t => t.isExpanded);
                
                return {
                    ...result,
                    // ✅ 保留原始得分（如果存在）
                    originalScore: result.score,
                    // ✅ Tag增强后的得分
                    score: result.score * boostFactor,
                    // ✅ Tag匹配信息
                    tagMatchScore: avgTagScore,
                    matchedTags: vectorMatchedTags.slice(0, 10).map(t => t.tag), // 向量匹配的tags
                    expandedTags: graphExpandedTags.slice(0, 10).map(t => ({ // 🌟 图扩展的tags
                        tag: t.tag,
                        weight: t.cooccurrenceWeight
                    })),
                    tagMatchCount: vectorMatchedTags.length,
                    expandedTagCount: graphExpandedTags.length, // 🌟 扩展tag数量
                    totalTagCount: expandedTags.length,
                    boostFactor: boostFactor
                };
            });

            this.recordMetric('search_success', performance.now() - startTime);
            return enhancedResults;

        } catch (error) {
            console.error(`[VectorDB][TagSearch] Tag-enhanced search failed:`, error);
            console.log(`[VectorDB][TagSearch] Fallback to normal search`);
            return await this.search(diaryName, queryVector, k);
        }
    }

    /**
     * 根据文本内容获取对应的向量
     * @param {string} diaryName - 日记本名称
     * @param {string} text - 要查找的文本
     * @returns {Array|null} - 返回对应的向量，如果未找到则返回null
     */
    async getVectorByText(diaryName, text) {
        try {
            // 确保索引已加载
            const loaded = await this.loadIndexForSearch(diaryName);
            if (!loaded) {
                console.error(`[VectorDB][getVectorByText] Failed to load index for "${diaryName}"`);
                return null;
            }

            const index = this.indices.get(diaryName);
            const chunkMap = this.chunkMaps.get(diaryName);

            if (!index || !chunkMap) {
                console.error(`[VectorDB][getVectorByText] Index or chunkMap not found for "${diaryName}"`);
                return null;
            }

            // 在 chunkMap 中查找匹配的文本
            const trimmedText = text.trim();
            for (const [label, data] of Object.entries(chunkMap)) {
                if (data.text.trim() === trimmedText) {
                    // 找到匹配的文本，从索引中获取向量
                    try {
                        const vector = index.getPoint(Number(label));
                        return vector;
                    } catch (error) {
                        console.error(`[VectorDB][getVectorByText] Error getting vector for label ${label}:`, error.message);
                        return null;
                    }
                }
            }

            console.warn(`[VectorDB][getVectorByText] Text not found in chunkMap for "${diaryName}"`);
            return null;
        } catch (error) {
            console.error(`[VectorDB][getVectorByText] Error:`, error);
            return null;
        }
    }

    async manageMemory() {
        const memUsage = process.memoryUsage().heapUsed;
        if (memUsage > this.config.maxMemoryUsage) {
            console.log('[VectorDB] Memory threshold exceeded, evicting least recently used indices...');
            const entries = Array.from(this.lruCache.entries()).sort(([, a], [, b]) => a.lastAccessed - b.lastAccessed);
            for (const [diaryName] of entries) {
                if (process.memoryUsage().heapUsed < this.config.maxMemoryUsage * 0.8) break;

                // ✅ 跳过正在处理的索引
                if (this.activeWorkers.has(diaryName)) {
                    console.log(`[VectorDB] Skipping "${diaryName}" - currently active`);
                    continue;
                }

                this.indices.delete(diaryName);
                this.chunkMaps.delete(diaryName);
                this.lruCache.delete(diaryName);
                console.log(`[VectorDB] Evicted index for "${diaryName}" from memory.`);
            }
        }
    }


    /**
     * 同步并缓存所有日记本名称的向量（增量更新）
     */
    async cacheDiaryNameVectors() {
        console.log('[VectorDB] Starting to sync diary book name vectors...');

        // ✅ 加锁防止并发调用
        const lockKey = 'diary_name_vectors';
        await this.acquireLock(lockKey);

        try {
            const diaryNameVectors = this.storage.loadDiaryNameVectors();

            const diaryBooks = await fs.readdir(DIARY_ROOT_PATH, { withFileTypes: true });
            const currentDiaryNames = new Set();
            for (const dirent of diaryBooks) {
                if (dirent.isDirectory() && !dirent.name.startsWith('已整理') && dirent.name !== 'VCP论坛') {
                    currentDiaryNames.add(dirent.name);
                }
            }

            const cachedNames = new Set(diaryNameVectors.keys());
            let hasChanges = false;

            // 检查已删除的日记本
            for (const cachedName of cachedNames) {
                if (!currentDiaryNames.has(cachedName)) {
                    diaryNameVectors.delete(cachedName);
                    hasChanges = true;
                    console.log(`[VectorDB] Removed deleted diary "${cachedName}" from name vector cache.`);
                }
            }

            // 检查新增的日记本
            const namesToVectorize = [];
            for (const currentName of currentDiaryNames) {
                if (!cachedNames.has(currentName)) {
                    namesToVectorize.push(currentName);
                }
            }

            if (namesToVectorize.length > 0) {
                console.log(`[VectorDB] Found ${namesToVectorize.length} new diary books to vectorize.`);
                hasChanges = true;
                try {
                    const vectors = await this.getEmbeddingsWithRetry(namesToVectorize);
                    if (vectors.length !== namesToVectorize.length) {
                        throw new Error(`Vectorization count mismatch: expected ${namesToVectorize.length}, got ${vectors.length}`);
                    }
                    for (let i = 0; i < namesToVectorize.length; i++) {
                        diaryNameVectors.set(namesToVectorize[i], vectors[i]);
                    }
                } catch (error) {
                    console.error('[VectorDB] Failed to vectorize new diary book names:', error);
                    // 如果向量化失败，则不保存，避免写入部分状态
                    return;
                }
            }

            if (hasChanges) {
                this.storage.saveDiaryNameVectors(diaryNameVectors);
                console.log(`[VectorDB] Diary name vector cache updated. Total entries: ${diaryNameVectors.size}.`);
            } else {
                console.log('[VectorDB] Diary name vector cache is up-to-date.');
            }
        } finally {
            this.releaseLock(lockKey);
        }
    }

    /**
     * 获取缓存的日记本名称向量
     * @param {string} diaryName - 日记本名称
     * @returns {Array|null} - 向量数组或null
     */
    getDiaryNameVector(diaryName) {
        const vectors = this.storage.loadDiaryNameVectors();
        return vectors.get(diaryName) || null;
    }

    /**
     * ✅ 批量写入优化：记录使用统计到内存缓冲区
     * 使用防抖机制，减少磁盘写入频率
     */
    trackUsage(diaryName) {
        // 更新内存缓冲区（无需异步操作，性能更好）
        const current = this.usageStatsBuffer.get(diaryName) || {
            frequency: 0,
            lastAccessed: null
        };
        current.frequency++;
        current.lastAccessed = Date.now();
        this.usageStatsBuffer.set(diaryName, current);

        // 防抖：重置定时器
        if (this.usageStatsFlushTimer) {
            clearTimeout(this.usageStatsFlushTimer);
        }

        // 设置新的延迟写入任务
        this.usageStatsFlushTimer = setTimeout(() => {
            this.flushUsageStats().catch(e => {
                console.error('[VectorDB] Failed to flush usage stats:', e);
            });
        }, this.usageStatsFlushDelay);
    }

    /**
     * ✅ 将缓冲区数据批量写入磁盘
     */
    async flushUsageStats() {
        if (this.usageStatsBuffer.size === 0) {
            this.debugLog('Usage stats buffer is empty, skipping flush');
            return;
        }

        const lockKey = 'usage_stats';
        let bufferSnapshot; // ✅ 在外部作用域定义，避免catch块中未定义
        let lockAcquired = false; // ✅ Bug修复3：追踪锁状态
        
        try {
            await this.acquireLock(lockKey);
            lockAcquired = true; // ✅ 标记锁已获取
            
            bufferSnapshot = new Map(this.usageStatsBuffer);
            this.usageStatsBuffer.clear();

            // ✅ 直接写入SQLite
            this.storage.updateUsageStats(bufferSnapshot);

            this.debugLog(`Flushed ${bufferSnapshot.size} usage stats to database`);

        } catch (e) {
            console.error('[VectorDB] Failed to flush usage stats:', e.message);

            // 写入失败时放回缓冲区
            if (bufferSnapshot) { // ✅ 检查是否存在
                for (const [diaryName, data] of bufferSnapshot.entries()) {
                    const existing = this.usageStatsBuffer.get(diaryName);
                    if (existing) {
                        existing.frequency += data.frequency;
                        if (data.lastAccessed > existing.lastAccessed) {
                            existing.lastAccessed = data.lastAccessed;
                        }
                    } else {
                        this.usageStatsBuffer.set(diaryName, data);
                    }
                }
            }

            if (!this.isShuttingDown) {
                setTimeout(() => {
                    this.flushUsageStats().catch(console.error);
                }, 10000);
            }
        } finally {
            if (lockAcquired) { // ✅ Bug修复3：只释放已持有的锁
                this.releaseLock(lockKey);
            }
        }
    }

    async preWarmIndices() {
        console.log('[VectorDB] Starting index pre-warming...');
        const usageStats = this.storage.loadUsageStats();
        const sortedDiaries = Object.entries(usageStats)
            .sort(([, a], [, b]) => b.frequency - a.frequency)
            .map(([name]) => name);

        const preLoadCount = Math.min(this.config.preWarmCount, sortedDiaries.length);
        if (preLoadCount === 0) {
            console.log('[VectorDB] No usage stats found, skipping pre-warming.');
            return;
        }
        
        // ✅ 修复：只探测一次dimensions，避免重复向量化
        let sharedDimensions = null;
        try {
            console.log(`[VectorDB] Probing embedding dimensions...`);
            const dummyEmbeddings = await this.getEmbeddingsWithRetry(["."]);
            if (dummyEmbeddings && dummyEmbeddings.length > 0) {
                sharedDimensions = dummyEmbeddings[0].length;
                console.log(`[VectorDB] ✅ Detected embedding dimensions: ${sharedDimensions} (single probe for all indices)`);
            }
        } catch (error) {
            console.warn(`[VectorDB] ⚠️ Failed to detect dimensions:`, error.message);
            console.warn(`[VectorDB] Will skip pre-warming and continue startup`);
            return; // ✅ 失败时直接返回，不阻塞启动
        }
        
        const preLoadPromises = sortedDiaries
            .slice(0, preLoadCount)
            .map(diaryName => this.loadIndexForSearch(diaryName, sharedDimensions));
        
        await Promise.all(preLoadPromises);
        console.log(`[VectorDB] Pre-warmed ${preLoadCount} most frequently used indices.`);
    }

    async fileExists(filePath) {
        try {
            await fs.access(filePath);
            return true;
        } catch {
            return false;
        }
    }
    /**
     * ✅ 新增：智能同步索引与数据库（基于差异diff修复）
     * 只处理缺失的chunk，不重新embedding已有数据
     */
    async syncIndexWithDatabase(diaryName) {
        await this.acquireLock(diaryName);
        try {
            console.log(`[VectorDB] Syncing index with database for "${diaryName}"...`);
            
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            
            // 从数据库加载完整数据
            const chunkMap = this.storage.getChunkMap(diaryName);
            const dbLabels = new Set(Object.keys(chunkMap).map(Number));
            
            if (dbLabels.size === 0) {
                console.warn(`[VectorDB] No chunks in database for "${diaryName}", skipping sync`);
                return;
            }
            
            // 尝试加载现有索引
            let index = null;
            let indexLabels = new Set();
            
            try {
                // 获取dimensions
                const dummyText = Object.values(chunkMap)[0].text;
                const cleanedText = this.prepareTextForEmbedding(dummyText);
                const dummyEmbedding = await this.getEmbeddingsWithRetry([cleanedText]);
                const dimensions = dummyEmbedding[0].length;
                
                index = new HierarchicalNSW('l2', dimensions);
                index.readIndexSync(indexPath);
                
                // 收集索引中的labels
                for (const label of dbLabels) {
                    try {
                        index.getPoint(label);
                        indexLabels.add(label);
                    } catch (e) {
                        // label不存在
                    }
                }
                
                console.log(`[VectorDB] Index has ${indexLabels.size}/${dbLabels.size} chunks from database`);
            } catch (e) {
                console.log(`[VectorDB] Cannot load index, will create new one`);
            }
            
            // 计算需要添加的chunks（在数据库中但不在索引中）
            const missingLabels = Array.from(dbLabels).filter(l => !indexLabels.has(l));
            
            if (missingLabels.length === 0 && indexLabels.size === dbLabels.size) {
                console.log(`[VectorDB] Index and database are already in sync for "${diaryName}"`);
                return;
            }
            
            console.log(`[VectorDB] Need to add ${missingLabels.length} missing chunks to index`);
            
            // 只对缺失的chunks获取embedding
            const missingChunks = missingLabels.map(label => {
                const data = chunkMap[label];
                return this.prepareTextForEmbedding(data.text);
            });
            
            const vectors = await this.getEmbeddingsWithRetry(missingChunks);
            
            if (vectors.length !== missingLabels.length) {
                throw new Error(`Embedding count mismatch: expected ${missingLabels.length}, got ${vectors.length}`);
            }
            
            // 如果没有索引，创建新的
            if (!index) {
                const dimensions = vectors[0].length;
                index = new HierarchicalNSW('l2', dimensions);
                index.initIndex(dbLabels.size);
                
                // 先添加所有已存在的chunks（需要重新embedding）
                console.log(`[VectorDB] Creating new index with ${dbLabels.size} chunks...`);
                const allTexts = Array.from(dbLabels).map(label => 
                    this.prepareTextForEmbedding(chunkMap[label].text)
                );
                const allVectors = await this.getEmbeddingsWithRetry(allTexts);
                
                const sortedLabels = Array.from(dbLabels).sort((a, b) => a - b);
                for (let i = 0; i < allVectors.length; i++) {
                    index.addPoint(allVectors[i], sortedLabels[i]);
                }
            } else {
                // 只添加缺失的chunks
                for (let i = 0; i < missingLabels.length; i++) {
                    try {
                        index.addPoint(vectors[i], missingLabels[i]);
                    } catch (e) {
                        console.error(`[VectorDB] Failed to add point ${missingLabels[i]}:`, e.message);
                    }
                }
            }
            
            // 保存索引文件
            await index.writeIndex(indexPath);
            
            // 更新内存
            this.indices.set(diaryName, index);
            this.chunkMaps.set(diaryName, chunkMap);
            
            console.log(`[VectorDB] ✅ Index synced with database for "${diaryName}" (${dbLabels.size} chunks, added ${missingLabels.length} missing)`);
        } catch (error) {
            console.error(`[VectorDB] Failed to sync index for "${diaryName}":`, error);
            throw error;
        } finally {
            this.releaseLock(diaryName);
        }
    }


    /**
     * ✅ 新增：从数据库重建索引（原子化修复，无需重新扫描文件）
     */
    async rebuildIndexFromDatabase(diaryName) {
        await this.acquireLock(diaryName);
        try {
            console.log(`[VectorDB] Rebuilding index from database for "${diaryName}"...`);

            const chunkMap = this.storage.getChunkMap(diaryName);
            const chunks = Object.values(chunkMap).map(data => data.text);

            if (chunks.length === 0) {
                console.warn(`[VectorDB] No chunks in database for "${diaryName}", skipping rebuild`);
                return;
            }

            // 清理后的文本用于embedding
            const cleanedTexts = chunks.map(text => this.prepareTextForEmbedding(text));

            // 获取embeddings
            console.log(`[VectorDB] Getting embeddings for ${chunks.length} chunks from database...`);
            const vectors = await this.getEmbeddingsWithRetry(cleanedTexts);

            if (vectors.length !== chunks.length) {
                throw new Error(`Embedding count mismatch: expected ${chunks.length}, got ${vectors.length}`);
            }

            // 创建新索引
            const dimensions = vectors[0].length;
            const index = new HierarchicalNSW('l2', dimensions);
            index.initIndex(chunks.length);

            // 添加所有向量
            const labels = Object.keys(chunkMap).map(Number).sort((a, b) => a - b);
            for (let i = 0; i < vectors.length; i++) {
                index.addPoint(vectors[i], labels[i]);
            }

            // 保存索引文件
            const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
            const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);
            await index.writeIndex(indexPath);

            // 更新内存
            this.indices.set(diaryName, index);
            this.chunkMaps.set(diaryName, chunkMap);

            console.log(`[VectorDB] ✅ Index rebuilt from database for "${diaryName}" (${chunks.length} vectors)`);
        } catch (error) {
            console.error(`[VectorDB] Failed to rebuild index from database for "${diaryName}":`, error);
            throw error;
        } finally {
            this.releaseLock(diaryName);
        }
    }

    async shutdown() {
        console.log('[VectorDB] Shutting down...');
        this.isShuttingDown = true;

        // ✅ 取消待处理的flush定时器
        if (this.usageStatsFlushTimer) {
            clearTimeout(this.usageStatsFlushTimer);
            this.usageStatsFlushTimer = null;
        }

        // ✅ 立即刷新缓冲区数据（确保数据不丢失）
        if (this.usageStatsBuffer.size > 0) {
            console.log('[VectorDB] Flushing usage stats buffer before shutdown...');
            try {
                await this.flushUsageStats();
                console.log('[VectorDB] Usage stats flushed successfully.');
            } catch (e) {
                console.error('[VectorDB] Failed to flush usage stats during shutdown:', e);
            }
        }

        // 关闭 worker pool
        if (this.searchWorkerPool && typeof this.searchWorkerPool.terminate === 'function') {
            await this.searchWorkerPool.terminate();
            console.log('[VectorDB] Worker pool shut down successfully.');
        } else {
            console.log('[VectorDB] Worker pool not found or does not have a terminate method.');
        }

        // 关闭数据库连接
        this.storage.close();

        console.log('[VectorDB] Shutdown complete.');
    }
}

// --- Standalone functions for Worker ---
async function getEmbeddingsInWorker(chunks, config) {
    const { default: fetch } = await import('node-fetch');
    const allVectors = [];
    const batchSize = parseInt(process.env.VECTORDB_BATCH_SIZE) || 5;

    const retryAttempts = config.retryAttempts || 3;
    const retryBaseDelay = config.retryBaseDelay || 1000;
    const retryMaxDelay = config.retryMaxDelay || 10000;

    for (let i = 0; i < chunks.length; i += batchSize) {
        const batch = chunks.slice(i, i + batchSize);

        let lastError;
        for (let attempt = 1; attempt <= retryAttempts; attempt++) {
            try {
                const response = await fetch(`${config.apiUrl}/v1/embeddings`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${config.apiKey}`
                    },
                    body: JSON.stringify({
                        model: config.embeddingModel,
                        input: batch
                    })
                });

                if (!response.ok) {
                    const errorBody = await response.text();
                    const err = new Error(`Embedding API error: ${response.status} - ${errorBody}`);
                    err.status = response.status;
                    err.headers = response.headers; // ✅ 保存headers
                    throw err;
                }

                const data = await response.json();

                if (!data.data || !Array.isArray(data.data)) {
                    throw new Error(`Invalid API response: missing data array`);
                }

                const vectors = data.data.map(item => item.embedding);

                for (let j = 0; j < vectors.length; j++) {
                    if (!vectors[j] || !Array.isArray(vectors[j]) || vectors[j].length === 0) {
                        throw new Error(`Invalid embedding at index ${j} for text: "${batch[j].substring(0, 50)}..."`);
                    }
                }

                if (vectors.length !== batch.length) {
                    throw new Error(`Batch size mismatch: sent ${batch.length}, received ${vectors.length}`);
                }

                allVectors.push(...vectors);

                lastError = null;
                break;
            } catch (error) {
                lastError = error;
                console.error(`[VectorDB][Worker] Batch attempt ${attempt}/${retryAttempts} failed:`, error.message);

                if (attempt < retryAttempts) {
                    let delay;

                    if (error.status === 429) {
                        const retryAfter = error.headers?.get('retry-after');
                        if (retryAfter) {
                            if (/^\d+$/.test(retryAfter)) {
                                delay = parseInt(retryAfter) * 1000;
                            } else {
                                const retryDate = new Date(retryAfter);
                                delay = retryDate.getTime() - Date.now();
                            }
                            delay = Math.max(0, Math.min(delay, 60000)); // Wait at most 60s
                        } else {
                            delay = 30000; // Default 30s
                        }
                        console.log(`[VectorDB][Worker] Rate limited (429). Waiting ${delay}ms...`);
                    } else {
                        delay = Math.min(retryBaseDelay * Math.pow(2, attempt - 1), retryMaxDelay);
                    }

                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }

        if (lastError) {
            // ✅ 区分429限流错误和其他错误
            if (lastError.status === 429) {
                console.warn(`[VectorDB][Worker] Rate limit hit after ${retryAttempts} attempts. Stopping batch processing to allow quota recovery.`);
                console.warn(`[VectorDB][Worker] Progress has been saved. Will resume on next run.`);
                // ✅ 抛出特殊的限流错误，让Worker知道这是可恢复的
                const rateLimitError = new Error('RATE_LIMIT_EXCEEDED');
                rateLimitError.isRateLimitError = true;
                rateLimitError.processedCount = i; // 记录已处理的chunk数量
                throw rateLimitError;
            } else {
                // 其他错误按原逻辑处理
                throw new Error(
                    `Failed to embed batch (chunks ${i}-${i + batch.length - 1}) after ${retryAttempts} attempts.\n` +
                    `Last error: ${lastError.message}\n` +
                    `Sample text: "${batch[0].substring(0, 100)}..."`
                );
            }
        }
    }
    return allVectors;
}

async function processSingleDiaryBookInWorker(diaryName, config) {
    const VectorDBStorage = require('./VectorDBStorage.js');

    // ✅ 定义 emoji 清理函数（与主类保持一致）
    const prepareTextForEmbedding = (text) => {
        const decorativeEmojis = /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu;
        let cleaned = text.replace(decorativeEmojis, ' ').replace(/\s+/g, ' ').trim();
        return cleaned.length === 0 ? '[EMPTY_CONTENT]' : cleaned;
    };

    const diaryPath = path.join(DIARY_ROOT_PATH, diaryName);
    const files = await fs.readdir(diaryPath);
    const relevantFiles = files.filter(f => f.toLowerCase().endsWith('.txt') || f.toLowerCase().endsWith('.md'));

    // ✅ 初始化Storage
    const storage = new VectorDBStorage(VECTOR_STORE_PATH);
    await storage.initialize();

    try {
        // ✅ Step 1: 检查是否有未完成的构建进度
        const progress = storage.getBuildProgress(diaryName);
        const processedFiles = progress ? new Set(progress.processedFiles) : new Set();

        console.log(`[VectorDB][Worker] "${diaryName}" build progress: ${processedFiles.size}/${relevantFiles.length} files processed`);

        // ✅ Step 2: 加载已有的索引和chunkMap（如果存在）
        const safeFileNameBase = Buffer.from(diaryName, 'utf-8').toString('base64url');
        const indexPath = path.join(VECTOR_STORE_PATH, `${safeFileNameBase}.bin`);

        let index = null;
        let chunkMap = {};
        let labelCounter = 0;
        let dimensions = null;

        // 尝试加载现有索引
        try {
            await fs.access(indexPath);
            const existingChunkMap = storage.getChunkMap(diaryName);

            if (Object.keys(existingChunkMap).length > 0) {
                chunkMap = existingChunkMap;
                labelCounter = Math.max(...Object.keys(chunkMap).map(Number)) + 1;

                // 获取dimensions
                const dummyText = Object.values(chunkMap)[0].text;
                const dummyEmbedding = await getEmbeddingsInWorker([prepareTextForEmbedding(dummyText)], config);
                dimensions = dummyEmbedding[0].length;

                index = new HierarchicalNSW('l2', dimensions);
                index.readIndexSync(indexPath);

                console.log(`[VectorDB][Worker] Loaded existing index with ${Object.keys(chunkMap).length} chunks, continuing from label ${labelCounter}`);
            }
        } catch (e) {
            console.log(`[VectorDB][Worker] No existing index found, will create new one`);
        }

        // ✅ Step 3: 渐进式处理文件（按文件为单位保存）
        const fileHashes = {};
        const SAVE_INTERVAL = parseInt(process.env.VECTORDB_SAVE_INTERVAL) || 10; // 每10个文件保存一次
        let filesProcessedSinceLastSave = 0;

        for (const file of relevantFiles) {
            // 跳过已处理的文件
            if (processedFiles.has(file)) {
                console.log(`[VectorDB][Worker] Skipping already processed file: "${file}"`);
                const filePath = path.join(diaryPath, file);
                const content = await fs.readFile(filePath, 'utf-8');
                fileHashes[file] = crypto.createHash('md5').update(content).digest('hex');
                continue;
            }

            const filePath = path.join(diaryPath, file);
            const content = await fs.readFile(filePath, 'utf-8');
            fileHashes[file] = crypto.createHash('md5').update(content).digest('hex');

            const chunks = chunkText(content);
            const fileChunks = [];
            const fileChunkTexts = [];

            for (const chunk of chunks) {
                const cleanedText = prepareTextForEmbedding(chunk);
                if (cleanedText === '[EMPTY_CONTENT]') {
                    continue;
                }

                const chunkHash = crypto.createHash('sha256').update(chunk).digest('hex');
                fileChunks.push({ chunk, chunkHash });
                fileChunkTexts.push(cleanedText);
            }

            if (fileChunks.length === 0) {
                console.warn(`[VectorDB][Worker] File "${file}" has no valid chunks, skipping`);
                processedFiles.add(file);
                continue;
            }

            // ✅ 获取这个文件的所有embeddings
            console.log(`[VectorDB][Worker] Processing file "${file}" (${fileChunks.length} chunks)...`);
            let fileVectors;
            try {
                fileVectors = await getEmbeddingsInWorker(fileChunkTexts, config);

                if (fileVectors.length !== fileChunks.length) {
                    throw new Error(`Embedding count mismatch for file "${file}": expected ${fileChunks.length}, got ${fileVectors.length}`);
                }
            } catch (error) {
                // ✅ 特殊处理：遇到429限流错误时优雅退出
                if (error.isRateLimitError) {
                    console.warn(`[VectorDB][Worker] ⏸️ Rate limit encountered while processing "${file}"`);
                    console.warn(`[VectorDB][Worker] Progress saved: ${processedFiles.size}/${relevantFiles.length} files completed`);
                    console.warn(`[VectorDB][Worker] Next file to process: "${file}"`);

                    // 保存当前进度（不包括当前失败的文件）
                    if (processedFiles.size > 0) {
                        await index.writeIndex(indexPath);
                        storage.saveChunks(diaryName, chunkMap);
                        storage.saveBuildProgress(diaryName, Array.from(processedFiles), relevantFiles.length, Array.from(processedFiles).pop());
                        console.log(`[VectorDB][Worker] ✅ Progress checkpoint saved before rate limit pause`);
                    }

                    storage.close();

                    // ✅ 抛出特殊错误让Manager知道这是正常的暂停
                    const pauseError = new Error(`Rate limit reached. Progress saved at ${processedFiles.size}/${relevantFiles.length} files. Will resume automatically on next run.`);
                    pauseError.isPauseError = true;
                    pauseError.processedFiles = processedFiles.size;
                    pauseError.totalFiles = relevantFiles.length;
                    throw pauseError;
                }

                // 其他错误正常抛出
                throw error;
            }

            // ✅ 初始化索引（如果还没有）
            if (!index) {
                dimensions = fileVectors[0].length;
                index = new HierarchicalNSW('l2', dimensions);
                // ✅ 修复：智能容量预估，支持大规模专业论文集
                const processedChunkCount = Object.keys(chunkMap).length;
                const processedFileCount = processedFiles.size;
                const remainingFiles = relevantFiles.length - processedFiles.size;
                
                let estimatedTotal;
                
                if (processedFileCount > 0) {
                    // 基于已处理文件动态计算平均值
                    const avgChunksPerFile = Math.ceil(processedChunkCount / processedFileCount);
                    estimatedTotal = processedChunkCount + (remainingFiles * avgChunksPerFile);
                    console.log(`[VectorDB][Worker] Capacity estimation based on ${processedFileCount} processed files (avg: ${avgChunksPerFile} chunks/file)`);
                } else {
                    // 首次创建：基于总文件数做保守估计
                    // 假设每个文件至少200个chunks（适配大型论文集）
                    const conservativeEstimate = relevantFiles.length * 200;
                    estimatedTotal = Math.max(conservativeEstimate, 5000);
                    console.log(`[VectorDB][Worker] Initial capacity estimation for ${relevantFiles.length} files: ${estimatedTotal} chunks`);
                }
                
                // ✅ 关键：为大规模数据集增加50%缓冲（而非20%）
                const capacityWithBuffer = Math.ceil(estimatedTotal * 1.5);
                const finalCapacity = Math.max(capacityWithBuffer, 10000); // 最小容量提升到10000
                
                index.initIndex(finalCapacity);
                console.log(`[VectorDB][Worker] ✅ Index initialized with capacity: ${finalCapacity.toLocaleString()} (estimated: ${estimatedTotal.toLocaleString()})`);
            }
            
            // ✅ 添加这个文件的所有向量到索引（带容量检查）
            for (let i = 0; i < fileVectors.length; i++) {
                const currentLabel = labelCounter++;
                
                // ✅ 关键修复：添加前检查容量，必要时扩容
                const currentCount = Object.keys(chunkMap).length + 1;
                const currentCapacity = index.getMaxElements();
                
                if (currentCount > currentCapacity) {
                    const newCapacity = Math.ceil(currentCapacity * 1.5);
                    console.log(`[VectorDB][Worker] ⚠️ Capacity exceeded! Resizing from ${currentCapacity} to ${newCapacity}`);
                    index.resizeIndex(newCapacity);
                }
                
                index.addPoint(fileVectors[i], currentLabel);
                chunkMap[currentLabel] = {
                    text: fileChunks[i].chunk,
                    sourceFile: file,
                    chunkHash: fileChunks[i].chunkHash
                };
            }

            processedFiles.add(file);
            filesProcessedSinceLastSave++;

            // ✅ Step 4: 定期保存进度（每N个文件或最后一个文件）
            const isLastFile = processedFiles.size === relevantFiles.length;
            const shouldSave = filesProcessedSinceLastSave >= SAVE_INTERVAL || isLastFile;

            if (shouldSave) {
                console.log(`[VectorDB][Worker] Saving progress: ${processedFiles.size}/${relevantFiles.length} files (${Object.keys(chunkMap).length} chunks)...`);

                // 保存索引文件
                await index.writeIndex(indexPath);

                // 保存chunkMap到数据库
                storage.saveChunks(diaryName, chunkMap);

                // 验证保存
                const savedChunkMap = storage.getChunkMap(diaryName);
                if (Object.keys(savedChunkMap).length !== Object.keys(chunkMap).length) {
                    throw new Error(`Checkpoint save verification failed: expected ${Object.keys(chunkMap).length}, got ${Object.keys(savedChunkMap).length}`);
                }

                // 保存进度
                if (!isLastFile) {
                    storage.saveBuildProgress(diaryName, Array.from(processedFiles), relevantFiles.length, file);
                    console.log(`[VectorDB][Worker] ✅ Checkpoint saved: ${processedFiles.size}/${relevantFiles.length} files`);
                }

                filesProcessedSinceLastSave = 0;
            }
        }

        // ✅ Step 5: 最终验证
        if (Object.keys(chunkMap).length === 0) {
            throw new Error(`Diary "${diaryName}" resulted in 0 valid chunks after processing all files`);
        }

        // ✅ Step 6: 清除构建进度（完成）
        storage.clearBuildProgress(diaryName);

        console.log(`[VectorDB][Worker] ✅ Full rebuild completed successfully for "${diaryName}" (${Object.keys(chunkMap).length} chunks from ${relevantFiles.length} files).`);
        storage.close();
        return fileHashes;

    } catch (error) {
        console.error(`[VectorDB][Worker] ❌ Build failed for "${diaryName}":`, error.message);

        // ✅ 关键：失败时不删除已保存的进度！
        // 保留索引文件和数据库数据，下次可以继续
        try {
            storage.close();
        } catch (e) { /* ignore */ }

        throw error;
    }
}

module.exports = { VectorDBManager, processSingleDiaryBookInWorker };
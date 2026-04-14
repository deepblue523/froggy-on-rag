const { EventEmitter } = require('events');
const path = require('path');
const fs = require('fs');
const { performance } = require('perf_hooks');
const { v4: uuidv4 } = require('uuid');
const chokidar = require('chokidar');
const { VectorStore } = require('./vector-store');
const { DocumentProcessor } = require('./document-processor');
const { SearchService } = require('./search-service');
const { WebSearchService } = require('./web-search-service');
const { getAppSettingsPath } = require('../../paths');
const {
  splitSettingsForPersist,
  mergeSettingsLayers,
  readJsonObject,
  patchAppSettings,
  writeAppAndNamespace,
  migrateLegacySettingsJson
} = require('../../settings-files');

/** Compare two paths for equality (case-insensitive on Windows). */
function pathsEqual(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

class RAGService extends EventEmitter {
  constructor(dataDir) {
    super();
    this._disposed = false;
    this.dataDir = dataDir;
    this.appSettingsPath = getAppSettingsPath();
    this.namespacePath = path.join(dataDir, 'namespace.json');
    this.legacySettingsPath = path.join(dataDir, 'settings.json');
    this.vectorStore = new VectorStore(dataDir);
    this.searchService = new SearchService(this.vectorStore);
    this.webSearchService = new WebSearchService();
    this.searchProfilingEnabled = process.env.SEARCH_PROFILE === '1';
    
    // Initialize embedding model (lazy load)
    this.embeddingModel = null;
    
    // Settings (load before creating document processor)
    this.settings = this.loadSettings();
    this.webSearchService.configure(this.settings);
    
    // Load embedding model and create document processor
    this.loadEmbeddingModel();
    
    const normalizeEmbeddings = this.settings.normalizeEmbeddings !== false; // Default to true
    this.documentProcessor = new DocumentProcessor(this.embeddingModel, normalizeEmbeddings);
    
    // Ingestion queue
    this.ingestionQueue = [];
    this.processing = false;
    this.activeProcessingCount = 0;
    this.maxConcurrentProcessing = 3; // Process up to 3 files concurrently
    
    // File watchers
    this.fileWatchers = new Map();
    this.directoryWatchers = new Map();
    
    // Start processing queue
    this.startQueueProcessor();
    
    // Restore watched files/directories
    this.restoreWatchers();
    
    // Sync watched files/directories with vector store on startup (non-blocking)
    // Don't await - let it run in the background so app can start quickly
    this.syncWatchedFilesWithVectorStore().catch(err => {
      console.error('Error syncing watched files:', err);
    });
  }

  async loadEmbeddingModel() {
    try {
      // Use embedding model from settings, or default
      const modelName = this.settings.embeddingModel || 'Xenova/all-MiniLM-L6-v2';
      const { pipeline } = await import('@xenova/transformers');
      this.embeddingModel = await pipeline('feature-extraction', modelName);
      if (this.documentProcessor) {
        this.documentProcessor.embeddingModel = this.embeddingModel;
      }
    } catch (error) {
      console.error('Error loading embedding model:', error);
      // Continue without model - will use fallback
    }
  }

  _defaultSettings() {
    return {
      files: [],
      directories: [],
      mruSearches: [],
      splitterPosition: 250,
      chunkSize: 1000,
      chunkOverlap: 200,
      retrievalTopK: 10,
      retrievalScoreThreshold: 0,
      retrievalMaxChunksPerDoc: 0,
      retrievalGroupByDoc: false,
      retrievalReturnFullDocs: false,
      retrievalMaxContextTokens: 0,
      searchProfiling: false,
      minimizeToTray: false,
      webSearchEnabled: false,
      webSearchApiKey: '',
      webSearchCx: '',
      webSearchMaxResults: 5,
      webSearchSafeSearch: 'off',
      webSearchTimeoutMs: 10000,
      webSearchFetchPages: true,
      webSearchFetchMaxBytes: 1048576,
      webSearchPageFetchTimeoutMs: 8000
    };
  }

  loadSettings() {
    migrateLegacySettingsJson(
      this.legacySettingsPath,
      this.appSettingsPath,
      this.namespacePath
    );
    const appLayer = readJsonObject(this.appSettingsPath);
    const namespaceLayer = readJsonObject(this.namespacePath);
    return mergeSettingsLayers(this._defaultSettings(), appLayer, namespaceLayer);
  }

  _saveSettingsToDisk() {
    try {
      const { app, namespace } = splitSettingsForPersist(this.settings);
      writeAppAndNamespace(this.appSettingsPath, this.namespacePath, app, namespace);
    } catch (error) {
      console.error('Error saving settings:', error);
    }
  }

  getSettings() {
    return this.settings;
  }

  saveSettings(newSettings) {
    if (newSettings) {
      this.settings = { ...this.settings, ...newSettings };
      
      // Update document processor if normalizeEmbeddings changed
      if (newSettings.normalizeEmbeddings !== undefined && this.documentProcessor) {
        this.documentProcessor.normalizeEmbeddings = newSettings.normalizeEmbeddings;
      }
      
      // Reload embedding model if model changed
      if (newSettings.embeddingModel && newSettings.embeddingModel !== this.settings.embeddingModel) {
        this.loadEmbeddingModel();
      }

      // Reconfigure web search service when relevant settings change
      this.webSearchService.configure(this.settings);
    }
    
    this._saveSettingsToDisk();

    // Merge-write app file again for web search so keys are never dropped by a
    // race with window-state saves or partial IPC payloads.
    const ws = this.settings;
    patchAppSettings(this.appSettingsPath, {
      webSearchEnabled: ws.webSearchEnabled || false,
      webSearchApiKey: ws.webSearchApiKey || '',
      webSearchCx: ws.webSearchCx || '',
      webSearchMaxResults: ws.webSearchMaxResults || 5,
      webSearchSafeSearch: ws.webSearchSafeSearch || 'off',
      webSearchTimeoutMs: (() => {
        const n = Number(ws.webSearchTimeoutMs);
        if (!Number.isFinite(n) || n < 0) return 10000;
        return Math.min(Math.floor(n), 600000);
      })(),
      webSearchFetchPages: ws.webSearchFetchPages !== false,
      webSearchFetchMaxBytes: (() => {
        const n = Number(ws.webSearchFetchMaxBytes);
        if (!Number.isFinite(n) || n < 4096) return 1048576;
        return Math.min(Math.floor(n), 10 * 1024 * 1024);
      })(),
      webSearchPageFetchTimeoutMs: (() => {
        const n = Number(ws.webSearchPageFetchTimeoutMs);
        if (!Number.isFinite(n) || n < 0) return 8000;
        return Math.min(Math.floor(n), 120000);
      })()
    });

    return this.settings;
  }

  async ingestFile(filePath, watch = false) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const fileId = this.getFileId(filePath);
    
    // Add to settings if not exists
    let fileEntry = this.settings.files.find(f => f.path === filePath);
    if (!fileEntry) {
      fileEntry = {
        path: filePath,
        watch: watch,
        active: true, // Default to active
        id: fileId
      };
      this.settings.files.push(fileEntry);
      this._saveSettingsToDisk();
    }

    // Only add to queue if active
    if (fileEntry.active !== false) {
      this.addToQueue(filePath, 'file');
    }
    
    // Set up file watcher if requested
    if (watch) {
      this.watchFile(filePath);
    }

    return { fileId, status: 'queued' };
  }

  async ingestDirectory(dirPath, recursive = false, watch = false) {
    if (!fs.existsSync(dirPath)) {
      throw new Error(`Directory not found: ${dirPath}`);
    }

    // Add to settings if not exists
    let dirEntry = this.settings.directories.find(d => d.path === dirPath);
    if (!dirEntry) {
      dirEntry = {
        path: dirPath,
        watch: watch,
        recursive: recursive,
        active: true, // Default to active
        id: uuidv4()
      };
      this.settings.directories.push(dirEntry);
      this._saveSettingsToDisk();
    }

    // Find all supported files
    const files = this.findSupportedFiles(dirPath, recursive);
    
    // Only add files to queue if directory is active
    if (dirEntry.active !== false) {
      for (const file of files) {
        this.addToQueue(file, 'file');
      }
    }

    // Set up directory watcher if requested
    if (watch) {
      this.watchDirectory(dirPath, recursive);
    }

    return { fileCount: files.length, status: 'queued' };
  }

  findSupportedFiles(dirPath, recursive) {
    const supportedExts = ['.txt', '.pdf', '.docx', '.xlsx', '.csv', '.html', '.htm'];
    const files = [];

    const scanDir = (dir) => {
      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (supportedExts.includes(ext)) {
              files.push(fullPath);
            }
          } else if (entry.isDirectory() && recursive) {
            scanDir(fullPath);
          }
        }
      } catch (error) {
        console.error(`Error scanning directory ${dir}:`, error);
      }
    };

    scanDir(dirPath);
    return files;
  }

  addToQueue(filePath, type) {
    if (this._disposed) return;
    const queueItem = {
      id: uuidv4(),
      filePath,
      type,
      status: 'pending',
      addedAt: Date.now()
    };
    
    this.ingestionQueue.push(queueItem);
    this.emit('ingestion-update', { type: 'queued', item: queueItem });
  }

  async startQueueProcessor() {
    if (this.processing) return;
    this.processing = true;

    while (!this._disposed) {
      // Wait if no items in queue
      if (this.ingestionQueue.length === 0) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        continue;
      }

      // Wait if already processing max concurrent items
      if (this.activeProcessingCount >= this.maxConcurrentProcessing) {
        await new Promise(resolve => setTimeout(resolve, 100));
        continue;
      }

      // Start processing next item (don't await - process concurrently)
      const item = this.ingestionQueue.shift();
      this.activeProcessingCount++;
      
      this.processQueueItem(item).finally(() => {
        this.activeProcessingCount--;
      });
      
      // Small delay to allow event loop to process other events
      await new Promise(resolve => setImmediate(resolve));
    }
    this.processing = false;
  }

  async processQueueItem(item) {
    if (this._disposed) {
      return;
    }
    try {
      item.status = 'processing';
      this.emit('ingestion-update', { type: 'processing', item });

      const filePath = item.filePath;
      const fileId = this.getFileId(filePath);
      
      // Check if document exists
      const existingDoc = this.vectorStore.getDocument(fileId);
      
      // Process file
      const { content, metadata } = await this.documentProcessor.processFile(filePath);
      
      // Get chunking settings from settings
      const chunkSize = this.settings.chunkSize || 1000;
      const chunkOverlap = this.settings.chunkOverlap || 200;
      const minChunkChars = this.settings.minChunkChars || 0;
      const minChunkTokens = this.settings.minChunkTokens || 0;
      const maxChunksPerDocument = this.settings.maxChunksPerDocument || 0;
      
      // Chunk content
      const chunks = await this.documentProcessor.chunkContent(
        content, 
        metadata, 
        chunkSize, 
        chunkOverlap,
        minChunkChars,
        minChunkTokens,
        maxChunksPerDocument
      );
      
      // Update document in vector store
      this.vectorStore.addDocument({
        id: fileId,
        filePath,
        fileName: path.basename(filePath),
        fileType: path.extname(filePath).toLowerCase(),
        fileSize: metadata.fileSize,
        ingestedAt: existingDoc ? existingDoc.ingested_at : Date.now(),
        status: 'processing'
      });

      // Delete old chunks
      this.vectorStore.deleteDocumentChunks(fileId);

      // Add new chunks with document ID
      const chunksWithDocId = chunks.map(chunk => ({
        ...chunk,
        documentId: fileId,
        createdAt: Date.now()
      }));

      this.vectorStore.addChunks(chunksWithDocId);

      // Update document status
      this.vectorStore.updateDocumentStatus(fileId, 'completed');

      item.status = 'completed';
      this.emit('ingestion-update', { type: 'completed', item });
    } catch (error) {
      console.error('Error processing queue item:', error);
      item.status = 'error';
      item.error = error.message;
      this.emit('ingestion-update', { type: 'error', item });
    }
  }

  getFileId(filePath) {
    // Use file path as ID (normalized)
    return path.resolve(filePath);
  }

  getIngestionStatus() {
    return {
      queueLength: this.ingestionQueue.length,
      processing: this.processing,
      activeProcessingCount: this.activeProcessingCount,
      queue: this.ingestionQueue.map(item => ({
        id: item.id,
        filePath: item.filePath,
        status: item.status
      }))
    };
  }

  getFiles() {
    return this.settings.files || [];
  }

  getDirectories() {
    return this.settings.directories || [];
  }

  getDirectoryFiles(dirPath) {
    // Normalize directory path for comparison (use path equality so we find the entry on all platforms)
    const normalizedDirPath = path.resolve(dirPath);

    // Find the directory entry to get recursive setting (pathsEqual handles Windows casing)
    const dirEntry = this.settings.directories.find(d => pathsEqual(d.path, normalizedDirPath));
    if (!dirEntry) {
      return [];
    }

    // Find all supported files in the directory (respect recursive so child folders are included)
    const files = this.findSupportedFiles(dirEntry.path, dirEntry.recursive || false);
    
    // Get ingestion status
    const ingestionStatus = this.getIngestionStatus();
    const statusMap = new Map();
    ingestionStatus.queue.forEach(item => {
      const normalized = path.resolve(item.filePath);
      statusMap.set(normalized, item.status);
    });
    
    // Get document status from vector store
    const documents = this.vectorStore.getDocuments();
    const docStatusMap = new Map();
    documents.forEach(doc => {
      const normalized = path.resolve(doc.file_path);
      docStatusMap.set(normalized, doc.status);
    });

    // Combine file info with status
    return files.map(filePath => {
      const normalizedFilePath = path.resolve(filePath);
      const fileId = this.getFileId(filePath);
      const queueStatus = statusMap.get(normalizedFilePath);
      const docStatus = docStatusMap.get(normalizedFilePath);
      
      // Determine overall status: queue status takes precedence, then doc status, then 'not-ingested'
      let status = 'not-ingested';
      if (queueStatus) {
        status = queueStatus;
      } else if (docStatus) {
        status = docStatus;
      }

      return {
        path: filePath,
        name: path.basename(filePath),
        status: status
      };
    });
  }

  removeFile(filePath) {
    // Normalize paths for comparison
    const normalizedPath = path.resolve(filePath);
    
    // Find the file entry (might be stored with different path format)
    const fileEntry = this.settings.files.find(f => {
      const storedPath = path.resolve(f.path);
      return storedPath === normalizedPath;
    });
    
    if (fileEntry) {
      // Remove from settings using the stored path format
      this.settings.files = this.settings.files.filter(f => {
        const storedPath = path.resolve(f.path);
        return storedPath !== normalizedPath;
      });
      this._saveSettingsToDisk();
      
      // Stop watching (use stored path)
      this.unwatchFile(fileEntry.path);
    }
    
    // Remove from vector store
    const fileId = this.getFileId(filePath);
    this.vectorStore.deleteDocument(fileId);
    
    // Emit event to notify UI of vector store change
    this.emit('ingestion-update', { type: 'removed', filePath });
  }

  removeDirectory(dirPath) {
    // Normalize paths for comparison
    const normalizedDirPath = path.resolve(dirPath);
    
    // Find the directory entry (might be stored with different path format)
    const dirEntry = this.settings.directories.find(d => {
      const storedPath = path.resolve(d.path);
      return storedPath === normalizedDirPath;
    });
    
    if (dirEntry) {
      // Remove from settings using the stored path format
      this.settings.directories = this.settings.directories.filter(d => {
        const storedPath = path.resolve(d.path);
        return storedPath !== normalizedDirPath;
      });
      this._saveSettingsToDisk();
      
      // Stop watching (use stored path)
      this.unwatchDirectory(dirEntry.path);
    }
    
    // Remove all files from this directory in the vector store
    const allDocuments = this.vectorStore.getDocuments();
    const normalizedDirPathWithSep = normalizedDirPath + path.sep;
    
    for (const doc of allDocuments) {
      const normalizedDocPath = path.resolve(doc.file_path);
      // Check if document is within the directory being removed
      if (normalizedDocPath.startsWith(normalizedDirPathWithSep) || normalizedDocPath === normalizedDirPath) {
        this.vectorStore.deleteDocument(doc.id);
      }
    }
    
    // Emit event to notify UI of vector store change
    this.emit('ingestion-update', { type: 'removed', dirPath });
  }

  updateFileWatch(filePath, watch) {
    const file = this.settings.files.find(f => f.path === filePath);
    if (file) {
      file.watch = watch;
      this._saveSettingsToDisk();
      
      if (watch) {
        this.watchFile(filePath);
      } else {
        this.unwatchFile(filePath);
      }
    }
  }

  updateDirectoryWatch(dirPath, watch, recursive) {
    const dir = this.settings.directories.find(d => pathsEqual(d.path, dirPath));
    if (dir) {
      dir.watch = watch;
      dir.recursive = recursive;
      this._saveSettingsToDisk();
      
      if (watch) {
        this.watchDirectory(dir.path, recursive); // Use stored path format
      } else {
        this.unwatchDirectory(dir.path); // Use stored path format
      }
    }
  }

  updateFileActive(filePath, active) {
    // Normalize paths for comparison
    const normalizedPath = path.resolve(filePath);
    
    // Find the file entry
    const fileEntry = this.settings.files.find(f => {
      const storedPath = path.resolve(f.path);
      return storedPath === normalizedPath;
    });
    
    if (fileEntry) {
      const wasActive = fileEntry.active !== false;
      fileEntry.active = active;
      this._saveSettingsToDisk();
      
      const fileId = this.getFileId(filePath);
      
      if (active && !wasActive) {
        // Reactivating: add to queue for ingestion
        if (fs.existsSync(filePath)) {
          this.addToQueue(filePath, 'file');
        }
      } else if (!active && wasActive) {
        // Deactivating: remove from vector store
        this.vectorStore.deleteDocument(fileId);
        // Emit event to notify UI
        this.emit('ingestion-update', { type: 'deactivated', filePath });
      }
    }
  }

  updateDirectoryActive(dirPath, active) {
    // Normalize paths for comparison
    const normalizedDirPath = path.resolve(dirPath);
    
    // Find the directory entry
    const dirEntry = this.settings.directories.find(d => {
      const storedPath = path.resolve(d.path);
      return storedPath === normalizedDirPath;
    });
    
    if (dirEntry) {
      const wasActive = dirEntry.active !== false;
      dirEntry.active = active;
      this._saveSettingsToDisk();
      
      if (active && !wasActive) {
        // Reactivating: find all files and add to queue
        if (fs.existsSync(dirPath)) {
          const files = this.findSupportedFiles(dirPath, dirEntry.recursive || false);
          for (const file of files) {
            if (fs.existsSync(file)) {
              this.addToQueue(file, 'file');
            }
          }
        }
      } else if (!active && wasActive) {
        // Deactivating: remove all files from this directory in the vector store
        const allDocuments = this.vectorStore.getDocuments();
        const normalizedDirPathWithSep = normalizedDirPath + path.sep;
        
        for (const doc of allDocuments) {
          const normalizedDocPath = path.resolve(doc.file_path);
          // Check if document is within the directory being deactivated
          if (normalizedDocPath.startsWith(normalizedDirPathWithSep) || normalizedDocPath === normalizedDirPath) {
            this.vectorStore.deleteDocument(doc.id);
          }
        }
        // Emit event to notify UI
        this.emit('ingestion-update', { type: 'deactivated', dirPath });
      }
    }
  }

  watchFile(filePath) {
    if (this.fileWatchers.has(filePath)) {
      return;
    }

    const watcher = chokidar.watch(filePath);
    watcher.on('change', () => {
      // Only process if file is active
      const fileEntry = this.settings.files.find(f => f.path === filePath);
      if (fileEntry?.active !== false) {
        this.addToQueue(filePath, 'file');
      }
    });

    watcher.on('unlink', () => {
      // File was deleted, remove from vector store
      const fileId = this.getFileId(filePath);
      this.vectorStore.deleteDocument(fileId);
      // Emit event to notify UI of vector store change
      this.emit('ingestion-update', { type: 'removed', filePath });
    });

    this.fileWatchers.set(filePath, watcher);
  }

  unwatchFile(filePath) {
    const watcher = this.fileWatchers.get(filePath);
    if (watcher) {
      watcher.close();
      this.fileWatchers.delete(filePath);
    }
  }

  watchDirectory(dirPath, recursive) {
    // Normalize the directory path for consistent comparison
    const normalizedDirPath = path.resolve(dirPath);
    
    if (this.directoryWatchers.has(normalizedDirPath)) {
      return;
    }

    // Use normalized path for watching - chokidar handles both forward and backslashes
    // Chokidar watches recursively by default, so we'll filter in the event handler for non-recursive
    const watchPath = normalizedDirPath;
    const watcher = chokidar.watch(watchPath, {
      ignored: /(^|[\/\\])\../, // ignore dotfiles
      persistent: true,
      ignoreInitial: true, // Don't process existing files on startup (handled by sync)
      awaitWriteFinish: {
        stabilityThreshold: 2000, // Wait 2 seconds after file stops changing
        pollInterval: 100 // Check every 100ms
      }
    });

    watcher.on('add', (filePath) => {
      console.log(`[Watcher] File added: ${filePath}`);
      // Find directory entry using normalized path comparison
      const dirEntry = this.settings.directories.find(d => {
        const normalized = path.resolve(d.path);
        return normalized === normalizedDirPath;
      });
      if (dirEntry?.active !== false) {
        // For non-recursive watching, check if file is a direct child
        const isRecursive = dirEntry?.recursive || false;
        if (!isRecursive) {
          const fileDir = path.dirname(path.resolve(filePath));
          const watchDir = normalizedDirPath;
          if (fileDir !== watchDir) {
            // File is in a subdirectory, skip it
            return;
          }
        }
        const ext = path.extname(filePath).toLowerCase();
        if (['.txt', '.pdf', '.docx', '.xlsx', '.csv', '.html', '.htm'].includes(ext)) {
          console.log(`[Watcher] Queueing new file: ${filePath}`);
          this.addToQueue(filePath, 'file');
        }
      }
    });

    watcher.on('change', (filePath) => {
      console.log(`[Watcher] File changed: ${filePath}`);
      // Find directory entry using normalized path comparison
      const dirEntry = this.settings.directories.find(d => {
        const normalized = path.resolve(d.path);
        return normalized === normalizedDirPath;
      });
      if (dirEntry?.active !== false) {
        // For non-recursive watching, check if file is a direct child
        const isRecursive = dirEntry?.recursive || false;
        if (!isRecursive) {
          const fileDir = path.dirname(path.resolve(filePath));
          const watchDir = normalizedDirPath;
          if (fileDir !== watchDir) {
            // File is in a subdirectory, skip it
            return;
          }
        }
        const ext = path.extname(filePath).toLowerCase();
        if (['.txt', '.pdf', '.docx', '.xlsx', '.csv', '.html', '.htm'].includes(ext)) {
          console.log(`[Watcher] Queueing changed file: ${filePath}`);
          this.addToQueue(filePath, 'file');
        }
      }
    });

    watcher.on('unlink', (filePath) => {
      console.log(`[Watcher] File deleted: ${filePath}`);
      // File was deleted from watched directory, remove from vector store
      const ext = path.extname(filePath).toLowerCase();
      if (['.txt', '.pdf', '.docx', '.xlsx', '.csv', '.html', '.htm'].includes(ext)) {
        const fileId = this.getFileId(filePath);
        this.vectorStore.deleteDocument(fileId);
        // Emit event to notify UI of vector store change
        this.emit('ingestion-update', { type: 'removed', filePath });
      }
    });

    watcher.on('error', (error) => {
      console.error(`[Watcher] Error watching directory ${normalizedDirPath}:`, error);
    });

    watcher.on('ready', () => {
      console.log(`[Watcher] Ready watching directory: ${normalizedDirPath} (recursive: ${recursive})`);
    });

    this.directoryWatchers.set(normalizedDirPath, watcher);
  }

  unwatchDirectory(dirPath) {
    // Normalize path for consistent lookup
    const normalizedDirPath = path.resolve(dirPath);
    const watcher = this.directoryWatchers.get(normalizedDirPath);
    if (watcher) {
      watcher.close();
      this.directoryWatchers.delete(normalizedDirPath);
      console.log(`[Watcher] Stopped watching directory: ${normalizedDirPath}`);
    }
  }

  restoreWatchers() {
    console.log('[Watcher] Restoring watchers...');
    // Restore file watchers
    for (const file of this.settings.files || []) {
      if (file.watch && fs.existsSync(file.path)) {
        this.watchFile(file.path);
      }
    }

    // Restore directory watchers
    for (const dir of this.settings.directories || []) {
      if (dir.watch && fs.existsSync(dir.path)) {
        console.log(`[Watcher] Restoring directory watcher: ${dir.path} (recursive: ${dir.recursive || false})`);
        this.watchDirectory(dir.path, dir.recursive);
      }
    }
    console.log('[Watcher] Watchers restored');
  }

  getDocuments() {
    return this.vectorStore.getDocuments();
  }

  getDocument(documentId) {
    return this.vectorStore.getDocument(documentId);
  }

  getDocumentChunks(documentId) {
    return this.vectorStore.getDocumentChunks(documentId);
  }

  getChunkContent(chunkId) {
    return this.vectorStore.getChunk(chunkId);
  }

  getVectorStoreStats() {
    return this.vectorStore.getStats();
  }

  async search(query, limit = 10, algorithm = 'hybrid', options = {}) {
    const webSearch = options.webSearch || false;
    const searchWarnings = [];
    const searchErrors = [];
    const profiler = this.createSearchProfiler(`Search:${algorithm}`);
    profiler?.mark('start');
    
    // Get retrieval settings from settings
    const topK = this.settings.retrievalTopK || limit || 10;
    const scoreThreshold = this.settings.retrievalScoreThreshold || 0;
    const maxChunksPerDoc = this.settings.retrievalMaxChunksPerDoc || 0;
    const groupByDoc = this.settings.retrievalGroupByDoc || false;
    const returnFullDocs = this.settings.retrievalReturnFullDocs || false;
    const maxContextTokens = this.settings.retrievalMaxContextTokens || 0;
    
    // Get metadata settings from settings
    const sinceDays = this.settings.metadataSinceDays || 0;
    const timeDecayEnabled = this.settings.metadataTimeDecayEnabled || false;
    const timeDecayHalfLifeDays = this.settings.metadataTimeDecayHalfLifeDays || 30;
    
    // Generate embedding for query (needed for vector and hybrid search)
    let queryEmbedding = null;
    if (algorithm === 'vector' || algorithm === 'hybrid') {
      if (this.embeddingModel) {
        try {
          const output = await this.embeddingModel(query);
          queryEmbedding = Array.from(output.data);
          
          // Normalize query embedding if setting is enabled
          const normalizeEmbeddings = this.settings.normalizeEmbeddings !== false;
          if (normalizeEmbeddings) {
            const norm = Math.sqrt(queryEmbedding.reduce((sum, val) => sum + val * val, 0));
            if (norm > 0) {
              queryEmbedding = queryEmbedding.map(val => val / norm);
            }
          }
        } catch (error) {
          console.error('Error generating query embedding:', error);
          queryEmbedding = this.documentProcessor.simpleEmbedding(query);
        }
        profiler?.mark('query-embedding');
      } else {
        queryEmbedding = this.documentProcessor.simpleEmbedding(query);
        profiler?.mark('query-embedding-fallback');
      }
    }

    // Check chunk count to decide if we should use streaming
    const chunkCount = this.vectorStore.getChunksCount();
    profiler?.mark(`chunk-count:${chunkCount}`);
    const useStreaming = chunkCount > 5000; // Use streaming for large datasets
    
    // Get document info for time range filtering
    const documents = this.vectorStore.getDocuments();
    const docMap = new Map(documents.map(doc => [doc.id, doc]));
    profiler?.mark('documents-loaded');
    
    let allChunks = null;
    if (!useStreaming) {
      // For smaller datasets, load chunks into memory
      // Only load embeddings if needed for vector/hybrid search
      if (algorithm === 'vector' || algorithm === 'hybrid') {
        // Need embeddings for vector search
        allChunks = this.vectorStore.getAllChunks(true);
      } else {
        // Text-based search (BM25, TF-IDF) doesn't need embeddings
        allChunks = this.vectorStore.getAllChunksWithoutEmbeddings();
      }
    }

    // --- Web search: fetch and chunk in parallel with vector store search ---
    let webChunksPromise = null;
    if (webSearch && this.webSearchService.isAvailable()) {
      const chunkSize = this.settings.chunkSize || 1000;
      const chunkOverlap = this.settings.chunkOverlap || 200;
      const timeoutMs = this.webSearchService.timeoutMs || 0;
      webChunksPromise = this.webSearchService.searchAndChunk(query, chunkSize, chunkOverlap)
        .catch(err => {
          console.error('Web search error:', err);
          const msg = err && err.message ? String(err.message) : String(err);
          const aborted =
            (err && err.name === 'AbortError') ||
            /aborted|AbortError|The user aborted a request/i.test(msg);
          if (aborted && timeoutMs > 0) {
            searchWarnings.push(
              `Web search timed out after ${timeoutMs} ms; results are from the vector store only.`
            );
          } else {
            searchWarnings.push(`Web search was skipped: ${msg}`);
          }
          return [];
        });
      profiler?.mark('web-search-started');
    }
    
    // Use search service to perform search with retrieval and metadata settings
    // Pass vectorStore for streaming when dataset is large
    const results = await this.searchService.search(
      query, 
      queryEmbedding, 
      allChunks, 
      topK, 
      algorithm,
      {
        scoreThreshold,
        maxChunksPerDoc,
        groupByDoc,
        returnFullDocs,
        maxContextTokens
      },
      {
        sinceDays,
        timeDecayEnabled,
        timeDecayHalfLifeDays
      },
      docMap,
      useStreaming ? this.vectorStore : null
    );
    profiler?.mark('search-service');

    // --- Merge web search results into the vector store results ---
    let webResults = [];
    if (webChunksPromise) {
      const webChunks = await webChunksPromise;
      profiler?.mark(`web-chunks:${webChunks.length}`);

      if (webChunks.length > 0) {
        // Score web chunks using text-based search (BM25) against the query
        // so they get comparable scores to vector store results.
        const webBM25 = this.searchService.searchBM25(query, webChunks, webChunks.length);

        // Also score via vector similarity if we have an embedding
        let webVector = [];
        if (queryEmbedding && this.embeddingModel) {
          // Generate embeddings for web chunks on the fly
          for (const chunk of webChunks) {
            try {
              const output = await this.embeddingModel(chunk.content);
              chunk.embedding = Array.from(output.data);
              const normalizeEmbeddings = this.settings.normalizeEmbeddings !== false;
              if (normalizeEmbeddings) {
                const norm = Math.sqrt(chunk.embedding.reduce((s, v) => s + v * v, 0));
                if (norm > 0) chunk.embedding = chunk.embedding.map(v => v / norm);
              }
            } catch (_) {
              chunk.embedding = this.documentProcessor.simpleEmbedding(chunk.content);
            }
          }
          webVector = this.searchService.searchVector(queryEmbedding, webChunks, webChunks.length);
        }

        // Hybrid fusion of BM25 + vector for web chunks (same approach as hybrid search)
        const bm25Map = new Map(webBM25.map(r => [r.id, r.score]));
        const vectorMap = new Map(webVector.map(r => [r.id, r.score]));

        const normalize = (map) => {
          if (map.size === 0) return new Map();
          const vals = Array.from(map.values());
          const max = Math.max(...vals);
          const min = Math.min(...vals);
          const range = max - min || 1;
          const out = new Map();
          for (const [k, v] of map) out.set(k, (v - min) / range);
          return out;
        };

        const normBM25 = normalize(bm25Map);
        const normVector = normalize(vectorMap);
        const allIds = new Set([...bm25Map.keys(), ...vectorMap.keys()]);
        const chunkMap = new Map(webChunks.map(c => [c.id, c]));

        for (const id of allIds) {
          const bm25Score = normBM25.get(id) || 0;
          const vecScore = normVector.get(id) || 0;
          const combined = (bm25Score * 0.5) + (vecScore * 0.5);
          const chunk = chunkMap.get(id);
          if (chunk && combined > 0) {
            webResults.push({
              ...chunk,
              score: combined,
              algorithm: 'Web'
            });
          }
        }

        webResults.sort((a, b) => b.score - a.score);
        profiler?.mark('web-scored');
      }
    }

    // Merge vector store results and web results using reciprocal rank fusion (RRF)
    // so both sources get fair representation in the final list.
    let mergedResults = results;
    if (webResults.length > 0) {
      mergedResults = this._mergeResultsRRF(results, webResults, topK);
      profiler?.mark('merged');
    }
    
    // Handle grouped results
    if (groupByDoc && mergedResults.length > 0 && mergedResults[0].chunks) {
      const finalResults = mergedResults.map(result => {
        const doc = docMap.get(result.document_id);
        if (returnFullDocs && doc) {
          const docChunks = this.vectorStore.getDocumentChunks(result.document_id);
          return {
            documentId: result.document_id,
            content: docChunks.map(c => c.content).join('\n\n'),
            score: result.score,
            similarity: result.score,
            algorithm: result.algorithm,
            chunks: result.chunks.map(chunk => ({
              chunkId: chunk.id,
              content: chunk.content,
              score: chunk.score
            })),
            metadata: {
              fileName: doc.file_name,
              filePath: doc.file_path,
              fileType: doc.file_type,
              fileSize: doc.file_size
            }
          };
        } else {
          return {
            documentId: result.document_id,
            chunks: result.chunks.map(chunk => ({
              chunkId: chunk.id,
              content: chunk.content,
              score: chunk.score
            })),
            score: result.score,
            similarity: result.score,
            algorithm: result.algorithm,
            metadata: {
              fileName: doc ? doc.file_name : 'Unknown',
              filePath: doc ? doc.file_path : 'Unknown'
            }
          };
        }
      });
      profiler?.end('completed');
      this._logSearchConsoleMessages(searchWarnings, searchErrors);
      return { results: finalResults, warnings: searchWarnings, errors: searchErrors };
    }
    
    // Handle regular chunk results
    const finalResults = mergedResults.map(result => {
      const isWeb = result.metadata?.source === 'web';
      const doc = isWeb ? null : docMap.get(result.document_id);
      if (!isWeb && returnFullDocs && doc) {
        const docChunks = this.vectorStore.getDocumentChunks(result.document_id);
        return {
          chunkId: result.id,
          documentId: result.document_id,
          content: docChunks.map(c => c.content).join('\n\n'),
          score: result.score,
          similarity: result.score,
          algorithm: result.algorithm,
          metadata: {
            ...result.metadata,
            fileName: doc.file_name,
            filePath: doc.file_path,
            fileType: doc.file_type,
            fileSize: doc.file_size
          }
        };
      } else {
        return {
          chunkId: result.id,
          documentId: result.document_id,
          content: result.content,
          score: result.score,
          similarity: result.score,
          algorithm: result.algorithm,
          metadata: {
            ...result.metadata,
            fileName: isWeb ? (result.metadata?.webTitle || result.metadata?.displayLink || 'Web') : (doc ? doc.file_name : 'Unknown'),
            filePath: isWeb ? (result.metadata?.url || '') : (doc ? doc.file_path : 'Unknown')
          }
        };
      }
    });
    
    profiler?.end('completed');
    this._logSearchConsoleMessages(searchWarnings, searchErrors);
    return { results: finalResults, warnings: searchWarnings, errors: searchErrors };
  }

  _logSearchConsoleMessages(warnings, errors) {
    if (warnings && warnings.length) {
      for (const w of warnings) console.warn('[search]', w);
    }
    if (errors && errors.length) {
      for (const e of errors) console.error('[search]', e);
    }
  }

  /**
   * Reciprocal Rank Fusion (RRF) to merge two ranked result lists.
   * RRF score = sum(1 / (k + rank)) across lists where the result appears.
   */
  _mergeResultsRRF(listA, listB, limit, k = 60) {
    const scores = new Map();
    const items = new Map();

    const addList = (list) => {
      list.forEach((item, idx) => {
        const rank = idx + 1;
        const prev = scores.get(item.id) || 0;
        scores.set(item.id, prev + 1 / (k + rank));
        if (!items.has(item.id)) items.set(item.id, item);
      });
    };

    addList(listA);
    addList(listB);

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([id, rrfScore]) => {
        const item = items.get(id);
        return { ...item, score: rrfScore, rrfScore };
      });
  }

  async syncWatchedFilesWithVectorStore() {
    console.log('Syncing watched files/directories with vector store...');
    
    const watchedFilePaths = new Set();
    const watchedDirectories = new Set();
    
    // Collect all watched files (only active ones)
    for (const fileEntry of this.settings.files || []) {
      if (fileEntry.active !== false && fs.existsSync(fileEntry.path)) {
        watchedFilePaths.add(path.resolve(fileEntry.path));
      }
    }
    
    // Collect all files from watched directories (only active ones)
    for (const dirEntry of this.settings.directories || []) {
      if (dirEntry.active !== false && fs.existsSync(dirEntry.path)) {
        watchedDirectories.add(path.resolve(dirEntry.path));
        const files = this.findSupportedFiles(dirEntry.path, dirEntry.recursive || false);
        files.forEach(file => watchedFilePaths.add(path.resolve(file)));
      }
    }
    
    // Get all documents from vector store
    const allDocuments = this.vectorStore.getDocuments();
    const documentsByPath = new Map();
    allDocuments.forEach(doc => {
      const normalizedPath = path.resolve(doc.file_path);
      documentsByPath.set(normalizedPath, doc);
    });
    
    // Track paths that are watched (for orphan detection)
    const watchedPathsSet = new Set(watchedFilePaths);
    
    // 1. Process watched files that exist on disk
    let processedCount = 0;
    let updatedCount = 0;
    let addedCount = 0;
    let removedCount = 0;
    
    for (const filePath of watchedFilePaths) {
      try {
        if (!fs.existsSync(filePath)) {
          // File doesn't exist, remove from vector store if present
          const doc = documentsByPath.get(filePath);
          if (doc) {
            console.log(`Removing deleted file from vector store: ${filePath}`);
            this.vectorStore.deleteDocument(doc.id);
            removedCount++;
          }
          continue;
        }
        
        const stats = fs.statSync(filePath);
        const doc = documentsByPath.get(filePath);
        
        if (!doc) {
          // File not in vector store, queue for ingestion
          console.log(`Queueing new file for ingestion: ${filePath}`);
          this.addToQueue(filePath, 'file');
          addedCount++;
        } else if (stats.mtimeMs > doc.updated_at) {
          // File has been modified since last update, queue for re-processing
          console.log(`Queueing modified file for re-processing: ${filePath}`);
          this.addToQueue(filePath, 'file');
          updatedCount++;
        }
        
        processedCount++;
      } catch (error) {
        console.error(`Error syncing file ${filePath}:`, error);
      }
    }
    
    // 2. Remove orphaned documents (in vector store from watched paths but files no longer exist)
    // This handles the case where files were deleted between app sessions
    for (const [filePath, doc] of documentsByPath.entries()) {
      // Check if this document is from a watched path
      let isFromWatchedPath = watchedPathsSet.has(filePath);
      
      // If not directly watched, check if it's within a watched directory
      if (!isFromWatchedPath) {
        const normalizedDocPath = path.resolve(filePath);
        for (const watchedDir of watchedDirectories) {
          const normalizedDir = path.resolve(watchedDir);
          if (normalizedDocPath.startsWith(normalizedDir + path.sep) || normalizedDocPath === normalizedDir) {
            isFromWatchedPath = true;
            break;
          }
        }
      }
      
      // If from watched path but file no longer exists, remove it
      if (isFromWatchedPath && !fs.existsSync(filePath)) {
        console.log(`Removing orphaned document from vector store: ${filePath}`);
        this.vectorStore.deleteDocument(doc.id);
        removedCount++;
      }
    }
    
    console.log(`Sync complete: ${processedCount} processed, ${addedCount} added, ${updatedCount} updated, ${removedCount} removed`);
    
    if (addedCount > 0 || updatedCount > 0 || removedCount > 0) {
      this.emit('ingestion-update', { 
        type: 'sync-complete', 
        added: addedCount, 
        updated: updatedCount, 
        removed: removedCount 
      });
    }
  }

  async regenerateVectorStore() {
    console.log('Regenerating vector store...');
    
    // Clear the entire vector store
    this.vectorStore.clearStore();
    console.log('Vector store cleared');
    
    // Collect all files from current settings
    const allFilePaths = new Set();
    
    // Add files from files list (only active ones)
    for (const fileEntry of this.settings.files || []) {
      if (fileEntry.active !== false && fs.existsSync(fileEntry.path)) {
        allFilePaths.add(path.resolve(fileEntry.path));
      }
    }
    
    // Add files from directories (only active ones)
    for (const dirEntry of this.settings.directories || []) {
      if (dirEntry.active !== false && fs.existsSync(dirEntry.path)) {
        const files = this.findSupportedFiles(dirEntry.path, dirEntry.recursive || false);
        files.forEach(file => allFilePaths.add(path.resolve(file)));
      }
    }
    
    // Queue all files for re-indexing
    let queuedCount = 0;
    for (const filePath of allFilePaths) {
      try {
        if (fs.existsSync(filePath)) {
          this.addToQueue(filePath, 'file');
          queuedCount++;
        }
      } catch (error) {
        console.error(`Error queueing file ${filePath}:`, error);
      }
    }
    
    console.log(`Regeneration queued ${queuedCount} files`);
    
    // Emit event to notify UI
    this.emit('ingestion-update', { 
      type: 'regenerate-complete', 
      queued: queuedCount 
    });
    
    return { queued: queuedCount };
  }

  isSearchProfilingEnabled() {
    return this.searchProfilingEnabled || this.settings.searchProfiling === true;
  }

  createSearchProfiler(label) {
    if (!this.isSearchProfilingEnabled()) {
      return null;
    }
    const start = performance.now();
    let last = start;
    console.log(`[SearchProfiler] ${label} - start`);
    return {
      mark: (step) => {
        const now = performance.now();
        console.log(`[SearchProfiler] ${label} - ${step}: ${(now - last).toFixed(2)}ms (total ${(now - start).toFixed(2)}ms)`);
        last = now;
      },
      end: (finalStep = 'done') => {
        const now = performance.now();
        console.log(`[SearchProfiler] ${label} - ${finalStep}: ${(now - start).toFixed(2)}ms total`);
      }
    };
  }

  /**
   * Stop ingestion, close watchers and DB. Safe to call multiple times.
   */
  async dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this.ingestionQueue.length = 0;

    const deadline = Date.now() + 30000;
    while (this.activeProcessingCount > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }

    for (const fp of [...this.fileWatchers.keys()]) {
      this.unwatchFile(fp);
    }
    for (const dp of [...this.directoryWatchers.keys()]) {
      this.unwatchDirectory(dp);
    }

    this.removeAllListeners();

    try {
      this.vectorStore.close();
    } catch (error) {
      console.error('Error closing vector store:', error);
    }
  }
}

module.exports = { RAGService };



const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Data directory
  getDataDir: () => ipcRenderer.invoke('get-data-dir'),

  // Namespaces (per data subdirectory under ~/froggy-rag-mcp/data)
  listNamespaces: () => ipcRenderer.invoke('namespace-list'),
  getActiveNamespace: () => ipcRenderer.invoke('namespace-get-active'),
  setActiveNamespace: (name) => ipcRenderer.invoke('namespace-set', name),
  createNamespace: (name) => ipcRenderer.invoke('namespace-create', name),
  renameNamespace: (from, to) => ipcRenderer.invoke('namespace-rename', from, to),
  deleteNamespace: (name) => ipcRenderer.invoke('namespace-delete', name),
  onNamespaceChanged: (callback) => {
    ipcRenderer.on('namespace-changed', (_, payload) => callback(payload));
  },
  
  // App version
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  
  // RAG Service
  ingestFile: (filePath, watch) => ipcRenderer.invoke('ingest-file', filePath, watch),
  ingestDirectory: (dirPath, recursive, watch) => ipcRenderer.invoke('ingest-directory', dirPath, recursive, watch),
  getIngestionStatus: () => ipcRenderer.invoke('get-ingestion-status'),
  getFiles: () => ipcRenderer.invoke('get-files'),
  getDirectories: () => ipcRenderer.invoke('get-directories'),
  getDirectoryFiles: (dirPath) => ipcRenderer.invoke('get-directory-files', dirPath),
  removeFile: (filePath) => ipcRenderer.invoke('remove-file', filePath),
  removeDirectory: (dirPath) => ipcRenderer.invoke('remove-directory', dirPath),
  updateFileWatch: (filePath, watch) => ipcRenderer.invoke('update-file-watch', filePath, watch),
  updateDirectoryWatch: (dirPath, watch, recursive) => ipcRenderer.invoke('update-directory-watch', dirPath, watch, recursive),
  updateFileActive: (filePath, active) => ipcRenderer.invoke('update-file-active', filePath, active),
  updateDirectoryActive: (dirPath, active) => ipcRenderer.invoke('update-directory-active', dirPath, active),
  
  // Vector Store
  getDocuments: () => ipcRenderer.invoke('get-documents'),
  getDocument: (documentId) => ipcRenderer.invoke('get-document', documentId),
  getDocumentChunks: (documentId) => ipcRenderer.invoke('get-document-chunks', documentId),
  getChunkContent: (chunkId) => ipcRenderer.invoke('get-chunk-content', chunkId),
  getVectorStoreStats: () => ipcRenderer.invoke('get-vector-store-stats'),
  regenerateVectorStore: () => ipcRenderer.invoke('regenerate-vector-store'),
  
  // Search
  search: (query, limit, algorithm, options) => ipcRenderer.invoke('search', query, limit, algorithm, options),
  
  // MCP Server
  startMCPServer: (port) => ipcRenderer.invoke('start-mcp-server', port),
  stopMCPServer: () => ipcRenderer.invoke('stop-mcp-server'),
  getMCPServerStatus: () => ipcRenderer.invoke('get-mcp-server-status'),
  getMCPServerLogs: () => ipcRenderer.invoke('get-mcp-server-logs'),
  
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  
  // Clipboard
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),
  
  // Dialogs
  showDirectoryDialog: () => ipcRenderer.invoke('show-directory-dialog'),
  
  // File reading - now returns HTML directly
  readUsageFile: () => ipcRenderer.invoke('read-usage-file'),
  
  // Path checking
  isDirectory: (filePath) => ipcRenderer.invoke('is-directory', filePath),

  // Developer tools (main window)
  toggleDevTools: () => ipcRenderer.invoke('toggle-devtools'),

  // Open path in system file manager
  openPathInExplorer: (pathToOpen) => ipcRenderer.invoke('open-path-in-explorer', pathToOpen),
  
  // Events
  onIngestionUpdate: (callback) => {
    ipcRenderer.on('ingestion-update', (_, data) => callback(data));
  },
  onMCPServerLog: (callback) => {
    ipcRenderer.on('mcp-server-log', (_, data) => callback(data));
  },
  
  // Auto-update (GitHub Releases via electron-builder `build.publish`)
  getAutoUpdateEnabled: () => ipcRenderer.invoke('get-auto-update-enabled'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (callback) => {
    ipcRenderer.on('update-available', (_, data) => callback(data));
  },
  onUpdateNotAvailable: (callback) => {
    ipcRenderer.on('update-not-available', () => callback());
  },
  onUpdateError: (callback) => {
    ipcRenderer.on('update-error', (_, error) => callback(error));
  },
  onUpdateDownloadProgress: (callback) => {
    ipcRenderer.on('update-download-progress', (_, progress) => callback(progress));
  },
  onUpdateDownloaded: (callback) => {
    ipcRenderer.on('update-downloaded', (_, data) => callback(data));
  }
});

// Notify main process that renderer is ready
window.addEventListener('DOMContentLoaded', () => {
  ipcRenderer.send('app-ready');
});


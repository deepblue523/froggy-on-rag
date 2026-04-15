const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

// Helper to wait for services to be ready
let ragServiceRef = null;
let mcpServiceRef = null;
let servicesReady = false;
let servicesReadyPromise = null;
let servicesReadyResolve = null;
let handlersRegistered = false;
/** Live active namespace data dir from main.js (for settings read before RAGService is constructed). */
let getDataDirFn = null;

function waitForServices() {
  if (servicesReady && ragServiceRef && mcpServiceRef) {
    return Promise.resolve();
  }
  if (!servicesReadyPromise) {
    servicesReadyPromise = new Promise((resolve) => {
      servicesReadyResolve = resolve;
    });
  }
  return servicesReadyPromise;
}

module.exports = function setupIpcHandlers(ipcMain, ragService, mcpService, getDataDir) {
  if (typeof getDataDir === 'function') {
    getDataDirFn = getDataDir;
  }
  // Update service references if provided
  if (ragService && mcpService) {
    ragServiceRef = ragService;
    mcpServiceRef = mcpService;
    servicesReady = true;
    // Resolve any waiting promises
    if (servicesReadyResolve) {
      servicesReadyResolve();
      servicesReadyResolve = null;
      servicesReadyPromise = null;
    }
  } else {
    ragServiceRef = null;
    mcpServiceRef = null;
    servicesReady = false;
  }
  
  // Only register handlers once - if already registered, just set up event listeners
  if (handlersRegistered) {
    // Set up event listeners if services are now available
    if (ragService && mcpService) {
      setupEventListeners(ragService, mcpService);
    }
    return;
  }
  
  // Mark handlers as registered
  handlersRegistered = true;
  
  // RAG Service handlers
  ipcMain.handle('ingest-file', async (_, filePath, watch) => {
    await waitForServices();
    return await ragServiceRef.ingestFile(filePath, watch);
  });

  ipcMain.handle('ingest-directory', async (_, dirPath, recursive, watch) => {
    await waitForServices();
    return await ragServiceRef.ingestDirectory(dirPath, recursive, watch);
  });

  ipcMain.handle('get-ingestion-status', async () => {
    await waitForServices();
    return ragServiceRef.getIngestionStatus();
  });

  ipcMain.handle('get-files', async () => {
    await waitForServices();
    return ragServiceRef.getFiles();
  });

  ipcMain.handle('get-directories', async () => {
    await waitForServices();
    return ragServiceRef.getDirectories();
  });

  ipcMain.handle('get-directory-files', async (_, dirPath) => {
    await waitForServices();
    return ragServiceRef.getDirectoryFiles(dirPath);
  });

  ipcMain.handle('remove-file', async (_, filePath) => {
    await waitForServices();
    return ragServiceRef.removeFile(filePath);
  });

  ipcMain.handle('remove-directory', async (_, dirPath) => {
    await waitForServices();
    return ragServiceRef.removeDirectory(dirPath);
  });

  ipcMain.handle('update-file-watch', async (_, filePath, watch) => {
    await waitForServices();
    return ragServiceRef.updateFileWatch(filePath, watch);
  });

  ipcMain.handle('update-directory-watch', async (_, dirPath, watch, recursive) => {
    await waitForServices();
    return ragServiceRef.updateDirectoryWatch(dirPath, watch, recursive);
  });

  ipcMain.handle('update-file-active', async (_, filePath, active) => {
    await waitForServices();
    return ragServiceRef.updateFileActive(filePath, active);
  });

  ipcMain.handle('update-directory-active', async (_, dirPath, active) => {
    await waitForServices();
    return ragServiceRef.updateDirectoryActive(dirPath, active);
  });

  // Vector Store handlers
  ipcMain.handle('get-documents', async () => {
    await waitForServices();
    return ragServiceRef.getDocuments();
  });

  ipcMain.handle('get-document', async (_, documentId) => {
    await waitForServices();
    return ragServiceRef.getDocument(documentId);
  });

  ipcMain.handle('get-document-chunks', async (_, documentId) => {
    await waitForServices();
    return ragServiceRef.getDocumentChunks(documentId);
  });

  ipcMain.handle('get-chunk-content', async (_, chunkId) => {
    await waitForServices();
    return ragServiceRef.getChunkContent(chunkId);
  });

  ipcMain.handle('get-vector-store-stats', async () => {
    await waitForServices();
    return ragServiceRef.getVectorStoreStats();
  });

  ipcMain.handle('regenerate-vector-store', async () => {
    await waitForServices();
    return await ragServiceRef.regenerateVectorStore();
  });

  // Search handlers
  ipcMain.handle('search', async (_, query, limit = 10, algorithm = 'hybrid', options = {}) => {
    await waitForServices();
    return await ragServiceRef.search(query, limit, algorithm, options);
  });

  // MCP Server handlers
  ipcMain.handle('start-mcp-server', async (_, port = 3000) => {
    await waitForServices();
    return await mcpServiceRef.start(port);
  });

  ipcMain.handle('stop-mcp-server', async () => {
    await waitForServices();
    return mcpServiceRef.stop();
  });

  ipcMain.handle('get-mcp-server-status', async () => {
    await waitForServices();
    return mcpServiceRef.getStatus();
  });

  ipcMain.handle('get-mcp-server-logs', async () => {
    await waitForServices();
    return mcpServiceRef.getLogs();
  });

  // Settings handlers
  ipcMain.handle('get-settings', async () => {
    if (servicesReady && ragServiceRef) {
      return ragServiceRef.getSettings();
    }
    const paths = require('../paths');
    const { readMergedSettingsFromDisk } = require('../settings-files');
    const dataDir =
      typeof getDataDirFn === 'function'
        ? getDataDirFn()
        : paths.getDataDirForNamespace(paths.resolveInitialNamespaceName());
    return readMergedSettingsFromDisk(dataDir, paths.getAppSettingsPath());
  });

  ipcMain.handle('save-settings', async (_, settings) => {
    await waitForServices();
    return ragServiceRef.saveSettings(settings);
  });

  ipcMain.handle('toggle-devtools', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed()) {
      win.webContents.toggleDevTools();
    }
  });

  // Clipboard handlers
  ipcMain.handle('copy-to-clipboard', async (_, text) => {
    const { clipboard } = require('electron');
    clipboard.writeText(text);
    return true;
  });

  // Dialog handlers
  ipcMain.handle('show-directory-dialog', async () => {
    const { dialog, BrowserWindow } = require('electron');
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return null;
    
    const result = await dialog.showOpenDialog(window, {
      properties: ['openDirectory']
    });
    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // File reading handlers - now reads HTML directly
  ipcMain.handle('read-usage-file', async () => {
    try {
      // Try HTML file first, fallback to MD if needed
      const htmlPath = path.join(__dirname, '..', '..', 'USAGE.html');
      const mdPath = path.join(__dirname, '..', '..', 'USAGE.md');
      
      if (fs.existsSync(htmlPath)) {
        const content = fs.readFileSync(htmlPath, 'utf8');
        return content;
      } else if (fs.existsSync(mdPath)) {
        // Fallback: if HTML doesn't exist, try MD (for backwards compatibility)
        const content = fs.readFileSync(mdPath, 'utf8');
        return content;
      } else {
        console.error('Neither USAGE.html nor USAGE.md found');
        return null;
      }
    } catch (error) {
      console.error('Error reading usage file:', error);
      return null;
    }
  });

  // Open path in system file manager (Explorer, Finder, etc.)
  ipcMain.handle('open-path-in-explorer', async (_, pathToOpen) => {
    const { shell } = require('electron');
    const result = await shell.openPath(pathToOpen);
    if (result) {
      console.error('Error opening path:', result);
      return { success: false, error: result };
    }
    return { success: true };
  });

  // Path checking handler
  ipcMain.handle('is-directory', (_, filePath) => {
    try {
      if (!fs.existsSync(filePath)) {
        return false;
      }
      const stats = fs.statSync(filePath);
      return stats.isDirectory();
    } catch (error) {
      console.error('Error checking if path is directory:', error);
      return false;
    }
  });

  // Setup event forwarding (only if services are provided)
  if (ragService && mcpService) {
    setupEventListeners(ragService, mcpService);
  }
};

function setupEventListeners(ragService, mcpService) {
  // Remove existing listeners to avoid duplicates
  ragService.removeAllListeners('ingestion-update');
  mcpService.removeAllListeners('log');
  
  ragService.on('ingestion-update', (data) => {
    try {
      const window = require('electron').BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('ingestion-update', data);
      }
    } catch (error) {
      // Silently ignore errors when renderer frame is disposed
      // This can happen during long processing sequences if the window is closed
      if (!error.message.includes('Render frame was disposed')) {
        console.error('Error sending ingestion-update:', error);
      }
    }
  });

  mcpService.on('log', (data) => {
    try {
      const window = require('electron').BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('mcp-server-log', data);
      }
    } catch (error) {
      // Silently ignore errors when renderer frame is disposed
      // This can happen during long processing sequences if the window is closed
      if (!error.message.includes('Render frame was disposed')) {
        console.error('Error sending mcp-server-log:', error);
      }
    }
  });
}


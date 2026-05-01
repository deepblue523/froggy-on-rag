const { ipcMain, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const appPaths = require('../paths');
const { readJsonObject } = require('../settings-files');
const { getRequestLogs } = require('./services/http-request-log');

// Helper to wait for services to be ready
let ragServiceRef = null;
let ragRestServerRef = null;
let servicesReady = false;
let servicesReadyPromise = null;
let servicesReadyResolve = null;
let handlersRegistered = false;
/** Live active namespace data dir from main.js (for settings read before RAGService is constructed). */
let getDataDirFn = null;
/** @type {import('./services/passthrough-inbound-server').PassthroughInboundService | null} */
let inboundPassthroughRef = null;
/** @type {(settings?: Record<string, unknown>) => (void | Promise<void>) | null} */
let onSettingsSavedFn = null;
/** AbortController for in-flight LLM tab direct-IPC test (upstream fetch). */
let llmPassthroughTestDirectAbortController = null;

function normalizePromptProfileName(value) {
  return String(value || '').trim();
}

function promptProfileToBody(profile) {
  if (typeof profile === 'string') return profile;
  if (profile && typeof profile === 'object' && !Array.isArray(profile)) {
    if (typeof profile.body === 'string') return profile.body;
    const parts = [];
    for (const key of ['system', 'prompt', 'template', 'instructions']) {
      const value = profile[key];
      if (typeof value === 'string' && value.trim()) {
        parts.push(value.trim());
      } else if (Array.isArray(value)) {
        const lines = value.map((line) => String(line || '').trim()).filter(Boolean);
        if (lines.length) parts.push(lines.join('\n'));
      }
    }
    return parts.join('\n\n');
  }
  return '';
}

function normalizePromptProfiles(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [rawName, rawProfile] of Object.entries(value)) {
    const name = normalizePromptProfileName(
      rawProfile && typeof rawProfile === 'object' && !Array.isArray(rawProfile) && rawProfile.name
        ? rawProfile.name
        : rawName
    );
    if (!name) continue;
    out[name] = {
      name,
      body: promptProfileToBody(rawProfile)
    };
  }
  return out;
}

function getNamespaceJsonPath(namespaceName) {
  if (!appPaths.isValidNamespaceName(namespaceName)) {
    throw new Error('Invalid namespace name');
  }
  const dataDir = appPaths.getDataDirForNamespace(namespaceName);
  if (!fs.existsSync(dataDir)) {
    throw new Error('Namespace does not exist');
  }
  return path.join(dataDir, 'namespace.json');
}

function updateActiveNamespacePromptProfiles(namespaceName, profiles) {
  if (!ragServiceRef || !ragServiceRef.settings || typeof getDataDirFn !== 'function') return;
  try {
    const activeDir = path.resolve(getDataDirFn());
    const targetDir = path.resolve(appPaths.getDataDirForNamespace(namespaceName));
    if (activeDir === targetDir) {
      ragServiceRef.settings.promptProfiles = profiles;
    }
  } catch {
    /* ignore active namespace cache refresh failures */
  }
}

function waitForServices() {
  if (servicesReady && ragServiceRef && ragRestServerRef) {
    return Promise.resolve();
  }
  if (!servicesReadyPromise) {
    servicesReadyPromise = new Promise((resolve) => {
      servicesReadyResolve = resolve;
    });
  }
  return servicesReadyPromise;
}

module.exports = function setupIpcHandlers(ipcMain, ragService, ragRestServer, getDataDir, inboundPassthrough, onSettingsSaved) {
  if (typeof getDataDir === 'function') {
    getDataDirFn = getDataDir;
  }
  if (arguments.length >= 5) {
    inboundPassthroughRef = inboundPassthrough || null;
  }
  if (typeof onSettingsSaved === 'function') {
    onSettingsSavedFn = onSettingsSaved;
  }
  // Update service references if provided
  if (ragService && ragRestServer) {
    ragServiceRef = ragService;
    ragRestServerRef = ragRestServer;
    servicesReady = true;
    // Resolve any waiting promises
    if (servicesReadyResolve) {
      servicesReadyResolve();
      servicesReadyResolve = null;
      servicesReadyPromise = null;
    }
  } else {
    ragServiceRef = null;
    ragRestServerRef = null;
    servicesReady = false;
  }
  
  // Only register handlers once - if already registered, just set up event listeners
  if (handlersRegistered) {
    // Set up event listeners if services are now available
    if (ragService && ragRestServer) {
      setupEventListeners(ragService, ragRestServer);
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

  // RAG REST server (corpus admin HTTP API)
  ipcMain.handle('start-rag-rest-server', async (_, port = 3000) => {
    await waitForServices();
    return await ragRestServerRef.start(port);
  });

  ipcMain.handle('stop-rag-rest-server', async () => {
    await waitForServices();
    return await ragRestServerRef.stop();
  });

  ipcMain.handle('get-rag-rest-server-status', async () => {
    await waitForServices();
    const base = ragRestServerRef.getStatus();
    if (inboundPassthroughRef && typeof inboundPassthroughRef.getStatus === 'function') {
      return { ...base, inboundPassthrough: inboundPassthroughRef.getStatus() };
    }
    return base;
  });

  ipcMain.handle('get-rag-rest-server-logs', async () => {
    await waitForServices();
    return ragRestServerRef.getLogs();
  });

  ipcMain.handle('get-rag-rest-server-request-logs', async (_, limit) => {
    await waitForServices();
    return getRequestLogs(ragServiceRef, limit);
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
    const out = ragServiceRef.saveSettings(settings);
    if (inboundPassthroughRef && typeof inboundPassthroughRef.syncFromSettings === 'function') {
      try {
        await inboundPassthroughRef.syncFromSettings();
      } catch (e) {
        console.error('Inbound passthrough sync failed:', e);
      }
    }
    if (typeof onSettingsSavedFn === 'function') {
      try {
        await onSettingsSavedFn(settings);
      } catch (e) {
        console.error('Post-save settings sync failed:', e);
      }
    }
    return out;
  });

  ipcMain.handle('save-web-search-settings', async (_, patch) => {
    await waitForServices();
    return ragServiceRef.saveWebSearchSettings(patch || {});
  });

  ipcMain.handle('namespace-prompt-profiles-get', async (_, namespaceName) => {
    try {
      const ns = String(namespaceName || '').trim();
      const namespacePath = getNamespaceJsonPath(ns);
      const namespaceSettings = readJsonObject(namespacePath);
      return {
        ok: true,
        namespace: ns,
        promptProfiles: normalizePromptProfiles(namespaceSettings.promptProfiles)
      };
    } catch (error) {
      return { ok: false, error: error.message || String(error), promptProfiles: {} };
    }
  });

  ipcMain.handle('namespace-prompt-profile-save', async (_, namespaceName, profile, originalName) => {
    try {
      const ns = String(namespaceName || '').trim();
      const namespacePath = getNamespaceJsonPath(ns);
      const name = normalizePromptProfileName(profile && profile.name);
      if (!name) {
        return { ok: false, error: 'Prompt profile name is required.' };
      }
      if (name.length > 100) {
        return { ok: false, error: 'Prompt profile name must be 100 characters or fewer.' };
      }
      const body = String((profile && profile.body) || '');
      const namespaceSettings = readJsonObject(namespacePath);
      const promptProfiles = normalizePromptProfiles(namespaceSettings.promptProfiles);
      const oldName = normalizePromptProfileName(originalName);
      if (oldName && oldName !== name) {
        delete promptProfiles[oldName];
      }
      promptProfiles[name] = { name, body };
      namespaceSettings.promptProfiles = promptProfiles;
      fs.mkdirSync(path.dirname(namespacePath), { recursive: true });
      fs.writeFileSync(namespacePath, JSON.stringify(namespaceSettings, null, 2), 'utf-8');
      updateActiveNamespacePromptProfiles(ns, promptProfiles);
      return { ok: true, namespace: ns, promptProfiles };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.handle('namespace-prompt-profile-delete', async (_, namespaceName, profileName) => {
    try {
      const ns = String(namespaceName || '').trim();
      const namespacePath = getNamespaceJsonPath(ns);
      const name = normalizePromptProfileName(profileName);
      if (!name) {
        return { ok: false, error: 'Prompt profile name is required.' };
      }
      const namespaceSettings = readJsonObject(namespacePath);
      const promptProfiles = normalizePromptProfiles(namespaceSettings.promptProfiles);
      delete promptProfiles[name];
      namespaceSettings.promptProfiles = promptProfiles;
      fs.mkdirSync(path.dirname(namespacePath), { recursive: true });
      fs.writeFileSync(namespacePath, JSON.stringify(namespaceSettings, null, 2), 'utf-8');
      updateActiveNamespacePromptProfiles(ns, promptProfiles);
      return { ok: true, namespace: ns, promptProfiles };
    } catch (error) {
      return { ok: false, error: error.message || String(error) };
    }
  });

  ipcMain.on('llm-passthrough-test-direct-cancel', () => {
    if (llmPassthroughTestDirectAbortController) {
      try {
        llmPassthroughTestDirectAbortController.abort();
      } catch {
        /* ignore */
      }
    }
  });

  /**
   * LLM tab: run the same RAG + upstream path as inbound HTTP without binding to loopback HTTP.
   * @param {unknown} _
   * @param {{ prompt?: string, messages?: { role?: string, content?: string }[], namespace?: string }} payload
   */
  ipcMain.handle('llm-passthrough-test-direct', async (_, payload) => {
    await waitForServices();
    const { completeChatProxy, extractPassthroughUpstreamReply } = require('./services/llm-passthrough');
    const prompt =
      payload && typeof payload.prompt === 'string' ? String(payload.prompt).trim() : '';
    const rawMsgs = payload && payload.messages;
    const messagesFromPayload =
      Array.isArray(rawMsgs) && rawMsgs.length > 0 ? rawMsgs : null;
    if (!messagesFromPayload && !prompt) {
      return { ok: false, message: 'Enter a message or provide a conversation.' };
    }
    const nsRaw = payload && payload.namespace;
    const namespace =
      typeof nsRaw === 'string' && nsRaw.trim() ? nsRaw.trim() : undefined;
    const inboundBody = messagesFromPayload
      ? { messages: messagesFromPayload, stream: false }
      : { messages: [{ role: 'user', content: prompt }], stream: false };
    const abortController = new AbortController();
    llmPassthroughTestDirectAbortController = abortController;
    try {
      const out = await completeChatProxy(ragServiceRef, inboundBody, {
        namespace,
        abortSignal: abortController.signal
      });
      const settings = ragServiceRef.getSettings();
      const reply = extractPassthroughUpstreamReply(settings, out.upstreamJson);
      if (!reply || !String(reply).trim()) {
        return { ok: false, message: 'The model returned an empty response.' };
      }
      return {
        ok: true,
        reply: String(reply).trim(),
        contextBlock: out.contextBlock || '',
        warnings: out.warnings || [],
        errors: out.errors || []
      };
    } catch (e) {
      if (e && e.name === 'AbortError') {
        return { ok: false, cancelled: true, message: 'Cancelled.' };
      }
      const msg = e && e.message ? e.message : String(e);
      return { ok: false, message: msg };
    } finally {
      if (llmPassthroughTestDirectAbortController === abortController) {
        llmPassthroughTestDirectAbortController = null;
      }
    }
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
  ipcMain.handle('render-markdown', async (_, markdown) => {
    try {
      const { markdownToViewerDocument } = require('./markdown-viewer-html');
      return markdownToViewerDocument(markdown);
    } catch (error) {
      console.error('render-markdown:', error);
      return null;
    }
  });

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
      console.error('Error checking if path is folder:', error);
      return false;
    }
  });

  // Setup event forwarding (only if services are provided)
  if (ragService && ragRestServer) {
    setupEventListeners(ragService, ragRestServer);
  }
};

function setupEventListeners(ragService, ragRestServer) {
  // Remove existing listeners to avoid duplicates
  ragService.removeAllListeners('ingestion-update');
  ragRestServer.removeAllListeners('log');
  ragRestServer.removeAllListeners('request-log');
  
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

  ragRestServer.on('log', (data) => {
    try {
      const window = require('electron').BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('rag-rest-server-log', data);
      }
    } catch (error) {
      // Silently ignore errors when renderer frame is disposed
      // This can happen during long processing sequences if the window is closed
      if (!error.message.includes('Render frame was disposed')) {
        console.error('Error sending rag-rest-server-log:', error);
      }
    }
  });

  ragRestServer.on('request-log', (entry) => {
    try {
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.isDestroyed() && window.webContents && !window.webContents.isDestroyed()) {
        window.webContents.send('rag-rest-server-request-log', entry);
      }
    } catch (error) {
      if (!error.message.includes('Render frame was disposed')) {
        console.error('Error sending rag-rest-server-request-log:', error);
      }
    }
  });
}


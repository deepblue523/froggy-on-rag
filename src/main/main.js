const { app, BrowserWindow, ipcMain, screen } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs = require('fs');

// Get version from package.json
const packageJson = require('../../package.json');
const appVersion = packageJson.version;
const paths = require('../paths');
const { readJsonObject, patchAppSettings } = require('../settings-files');

paths.ensureUserDataLayout();
let currentNamespaceName = paths.resolveInitialNamespaceName();
let dataDir = paths.getDataDirForNamespace(currentNamespaceName);
{
  const appLayer = readJsonObject(paths.getAppSettingsPath());
  if (appLayer.activeNamespace !== currentNamespaceName) {
    patchAppSettings(paths.getAppSettingsPath(), { activeNamespace: currentNamespaceName });
  }
}

let mainWindow;
let mcpServer = null;
let ragService = null;
let mcpService = null;

function getWindowState() {
  try {
    const ws = readJsonObject(paths.getAppSettingsPath()).windowState;
    if (ws && typeof ws === 'object') {
      return ws;
    }
  } catch (error) {
    console.error('Error reading window state:', error);
  }
  return null;
}

function saveWindowState() {
  if (!mainWindow) return;

  try {
    const bounds = mainWindow.getBounds();
    const state = {
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y
    };
    const appPath = paths.getAppSettingsPath();
    const appLayer = readJsonObject(appPath);
    appLayer.windowState = state;
    fs.mkdirSync(path.dirname(appPath), { recursive: true });
    fs.writeFileSync(appPath, JSON.stringify(appLayer, null, 2), 'utf-8');
    if (ragService && ragService.settings) {
      ragService.settings.windowState = state;
    }
  } catch (error) {
    console.error('Error saving window state:', error);
  }
}

function ensureWindowOnScreen(bounds) {
  const primaryDisplay = screen.getPrimaryDisplay();
  const workArea = primaryDisplay.workArea; // { x, y, width, height }
  let { x, y, width, height } = bounds;

  // Fallback for invalid or missing values
  const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
  if (!isNumber(width)) width = 1400;
  if (!isNumber(height)) height = 900;
  if (!isNumber(x)) x = workArea.x + 50;
  if (!isNumber(y)) y = workArea.y + 50;

  // Enforce reasonable min size
  const minWidth = 800;
  const minHeight = 600;
  width = Math.max(width, minWidth);
  height = Math.max(height, minHeight);

  // Do not exceed available work area
  width = Math.min(width, workArea.width);
  height = Math.min(height, workArea.height);

  // Clamp within work area so the title bar is always reachable (no off-screen top)
  const maxX = workArea.x + (workArea.width - width);
  const maxY = workArea.y + (workArea.height - height);
  x = Math.min(Math.max(x, workArea.x), maxX);
  y = Math.min(Math.max(y, workArea.y), maxY);

  return { x, y, width, height };
}

function attachServices() {
  const { RAGService } = require('./services/rag-service');
  const { MCPService } = require('./services/mcp-service');
  ragService = new RAGService(dataDir);
  mcpService = new MCPService(ragService);
  require('./ipc-handlers')(ipcMain, ragService, mcpService);
}

async function destroyServices() {
  require('./ipc-handlers')(ipcMain, null, null);
  if (mcpService) {
    try {
      await mcpService.stop();
    } catch (error) {
      console.error('Error stopping MCP server:', error);
    }
  }
  if (ragService) {
    await ragService.dispose();
  }
  ragService = null;
  mcpService = null;
}

// Initialize services early
async function initializeServices() {
  if (ragService) {
    return;
  }
  try {
    attachServices();
  } catch (error) {
    console.error('Error initializing services:', error);
    if (error.message && error.message.includes('better_sqlite3')) {
      console.error('Please run: npm rebuild better-sqlite3');
    }
    throw error;
  }
}

async function switchNamespace(name) {
  if (!paths.isValidNamespaceName(name)) {
    throw new Error('Invalid namespace name');
  }
  const targetDir = paths.getDataDirForNamespace(name);
  if (!fs.existsSync(targetDir)) {
    throw new Error('Namespace does not exist');
  }
  if (name === currentNamespaceName) {
    return { namespace: name, dataDir: targetDir };
  }

  await destroyServices();

  currentNamespaceName = name;
  dataDir = targetDir;
  patchAppSettings(paths.getAppSettingsPath(), { activeNamespace: name });

  attachServices();

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('namespace-changed', { namespace: name });
  }
  return { namespace: name, dataDir };
}

function createWindow() {
  // Get saved window state or use defaults
  const savedState = getWindowState();
  const defaultBounds = { width: 1400, height: 900, x: undefined, y: undefined };
  const bounds = savedState 
    ? ensureWindowOnScreen(savedState)
    : defaultBounds;

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    title: `Froggy RAG MCP (v${appVersion})`,
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'renderer', 'images', 'Froggy RAG x32.png')
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // Save window state on move/resize
  let saveTimeout;
  const debouncedSave = () => {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
      saveWindowState();
    }, 500); // Debounce to avoid excessive writes
  };

  mainWindow.on('moved', debouncedSave);
  mainWindow.on('resized', debouncedSave);

  // Save state when window is closed
  mainWindow.on('close', () => {
    saveWindowState();
  });

  // Open DevTools in development
  if (process.argv.includes('--dev')) {
    mainWindow.webContents.openDevTools();
  }
}

// Auto-updater configuration
function setupAutoUpdater() {
  // Configure auto-updater
  autoUpdater.autoDownload = false; // Don't auto-download, let user choose
  autoUpdater.autoInstallOnAppQuit = true; // Install on app quit if update is downloaded
  
  // Only check for updates in production (not in dev mode)
  if (!process.argv.includes('--dev') && app.isPackaged) {
    // Check for updates on startup
    autoUpdater.checkForUpdates();
    
    // Check for updates every 4 hours
    setInterval(() => {
      autoUpdater.checkForUpdates();
    }, 4 * 60 * 60 * 1000);
  }

  // Update available
  autoUpdater.on('update-available', (info) => {
    console.log('Update available:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-available', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      });
    }
  });

  // Update not available
  autoUpdater.on('update-not-available', (info) => {
    console.log('Update not available. Current version is latest.');
    if (mainWindow) {
      mainWindow.webContents.send('update-not-available');
    }
  });

  // Error checking for updates
  autoUpdater.on('error', (err) => {
    console.error('Error checking for updates:', err);
    if (mainWindow) {
      mainWindow.webContents.send('update-error', err.message);
    }
  });

  // Download progress
  autoUpdater.on('download-progress', (progressObj) => {
    if (mainWindow) {
      mainWindow.webContents.send('update-download-progress', {
        percent: progressObj.percent,
        transferred: progressObj.transferred,
        total: progressObj.total
      });
    }
  });

  // Update downloaded
  autoUpdater.on('update-downloaded', (info) => {
    console.log('Update downloaded:', info.version);
    if (mainWindow) {
      mainWindow.webContents.send('update-downloaded', {
        version: info.version,
        releaseDate: info.releaseDate,
        releaseNotes: info.releaseNotes
      });
    }
  });
}

// IPC handlers for update actions
ipcMain.handle('check-for-updates', async () => {
  if (app.isPackaged && !process.argv.includes('--dev')) {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { success: true, result };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Updates only available in production builds' };
});

ipcMain.handle('download-update', async () => {
  if (app.isPackaged && !process.argv.includes('--dev')) {
    try {
      await autoUpdater.downloadUpdate();
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Updates only available in production builds' };
});

ipcMain.handle('install-update', async () => {
  if (app.isPackaged && !process.argv.includes('--dev')) {
    try {
      autoUpdater.quitAndInstall(false, true);
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
  return { success: false, error: 'Updates only available in production builds' };
});

app.whenReady().then(() => {
  // Setup auto-updater
  setupAutoUpdater();

  // Register IPC handlers with null refs so renderer calls can wait for services
  require('./ipc-handlers')(ipcMain, null, null);

  // Show window immediately so the app feels responsive
  createWindow();

  // Defer service init so the first paint can show the loading screen, then run in background
  setImmediate(() => {
    initializeServices().catch((error) => {
      console.error('Failed to initialize services:', error);
    });
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// IPC handlers
ipcMain.handle('get-data-dir', () => dataDir);
ipcMain.handle('get-app-version', () => appVersion);

ipcMain.handle('namespace-list', () => paths.listNamespaceDirNames());
ipcMain.handle('namespace-get-active', () => currentNamespaceName);
ipcMain.handle('namespace-set', async (_, name) => {
  try {
    return { ok: true, ...(await switchNamespace(name)) };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('namespace-create', (_, name) => {
  if (!paths.isValidNamespaceName(name)) {
    return { ok: false, error: 'Invalid name (use letters, numbers, - and _)' };
  }
  if (paths.listNamespaceDirNames().includes(name)) {
    return { ok: false, error: 'A namespace with that name already exists' };
  }
  try {
    fs.mkdirSync(paths.getDataDirForNamespace(name), { recursive: true });
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('namespace-rename', async (_, from, to) => {
  if (!paths.isValidNamespaceName(from) || !paths.isValidNamespaceName(to)) {
    return { ok: false, error: 'Invalid name' };
  }
  const root = paths.getDataRoot();
  const oldPath = path.join(root, from);
  const newPath = path.join(root, to);
  if (!fs.existsSync(oldPath)) {
    return { ok: false, error: 'Source namespace not found' };
  }
  if (fs.existsSync(newPath)) {
    return { ok: false, error: 'Target name already exists' };
  }
  try {
    if (from === currentNamespaceName) {
      await destroyServices();
      fs.renameSync(oldPath, newPath);
      currentNamespaceName = to;
      dataDir = newPath;
      patchAppSettings(paths.getAppSettingsPath(), { activeNamespace: to });
      attachServices();
    } else {
      fs.renameSync(oldPath, newPath);
    }
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('namespace-changed', { namespace: currentNamespaceName });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
ipcMain.handle('namespace-delete', async (_, name) => {
  if (!paths.isValidNamespaceName(name)) {
    return { ok: false, error: 'Invalid name' };
  }
  const all = paths.listNamespaceDirNames();
  if (all.length <= 1) {
    return { ok: false, error: 'Cannot delete the last namespace' };
  }
  const dirPath = path.join(paths.getDataRoot(), name);
  if (!fs.existsSync(dirPath)) {
    return { ok: false, error: 'Namespace not found' };
  }
  try {
    if (name === currentNamespaceName) {
      const fallback = all.find((n) => n !== name) || 'general';
      await switchNamespace(fallback);
    }
    fs.rmSync(dirPath, { recursive: true, force: true });
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('namespace-changed', { namespace: currentNamespaceName });
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

// Fallback for app-ready event (services should already be initialized)
ipcMain.on('app-ready', async () => {
  if (!ragService) {
    await initializeServices();
  }
});


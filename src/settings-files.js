/**
 * App-level settings: ~/froggy-rag-mcp/settings.json (everything except per-store keys).
 * Namespace (per vector store): data/<ns>/namespace.json — only files, directories, mruSearches.
 */

const fs = require('fs');
const path = require('path');

/** Keys stored per vector store; all other settings live in settings.json */
const NAMESPACE_ONLY_KEYS = new Set(['files', 'directories', 'mruSearches']);

function splitSettingsForPersist(merged) {
  const app = {};
  const namespace = {};
  if (!merged || typeof merged !== 'object') {
    return { app, namespace };
  }
  for (const k of Object.keys(merged)) {
    if (NAMESPACE_ONLY_KEYS.has(k)) {
      namespace[k] = merged[k];
    } else {
      app[k] = merged[k];
    }
  }
  return { app, namespace };
}

function mergeSettingsLayers(defaults, appLayer, namespaceLayer) {
  const ns = {};
  if (namespaceLayer && typeof namespaceLayer === 'object') {
    for (const k of NAMESPACE_ONLY_KEYS) {
      if (Object.prototype.hasOwnProperty.call(namespaceLayer, k)) {
        ns[k] = namespaceLayer[k];
      }
    }
  }
  return { ...defaults, ...appLayer, ...ns };
}

function patchAppSettings(appSettingsPath, patch) {
  const o = readJsonObject(appSettingsPath);
  Object.assign(o, patch);
  fs.mkdirSync(path.dirname(appSettingsPath), { recursive: true });
  fs.writeFileSync(appSettingsPath, JSON.stringify(o, null, 2), 'utf-8');
}

function readJsonObject(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
    }
  } catch (error) {
    console.error('Error reading settings file:', filePath, error);
  }
  return {};
}

function writeAppAndNamespace(appPath, namespacePath, appObj, namespaceObj) {
  fs.mkdirSync(path.dirname(appPath), { recursive: true });
  fs.mkdirSync(path.dirname(namespacePath), { recursive: true });
  fs.writeFileSync(appPath, JSON.stringify(appObj, null, 2), 'utf-8');
  fs.writeFileSync(namespacePath, JSON.stringify(namespaceObj, null, 2), 'utf-8');
}

/**
 * Merge standalone window-state.json into app settings as windowState, then remove the file.
 * Skips copying bounds if settings already contain windowState.
 */
function mergeWindowStateFileIntoAppSettings(windowStateFilePath, appSettingsPath) {
  if (!fs.existsSync(windowStateFilePath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(windowStateFilePath, 'utf-8'));
    if (!raw || typeof raw !== 'object') return;
    const appLayer = readJsonObject(appSettingsPath);
    const existing = appLayer.windowState;
    const hasExisting =
      existing &&
      typeof existing === 'object' &&
      Number.isFinite(existing.width) &&
      Number.isFinite(existing.height);
    if (!hasExisting) {
      appLayer.windowState = {
        width: raw.width,
        height: raw.height,
        x: raw.x,
        y: raw.y
      };
      fs.mkdirSync(path.dirname(appSettingsPath), { recursive: true });
      fs.writeFileSync(appSettingsPath, JSON.stringify(appLayer, null, 2), 'utf-8');
    }
    fs.unlinkSync(windowStateFilePath);
  } catch (error) {
    console.error('Error merging window-state into settings:', windowStateFilePath, error);
  }
}

/** One-time: monolithic per-namespace settings.json → app settings.json + namespace.json (current split rules). */
function migrateLegacySettingsJson(legacyPath, appPath, namespacePath) {
  if (!fs.existsSync(legacyPath)) return false;
  try {
    const legacy = readJsonObject(legacyPath);
    const appLayer = readJsonObject(appPath);
    const namespaceLayer = readJsonObject(namespacePath);
    const combined = { ...appLayer, ...namespaceLayer, ...legacy };
    const { app, namespace } = splitSettingsForPersist(combined);
    writeAppAndNamespace(appPath, namespacePath, app, namespace);
    fs.unlinkSync(legacyPath);
    return true;
  } catch (error) {
    console.error('Error migrating legacy settings.json:', error);
    return false;
  }
}

/** Defaults merged with on-disk settings (kept in sync with RAGService expectations). */
function getDefaultSettings() {
  return {
    files: [],
    directories: [],
    mruSearches: [],
    splitterPosition: 250,
    chunkSize: 1000,
    chunkOverlap: 200,
    intelligentChunking: true,
    hierarchicalChunking: true,
    hierarchicalCoarseWindowParts: 3,
    chunkingWholeDocMaxRatio: 1.15,
    chunkingLlmEnabled: false,
    chunkingLlmBaseUrl: '',
    chunkingLlmModel: '',
    chunkingLlmApiKey: '',
    chunkingLlmTimeoutMs: 45000,
    chunkingLlmParagraphSeams: false,
    retrievalDedupeChunkGroups: true,
    retrievalTopK: 10,
    retrievalScoreThreshold: 0,
    retrievalMaxChunksPerDoc: 0,
    retrievalGroupByDoc: false,
    retrievalReturnFullDocs: false,
    retrievalMaxContextTokens: 0,
    searchProfiling: false,
    minimizeToTray: false,
    llmPassthroughEnabled: false,
    llmPassthroughProvider: 'ollama',
    llmPassthroughBaseUrl: 'http://127.0.0.1:11434',
    llmPassthroughApiKey: '',
    llmPassthroughModel: '',
    llmPassthroughTimeoutMs: 120000,
    llmPassthroughSearchAlgorithm: 'hybrid',
    passthroughListenEnabled: false,
    passthroughOllamaListenEnabled: false,
    passthroughOllamaListenPort: 11435,
    passthroughOpenAiListenEnabled: false,
    passthroughOpenAiListenPort: 18080
  };
}

/**
 * Read merged app + namespace settings from disk without constructing RAGService
 * (avoids blocking the renderer on heavy service startup).
 */
function readMergedSettingsFromDisk(dataDir, appSettingsPath) {
  const legacyPath = path.join(dataDir, 'settings.json');
  const namespacePath = path.join(dataDir, 'namespace.json');
  migrateLegacySettingsJson(legacyPath, appSettingsPath, namespacePath);
  const appLayer = readJsonObject(appSettingsPath);
  const namespaceLayer = readJsonObject(namespacePath);
  return mergeSettingsLayers(getDefaultSettings(), appLayer, namespaceLayer);
}

module.exports = {
  NAMESPACE_ONLY_KEYS,
  splitSettingsForPersist,
  mergeSettingsLayers,
  readJsonObject,
  patchAppSettings,
  writeAppAndNamespace,
  mergeWindowStateFileIntoAppSettings,
  migrateLegacySettingsJson,
  getDefaultSettings,
  readMergedSettingsFromDisk
};

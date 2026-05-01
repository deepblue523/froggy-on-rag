/**
 * App-level settings: ~/froggy-rag-mcp/settings.json (everything except per-store keys).
 * Namespace (per vector store): data/<ns>/namespace.json — files, directories setting, mruSearches,
 * promptProfiles.
 */

const fs = require('fs');
const path = require('path');

/** Keys stored per vector store; all other settings live in settings.json */
const NAMESPACE_ONLY_KEYS = new Set(['files', 'directories', 'mruSearches', 'promptProfiles']);

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
    promptProfiles: {},
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
    autoStartOnSystemStartup: false,
    llmPassthroughEnabled: false,
    llmPassthroughProvider: 'ollama',
    /** @deprecated use per-provider fields; kept for one-shot migration from older settings.json */
    llmPassthroughBaseUrl: 'http://127.0.0.1:11434',
    llmPassthroughApiKey: '',
    llmPassthroughModel: '',
    llmPassthroughOllamaBaseUrl: 'http://127.0.0.1:11434',
    llmPassthroughOllamaModel: '',
    llmPassthroughOllamaApiKey: '',
    llmPassthroughOpenAiBaseUrl: '',
    llmPassthroughOpenAiModel: '',
    llmPassthroughOpenAiApiKey: '',
    llmPassthroughTimeoutMs: 120000,
    llmPassthroughSearchAlgorithm: 'hybrid',
    /** Hostname (or bracketed IPv6), optional explicit :port, for the LLM tab's inbound HTTP test URL authority only. */
    llmPassthroughTestInboundHostname: '127.0.0.1',
    /** LLM tab: `inbound-http` POSTs to local listener; `direct-ipc` calls main via IPC (same pipeline). */
    llmPassthroughTestTransport: 'inbound-http',
    /** @type {string[]} Up to 5 saved custom inbound test hosts for the LLM test target dropdown (loopback/localhost are not stored). */
    llmPassthroughTestInboundHostMru: [],
    googleCustomSearchApiKey: '',
    googleCustomSearchEngineId: '',
    googleCustomSearchNumResults: 5,
    googleCustomSearchTimeoutSeconds: 15,
    llmPassthroughIncludeWebResults: false,
    /** @deprecated mirrors llmPassthroughEnabled; kept for older settings.json */
    passthroughListenEnabled: false,
    passthroughOllamaListenEnabled: false,
    passthroughOllamaListenPort: 11435,
    passthroughOpenAiListenEnabled: false,
    passthroughOpenAiListenPort: 18080,
    /** When true, RAG REST (/admin, /store, …) and inbound passthrough HTTP requests are appended to a rolling on-disk log. */
    mcpRequestLoggingEnabled: false,
    /** Entries older than this many days are dropped when the log is updated or read. */
    mcpRequestLogRetentionDays: 7
  };
}

/**
 * Read merged app + namespace settings from disk without constructing RAGService
 * (avoids blocking the renderer on heavy service startup).
 */
/**
 * Copy legacy single-endpoint fields into per-provider slots once (when app settings never had the new keys).
 * @param {Record<string, unknown>} merged
 * @param {Record<string, unknown>} appLayer
 */
function migrateLegacyLlmPassthroughEndpoints(merged, appLayer) {
  const hasNewKey =
    Object.prototype.hasOwnProperty.call(appLayer, 'llmPassthroughOllamaBaseUrl') ||
    Object.prototype.hasOwnProperty.call(appLayer, 'llmPassthroughOpenAiBaseUrl');
  if (hasNewKey) return;
  const legacyBase = merged.llmPassthroughBaseUrl;
  const legacyModel = merged.llmPassthroughModel;
  const legacyKey = merged.llmPassthroughApiKey;
  const prov = merged.llmPassthroughProvider === 'openai' ? 'openai' : 'ollama';
  if (prov === 'openai') {
    merged.llmPassthroughOpenAiBaseUrl = String(legacyBase || '').trim();
    merged.llmPassthroughOpenAiModel = String(legacyModel || '').trim();
    merged.llmPassthroughOpenAiApiKey = String(legacyKey || '').trim();
  } else {
    merged.llmPassthroughOllamaBaseUrl =
      legacyBase != null && String(legacyBase).trim() !== ''
        ? String(legacyBase).trim()
        : 'http://127.0.0.1:11434';
    merged.llmPassthroughOllamaModel = String(legacyModel || '').trim();
    merged.llmPassthroughOllamaApiKey = String(legacyKey || '').trim();
  }
}

function readMergedSettingsFromDisk(dataDir, appSettingsPath) {
  const legacyPath = path.join(dataDir, 'settings.json');
  const namespacePath = path.join(dataDir, 'namespace.json');
  migrateLegacySettingsJson(legacyPath, appSettingsPath, namespacePath);
  const appLayer = readJsonObject(appSettingsPath);
  const namespaceLayer = readJsonObject(namespacePath);
  const merged = mergeSettingsLayers(getDefaultSettings(), appLayer, namespaceLayer);
  migrateLegacyLlmPassthroughEndpoints(merged, appLayer);
  // Inbound HTTP master toggle was merged into llmPassthroughEnabled; keep stored flag in sync.
  merged.passthroughListenEnabled = merged.llmPassthroughEnabled === true;
  return merged;
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
  migrateLegacyLlmPassthroughEndpoints,
  getDefaultSettings,
  readMergedSettingsFromDisk
};

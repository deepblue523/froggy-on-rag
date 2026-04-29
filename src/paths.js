/**
 * User data layout under ~/froggy-rag-mcp:
 *   settings.json (app-level; includes windowState, activeNamespace)
 *   data/<namespace>/vector_store.db
 *   data/<namespace>/namespace.json (files, directories setting, mruSearches, promptProfiles for that store)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const { mergeWindowStateFileIntoAppSettings, readJsonObject } = require('./settings-files');

const APP_FOLDER = 'froggy-rag-mcp';
/** Legacy typo used in some installs */
const LEGACY_TYPO_FOLDER = 'fraggy-mcp-rag';

const NAMESPACE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

function getAppRoot() {
  return path.join(os.homedir(), APP_FOLDER);
}

function getDataRoot() {
  return path.join(getAppRoot(), 'data');
}

function isValidNamespaceName(name) {
  return typeof name === 'string' && NAMESPACE_NAME_RE.test(name);
}

function getDataDirForNamespace(namespaceName) {
  if (!isValidNamespaceName(namespaceName)) {
    throw new Error(`Invalid namespace name: ${namespaceName}`);
  }
  return path.join(getDataRoot(), namespaceName);
}

function listNamespaceDirNames() {
  const root = getDataRoot();
  if (!fs.existsSync(root)) {
    return [];
  }
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.') && isValidNamespaceName(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Pick initial namespace from app settings and existing folders.
 */
function resolveInitialNamespaceName() {
  const names = listNamespaceDirNames();
  const app = readJsonObject(getAppSettingsPath());
  const saved = typeof app.activeNamespace === 'string' ? app.activeNamespace : '';
  if (saved && names.includes(saved)) {
    return saved;
  }
  if (names.includes('general')) {
    return 'general';
  }
  if (names.length > 0) {
    return names[0];
  }
  fs.mkdirSync(getDataDirForNamespace('general'), { recursive: true });
  return 'general';
}

function getResolvedDataDir() {
  return getDataDirForNamespace(resolveInitialNamespaceName());
}

function getGeneralDataDir() {
  return getDataDirForNamespace('general');
}

function getAppSettingsPath() {
  return path.join(getAppRoot(), 'settings.json');
}

function migrateIfAbsent(from, to) {
  if (!fs.existsSync(from) || fs.existsSync(to)) return;
  try {
    fs.renameSync(from, to);
  } catch (err) {
    // Windows often returns EBUSY when another process has the file open (e.g. SQLite).
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      fs.copyFileSync(from, to);
      try {
        fs.unlinkSync(from);
      } catch (_) {
        /* leave stale copy; new path is authoritative */
      }
    } else {
      throw err;
    }
  }
}

/**
 * Ensures folders exist and moves files from older layouts when safe.
 */
function ensureUserDataLayout() {
  const root = getAppRoot();
  const general = getGeneralDataDir();
  fs.mkdirSync(general, { recursive: true });

  const legacyFlatData = path.join(root, 'data');
  const appSettingsPath = getAppSettingsPath();
  mergeWindowStateFileIntoAppSettings(path.join(legacyFlatData, 'window-state.json'), appSettingsPath);
  for (const name of ['vector_store.db', 'settings.json']) {
    migrateIfAbsent(path.join(legacyFlatData, name), path.join(general, name));
  }

  const typoData = path.join(os.homedir(), LEGACY_TYPO_FOLDER, 'data');
  mergeWindowStateFileIntoAppSettings(path.join(typoData, 'window-state.json'), appSettingsPath);
  mergeWindowStateFileIntoAppSettings(path.join(root, 'window-state.json'), appSettingsPath);
  for (const name of ['vector_store.db', 'settings.json']) {
    migrateIfAbsent(path.join(typoData, name), path.join(general, name));
  }
}

module.exports = {
  getAppRoot,
  getDataRoot,
  isValidNamespaceName,
  getDataDirForNamespace,
  listNamespaceDirNames,
  resolveInitialNamespaceName,
  getResolvedDataDir,
  getGeneralDataDir,
  getAppSettingsPath,
  ensureUserDataLayout
};

/**
 * Always-inject chunks: files/folders flagged `alwaysInject` in a namespace's settings have all of
 * their chunks prepended to every search result set as standard context. They do not count toward
 * the top-K limit, and they're tagged with `metadata.alwaysInject = true` so the formatter can
 * group them under a "Standard context" section.
 */

const path = require('path');
const fs = require('fs');
const paths = require('../../../paths');
const { readJsonObject } = require('../../../settings-files');

/** Extensions matched when expanding always-inject folder entries. Mirrors `rag-service` SUPPORTED_INGEST_EXTENSIONS. */
const SUPPORTED_INGEST_EXTENSIONS = [
  '.txt',
  '.pdf',
  '.docx',
  '.xlsx',
  '.csv',
  '.html',
  '.htm',
  '.md',
  '.markdown',
  '.mdx'
];

function pathsEqual(a, b) {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  if (process.platform === 'win32') {
    return na.toLowerCase() === nb.toLowerCase();
  }
  return na === nb;
}

function findSupportedFiles(dirPath, recursive) {
  const out = [];
  const scanDir = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (SUPPORTED_INGEST_EXTENSIONS.includes(ext)) out.push(full);
      } else if (entry.isDirectory() && recursive) {
        scanDir(full);
      }
    }
  };
  scanDir(dirPath);
  return out;
}

/**
 * Collect file paths flagged for always-inject in a namespace's saved settings.
 * Inactive entries (active === false) are skipped because their docs are removed from the store.
 *
 * @param {{ files?: any[], directories?: any[] }} namespaceSettings
 * @returns {string[]} resolved file paths
 */
function collectAlwaysInjectFilePaths(namespaceSettings) {
  const out = new Set();
  const files = Array.isArray(namespaceSettings && namespaceSettings.files)
    ? namespaceSettings.files
    : [];
  for (const f of files) {
    if (!f || f.alwaysInject !== true || f.active === false) continue;
    if (typeof f.path !== 'string' || !f.path) continue;
    out.add(path.resolve(f.path));
  }
  const dirs = Array.isArray(namespaceSettings && namespaceSettings.directories)
    ? namespaceSettings.directories
    : [];
  for (const d of dirs) {
    if (!d || d.alwaysInject !== true || d.active === false) continue;
    if (typeof d.path !== 'string' || !d.path) continue;
    let dirFiles;
    try {
      dirFiles = findSupportedFiles(d.path, d.recursive === true);
    } catch {
      dirFiles = [];
    }
    for (const fp of dirFiles) out.add(path.resolve(fp));
  }
  return Array.from(out);
}

/**
 * Read the namespace's saved settings (files + directories). Uses the active in-memory settings
 * when the namespace matches `ragService.dataDir`; otherwise loads `<dataDir>/namespace.json`.
 *
 * @param {{ dataDir: string, getSettings: () => Record<string, unknown> }} ragService
 * @param {string} namespace
 */
function readNamespaceSettings(ragService, namespace) {
  const ns = String(namespace || '').trim();
  if (!ns) return { files: [], directories: [] };
  const targetDir = path.resolve(paths.getDataDirForNamespace(ns));
  const activeDir = ragService && ragService.dataDir ? path.resolve(ragService.dataDir) : null;
  if (activeDir && targetDir === activeDir && typeof ragService.getSettings === 'function') {
    const s = ragService.getSettings() || {};
    return {
      files: Array.isArray(s.files) ? s.files : [],
      directories: Array.isArray(s.directories) ? s.directories : []
    };
  }
  const obj = readJsonObject(path.join(targetDir, 'namespace.json'));
  return {
    files: Array.isArray(obj.files) ? obj.files : [],
    directories: Array.isArray(obj.directories) ? obj.directories : []
  };
}

/**
 * Get always-inject chunk hits for a namespace, in the same shape returned by corpus search.
 * Each hit carries `metadata.alwaysInject = true` so the formatter can render them under the
 * standard-context section.
 *
 * @param {{ dataDir: string, getSettings: () => Record<string, unknown> }} ragService
 * @param {string} namespace
 * @param {{ getDocumentByFilePath: (p: string) => any, getDocumentChunks: (id: string) => any[] }} vectorStore
 */
function collectAlwaysInjectHits(ragService, namespace, vectorStore) {
  if (!vectorStore) return [];
  const namespaceSettings = readNamespaceSettings(ragService, namespace);
  const filePaths = collectAlwaysInjectFilePaths(namespaceSettings);
  if (filePaths.length === 0) return [];

  const hits = [];
  for (const filePath of filePaths) {
    let doc;
    try {
      doc = vectorStore.getDocumentByFilePath(filePath);
    } catch {
      doc = null;
    }
    if (!doc || !doc.id) continue;
    let chunks;
    try {
      chunks = vectorStore.getDocumentChunks(doc.id) || [];
    } catch {
      chunks = [];
    }
    for (const ch of chunks) {
      const baseMeta = ch && ch.metadata && typeof ch.metadata === 'object' && !Array.isArray(ch.metadata)
        ? { ...ch.metadata }
        : {};
      hits.push({
        chunkId: ch.id,
        documentId: doc.id,
        namespace,
        content: ch.content || '',
        score: 1,
        similarity: 1,
        algorithm: 'always-inject',
        metadata: {
          ...baseMeta,
          alwaysInject: true,
          fileName: doc.file_name,
          filePath: doc.file_path,
          fileType: doc.file_type,
          namespace
        }
      });
    }
  }
  return hits;
}

module.exports = {
  collectAlwaysInjectHits,
  collectAlwaysInjectFilePaths,
  readNamespaceSettings,
  __testing: {
    findSupportedFiles,
    pathsEqual,
    SUPPORTED_INGEST_EXTENSIONS
  }
};

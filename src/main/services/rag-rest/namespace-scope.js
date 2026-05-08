/**
 * Corpus namespace resolution for admin REST, RAG search, and LLM passthrough.
 *
 * Each namespace maps to a separate SQLite corpus under the user data layout:
 *   ~/froggy-rag-mcp/data/<namespace>/vector_store.db
 *
 * When `namespace` is omitted on corpus tools or admin query params:
 * - If the running server's `dataDir` is exactly `getDataDirForNamespace(<name>)` for some valid
 *   name under the standard data root, that name is the **default** and all operations are
 *   scoped to that single corpus (same as pre-namespace-aware behavior).
 * - If `dataDir` is outside that layout (e.g. custom CLI `--data-path`), there is no inferred
 *   default; corpus reads/search aggregate **all** namespace folders that exist on disk
 *   (and ambiguous ID lookups without `namespace` return an error if multiple corpora match).
 *
 * When `namespace` is provided explicitly, only that corpus is used; the name must exist and
 * have `vector_store.db`.
 */

const path = require('path');
const fs = require('fs');
const paths = require('../../../paths');
const { VectorStore } = require('../vector-store');

function normalizeNamespaceInput(arg) {
  if (arg === undefined || arg === null) return null;
  const s = String(arg).trim();
  return s === '' ? null : s;
}

/**
 * @param {import('../rag-service')} ragService
 * @returns {string | null}
 */
function inferDefaultCorpusNamespaceName(ragService) {
  const dataRoot = path.resolve(paths.getDataRoot());
  const resolved = path.resolve(ragService.dataDir);
  const rel = path.relative(dataRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    return null;
  }
  const first = rel.split(path.sep)[0];
  if (!paths.isValidNamespaceName(first)) {
    return null;
  }
  if (path.resolve(paths.getDataDirForNamespace(first)) !== resolved) {
    return null;
  }
  return first;
}

function listCorpusNamespaceNamesOnDisk() {
  return paths
    .listNamespaceDirNames()
    .filter((n) => fs.existsSync(path.join(paths.getDataDirForNamespace(n), 'vector_store.db')));
}

/**
 * @param {string} name
 */
function assertCorpusExistsForNamespace(name) {
  if (!paths.isValidNamespaceName(name)) {
    const err = new Error(`Invalid namespace name: ${name}`);
    err.code = 'INVALID_NAMESPACE';
    throw err;
  }
  const dir = paths.getDataDirForNamespace(name);
  const dbPath = path.join(dir, 'vector_store.db');
  if (!fs.existsSync(dbPath)) {
    const err = new Error(`Namespace has no corpus (missing vector_store.db): ${name}`);
    err.code = 'NAMESPACE_NOT_FOUND';
    throw err;
  }
}

/**
 * Resolve which corpus namespace(s) a request refers to.
 *
 * @param {import('../rag-service')} ragService
 * @param {unknown} explicitNamespace
 * @returns {{ mode: 'single' | 'all', namespaces: string[], usePrimaryForNamespace: (name: string) => boolean }}
 */
function resolveCorpusNamespaces(ragService, explicitNamespace) {
  const explicit = normalizeNamespaceInput(explicitNamespace);
  const primaryResolved = path.resolve(ragService.dataDir);

  if (explicit) {
    assertCorpusExistsForNamespace(explicit);
    return {
      mode: 'single',
      namespaces: [explicit],
      usePrimaryForNamespace: (name) =>
        path.resolve(paths.getDataDirForNamespace(name)) === primaryResolved
    };
  }

  const active = inferDefaultCorpusNamespaceName(ragService);
  if (active) {
    return {
      mode: 'single',
      namespaces: [active],
      usePrimaryForNamespace: () => true
    };
  }

  const names = listCorpusNamespaceNamesOnDisk();
  return {
    mode: 'all',
    namespaces: names,
    usePrimaryForNamespace: (name) => path.resolve(paths.getDataDirForNamespace(name)) === primaryResolved
  };
}

/**
 * Ingest/stats target: never "all" — explicit namespace or default inferred, else primary dataDir only.
 *
 * @param {import('../rag-service')} ragService
 * @param {unknown} explicitNamespace
 * @returns {{ namespace: string, dataDir: string, usePrimary: boolean }}
 */
function resolveIngestOrStatsTarget(ragService, explicitNamespace) {
  const explicit = normalizeNamespaceInput(explicitNamespace);
  const primaryResolved = path.resolve(ragService.dataDir);

  if (explicit) {
    assertCorpusExistsForNamespace(explicit);
    const dir = path.resolve(paths.getDataDirForNamespace(explicit));
    return {
      namespace: explicit,
      dataDir: dir,
      usePrimary: dir === primaryResolved
    };
  }

  const active = inferDefaultCorpusNamespaceName(ragService);
  if (active) {
    return {
      namespace: active,
      dataDir: primaryResolved,
      usePrimary: true
    };
  }

  return {
    namespace: null,
    dataDir: primaryResolved,
    usePrimary: true
  };
}

/**
 * @param {string} dataDir
 * @param {(vs: import('../vector-store').VectorStore) => void | T} fn
 * @returns {T}
 * @template T
 */
function withVectorStore(dataDir, fn) {
  const vs = new VectorStore(dataDir);
  try {
    return fn(vs);
  } finally {
    vs.close();
  }
}

/**
 * @param {string} dataDir
 * @param {(vs: import('../vector-store').VectorStore) => Promise<void | T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withVectorStoreAsync(dataDir, fn) {
  const vs = new VectorStore(dataDir);
  try {
    return await fn(vs);
  } finally {
    vs.close();
  }
}

/**
 * Run `fn(vs)` with a VectorStore for `namespace`, picking the active corpus's in-memory store when
 * the namespace is active, otherwise leasing from `ragService.vectorStorePool` (TTL idle close +
 * ref counting). Falls back to a one-shot VectorStore when the pool isn't attached (e.g. tests).
 *
 * @param {{ dataDir?: string, vectorStore?: import('../vector-store').VectorStore, vectorStorePool?: import('../vector-store-pool').VectorStorePool }} ragService
 * @param {string} namespace
 * @param {(vs: import('../vector-store').VectorStore) => T} fn
 * @returns {T}
 * @template T
 */
function withCorpusForNamespace(ragService, namespace, fn) {
  const ns = String(namespace || '').trim();
  if (!ns) {
    throw new Error('namespace is required');
  }
  if (ragService && ragService.vectorStorePool) {
    const lease = ragService.vectorStorePool.acquire(ns);
    try {
      return fn(lease.vs);
    } finally {
      lease.release();
    }
  }
  return withVectorStore(paths.getDataDirForNamespace(ns), fn);
}

module.exports = {
  normalizeNamespaceInput,
  inferDefaultCorpusNamespaceName,
  listCorpusNamespaceNamesOnDisk,
  resolveCorpusNamespaces,
  resolveIngestOrStatsTarget,
  assertCorpusExistsForNamespace,
  withVectorStore,
  withVectorStoreAsync,
  withCorpusForNamespace
};

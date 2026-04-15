/**
 * Shared corpus search across one or more namespace stores (used by MCP tools and admin REST).
 */

const { VectorStore } = require('../vector-store');
const paths = require('../../../paths');
const { resolveCorpusNamespaces } = require('./namespace-scope');

function mergeMetaWithNamespace(metadata, namespace) {
  const base =
    metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? { ...metadata } : {};
  base.namespace = namespace;
  return base;
}

function mapSearchHit(r, namespace) {
  return {
    chunkId: r.chunkId,
    documentId: r.documentId,
    namespace,
    content: r.content,
    score: r.score,
    similarity: r.similarity,
    algorithm: r.algorithm,
    metadata: mergeMetaWithNamespace(r.metadata, namespace)
  };
}

/**
 * @param {import('../rag-service')} ragService
 * @param {{ namespace?: unknown, query: string, topK: number, algorithm: string, webSearch?: boolean }} opts
 */
async function searchCorpusInNamespaces(ragService, opts) {
  const query = opts.query;
  const topK = opts.topK;
  const algorithm = opts.algorithm;
  const webSearch = Boolean(opts.webSearch);

  const resolved = resolveCorpusNamespaces(ragService, opts.namespace);
  const lim = Math.floor(topK);
  const scopeNote =
    resolved.mode === 'all'
      ? 'No default namespace inferred from server dataDir; searched all corpora on disk.'
      : null;

  if (resolved.mode === 'all' && resolved.namespaces.length === 0) {
    return {
      results: [],
      warnings: [scopeNote || 'No corpora found.'],
      errors: [],
      scope: { mode: 'all', namespaces: [] }
    };
  }

  const merged = [];
  const warnings = [];
  const errors = [];
  const single = resolved.mode === 'single';

  for (const ns of resolved.namespaces) {
    const dir = paths.getDataDirForNamespace(ns);
    const useP = resolved.usePrimaryForNamespace(ns);
    const searchOpts = { webSearch: single && webSearch };
    /** @type {VectorStore | null} */
    let vs = null;
    if (!useP) {
      vs = new VectorStore(dir);
      searchOpts.corpusVectorStore = vs;
    }
    try {
      const payload = await ragService.search(query.trim(), lim, algorithm, searchOpts);
      warnings.push(...(payload.warnings || []));
      errors.push(...(payload.errors || []));
      for (const r of payload.results || []) {
        merged.push(mapSearchHit(r, ns));
      }
    } finally {
      if (vs) vs.close();
    }
  }

  if (resolved.mode === 'all') {
    merged.sort((a, b) => (b.score || 0) - (a.score || 0));
    const sliced = merged.slice(0, lim);
    if (webSearch) {
      warnings.push(
        'webSearch was ignored because multiple namespaces were searched; pass a single namespace to enable web results.'
      );
    }
    return {
      results: sliced,
      warnings,
      errors,
      scope: { mode: 'all', namespacesSearched: resolved.namespaces, note: scopeNote }
    };
  }

  return {
    results: merged,
    warnings,
    errors,
    scope: { mode: 'single', namespace: resolved.namespaces[0] }
  };
}

module.exports = {
  searchCorpusInNamespaces,
  mergeMetaWithNamespace,
  mapSearchHit
};

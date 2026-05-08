/**
 * Shared corpus search across one or more namespace stores (LLM passthrough and admin REST).
 *
 * Non-active namespaces are served from `ragService.vectorStorePool`, which keeps a resident
 * handle per namespace (with TTL idle close + ref counting). This lets concurrent passthrough
 * requests target different namespaces without thrashing SQLite handles.
 */

const { VectorStore } = require('../vector-store');
const { resolveCorpusNamespaces } = require('./namespace-scope');
const { collectAlwaysInjectHits } = require('./always-inject');

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
 * @param {{ namespace?: unknown, query: string, topK: number, algorithm: string, filters?: object }} opts
 */
async function searchCorpusInNamespaces(ragService, opts) {
  const query = opts.query;
  const topK = opts.topK;
  const algorithm = opts.algorithm;

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
  const alwaysInjectMerged = [];
  const warnings = [];
  const errors = [];

  for (const ns of resolved.namespaces) {
    const useP = resolved.usePrimaryForNamespace(ns);
    /** @type {{ vs: VectorStore, release: () => void, primary: boolean } | null} */
    let lease = null;
    const searchOpts = {};
    if (!useP) {
      // Fall back to a one-shot VectorStore when no pool is attached (e.g. tests with a stub
      // ragService). In normal app runtime the pool is always present.
      if (ragService && ragService.vectorStorePool) {
        lease = ragService.vectorStorePool.acquire(ns);
        searchOpts.corpusVectorStore = lease.vs;
      } else {
        const paths = require('../../../paths');
        const tempVs = new VectorStore(paths.getDataDirForNamespace(ns));
        lease = {
          vs: tempVs,
          primary: false,
          release: () => {
            try {
              tempVs.close();
            } catch {
              /* ignore */
            }
          }
        };
        searchOpts.corpusVectorStore = lease.vs;
      }
    }
    try {
      searchOpts.topK = lim;
      if (opts.filters && typeof opts.filters === 'object') {
        searchOpts.filters = opts.filters;
      }
      const payload = await ragService.search(query.trim(), lim, algorithm, searchOpts);
      warnings.push(...(payload.warnings || []));
      errors.push(...(payload.errors || []));
      for (const r of payload.results || []) {
        merged.push(mapSearchHit(r, ns));
      }

      // Always-inject chunks live alongside regular search results in the same store. They're
      // collected per namespace so the standard-context section reflects the namespace scope.
      const injectStore = useP ? ragService.vectorStore : lease && lease.vs;
      try {
        const injectHits = collectAlwaysInjectHits(ragService, ns, injectStore);
        for (const h of injectHits) alwaysInjectMerged.push(h);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        warnings.push(`Failed to collect always-inject chunks for namespace "${ns}": ${msg}`);
      }
    } finally {
      if (lease) {
        try {
          lease.release();
        } catch (e) {
          console.error(`[corpus-namespace-query] release error for "${ns}":`, e);
        }
      }
    }
  }

  if (resolved.mode === 'all') {
    merged.sort((a, b) => (b.score || 0) - (a.score || 0));
    const sliced = merged.slice(0, lim);
    return {
      results: [...alwaysInjectMerged, ...sliced],
      warnings,
      errors,
      scope: { mode: 'all', namespacesSearched: resolved.namespaces, note: scopeNote }
    };
  }

  return {
    results: [...alwaysInjectMerged, ...merged],
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

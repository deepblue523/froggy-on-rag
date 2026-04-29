const express = require('express');
const paths = require('../../../paths');
const {
  resolveCorpusNamespaces,
  resolveIngestOrStatsTarget,
  assertCorpusExistsForNamespace,
  withVectorStore
} = require('./namespace-scope');
const { searchCorpusInNamespaces, mergeMetaWithNamespace } = require('./corpus-namespace-query');

/**
 * Admin / store inspection and maintenance REST API (not MCP).
 * Mounted at `/admin` and `/store` (same routes).
 *
 * Namespace query param (and optional JSON body `namespace` for POST):
 * - Omitted: uses the corpus tied to the server's dataDir when it matches `data/<name>/`
 *   under the user data root; otherwise stats/ingest use the primary store only, while
 *   document listing merges all corpora (see namespace-scope.js).
 * - `?namespace=<name>`: target that corpus under ~/froggy-rag-mcp/data/<name>/.
 */

function mapSearchResults(payload) {
  const rows = payload.results || [];
  return {
    results: rows.map((r) => ({
      chunkId: r.chunkId,
      documentId: r.documentId,
      namespace: r.namespace,
      content: r.content,
      score: r.score,
      similarity: r.similarity,
      algorithm: r.algorithm,
      metadata: r.metadata
    })),
    warnings: payload.warnings || [],
    errors: payload.errors || [],
    scope: payload.scope
  };
}

function createAdminHandlers(ragService, log) {
  return {
    getStats(req, res) {
      try {
        const target = resolveIngestOrStatsTarget(ragService, req.query.namespace);
        if (target.usePrimary) {
          const stats = ragService.getVectorStoreStats();
          return res.json({ stats, namespace: target.namespace });
        }
        const stats = withVectorStore(target.dataDir, (vs) => vs.getStats());
        return res.json({ stats, namespace: target.namespace });
      } catch (error) {
        log('error', 'Admin stats error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    async ingestFile(req, res) {
      try {
        const { filePath, watch = false } = req.body || {};
        if (!filePath) {
          return res.status(400).json({ error: 'filePath is required' });
        }
        const target = resolveIngestOrStatsTarget(ragService, req.query.namespace);
        log('info', 'Admin ingest file', { filePath, watch, namespace: target.namespace });
        const opts = {};
        if (!target.usePrimary) {
          opts.targetDataDir = target.dataDir;
          opts.targetNamespace = target.namespace;
        }
        const result = await ragService.ingestFile(filePath, watch, opts);
        res.json(result);
      } catch (error) {
        log('error', 'Admin ingest file error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    async ingestDirectory(req, res) {
      try {
        const { dirPath, recursive = false, watch = false } = req.body || {};
        if (!dirPath) {
          return res.status(400).json({ error: 'dirPath is required' });
        }
        const target = resolveIngestOrStatsTarget(ragService, req.query.namespace);
        log('info', 'Admin ingest folder', { dirPath, recursive, watch, namespace: target.namespace });
        const opts = {};
        if (!target.usePrimary) {
          opts.targetDataDir = target.dataDir;
          opts.targetNamespace = target.namespace;
        }
        const result = await ragService.ingestDirectory(dirPath, recursive, watch, opts);
        res.json(result);
      } catch (error) {
        log('error', 'Admin ingest folder error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    listDocuments(req, res) {
      try {
        const resolved = resolveCorpusNamespaces(ragService, req.query.namespace);
        const combined = [];
        for (const ns of resolved.namespaces) {
          const rows = resolved.usePrimaryForNamespace(ns)
            ? ragService.getDocuments()
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocuments());
          for (const doc of rows) {
            combined.push({ ...doc, namespace: ns });
          }
        }
        res.json({ documents: combined });
      } catch (error) {
        log('error', 'Admin list documents error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    getDocument(req, res) {
      try {
        const { documentId } = req.params;
        const qNs = req.query.namespace;
        if (qNs) {
          assertCorpusExistsForNamespace(String(qNs).trim());
          const ns = String(qNs).trim();
          const doc = withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(documentId));
          if (!doc) {
            return res.status(404).json({ error: 'Document not found' });
          }
          return res.json({ document: { ...doc, namespace: ns } });
        }
        const resolved = resolveCorpusNamespaces(ragService, null);
        if (resolved.mode === 'single') {
          const ns = resolved.namespaces[0];
          const doc = resolved.usePrimaryForNamespace(ns)
            ? ragService.getDocument(documentId)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(documentId));
          if (!doc) {
            return res.status(404).json({ error: 'Document not found' });
          }
          return res.json({ document: { ...doc, namespace: ns } });
        }
        const hits = [];
        for (const ns of resolved.namespaces) {
          const doc = resolved.usePrimaryForNamespace(ns)
            ? ragService.getDocument(documentId)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(documentId));
          if (doc) hits.push({ doc, ns });
        }
        if (hits.length === 0) {
          return res.status(404).json({ error: 'Document not found' });
        }
        if (hits.length > 1) {
          return res.status(400).json({
            error: 'documentId matches multiple corpora; pass namespace query parameter',
            namespaces: hits.map((h) => h.ns)
          });
        }
        return res.json({ document: { ...hits[0].doc, namespace: hits[0].ns } });
      } catch (error) {
        log('error', 'Admin get document error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    getDocumentChunks(req, res) {
      try {
        const { documentId } = req.params;
        const qNs = req.query.namespace;
        if (qNs) {
          assertCorpusExistsForNamespace(String(qNs).trim());
          const ns = String(qNs).trim();
          const chunks = withVectorStore(paths.getDataDirForNamespace(ns), (vs) =>
            vs.getDocumentChunks(documentId)
          );
          return res.json({
            chunks: chunks.map((c) => ({
              ...c,
              metadata: mergeMetaWithNamespace(c.metadata, ns)
            }))
          });
        }
        const resolved = resolveCorpusNamespaces(ragService, null);
        if (resolved.mode === 'single') {
          const ns = resolved.namespaces[0];
          const chunks = resolved.usePrimaryForNamespace(ns)
            ? ragService.getDocumentChunks(documentId)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) =>
                vs.getDocumentChunks(documentId)
              );
          return res.json({
            chunks: chunks.map((c) => ({
              ...c,
              metadata: mergeMetaWithNamespace(c.metadata, ns)
            }))
          });
        }
        const hits = [];
        for (const ns of resolved.namespaces) {
          const chunks = resolved.usePrimaryForNamespace(ns)
            ? ragService.getDocumentChunks(documentId)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) =>
                vs.getDocumentChunks(documentId)
              );
          if (chunks.length > 0) hits.push({ chunks, ns });
        }
        if (hits.length === 0) {
          return res.json({ chunks: [] });
        }
        if (hits.length > 1) {
          return res.status(400).json({
            error: 'document has chunks in multiple corpora; pass namespace query parameter',
            namespaces: hits.map((h) => h.ns)
          });
        }
        return res.json({
          chunks: hits[0].chunks.map((c) => ({
            ...c,
            metadata: mergeMetaWithNamespace(c.metadata, hits[0].ns)
          }))
        });
      } catch (error) {
        log('error', 'Admin get chunks error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    getChunk(req, res) {
      try {
        const { chunkId } = req.params;
        const qNs = req.query.namespace;
        if (qNs) {
          assertCorpusExistsForNamespace(String(qNs).trim());
          const ns = String(qNs).trim();
          const chunk = withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(chunkId));
          if (!chunk) {
            return res.status(404).json({ error: 'Chunk not found' });
          }
          return res.json({
            chunk: { ...chunk, metadata: mergeMetaWithNamespace(chunk.metadata, ns) }
          });
        }
        const resolved = resolveCorpusNamespaces(ragService, null);
        if (resolved.mode === 'single') {
          const ns = resolved.namespaces[0];
          const chunk = resolved.usePrimaryForNamespace(ns)
            ? ragService.getChunkContent(chunkId)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(chunkId));
          if (!chunk) {
            return res.status(404).json({ error: 'Chunk not found' });
          }
          return res.json({
            chunk: { ...chunk, metadata: mergeMetaWithNamespace(chunk.metadata, ns) }
          });
        }
        const hits = [];
        for (const ns of resolved.namespaces) {
          const chunk = resolved.usePrimaryForNamespace(ns)
            ? ragService.getChunkContent(chunkId)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(chunkId));
          if (chunk) hits.push({ chunk, ns });
        }
        if (hits.length === 0) {
          return res.status(404).json({ error: 'Chunk not found' });
        }
        if (hits.length > 1) {
          return res.status(400).json({
            error: 'chunkId matches multiple corpora; pass namespace query parameter',
            namespaces: hits.map((h) => h.ns)
          });
        }
        return res.json({
          chunk: {
            ...hits[0].chunk,
            metadata: mergeMetaWithNamespace(hits[0].chunk.metadata, hits[0].ns)
          }
        });
      } catch (error) {
        log('error', 'Admin get chunk error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    },

    /** Corpus search across the active or requested namespace. */
    async corpusSearch(req, res) {
      try {
        const body = req.body || {};
        const { query, limit = 10, algorithm = 'hybrid', filters } = body;
        const namespace = req.query.namespace !== undefined ? req.query.namespace : body.namespace;
        if (!query) {
          return res.status(400).json({ error: 'query is required' });
        }
        const algo =
          filters && typeof filters === 'object' && filters.algorithm ? filters.algorithm : algorithm;
        log('info', 'Admin corpus search', { query, limit, algorithm: algo, namespace });
        const out = await searchCorpusInNamespaces(ragService, {
          namespace,
          query,
          topK: Number(limit) || 10,
          algorithm: algo
        });
        res.json(mapSearchResults(out));
      } catch (error) {
        log('error', 'Admin corpus search error', { error: error.message });
        const code = error.code === 'INVALID_NAMESPACE' || error.code === 'NAMESPACE_NOT_FOUND' ? 400 : 500;
        res.status(code).json({ error: error.message });
      }
    }
  };
}

function createAdminRouter(ragService, log) {
  const h = createAdminHandlers(ragService, log);
  const router = express.Router();

  router.get('/stats', h.getStats);
  router.post('/ingest/file', h.ingestFile);
  router.post('/ingest/directory', h.ingestDirectory);
  router.get('/documents', h.listDocuments);
  router.get('/documents/:documentId', h.getDocument);
  router.get('/documents/:documentId/chunks', h.getDocumentChunks);
  router.get('/chunks/:chunkId', h.getChunk);
  router.post('/corpus-search', h.corpusSearch);

  return router;
}

/**
 * @param {import('express').Express} app
 * @param {import('../rag-service')} ragService
 * @param {(level: string, message: string, data?: object) => void} log
 */
function mountAdminRoutes(app, ragService, log) {
  app.use('/admin', createAdminRouter(ragService, log));
  app.use('/store', createAdminRouter(ragService, log));
}

module.exports = { createAdminRouter, mountAdminRoutes, createAdminHandlers };

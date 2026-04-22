/**
 * MCP tool definitions and execution, backed by RAGService.
 */

const {
  resolveCorpusNamespaces,
  inferDefaultCorpusNamespaceName,
  listCorpusNamespaceNamesOnDisk,
  assertCorpusExistsForNamespace,
  withVectorStore
} = require('./namespace-scope');
const { searchCorpusInNamespaces, mergeMetaWithNamespace } = require('./corpus-namespace-query');
const { runLlmPassthrough } = require('../llm-passthrough');
const paths = require('../../../paths');

const DOCUMENT_RESOURCE_SCHEME = 'froggy-rag';
const CHUNK_RESOURCE_SCHEME = 'froggy-rag-chunk';

const TOOL_DEFINITIONS = [
  {
    name: 'search_vector_store',
    description:
      'Search the local vector store for relevant content. Optional namespace scopes one corpus; omitted uses the server default namespace when inferable, otherwise searches all corpora on disk.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        topK: { type: 'integer', default: 5 },
        filters: { type: 'object' },
        namespace: { type: 'string', description: 'Corpus namespace (data/<name>/vector_store.db).' }
      },
      required: ['query']
    }
  },
  {
    name: 'get_document',
    description:
      'Get a document by ID. Pass namespace when IDs may collide across corpora; omitted uses default namespace or disambiguates across all corpora.',
    inputSchema: {
      type: 'object',
      properties: {
        documentId: { type: 'string' },
        namespace: { type: 'string' }
      },
      required: ['documentId']
    }
  },
  {
    name: 'get_chunk',
    description:
      'Get a chunk by ID. Pass namespace when IDs may collide across corpora; omitted uses default namespace or disambiguates across all corpora.',
    inputSchema: {
      type: 'object',
      properties: {
        chunkId: { type: 'string' },
        namespace: { type: 'string' }
      },
      required: ['chunkId']
    }
  },
  {
    name: 'list_documents',
    description:
      'List documents in the vector store. Optional namespace scopes one corpus; omitted uses default or merges all corpora (with per-document namespace).',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', default: 50 },
        offset: { type: 'integer', default: 0 },
        namespace: { type: 'string' }
      }
    }
  },
  {
    name: 'list_namespaces',
    description:
      'List corpus namespace directories under the user data root and whether each has a vector store. Includes the active/default namespace when inferable.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'llm_rag_passthrough',
    description:
      'Run RAG retrieval over the vector store (same namespace rules as search_vector_store), inject matching chunks into the prompt, then forward to the configured LLM (Ollama or OpenAI-compatible). Requires LLM Passthrough to be enabled and configured in Froggy app settings (base URL, model, etc.). Returns the model reply plus retrieval scope and optional context preview.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'User question or instruction to answer using retrieved documents.' },
        namespace: {
          type: 'string',
          description:
            'Corpus namespace to search; omit to use server default or merged multi-corpus behavior (same as search_vector_store).'
        },
        topK: {
          type: 'integer',
          description: 'Max retrieval hits before sending to the LLM (1–100). Default: server Retrieval top K.'
        },
        algorithm: {
          type: 'string',
          enum: ['hybrid', 'bm25', 'tfidf', 'vector'],
          description: 'Retrieval algorithm for this call (overrides LLM Passthrough settings default when set).'
        }
      },
      required: ['prompt']
    }
  }
];

function textToolResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
      }
    ]
  };
}

function rpcError(code, message, data) {
  return { error: { code, message, data } };
}

class MCPToolRegistry {
  /**
   * @param {import('../rag-service')} ragService
   * @param {(level: string, message: string, data?: object) => void} log
   */
  constructor(ragService, log) {
    this.ragService = ragService;
    this.log = log;
    /** @type {Record<string, (args: object) => Promise<{ result?: object, error?: object }>>} */
    this._handlers = {
      search_vector_store: (args) => this._searchCorpus(args),
      get_document: (args) => this._getDocument(args),
      get_chunk: (args) => this._getChunk(args),
      list_documents: (args) => this._listDocuments(args),
      list_namespaces: (args) => this._listNamespaces(args),
      llm_rag_passthrough: (args) => this._llmRagPassthrough(args)
    };
  }

  listTools() {
    return TOOL_DEFINITIONS.map((t) => ({ ...t }));
  }

  /**
   * @param {string} name
   * @param {object} args
   */
  async call(name, args) {
    const handler = this._handlers[name];
    if (!handler) {
      return rpcError(-32602, 'Invalid params', `Unknown tool: ${name}`);
    }
    try {
      return await handler(args && typeof args === 'object' ? args : {});
    } catch (err) {
      this.log('error', 'Tool execution error', { name, error: err.message });
      return rpcError(-32000, 'Server error', err.message);
    }
  }

  async _searchCorpus(args) {
    const query = args.query;
    if (typeof query !== 'string' || !query.trim()) {
      return rpcError(-32602, 'Invalid params', 'query is required');
    }
    const topK = args.topK !== undefined ? Number(args.topK) : 5;
    if (!Number.isFinite(topK) || topK < 1) {
      return rpcError(-32602, 'Invalid params', 'topK must be a positive integer');
    }
    const filters = args.filters && typeof args.filters === 'object' ? args.filters : {};
    const algorithm =
      typeof filters.algorithm === 'string' && filters.algorithm ? filters.algorithm : 'hybrid';

    try {
      const out = await searchCorpusInNamespaces(this.ragService, {
        namespace: args.namespace,
        query: query.trim(),
        topK: Math.floor(topK),
        algorithm
      });
      return {
        result: textToolResult({
          results: out.results,
          scope: out.scope,
          warnings: out.warnings,
          errors: out.errors
        })
      };
    } catch (e) {
      return rpcError(-32602, 'Invalid params', e.message);
    }
  }

  async _getDocument(args) {
    const documentId = args.documentId;
    if (typeof documentId !== 'string' || !documentId.trim()) {
      return rpcError(-32602, 'Invalid params', 'documentId is required');
    }
    const id = documentId.trim();
    const explicitNs =
      args.namespace !== undefined && args.namespace !== null && String(args.namespace).trim() !== ''
        ? String(args.namespace).trim()
        : null;

    if (explicitNs) {
      try {
        assertCorpusExistsForNamespace(explicitNs);
      } catch (e) {
        return rpcError(-32602, 'Invalid params', e.message);
      }
      const dir = paths.getDataDirForNamespace(explicitNs);
      const doc = withVectorStore(dir, (vs) => vs.getDocument(id));
      if (!doc) {
        return rpcError(-32001, 'Document not found', { documentId: id, namespace: explicitNs });
      }
      return { result: textToolResult({ document: { ...doc, namespace: explicitNs } }) };
    }

    let resolved;
    try {
      resolved = resolveCorpusNamespaces(this.ragService, null);
    } catch (e) {
      return rpcError(-32000, 'Server error', e.message);
    }

    if (resolved.mode === 'single') {
      const ns = resolved.namespaces[0];
      const doc = resolved.usePrimaryForNamespace(ns)
        ? this.ragService.getDocument(id)
        : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(id));
      if (!doc) {
        return rpcError(-32001, 'Document not found', { documentId: id, namespace: ns });
      }
      return { result: textToolResult({ document: { ...doc, namespace: ns } }) };
    }

    const hits = [];
    for (const ns of resolved.namespaces) {
      const doc = resolved.usePrimaryForNamespace(ns)
        ? this.ragService.getDocument(id)
        : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(id));
      if (doc) hits.push({ doc, namespace: ns });
    }
    if (hits.length === 0) {
      return rpcError(-32001, 'Document not found', id);
    }
    if (hits.length > 1) {
      return rpcError(
        -32602,
        'Invalid params',
        `documentId matches multiple corpora; pass namespace. Found in: ${hits.map((h) => h.namespace).join(', ')}`
      );
    }
    return {
      result: textToolResult({ document: { ...hits[0].doc, namespace: hits[0].namespace } })
    };
  }

  async _getChunk(args) {
    const chunkId = args.chunkId;
    if (typeof chunkId !== 'string' || !chunkId.trim()) {
      return rpcError(-32602, 'Invalid params', 'chunkId is required');
    }
    const id = chunkId.trim();
    const explicitNs =
      args.namespace !== undefined && args.namespace !== null && String(args.namespace).trim() !== ''
        ? String(args.namespace).trim()
        : null;

    if (explicitNs) {
      try {
        assertCorpusExistsForNamespace(explicitNs);
      } catch (e) {
        return rpcError(-32602, 'Invalid params', e.message);
      }
      const dir = paths.getDataDirForNamespace(explicitNs);
      const chunk = withVectorStore(dir, (vs) => vs.getChunk(id));
      if (!chunk) {
        return rpcError(-32001, 'Chunk not found', { chunkId: id, namespace: explicitNs });
      }
      return {
        result: textToolResult({
          chunk: { ...chunk, metadata: mergeMetaWithNamespace(chunk.metadata, explicitNs) }
        })
      };
    }

    let resolved;
    try {
      resolved = resolveCorpusNamespaces(this.ragService, null);
    } catch (e) {
      return rpcError(-32000, 'Server error', e.message);
    }

    if (resolved.mode === 'single') {
      const ns = resolved.namespaces[0];
      const chunk = resolved.usePrimaryForNamespace(ns)
        ? this.ragService.getChunkContent(id)
        : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(id));
      if (!chunk) {
        return rpcError(-32001, 'Chunk not found', { chunkId: id, namespace: ns });
      }
      return {
        result: textToolResult({
          chunk: { ...chunk, metadata: mergeMetaWithNamespace(chunk.metadata, ns) }
        })
      };
    }

    const hits = [];
    for (const ns of resolved.namespaces) {
      const chunk = resolved.usePrimaryForNamespace(ns)
        ? this.ragService.getChunkContent(id)
        : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(id));
      if (chunk) hits.push({ chunk, namespace: ns });
    }
    if (hits.length === 0) {
      return rpcError(-32001, 'Chunk not found', id);
    }
    if (hits.length > 1) {
      return rpcError(
        -32602,
        'Invalid params',
        `chunkId matches multiple corpora; pass namespace. Found in: ${hits.map((h) => h.namespace).join(', ')}`
      );
    }
    return {
      result: textToolResult({
        chunk: {
          ...hits[0].chunk,
          metadata: mergeMetaWithNamespace(hits[0].chunk.metadata, hits[0].namespace)
        }
      })
    };
  }

  async _listDocuments(args) {
    let limit = args.limit !== undefined ? Number(args.limit) : 50;
    let offset = args.offset !== undefined ? Number(args.offset) : 0;
    if (!Number.isFinite(limit) || limit < 1) {
      return rpcError(-32602, 'Invalid params', 'limit must be a positive integer');
    }
    if (!Number.isFinite(offset) || offset < 0) {
      return rpcError(-32602, 'Invalid params', 'offset must be a non-negative integer');
    }
    limit = Math.min(Math.floor(limit), 500);
    offset = Math.floor(offset);

    let resolved;
    try {
      resolved = resolveCorpusNamespaces(this.ragService, args.namespace);
    } catch (e) {
      return rpcError(-32602, 'Invalid params', e.message);
    }

    /** @type {{ doc: object, namespace: string, sortKey: number }[]} */
    const combined = [];
    for (const ns of resolved.namespaces) {
      const rows = resolved.usePrimaryForNamespace(ns)
        ? this.ragService.getDocuments()
        : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocuments());
      for (const doc of rows) {
        combined.push({
          doc: { ...doc, namespace: ns },
          namespace: ns,
          sortKey: Number(doc.ingested_at) || 0
        });
      }
    }
    combined.sort((a, b) => b.sortKey - a.sortKey);
    const total = combined.length;
    const slice = combined.slice(offset, offset + limit).map((x) => x.doc);
    return {
      result: textToolResult({
        documents: slice,
        total,
        limit,
        offset,
        scope:
          resolved.mode === 'all'
            ? { mode: 'all', namespaces: resolved.namespaces }
            : { mode: 'single', namespace: resolved.namespaces[0] }
      })
    };
  }

  async _llmRagPassthrough(args) {
    const settings = this.ragService.getSettings();
    if (!settings.llmPassthroughEnabled) {
      return rpcError(
        -32602,
        'Invalid params',
        'LLM Passthrough is disabled. Enable and configure it in the Froggy RAG app (Settings → LLM Passthrough), then restart or use a running server with those settings.'
      );
    }
    const prompt = args.prompt;
    if (typeof prompt !== 'string' || !prompt.trim()) {
      return rpcError(-32602, 'Invalid params', 'prompt is required');
    }
    let topKArg;
    if (args.topK !== undefined && args.topK !== null) {
      const t = Number(args.topK);
      if (!Number.isFinite(t) || t < 1) {
        return rpcError(-32602, 'Invalid params', 'topK must be a positive integer');
      }
      topKArg = Math.min(100, Math.floor(t));
    }
    const algorithm =
      typeof args.algorithm === 'string' && ['hybrid', 'bm25', 'tfidf', 'vector'].includes(args.algorithm)
        ? args.algorithm
        : undefined;
    const namespace =
      args.namespace !== undefined && args.namespace !== null && String(args.namespace).trim() !== ''
        ? String(args.namespace).trim()
        : undefined;

    try {
      const out = await runLlmPassthrough(this.ragService, prompt, {
        namespace,
        topK: topKArg,
        algorithm
      });
      return {
        result: textToolResult({
          reply: out.reply,
          scope: out.scope,
          warnings: out.warnings,
          errors: out.errors,
          contextPreview: out.contextBlock || null
        })
      };
    } catch (e) {
      this.log('error', 'llm_rag_passthrough failed', { error: e.message });
      return rpcError(-32000, 'LLM passthrough failed', e.message);
    }
  }

  async _listNamespaces() {
    const names = paths.listNamespaceDirNames();
    const active = inferDefaultCorpusNamespaceName(this.ragService);
    const corpora = listCorpusNamespaceNamesOnDisk();
    const namespaces = names.map((name) => ({
      name,
      hasCorpus: corpora.includes(name),
      dataDir: paths.getDataDirForNamespace(name)
    }));
    return {
      result: textToolResult({
        namespaces,
        activeNamespace: active,
        note: active
          ? 'activeNamespace is inferred from the server data directory under the standard data root.'
          : 'No active namespace inferred; corpus tools without namespace search/list across all corpora on disk.'
      })
    };
  }
}

function parseResourceUri(uri) {
  if (typeof uri !== 'string') return null;
  const docPrefix = `${DOCUMENT_RESOURCE_SCHEME}://document/`;
  if (uri.startsWith(docPrefix)) {
    const rest = uri.slice(docPrefix.length);
    if (!rest) return null;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      return { kind: 'document', namespace: null, id: decodeURIComponent(rest) };
    }
    const ns = decodeURIComponent(rest.slice(0, slash));
    const id = decodeURIComponent(rest.slice(slash + 1));
    return id ? { kind: 'document', namespace: ns, id } : null;
  }
  const chunkPrefix = `${CHUNK_RESOURCE_SCHEME}://chunk/`;
  if (uri.startsWith(chunkPrefix)) {
    const rest = uri.slice(chunkPrefix.length);
    if (!rest) return null;
    const slash = rest.indexOf('/');
    if (slash === -1) {
      return { kind: 'chunk', namespace: null, id: decodeURIComponent(rest) };
    }
    const ns = decodeURIComponent(rest.slice(0, slash));
    const id = decodeURIComponent(rest.slice(slash + 1));
    return id ? { kind: 'chunk', namespace: ns, id } : null;
  }
  return null;
}

/**
 * @param {string} documentId
 * @param {string | null} [namespace]
 */
function resourceUriForDocument(documentId, namespace = null) {
  if (namespace) {
    return `${DOCUMENT_RESOURCE_SCHEME}://document/${encodeURIComponent(namespace)}/${encodeURIComponent(documentId)}`;
  }
  return `${DOCUMENT_RESOURCE_SCHEME}://document/${encodeURIComponent(documentId)}`;
}

/**
 * @param {string} chunkId
 * @param {string | null} [namespace]
 */
function resourceUriForChunk(chunkId, namespace = null) {
  if (namespace) {
    return `${CHUNK_RESOURCE_SCHEME}://chunk/${encodeURIComponent(namespace)}/${encodeURIComponent(chunkId)}`;
  }
  return `${CHUNK_RESOURCE_SCHEME}://chunk/${encodeURIComponent(chunkId)}`;
}

module.exports = {
  MCPToolRegistry,
  TOOL_DEFINITIONS,
  parseResourceUri,
  resourceUriForDocument,
  resourceUriForChunk,
  DOCUMENT_RESOURCE_SCHEME,
  CHUNK_RESOURCE_SCHEME
};

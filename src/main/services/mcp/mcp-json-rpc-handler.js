const path = require('path');
const paths = require('../../../paths');
const {
  parseResourceUri,
  resourceUriForDocument,
  resourceUriForChunk
} = require('./mcp-tool-registry');
const {
  resolveCorpusNamespaces,
  assertCorpusExistsForNamespace,
  withVectorStore
} = require('./namespace-scope');

const DEFAULT_PROTOCOL_VERSION = '2025-06-18';
const SERVER_NAME = 'froggy-rag-mcp';
const INSTRUCTIONS =
  'Use search_vector_store for vector search (optional namespace). For RAG plus your configured upstream LLM, use the Froggy app: enable LLM Passthrough and inbound HTTP listeners under Settings → LLM Passthrough, then call those local Ollama- or OpenAI-compatible ports from your client. Use list_namespaces to discover corpora; omit namespace to use the server default or search all when no default is inferred.';

function readPackageVersion() {
  try {
    const pkgPath = path.join(__dirname, '..', '..', '..', '..', 'package.json');
    // eslint-disable-next-line import/no-dynamic-require, global-require
    const pkg = require(pkgPath);
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

/**
 * @param {object} opts
 * @param {import('../rag-service')} opts.ragService
 * @param {import('./mcp-tool-registry').MCPToolRegistry} opts.toolRegistry
 * @param {(level: string, message: string, data?: object) => void} opts.log
 * @param {string} [opts.serverVersion]
 */
function createMCPJsonRpcHandler(opts) {
  const { ragService, toolRegistry, log } = opts;
  const serverVersion = opts.serverVersion || readPackageVersion();

  /**
   * @param {unknown} params
   */
  function handleInitialize(params) {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : {};
    const clientProtocol =
      typeof p.protocolVersion === 'string' && p.protocolVersion
        ? p.protocolVersion
        : DEFAULT_PROTOCOL_VERSION;
    return {
      protocolVersion: clientProtocol,
      capabilities: {
        tools: {}
      },
      serverInfo: {
        name: SERVER_NAME,
        version: serverVersion
      },
      instructions: INSTRUCTIONS
    };
  }

  function handleToolsList() {
    return { tools: toolRegistry.listTools() };
  }

  /**
   * @param {unknown} params
   */
  async function handleToolsCall(params) {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
    if (!p || typeof p.name !== 'string' || !p.name) {
      return {
        error: { code: -32602, message: 'Invalid params', data: 'params.name is required' }
      };
    }
    const args = p.arguments && typeof p.arguments === 'object' && !Array.isArray(p.arguments) ? p.arguments : {};
    const toolOutcome = await toolRegistry.call(p.name, args);
    if (toolOutcome.error) {
      return { error: toolOutcome.error };
    }
    return toolOutcome.result;
  }

  function handleResourcesList() {
    let resolved;
    try {
      resolved = resolveCorpusNamespaces(ragService, null);
    } catch {
      return { resources: [] };
    }
    const resources = [];
    for (const ns of resolved.namespaces) {
      const rows = resolved.usePrimaryForNamespace(ns)
        ? ragService.getDocuments()
        : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocuments());
      for (const d of rows) {
        resources.push({
          uri: resourceUriForDocument(d.id, ns),
          name: `${ns}: ${d.file_path || d.id}`,
          description: `Ingested document ${d.id} (namespace ${ns})`,
          mimeType: 'application/json'
        });
      }
    }
    return { resources };
  }

  /**
   * @param {unknown} params
   */
  function handleResourcesRead(params) {
    const p = params && typeof params === 'object' && !Array.isArray(params) ? params : null;
    const uri = p && typeof p.uri === 'string' ? p.uri : null;
    if (!uri) {
      return {
        error: { code: -32602, message: 'Invalid params', data: 'params.uri is required' }
      };
    }
    const parsed = parseResourceUri(uri);
    if (!parsed) {
      return {
        error: { code: -32602, message: 'Invalid params', data: `Unsupported uri: ${uri}` }
      };
    }
    if (parsed.kind === 'document') {
      let doc = null;
      let nsOut = parsed.namespace;
      if (parsed.namespace) {
        try {
          assertCorpusExistsForNamespace(parsed.namespace);
        } catch (e) {
          return {
            error: { code: -32602, message: 'Invalid params', data: e.message }
          };
        }
        doc = withVectorStore(paths.getDataDirForNamespace(parsed.namespace), (vs) =>
          vs.getDocument(parsed.id)
        );
      } else {
        let resolved;
        try {
          resolved = resolveCorpusNamespaces(ragService, null);
        } catch (e) {
          return { error: { code: -32000, message: 'Server error', data: e.message } };
        }
        if (resolved.mode === 'single') {
          const ns = resolved.namespaces[0];
          doc = resolved.usePrimaryForNamespace(ns)
            ? ragService.getDocument(parsed.id)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(parsed.id));
          nsOut = ns;
        } else {
          const hits = [];
          for (const ns of resolved.namespaces) {
            const d = resolved.usePrimaryForNamespace(ns)
              ? ragService.getDocument(parsed.id)
              : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getDocument(parsed.id));
            if (d) hits.push({ d, ns });
          }
          if (hits.length === 0) {
            return { error: { code: -32001, message: 'Resource not found', data: parsed.id } };
          }
          if (hits.length > 1) {
            return {
              error: {
                code: -32602,
                message: 'Invalid params',
                data: `Ambiguous document URI; include namespace segment. Found in: ${hits.map((h) => h.ns).join(', ')}`
              }
            };
          }
          doc = hits[0].d;
          nsOut = hits[0].ns;
        }
      }
      if (!doc) {
        return {
          error: { code: -32001, message: 'Resource not found', data: parsed.id }
        };
      }
      const text = JSON.stringify({ ...doc, namespace: nsOut }, null, 2);
      return {
        contents: [{ uri: resourceUriForDocument(parsed.id, nsOut), mimeType: 'application/json', text }]
      };
    }
    let chunk = null;
    let nsChunk = parsed.namespace;
    if (parsed.namespace) {
      try {
        assertCorpusExistsForNamespace(parsed.namespace);
      } catch (e) {
        return {
          error: { code: -32602, message: 'Invalid params', data: e.message }
        };
      }
      chunk = withVectorStore(paths.getDataDirForNamespace(parsed.namespace), (vs) => vs.getChunk(parsed.id));
    } else {
      let resolved;
      try {
        resolved = resolveCorpusNamespaces(ragService, null);
      } catch (e) {
        return { error: { code: -32000, message: 'Server error', data: e.message } };
      }
      if (resolved.mode === 'single') {
        const ns = resolved.namespaces[0];
        chunk = resolved.usePrimaryForNamespace(ns)
          ? ragService.getChunkContent(parsed.id)
          : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(parsed.id));
        nsChunk = ns;
      } else {
        const hits = [];
        for (const ns of resolved.namespaces) {
          const c = resolved.usePrimaryForNamespace(ns)
            ? ragService.getChunkContent(parsed.id)
            : withVectorStore(paths.getDataDirForNamespace(ns), (vs) => vs.getChunk(parsed.id));
          if (c) hits.push({ c, ns });
        }
        if (hits.length === 0) {
          return { error: { code: -32001, message: 'Resource not found', data: parsed.id } };
        }
        if (hits.length > 1) {
          return {
            error: {
              code: -32602,
              message: 'Invalid params',
              data: `Ambiguous chunk URI; include namespace segment. Found in: ${hits.map((h) => h.ns).join(', ')}`
            }
          };
        }
        chunk = hits[0].c;
        nsChunk = hits[0].ns;
      }
    }
    if (!chunk) {
      return {
        error: { code: -32001, message: 'Resource not found', data: parsed.id }
      };
    }
    const meta =
      chunk.metadata && typeof chunk.metadata === 'object' && !Array.isArray(chunk.metadata)
        ? { ...chunk.metadata, namespace: nsChunk }
        : { namespace: nsChunk };
    const text = JSON.stringify({ ...chunk, metadata: meta }, null, 2);
    return {
      contents: [
        { uri: resourceUriForChunk(parsed.id, nsChunk), mimeType: 'application/json', text }
      ]
    };
  }

  /** @type {Record<string, (params: unknown) => unknown | Promise<unknown>>} */
  const methodHandlers = {
    initialize: handleInitialize,
    'tools/list': () => handleToolsList(),
    'tools/call': handleToolsCall,
    'resources/list': () => handleResourcesList(),
    'resources/read': handleResourcesRead
  };

  /**
   * @param {string} method
   * @param {unknown} params
   */
  async function dispatch(method, params) {
    const fn = methodHandlers[method];
    if (!fn) {
      return {
        error: {
          code: -32601,
          message: 'Method not found',
          data: `Unknown method: ${method}`
        }
      };
    }
    return fn(params);
  }

  /**
   * @param {unknown} request
   * @returns {Promise<import('./json-rpc-types').MCPHandlerResult | import('./json-rpc-types').JsonRpcResponse[]>}
   */
  return async function handleMCPRequest(request) {
    if (request === null || typeof request !== 'object' || Array.isArray(request)) {
      if (Array.isArray(request)) {
        return {
          jsonrpc: '2.0',
          error: {
            code: -32600,
            message: 'Invalid Request',
            data: 'Batch requests are not supported'
          },
          id: null
        };
      }
      return {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: 'Body must be a JSON object'
        },
        id: null
      };
    }

    if (request.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: 'jsonrpc must be "2.0"'
        },
        id: 'id' in request ? request.id : null
      };
    }

    const hasId = Object.prototype.hasOwnProperty.call(request, 'id');
    const { method, params } = request;
    const id = hasId ? request.id : undefined;

    if (typeof method !== 'string' || !method) {
      if (!hasId) return null;
      return {
        jsonrpc: '2.0',
        error: { code: -32600, message: 'Invalid Request', data: 'method is required' },
        id
      };
    }

    const isNotification = !hasId;

    if (method.startsWith('notifications/')) {
      log('info', 'MCP notification', { method });
      return isNotification ? null : { jsonrpc: '2.0', result: {}, id };
    }

    if (isNotification) {
      log('info', 'MCP notification (ignored)', { method });
      return null;
    }

    log('info', 'MCP request', { method, id });

    try {
      const result = await dispatch(method, params);
      if (result && typeof result === 'object' && 'error' in result && result.error) {
        return { jsonrpc: '2.0', error: result.error, id };
      }
      return { jsonrpc: '2.0', result, id };
    } catch (err) {
      log('error', 'MCP handler error', { method, error: err.message });
      return {
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Server error', data: err.message },
        id
      };
    }
  };
}

module.exports = {
  createMCPJsonRpcHandler,
  DEFAULT_PROTOCOL_VERSION,
  SERVER_NAME,
  INSTRUCTIONS,
  readPackageVersion
};

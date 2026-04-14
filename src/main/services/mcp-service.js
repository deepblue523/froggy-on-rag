const { EventEmitter } = require('events');
const express = require('express');
const { spawn } = require('child_process');

class MCPService extends EventEmitter {
  constructor(ragService) {
    super();
    this.ragService = ragService;
    this.server = null;
    this.restServer = null;
    this.httpServer = null;
    this.restPort = null;
    this.logs = [];
    this.maxLogs = 1000;
    this.stdioMode = false;
    this.initialized = false;
  }

  log(level, message, data = null) {
    const logEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };
    
    this.logs.push(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }
    
    this.emit('log', logEntry);
  }

  async start(port = 3000) {
    if (this.httpServer) {
      throw new Error('MCP server is already running');
    }

    this.restPort = port;
    
    // Start REST server
    this.restServer = express();
    this.restServer.use(express.json());

    // CORS
    this.restServer.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
      } else {
        next();
      }
    });

    // MCP Tools
    this.setupRESTTools();
    
    // MCP Protocol (JSON-RPC 2.0)
    this.setupMCPProtocol();

    return new Promise((resolve, reject) => {
      this.httpServer = this.restServer.listen(port, () => {
        this.log('info', `MCP REST server started on port ${port}`);
        this.log('info', `MCP Protocol endpoint available at http://localhost:${port}/mcp`);
        resolve({ port, status: 'running' });
      });

      this.httpServer.on('error', (error) => {
        this.log('error', `MCP REST server error: ${error.message}`);
        reject(error);
      });
    });
  }

  setupRESTTools() {
    // Health check
    this.restServer.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'froggy-rag-mcp' });
    });

    // Status endpoint
    this.restServer.get('/status', (req, res) => {
      try {
        const status = this.getStatus();
        res.json(status);
      } catch (error) {
        this.log('error', 'Status error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // List tools endpoint
    this.restServer.get('/tools', (req, res) => {
      try {
        const tools = [
          {
            id: 'search',
            name: 'search',
            description: 'Search the vector store for similar content, optionally augmented with live web search results. JSON body includes results, warnings[], and errors[] (e.g. web search timeout still returns vector results with a warning).',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query' },
                limit: { type: 'number', description: 'Maximum number of results', default: 10 },
                algorithm: { 
                  type: 'string',
                  description: 'Search algorithm: hybrid, bm25, tfidf, or vector',
                  enum: ['hybrid', 'bm25', 'tfidf', 'vector'],
                  default: 'hybrid'
                },
                webSearch: {
                  type: 'boolean',
                  description: 'When true, also perform a Google Custom Search and merge web results with vector store results',
                  default: false
                }
              },
              required: ['query']
            }
          },
          {
            id: 'get_documents',
            name: 'get_documents',
            description: 'Get all documents in the vector store',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            id: 'get_document_chunks',
            name: 'get_document_chunks',
            description: 'Get chunks for a specific document',
            inputSchema: {
              type: 'object',
              properties: {
                documentId: { type: 'string', description: 'Document ID' }
              },
              required: ['documentId']
            }
          },
          {
            id: 'get_chunk',
            name: 'get_chunk',
            description: 'Get chunk content by ID',
            inputSchema: {
              type: 'object',
              properties: {
                chunkId: { type: 'string', description: 'Chunk ID' }
              },
              required: ['chunkId']
            }
          },
          {
            id: 'get_stats',
            name: 'get_stats',
            description: 'Get vector store statistics',
            inputSchema: { type: 'object', properties: {} }
          },
          {
            id: 'ingest_file',
            name: 'ingest_file',
            description: 'Ingest a file into the vector store',
            inputSchema: {
              type: 'object',
              properties: {
                filePath: { type: 'string', description: 'Path to the file' },
                watch: { type: 'boolean', description: 'Watch for file changes', default: false }
              },
              required: ['filePath']
            }
          },
          {
            id: 'ingest_directory',
            name: 'ingest_directory',
            description: 'Ingest a directory into the vector store',
            inputSchema: {
              type: 'object',
              properties: {
                dirPath: { type: 'string', description: 'Path to the directory' },
                recursive: { type: 'boolean', description: 'Recursively scan subdirectories', default: false },
                watch: { type: 'boolean', description: 'Watch for file changes', default: false }
              },
              required: ['dirPath']
            }
          }
        ];
        res.json({ tools });
      } catch (error) {
        this.log('error', 'List tools error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Generic tool invocation endpoint
    this.restServer.post('/tools/:toolId', async (req, res) => {
      const toolId = req.params.toolId;
      const args = req.body || {};

      try {
        switch (toolId) {
          case 'search': {
            const { query, limit = 10, algorithm = 'hybrid', webSearch = false } = args;
            if (!query) {
              return res.status(400).json({ error: 'query is required' });
            }
            this.log('info', 'Search request', { query, limit, algorithm, webSearch });
            const payload = await this.ragService.search(query, limit, algorithm, { webSearch });
            const rows = payload.results || [];
            return res.json({
              results: rows.map(r => ({
                chunkId: r.chunkId,
                documentId: r.documentId,
                content: r.content,
                score: r.score,
                similarity: r.similarity,
                algorithm: r.algorithm,
                metadata: r.metadata
              })),
              warnings: payload.warnings || [],
              errors: payload.errors || []
            });
          }

          case 'get_documents': {
            const documents = this.ragService.getDocuments();
            return res.json({ documents });
          }

          case 'get_document_chunks': {
            const { documentId } = args;
            if (!documentId) {
              return res.status(400).json({ error: 'documentId is required' });
            }
            const chunks = this.ragService.getDocumentChunks(documentId);
            return res.json({ chunks });
          }

          case 'get_chunk': {
            const { chunkId } = args;
            if (!chunkId) {
              return res.status(400).json({ error: 'chunkId is required' });
            }
            const chunk = this.ragService.getChunkContent(chunkId);
            if (!chunk) {
              return res.status(404).json({ error: 'Chunk not found' });
            }
            return res.json({ chunk });
          }

          case 'get_stats': {
            const stats = this.ragService.getVectorStoreStats();
            return res.json({ stats });
          }

          case 'ingest_file': {
            const { filePath, watch = false } = args;
            if (!filePath) {
              return res.status(400).json({ error: 'filePath is required' });
            }
            this.log('info', 'Ingest file request', { filePath, watch });
            const result = await this.ragService.ingestFile(filePath, watch);
            return res.json(result);
          }

          case 'ingest_directory': {
            const { dirPath, recursive = false, watch = false } = args;
            if (!dirPath) {
              return res.status(400).json({ error: 'dirPath is required' });
            }
            this.log('info', 'Ingest directory request', { dirPath, recursive, watch });
            const result = await this.ragService.ingestDirectory(dirPath, recursive, watch);
            return res.json(result);
          }

          default:
            return res.status(404).json({ error: `Unknown tool: ${toolId}` });
        }
      } catch (error) {
        this.log('error', 'Tool invocation error', { toolId, error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Search tool
    this.restServer.post('/tools/search', async (req, res) => {
      try {
        const { query, limit = 10, algorithm = 'hybrid', webSearch = false } = req.body;
        if (!query) {
          return res.status(400).json({ error: 'Query is required' });
        }

        this.log('info', 'Search request', { query, limit, algorithm, webSearch });
        const payload = await this.ragService.search(query, limit, algorithm, { webSearch });
        const rows = payload.results || [];

        res.json({
          results: rows.map(r => ({
            chunkId: r.chunkId,
            documentId: r.documentId,
            content: r.content,
            score: r.score,
            similarity: r.similarity,
            algorithm: r.algorithm,
            metadata: r.metadata
          })),
          warnings: payload.warnings || [],
          errors: payload.errors || []
        });
      } catch (error) {
        this.log('error', 'Search error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Get documents tool
    this.restServer.get('/tools/documents', (req, res) => {
      try {
        const documents = this.ragService.getDocuments();
        res.json({ documents });
      } catch (error) {
        this.log('error', 'Get documents error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Get document chunks tool
    this.restServer.get('/tools/documents/:documentId/chunks', (req, res) => {
      try {
        const { documentId } = req.params;
        const chunks = this.ragService.getDocumentChunks(documentId);
        res.json({ chunks });
      } catch (error) {
        this.log('error', 'Get chunks error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Get chunk content tool
    this.restServer.get('/tools/chunks/:chunkId', (req, res) => {
      try {
        const { chunkId } = req.params;
        const chunk = this.ragService.getChunkContent(chunkId);
        if (!chunk) {
          return res.status(404).json({ error: 'Chunk not found' });
        }
        res.json({ chunk });
      } catch (error) {
        this.log('error', 'Get chunk error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Vector store stats tool
    this.restServer.get('/tools/stats', (req, res) => {
      try {
        const stats = this.ragService.getVectorStoreStats();
        res.json({ stats });
      } catch (error) {
        this.log('error', 'Get stats error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Ingest file tool
    this.restServer.post('/tools/ingest/file', async (req, res) => {
      try {
        const { filePath, watch = false } = req.body;
        if (!filePath) {
          return res.status(400).json({ error: 'filePath is required' });
        }

        this.log('info', 'Ingest file request', { filePath, watch });
        const result = await this.ragService.ingestFile(filePath, watch);
        res.json(result);
      } catch (error) {
        this.log('error', 'Ingest file error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    // Ingest directory tool
    this.restServer.post('/tools/ingest/directory', async (req, res) => {
      try {
        const { dirPath, recursive = false, watch = false } = req.body;
        if (!dirPath) {
          return res.status(400).json({ error: 'dirPath is required' });
        }

        this.log('info', 'Ingest directory request', { dirPath, recursive, watch });
        const result = await this.ragService.ingestDirectory(dirPath, recursive, watch);
        res.json(result);
      } catch (error) {
        this.log('error', 'Ingest directory error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });
  }

  setupMCPProtocol() {
    // MCP Protocol endpoint (JSON-RPC 2.0)
    this.restServer.post('/mcp', async (req, res) => {
      try {
        const request = req.body;
        const response = await this.handleMCPRequest(request);
        
        if (response.error && response.error.code === -32600) {
          // Invalid request - send 400 status
          return res.status(400).json(response);
        }
        
        res.json(response);
      } catch (error) {
        this.log('error', 'MCP Protocol request error', { error: error.message });
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Server error',
            data: error.message
          },
          id: null
        });
      }
    });
  }

  stop() {
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer.close(() => {
          this.log('info', 'MCP REST server stopped');
          this.httpServer = null;
          this.restServer = null;
          this.restPort = null;
          resolve({ status: 'stopped' });
        });
      });
    }
    return Promise.resolve({ status: 'stopped' });
  }

  getStatus() {
    const baseUrl = this.restPort ? `http://localhost:${this.restPort}` : null;
    return {
      running: this.httpServer !== null,
      port: this.restPort,
      restUrl: baseUrl,
      mcpUrl: baseUrl ? `${baseUrl}/mcp` : null,
      logsCount: this.logs.length
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(-limit);
  }

  // Stdio mode support
  async startStdio() {
    if (this.stdioMode) {
      throw new Error('Stdio mode is already running');
    }

    this.stdioMode = true;
    
    // Set stdin to raw mode for line-by-line reading
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.setEncoding('utf8');
    
    let buffer = '';
    
    process.stdin.on('data', async (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // Keep incomplete line in buffer
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // Skip empty lines
        
        try {
          const request = JSON.parse(trimmed);
          const response = await this.handleMCPRequest(request);
          if (response) {
            process.stdout.write(JSON.stringify(response) + '\n');
          }
        } catch (error) {
          // Send error response
          const errorResponse = {
            jsonrpc: '2.0',
            error: {
              code: -32700,
              message: 'Parse error',
              data: error.message
            },
            id: null
          };
          process.stdout.write(JSON.stringify(errorResponse) + '\n');
          this.log('error', 'Stdio parse error', { error: error.message, line: trimmed });
        }
      }
    });

    process.stdin.on('end', () => {
      this.stdioMode = false;
      this.log('info', 'Stdio mode ended');
    });

    process.stdin.on('error', (error) => {
      this.log('error', 'Stdio error', { error: error.message });
      this.stdioMode = false;
    });

    // Ensure we don't exit on stdin close
    process.stdin.resume();
    
    this.log('info', 'Stdio mode started');
  }

  stopStdio() {
    if (this.stdioMode) {
      this.stdioMode = false;
      this.log('info', 'Stdio mode stopped');
    }
  }

  // Extract MCP protocol request handling (reusable for HTTP and stdio)
  async handleMCPRequest(request) {
    // Validate JSON-RPC 2.0 request
    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      return {
        jsonrpc: '2.0',
        error: {
          code: -32600,
          message: 'Invalid Request',
          data: 'jsonrpc must be "2.0"'
        },
        id: request.id || null
      };
    }

    const { method, params, id } = request;
    
    this.log('info', 'MCP Protocol request', { method, id });

    let result = null;
    let error = null;

    try {
      switch (method) {
        case 'initialize':
          this.initialized = true;
          result = {
            protocolVersion: '2024-11-05',
            capabilities: {
              tools: {},
              resources: {}
            },
            serverInfo: {
              name: 'froggy-rag-mcp',
              version: '1.0.0'
            }
          };
          break;

        case 'tools/list':
          result = {
            tools: this.getToolsList()
          };
          break;

        case 'tools/call':
          if (!params || !params.name) {
            error = {
              code: -32602,
              message: 'Invalid params',
              data: 'Tool name is required'
            };
            break;
          }

          const toolName = params.name;
          const toolParams = params.arguments || {};
          const toolResult = await this.executeTool(toolName, toolParams);
          
          if (toolResult.error) {
            error = toolResult.error;
          } else {
            result = toolResult.result;
          }
          break;

        default:
          error = {
            code: -32601,
            message: 'Method not found',
            data: `Unknown method: ${method}`
          };
      }
    } catch (err) {
      this.log('error', 'MCP Protocol error', { method, error: err.message });
      error = {
        code: -32000,
        message: 'Server error',
        data: err.message
      };
    }

    const response = {
      jsonrpc: '2.0',
      id: id || null
    };

    if (error) {
      response.error = error;
    } else {
      response.result = result;
    }

    return response;
  }

  // Get tools list (reusable)
  getToolsList() {
    return [
      {
        name: 'search',
        description: 'Search the vector store for similar content, optionally augmented with live web search results. Response includes results, warnings[], and errors[] (e.g. web search timeout).',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Maximum number of results', default: 10 },
            algorithm: { 
              type: 'string', 
              description: 'Search algorithm: hybrid, bm25, tfidf, or vector',
              enum: ['hybrid', 'bm25', 'tfidf', 'vector'],
              default: 'hybrid'
            },
            webSearch: {
              type: 'boolean',
              description: 'When true, also perform a Google Custom Search and merge web results with vector store results',
              default: false
            }
          },
          required: ['query']
        }
      },
      {
        name: 'get_documents',
        description: 'Get all documents in the vector store',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'get_document_chunks',
        description: 'Get chunks for a specific document',
        inputSchema: {
          type: 'object',
          properties: {
            documentId: { type: 'string', description: 'Document ID' }
          },
          required: ['documentId']
        }
      },
      {
        name: 'get_chunk',
        description: 'Get chunk content by ID',
        inputSchema: {
          type: 'object',
          properties: {
            chunkId: { type: 'string', description: 'Chunk ID' }
          },
          required: ['chunkId']
        }
      },
      {
        name: 'get_stats',
        description: 'Get vector store statistics',
        inputSchema: {
          type: 'object',
          properties: {}
        }
      },
      {
        name: 'ingest_file',
        description: 'Ingest a file into the vector store',
        inputSchema: {
          type: 'object',
          properties: {
            filePath: { type: 'string', description: 'Path to the file' },
            watch: { type: 'boolean', description: 'Watch for file changes', default: false }
          },
          required: ['filePath']
        }
      },
      {
        name: 'ingest_directory',
        description: 'Ingest a directory into the vector store',
        inputSchema: {
          type: 'object',
          properties: {
            dirPath: { type: 'string', description: 'Path to the directory' },
            recursive: { type: 'boolean', description: 'Recursively scan subdirectories', default: false },
            watch: { type: 'boolean', description: 'Watch for file changes', default: false }
          },
          required: ['dirPath']
        }
      }
    ];
  }

  // Execute tool (reusable for CLI and MCP protocol)
  async executeTool(toolName, toolParams) {
    try {
      switch (toolName) {
        case 'search':
          if (!toolParams.query) {
            return {
              error: { code: -32602, message: 'Invalid params', data: 'query is required' }
            };
          }
          const searchPayload = await this.ragService.search(
            toolParams.query, 
            toolParams.limit || 10,
            toolParams.algorithm || 'hybrid',
            { webSearch: toolParams.webSearch || false }
          );
          const searchResults = searchPayload.results || [];
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify(
                  {
                    results: searchResults.map(r => ({
                      chunkId: r.chunkId,
                      documentId: r.documentId,
                      content: r.content,
                      score: r.score,
                      similarity: r.similarity,
                      algorithm: r.algorithm,
                      metadata: r.metadata
                    })),
                    warnings: searchPayload.warnings || [],
                    errors: searchPayload.errors || []
                  },
                  null,
                  2
                )
              }]
            }
          };

        case 'get_documents':
          const documents = this.ragService.getDocuments();
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({ documents }, null, 2)
              }]
            }
          };

        case 'get_document_chunks':
          if (!toolParams.documentId) {
            return {
              error: { code: -32602, message: 'Invalid params', data: 'documentId is required' }
            };
          }
          const chunks = this.ragService.getDocumentChunks(toolParams.documentId);
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({ chunks }, null, 2)
              }]
            }
          };

        case 'get_chunk':
          if (!toolParams.chunkId) {
            return {
              error: { code: -32602, message: 'Invalid params', data: 'chunkId is required' }
            };
          }
          const chunk = this.ragService.getChunkContent(toolParams.chunkId);
          if (!chunk) {
            return {
              error: { code: -404, message: 'Not Found', data: 'Chunk not found' }
            };
          }
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({ chunk }, null, 2)
              }]
            }
          };

        case 'get_stats':
          const stats = this.ragService.getVectorStoreStats();
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify({ stats }, null, 2)
              }]
            }
          };

        case 'ingest_file':
          if (!toolParams.filePath) {
            return {
              error: { code: -32602, message: 'Invalid params', data: 'filePath is required' }
            };
          }
          const ingestFileResult = await this.ragService.ingestFile(toolParams.filePath, toolParams.watch || false);
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify(ingestFileResult, null, 2)
              }]
            }
          };

        case 'ingest_directory':
          if (!toolParams.dirPath) {
            return {
              error: { code: -32602, message: 'Invalid params', data: 'dirPath is required' }
            };
          }
          const ingestDirResult = await this.ragService.ingestDirectory(
            toolParams.dirPath,
            toolParams.recursive || false,
            toolParams.watch || false
          );
          return {
            result: {
              content: [{
                type: 'text',
                text: JSON.stringify(ingestDirResult, null, 2)
              }]
            }
          };

        default:
          return {
            error: {
              code: -32601,
              message: 'Method not found',
              data: `Unknown tool: ${toolName}`
            }
          };
      }
    } catch (err) {
      this.log('error', 'Tool execution error', { toolName, error: err.message });
      return {
        error: {
          code: -32000,
          message: 'Server error',
          data: err.message
        }
      };
    }
  }

  // CLI tool mode methods
  async listTools() {
    return this.getToolsList();
  }

  async callTool(toolName, params) {
    const result = await this.executeTool(toolName, params);
    if (result.error) {
      throw new Error(result.error.message + (result.error.data ? `: ${result.error.data}` : ''));
    }
    // For CLI, extract the text content and parse if it's JSON
    if (result.result && result.result.content && result.result.content.length > 0) {
      const textContent = result.result.content[0].text;
      try {
        return JSON.parse(textContent);
      } catch (e) {
        return textContent;
      }
    }
    return result.result;
  }
}

module.exports = { MCPService };



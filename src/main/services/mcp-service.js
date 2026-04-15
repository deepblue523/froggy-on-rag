const { EventEmitter } = require('events');
const express = require('express');
const { mountAdminRoutes } = require('./mcp/admin-routes');
const { mountMcpRoutes } = require('./mcp/mcp-routes');
const { MCPToolRegistry } = require('./mcp/mcp-tool-registry');
const { createMCPJsonRpcHandler } = require('./mcp/mcp-json-rpc-handler');
const { inferDefaultCorpusNamespaceName } = require('./mcp/namespace-scope');

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

    this.toolRegistry = new MCPToolRegistry(ragService, (level, message, data) =>
      this.log(level, message, data)
    );
    this._handleMcpJsonRpc = createMCPJsonRpcHandler({
      ragService,
      toolRegistry: this.toolRegistry,
      log: (level, message, data) => this.log(level, message, data)
    });
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

    this.restServer = express();
    this.restServer.use(express.json());

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

    this.restServer.get('/health', (req, res) => {
      res.json({ status: 'ok', service: 'froggy-rag-mcp' });
    });

    this.restServer.get('/status', (req, res) => {
      try {
        res.json(this.getStatus());
      } catch (error) {
        this.log('error', 'Status error', { error: error.message });
        res.status(500).json({ error: error.message });
      }
    });

    mountAdminRoutes(this.restServer, this.ragService, (level, message, data) =>
      this.log(level, message, data)
    );

    mountMcpRoutes(this.restServer, {
      handleMCPRequest: (body) => this.handleMCPRequest(body),
      log: (level, message, data) => this.log(level, message, data)
    });

    return new Promise((resolve, reject) => {
      this.httpServer = this.restServer.listen(port, () => {
        this.log('info', `MCP REST server started on port ${port}`);
        this.log('info', `MCP JSON-RPC at http://localhost:${port}/mcp`);
        this.log('info', `Admin REST at http://localhost:${port}/admin (alias /store)`);
        resolve({ port, status: 'running' });
      });

      this.httpServer.on('error', (error) => {
        this.log('error', `MCP REST server error: ${error.message}`);
        reject(error);
      });
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
    const activeNamespace = this.ragService
      ? inferDefaultCorpusNamespaceName(this.ragService)
      : null;
    return {
      running: this.httpServer !== null,
      port: this.restPort,
      restUrl: baseUrl,
      mcpUrl: baseUrl ? `${baseUrl}/mcp` : null,
      adminUrl: baseUrl ? `${baseUrl}/admin` : null,
      storeUrl: baseUrl ? `${baseUrl}/store` : null,
      activeNamespace,
      logsCount: this.logs.length
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(-limit);
  }

  async startStdio() {
    if (this.stdioMode) {
      throw new Error('Stdio mode is already running');
    }

    this.stdioMode = true;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.setEncoding('utf8');

    let buffer = '';

    process.stdin.on('data', async (chunk) => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const request = JSON.parse(trimmed);
          const response = await this.handleMCPRequest(request);
          if (response !== null) {
            process.stdout.write(`${JSON.stringify(response)}\n`);
          }
        } catch (error) {
          const errorResponse = {
            jsonrpc: '2.0',
            error: {
              code: -32700,
              message: 'Parse error',
              data: error.message
            },
            id: null
          };
          process.stdout.write(`${JSON.stringify(errorResponse)}\n`);
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

    process.stdin.resume();

    this.log('info', 'Stdio mode started');
  }

  stopStdio() {
    if (this.stdioMode) {
      this.stdioMode = false;
      this.log('info', 'Stdio mode stopped');
    }
  }

  async handleMCPRequest(request) {
    const response = await this._handleMcpJsonRpc(request);

    if (
      request &&
      typeof request === 'object' &&
      !Array.isArray(request) &&
      request.method === 'initialize' &&
      response &&
      response.error === undefined &&
      Object.prototype.hasOwnProperty.call(response, 'result')
    ) {
      this.initialized = true;
    }

    return response;
  }

  getToolsList() {
    return this.toolRegistry.listTools();
  }

  async executeTool(toolName, toolParams) {
    return this.toolRegistry.call(toolName, toolParams);
  }

  async listTools() {
    return this.toolRegistry.listTools();
  }

  async callTool(toolName, params) {
    const result = await this.toolRegistry.call(toolName, params);
    if (result.error) {
      throw new Error(
        result.error.message + (result.error.data ? `: ${result.error.data}` : '')
      );
    }
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

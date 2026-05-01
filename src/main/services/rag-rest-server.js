const { EventEmitter } = require('events');
const express = require('express');
const { mountAdminRoutes } = require('./rag-rest/admin-routes');
const { inferDefaultCorpusNamespaceName } = require('./rag-rest/namespace-scope');
const { attachHttpRequestLogger } = require('./http-request-log');

/**
 * HTTP server for RAG corpus admin REST (/admin, /store), health, and status.
 * LLM passthrough inbound listeners live in {@link PassthroughInboundService}.
 */
class RagRestServer extends EventEmitter {
  constructor(ragService) {
    super();
    this.ragService = ragService;
    this.restServer = null;
    this.httpServer = null;
    this.restPort = null;
    this.logs = [];
    this.maxLogs = 1000;
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
      throw new Error('RAG REST server is already running');
    }

    this.restPort = port;

    this.restServer = express();
    this.restServer.use(express.json());
    attachHttpRequestLogger(this.restServer, this.ragService, 'rag-rest', (entry) =>
      this.emit('request-log', entry)
    );

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
      res.json({ status: 'ok', service: 'froggy-rag-rest' });
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

    return new Promise((resolve, reject) => {
      this.httpServer = this.restServer.listen(port, () => {
        this.log('info', `RAG REST server started on port ${port}`);
        this.log('info', `Admin REST at http://localhost:${port}/admin (alias /store)`);
        resolve({ port, status: 'running' });
      });

      this.httpServer.on('error', (error) => {
        this.log('error', `RAG REST server error: ${error.message}`);
        reject(error);
      });
    });
  }

  stop() {
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer.close(() => {
          this.log('info', 'RAG REST server stopped');
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
      adminUrl: baseUrl ? `${baseUrl}/admin` : null,
      storeUrl: baseUrl ? `${baseUrl}/store` : null,
      activeNamespace,
      logsCount: this.logs.length
    };
  }

  getLogs(limit = 100) {
    return this.logs.slice(-limit);
  }
}

module.exports = { RagRestServer };

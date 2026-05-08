/**
 * Optional HTTP listeners that mimic Ollama (/api/chat) and OpenAI (/v1/chat/completions),
 * apply RAG, and forward requests to the configured LLM Passthrough upstream (JSON or streaming).
 */

const express = require('express');
const { Readable } = require('stream');
const { completeChatProxy, getActiveLlmPassthroughUpstream } = require('./llm-passthrough');
const { attachHttpRequestLogger } = require('./http-request-log');

function readNamespaceFromReq(req) {
  const h = req.headers['x-froggy-namespace'];
  if (typeof h === 'string' && h.trim()) return h.trim();
  const q = req.query && req.query.namespace;
  if (typeof q === 'string' && q.trim()) return q.trim();
  return undefined;
}

function openAiError(res, status, message) {
  res.status(status).json({
    error: {
      message,
      type: 'invalid_request_error',
      param: null,
      code: null
    }
  });
}

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('stream/web').ReadableStream} webStream
 * @param {{ contentType?: string }} [opts]
 */
function pipeUpstreamWebStreamToResponse(req, res, webStream, opts = {}) {
  const contentType = opts.contentType || '';
  res.status(200);
  if (contentType) {
    res.setHeader('Content-Type', contentType);
  }
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  const nodeStream = Readable.fromWeb(webStream);
  nodeStream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: err.message });
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  });
  req.on('close', () => {
    if (!res.writableEnded) {
      nodeStream.destroy();
    }
  });
  nodeStream.pipe(res);
}

function applyPermissiveCors(app) {
  app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, X-Froggy-Namespace, x-froggy-namespace'
    );
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    return next();
  });
}

class PassthroughInboundService {
  /**
   * @param {*} ragService
   * @param {(level: string, message: string, data?: object) => void} [log]
   * @param {(entry: object) => void} [onRequestLogged]
   */
  constructor(ragService, log, onRequestLogged) {
    this.ragService = ragService;
    this.log = log || (() => {});
    this._onRequestLogged = typeof onRequestLogged === 'function' ? onRequestLogged : null;
    /** @type {import('http').Server | null} */
    this._ollamaServer = null;
    /** @type {import('http').Server | null} */
    this._openAiServer = null;
    this._ollamaPort = null;
    this._openAiPort = null;
    this._ollamaError = null;
    this._openAiError = null;
  }

  _ollamaApp() {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    applyPermissiveCors(app);
    attachHttpRequestLogger(app, this.ragService, 'inbound-ollama', (entry) => {
      if (this._onRequestLogged) this._onRequestLogged(entry);
    });

    app.get('/api/tags', (req, res) => {
      try {
        const model =
          getActiveLlmPassthroughUpstream(this.ragService.getSettings()).model || 'local';
        res.json({
          models: [{ name: model, model: model, modified_at: new Date().toISOString(), size: 0, digest: '' }]
        });
      } catch (e) {
        res.status(500).json({ error: e.message });
      }
    });

    app.post('/api/chat', async (req, res) => {
      const ns = readNamespaceFromReq(req);
      const abortController = new AbortController();
      const onClientAbort = () => abortController.abort();
      req.on('aborted', onClientAbort);
      let streamed = false;
      try {
        const out = await completeChatProxy(this.ragService, req.body || {}, {
          namespace: ns,
          abortSignal: abortController.signal
        });
        if (out.streaming && out.upstreamWebStream) {
          streamed = true;
          pipeUpstreamWebStreamToResponse(req, res, out.upstreamWebStream, {
            contentType: out.upstreamContentType
          });
          const detachAbort = () => {
            req.removeListener('aborted', onClientAbort);
          };
          res.once('finish', detachAbort);
          res.once('close', detachAbort);
          return;
        }
        res.json(out.upstreamJson);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg.includes('LLM Passthrough is disabled') || msg.includes('base URL') || msg.includes('model name')) {
          return res.status(503).json({ error: msg });
        }
        this.log('error', 'Inbound Ollama /api/chat error', { error: msg });
        res.status(400).json({ error: msg });
      } finally {
        if (!streamed) {
          req.removeListener('aborted', onClientAbort);
        }
      }
    });

    return app;
  }

  _openAiApp() {
    const app = express();
    app.use(express.json({ limit: '20mb' }));
    applyPermissiveCors(app);
    attachHttpRequestLogger(app, this.ragService, 'inbound-openai', (entry) => {
      if (this._onRequestLogged) this._onRequestLogged(entry);
    });

    app.get('/v1/models', (req, res) => {
      try {
        const m =
          getActiveLlmPassthroughUpstream(this.ragService.getSettings()).model || 'default';
        res.json({
          object: 'list',
          data: [
            {
              id: m,
              object: 'model',
              created: Math.floor(Date.now() / 1000),
              owned_by: 'froggy-rag'
            }
          ]
        });
      } catch (e) {
        res.status(500).json({
          error: { message: e.message, type: 'api_error', code: null }
        });
      }
    });

    app.post('/v1/chat/completions', async (req, res) => {
      const ns = readNamespaceFromReq(req);
      const abortController = new AbortController();
      const onClientAbort = () => abortController.abort();
      req.on('aborted', onClientAbort);
      let streamed = false;
      try {
        const out = await completeChatProxy(this.ragService, req.body || {}, {
          namespace: ns,
          abortSignal: abortController.signal
        });
        if (out.streaming && out.upstreamWebStream) {
          streamed = true;
          pipeUpstreamWebStreamToResponse(req, res, out.upstreamWebStream, {
            contentType: out.upstreamContentType
          });
          const detachAbort = () => {
            req.removeListener('aborted', onClientAbort);
          };
          res.once('finish', detachAbort);
          res.once('close', detachAbort);
          return;
        }
        res.json(out.upstreamJson);
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (msg.includes('LLM Passthrough is disabled') || msg.includes('base URL') || msg.includes('model name')) {
          return openAiError(res, 503, msg);
        }
        this.log('error', 'Inbound OpenAI /v1/chat/completions error', { error: msg });
        return openAiError(res, 400, msg);
      } finally {
        if (!streamed) {
          req.removeListener('aborted', onClientAbort);
        }
      }
    });

    return app;
  }

  /**
   * @param {import('express').Express} app
   * @param {number} port
   * @param {string} label
   * @returns {Promise<import('http').Server>}
   */
  _listen(app, port, label) {
    return new Promise((resolve, reject) => {
      const server = app.listen(port, () => {
        this.log('info', `Inbound passthrough (${label}) listening on port ${port}`);
        resolve(server);
      });
      server.on('error', (err) => {
        this.log('error', `Inbound passthrough (${label}) failed to bind`, {
          port,
          error: err.message
        });
        reject(err);
      });
    });
  }

  async stopAll() {
    const close = (server) =>
      new Promise((resolve) => {
        if (!server) return resolve();
        server.close(() => resolve());
      });
    await close(this._ollamaServer);
    await close(this._openAiServer);
    this._ollamaServer = null;
    this._openAiServer = null;
    this._ollamaPort = null;
    this._openAiPort = null;
    this._ollamaError = null;
    this._openAiError = null;
  }

  getStatus() {
    const s = this.ragService.getSettings();
    return {
      masterEnabled: s.llmPassthroughEnabled === true,
      ollama: {
        enabled: s.passthroughOllamaListenEnabled === true,
        listening: this._ollamaServer !== null,
        port: this._ollamaPort,
        lastError: this._ollamaError
      },
      openai: {
        enabled: s.passthroughOpenAiListenEnabled === true,
        listening: this._openAiServer !== null,
        port: this._openAiPort,
        lastError: this._openAiError
      }
    };
  }

  /**
   * Restart listeners from current ragService settings.
   */
  async syncFromSettings() {
    await this.stopAll();
    const s = this.ragService.getSettings();
    if (!s.llmPassthroughEnabled) {
      return;
    }

    const ragRestPort = s.serverPort || 3000;
    const ollamaPort = parseInt(String(s.passthroughOllamaListenPort || 0), 10);
    const openAiPort = parseInt(String(s.passthroughOpenAiListenPort || 0), 10);

    const validListenPort = (p) => Number.isFinite(p) && p >= 1024 && p <= 65535;

    const tryStart = async (kind, enabled, port, appFactory) => {
      if (!enabled) return;
      if (!validListenPort(port)) {
        const msg = `Invalid ${kind} listen port (use 1024–65535).`;
        if (kind === 'ollama') this._ollamaError = msg;
        else this._openAiError = msg;
        this.log('error', 'Inbound passthrough invalid port', { kind, port });
        return;
      }
      if (port === ragRestPort) {
        const msg = `Port ${port} is already used by the RAG REST server; pick another inbound port.`;
        if (kind === 'ollama') this._ollamaError = msg;
        else this._openAiError = msg;
        this.log('error', 'Inbound passthrough port conflict with RAG REST server', { kind, port });
        return;
      }
      try {
        const server = await this._listen(appFactory(), port, kind);
        if (kind === 'ollama') {
          this._ollamaServer = server;
          this._ollamaPort = port;
        } else {
          this._openAiServer = server;
          this._openAiPort = port;
        }
      } catch (e) {
        const msg = e && e.message ? e.message : String(e);
        if (kind === 'ollama') this._ollamaError = msg;
        else this._openAiError = msg;
      }
    };

    if (s.passthroughOllamaListenEnabled && ollamaPort && s.passthroughOpenAiListenEnabled && openAiPort) {
      if (ollamaPort === openAiPort) {
        this._ollamaError = 'Ollama and OpenAI inbound ports must differ.';
        this._openAiError = this._ollamaError;
        this.log('error', 'Inbound passthrough duplicate ports', { port: ollamaPort });
        return;
      }
    }

    await tryStart('ollama', s.passthroughOllamaListenEnabled === true, ollamaPort, () => this._ollamaApp());
    await tryStart(
      'openai',
      s.passthroughOpenAiListenEnabled === true,
      openAiPort,
      () => this._openAiApp()
    );
  }
}

module.exports = {
  PassthroughInboundService,
  __testing: { readNamespaceFromReq }
};

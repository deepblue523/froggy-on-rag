const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const net = require('net');

const paths = require('../src/paths');
const {
  PassthroughInboundService,
  __testing
} = require('../src/main/services/passthrough-inbound-server');

const { readNamespaceFromReq } = __testing;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.listen(0, () => {
      const addr = s.address();
      const port = typeof addr === 'object' && addr ? addr.port : null;
      s.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
    s.on('error', reject);
  });
}

function requestJson(port, path, { method = 'GET', body = null, headers = {} } = {}) {
  const payload = body != null ? JSON.stringify(body) : '';
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => {
          buf += c;
        });
        res.on('end', () => {
          let parsed = buf;
          try {
            parsed = buf ? JSON.parse(buf) : null;
          } catch {
            /* keep raw */
          }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function makeRagService(overrides = {}) {
  return {
    dataDir: paths.getDataDirForNamespace('general'),
    getSettings() {
      return {
        llmPassthroughEnabled: true,
        llmPassthroughProvider: 'ollama',
        llmPassthroughBaseUrl: 'http://127.0.0.1:9',
        llmPassthroughModel: 'stub',
        retrievalTopK: 5,
        llmPassthroughSearchAlgorithm: 'hybrid',
        serverPort: 19997,
        passthroughOllamaListenEnabled: true,
        passthroughOllamaListenPort: overrides.ollamaPort,
        passthroughOpenAiListenEnabled: Boolean(overrides.openAiPort),
        passthroughOpenAiListenPort: overrides.openAiPort || 18080,
        ...overrides.settingsExtra
      };
    },
    search: async () => ({ results: [], warnings: [], errors: [] })
  };
}

test('readNamespaceFromReq prefers x-froggy-namespace header', () => {
  const ns = readNamespaceFromReq({
    headers: { 'x-froggy-namespace': '  my-ns  ' },
    query: { namespace: 'ignored' }
  });
  assert.equal(ns, 'my-ns');
});

test('readNamespaceFromReq falls back to query.namespace', () => {
  const ns = readNamespaceFromReq({
    headers: {},
    query: { namespace: 'from-query' }
  });
  assert.equal(ns, 'from-query');
});

test('readNamespaceFromReq returns undefined when absent', () => {
  assert.equal(readNamespaceFromReq({ headers: {}, query: {} }), undefined);
});

test('PassthroughInboundService POST /api/chat returns upstream JSON', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ message: { content: 'from-upstream' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  const port = await getFreePort();
  const rag = makeRagService({ ollamaPort: port });
  const svc = new PassthroughInboundService(rag);
  await svc.syncFromSettings();

  t.after(async () => {
    await svc.stopAll();
  });

  const { status, body } = await requestJson(port, '/api/chat', {
    method: 'POST',
    body: {
      model: 'stub',
      messages: [{ role: 'user', content: 'hello' }],
      froggy: { rag: false }
    }
  });

  assert.equal(status, 200);
  assert.equal(body.message.content, 'from-upstream');
});

test('PassthroughInboundService returns 503 when upstream base URL is missing', async (t) => {
  const port = await getFreePort();
  const rag = makeRagService({
    ollamaPort: port,
    settingsExtra: {
      llmPassthroughEnabled: true,
      llmPassthroughBaseUrl: '',
      llmPassthroughModel: 'm'
    }
  });
  const svc = new PassthroughInboundService(rag);
  await svc.syncFromSettings();

  t.after(async () => {
    await svc.stopAll();
  });

  const { status, body } = await requestJson(port, '/api/chat', {
    method: 'POST',
    body: {
      messages: [{ role: 'user', content: 'x' }],
      froggy: { rag: false }
    }
  });

  assert.equal(status, 503);
  assert.match(String(body.error), /base URL/);
});

test('PassthroughInboundService POST /v1/chat/completions returns upstream JSON', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'openai-body' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  const port = await getFreePort();
  const rag = makeRagService({
    ollamaPort: 0,
    openAiPort: port,
    settingsExtra: {
      llmPassthroughProvider: 'openai',
      llmPassthroughOpenAiBaseUrl: 'https://example.invalid/v1',
      llmPassthroughOpenAiModel: 'gpt',
      passthroughOllamaListenEnabled: false,
      passthroughOpenAiListenEnabled: true,
      passthroughOpenAiListenPort: port
    }
  });
  const svc = new PassthroughInboundService(rag);
  await svc.syncFromSettings();

  t.after(async () => {
    await svc.stopAll();
  });

  const { status, body } = await requestJson(port, '/v1/chat/completions', {
    method: 'POST',
    body: {
      model: 'gpt',
      messages: [{ role: 'user', content: 'hi' }],
      froggy: { rag: false }
    }
  });

  assert.equal(status, 200);
  assert.equal(body.choices[0].message.content, 'openai-body');
});

test('PassthroughInboundService OPTIONS returns 204 (CORS preflight)', async (t) => {
  const port = await getFreePort();
  const rag = makeRagService({ ollamaPort: port });
  const svc = new PassthroughInboundService(rag);
  await svc.syncFromSettings();

  t.after(async () => {
    await svc.stopAll();
  });

  const { status } = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: '/api/chat',
        method: 'OPTIONS',
        headers: { Origin: 'http://localhost' }
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode }));
      }
    );
    req.on('error', reject);
    req.end();
  });

  assert.equal(status, 204);
});

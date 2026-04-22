/**
 * RAG-augmented chat: retrieve chunks from the corpus (same scoping as MCP search), then call Ollama or an OpenAI-compatible API.
 */

const { searchCorpusInNamespaces } = require('./mcp/corpus-namespace-query');

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function formatSearchHitsForContext(results) {
  if (!results || !results.length) {
    return '';
  }
  const blocks = [];
  let i = 1;
  for (const r of results) {
    if (r.chunks && Array.isArray(r.chunks)) {
      const meta = r.metadata || {};
      const baseSrc = meta.fileName || meta.filePath || 'document';
      const ns = meta.namespace ? ` [${meta.namespace}]` : '';
      const src = `${baseSrc}${ns}`;
      for (const ch of r.chunks) {
        const text = (ch && ch.content) || '';
        if (!text.trim()) continue;
        blocks.push(`[${i++}] Source: ${src}\n${text.trim()}`);
      }
    } else {
      const meta = r.metadata || {};
      const baseSrc = meta.fileName || meta.filePath || 'document';
      const ns = meta.namespace ? ` [${meta.namespace}]` : '';
      const src = `${baseSrc}${ns}`;
      const text = (r.content || '').trim();
      if (!text) continue;
      blocks.push(`[${i++}] Source: ${src}\n${text}`);
    }
  }
  return blocks.join('\n\n---\n\n');
}

function buildMessages(systemPreamble, userPrompt) {
  return [
    { role: 'system', content: systemPreamble },
    { role: 'user', content: userPrompt }
  ];
}

async function postJson(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...headers
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      if (data && typeof data === 'object') {
        const err = data.error;
        if (typeof err === 'string') msg = err;
        else if (err && typeof err === 'object' && err.message) msg = String(err.message);
        else if (data.message) msg = String(data.message);
      }
      throw new Error(msg);
    }
    return data;
  } finally {
    clearTimeout(t);
  }
}

function extractOllamaReply(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.message && typeof data.message.content === 'string') {
    return data.message.content;
  }
  return '';
}

function extractOpenAiStyleReply(data) {
  if (!data || typeof data !== 'object') return '';
  const c0 = data.choices && data.choices[0];
  if (!c0) return '';
  const m = c0.message;
  if (m && typeof m.content === 'string') return m.content;
  if (typeof c0.text === 'string') return c0.text;
  return '';
}

const ALLOWED_ALGORITHMS = new Set(['hybrid', 'bm25', 'tfidf', 'vector']);

/**
 * @param {*} ragService RAGService instance
 * @param {string} userPrompt
 * @param {{ namespace?: string, topK?: number, algorithm?: string }} [options]
 * @returns {Promise<{ reply: string, contextBlock: string, warnings: string[], errors: string[], scope?: object }>}
 */
async function runLlmPassthrough(ragService, userPrompt, options = {}) {
  const settings = ragService.getSettings();
  if (!settings.llmPassthroughEnabled) {
    throw new Error('LLM Passthrough is disabled. Enable it in Settings → LLM Passthrough.');
  }
  const provider = settings.llmPassthroughProvider === 'openai' ? 'openai' : 'ollama';
  const baseUrl = trimTrailingSlash(settings.llmPassthroughBaseUrl || '');
  const model = String(settings.llmPassthroughModel || '').trim();
  const apiKey = String(settings.llmPassthroughApiKey || '').trim();
  const timeoutMs =
    Number.isFinite(settings.llmPassthroughTimeoutMs) && settings.llmPassthroughTimeoutMs > 0
      ? settings.llmPassthroughTimeoutMs
      : 120000;

  let algorithm = settings.llmPassthroughSearchAlgorithm || 'hybrid';
  if (typeof options.algorithm === 'string' && ALLOWED_ALGORITHMS.has(options.algorithm)) {
    algorithm = options.algorithm;
  }

  if (!baseUrl) {
    throw new Error('LLM Passthrough base URL is required.');
  }
  if (!model) {
    throw new Error('LLM Passthrough model name is required.');
  }

  const trimmedPrompt = String(userPrompt || '').trim();
  if (!trimmedPrompt) {
    throw new Error('Prompt is empty.');
  }

  let topK = settings.retrievalTopK || 10;
  if (options.topK !== undefined && options.topK !== null) {
    const t = Number(options.topK);
    if (Number.isFinite(t) && t >= 1) {
      topK = Math.min(100, Math.floor(t));
    }
  } else {
    topK = Math.min(100, Math.max(1, Math.floor(topK)));
  }

  const namespaceArg =
    options.namespace !== undefined && options.namespace !== null && String(options.namespace).trim() !== ''
      ? String(options.namespace).trim()
      : undefined;

  const searchOut = await searchCorpusInNamespaces(ragService, {
    namespace: namespaceArg,
    query: trimmedPrompt,
    topK,
    algorithm
  });
  const warnings = Array.isArray(searchOut.warnings) ? [...searchOut.warnings] : [];
  const errors = Array.isArray(searchOut.errors) ? [...searchOut.errors] : [];
  const hits = searchOut.results || [];
  const scope = searchOut.scope;
  const contextBlock = formatSearchHitsForContext(hits);
  const contextForModel =
    contextBlock ||
    'No relevant chunks were retrieved from the knowledge base for this query. Answer using general knowledge and say that no local context was found.';

  const systemPreamble = [
    'You are a helpful assistant.',
    'The user message may be followed by instructions to use retrieved context.',
    'Use the following excerpts from the user\'s indexed documents when they help answer the question.',
    'If the excerpts are irrelevant, say so briefly and answer without inventing document content.',
    '',
    '### Retrieved context',
    '',
    contextForModel
  ].join('\n');

  const messages = buildMessages(systemPreamble, trimmedPrompt);

  let reply = '';
  if (provider === 'ollama') {
    const url = `${baseUrl}/api/chat`;
    const data = await postJson(
      url,
      { model, messages, stream: false },
      {},
      timeoutMs
    );
    reply = extractOllamaReply(data);
  } else {
    const url = `${baseUrl}/chat/completions`;
    const headers = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const data = await postJson(
      url,
      { model, messages, temperature: 0.7, stream: false },
      headers,
      timeoutMs
    );
    reply = extractOpenAiStyleReply(data);
  }

  if (!reply || !String(reply).trim()) {
    throw new Error('The model returned an empty response.');
  }

  return { reply: String(reply).trim(), contextBlock, warnings, errors, scope };
}

module.exports = {
  runLlmPassthrough,
  formatSearchHitsForContext
};

/**
 * RAG-augmented chat: retrieve chunks from the corpus (same scoping as MCP search), then call Ollama or an OpenAI-compatible API.
 */

const { searchCorpusInNamespaces } = require('./mcp/corpus-namespace-query');
const { searchGoogleCustomSearch } = require('./web-search');

function trimTrailingSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

/**
 * Resolved upstream for the selected API style (per-provider URLs/models/keys, with legacy field fallback).
 * @param {Record<string, unknown>} settings
 * @returns {{ provider: 'ollama' | 'openai', baseUrl: string, model: string, apiKey: string }}
 */
function getActiveLlmPassthroughUpstream(settings) {
  const prov = settings.llmPassthroughProvider === 'openai' ? 'openai' : 'ollama';
  if (prov === 'openai') {
    const baseUrl = trimTrailingSlash(
      String(settings.llmPassthroughOpenAiBaseUrl || settings.llmPassthroughBaseUrl || '')
    );
    const model = String(settings.llmPassthroughOpenAiModel ?? settings.llmPassthroughModel ?? '').trim();
    const apiKey = String(settings.llmPassthroughOpenAiApiKey ?? settings.llmPassthroughApiKey ?? '').trim();
    return { provider: 'openai', baseUrl, model, apiKey };
  }
  const baseUrl = trimTrailingSlash(
    String(settings.llmPassthroughOllamaBaseUrl || settings.llmPassthroughBaseUrl || '')
  );
  const model = String(settings.llmPassthroughOllamaModel ?? settings.llmPassthroughModel ?? '').trim();
  const apiKey = String(settings.llmPassthroughOllamaApiKey ?? settings.llmPassthroughApiKey ?? '').trim();
  return { provider: 'ollama', baseUrl, model, apiKey };
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

function combineContextBlocks(localContextBlock, webContextBlock) {
  const local = String(localContextBlock || '').trim();
  const web = String(webContextBlock || '').trim();
  if (local && web) {
    return [
      '### Local vector store results',
      '',
      local,
      '',
      '### Web search results',
      '',
      web
    ].join('\n');
  }
  return local || web;
}

async function getWebContextForPassthrough(settings, query, warnings) {
  if (settings.llmPassthroughIncludeWebResults !== true) {
    return '';
  }
  try {
    const out = await searchGoogleCustomSearch(settings, query, {
      numResults: settings.googleCustomSearchNumResults
    });
    return out.context || '';
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    warnings.push(`Web search skipped: ${msg}`);
    return '';
  }
}

function buildMessages(systemPreamble, userPrompt) {
  return [
    { role: 'system', content: systemPreamble },
    { role: 'user', content: userPrompt }
  ];
}

/**
 * @param {string} url
 * @param {object} body
 * @param {Record<string, string>} headers
 * @param {number} timeoutMs
 * @param {AbortSignal} [abortSignal] When aborted, the request is cancelled (in addition to timeout).
 */
async function postJson(url, body, headers, timeoutMs, abortSignal) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  const onExternalAbort = () => {
    controller.abort();
  };
  try {
    if (abortSignal) {
      if (abortSignal.aborted) {
        controller.abort();
        const err = new Error('Aborted');
        err.name = 'AbortError';
        throw err;
      }
      abortSignal.addEventListener('abort', onExternalAbort);
    }
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
    if (abortSignal) {
      abortSignal.removeEventListener('abort', onExternalAbort);
    }
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
    throw new Error('LLM Passthrough is disabled. Enable it under Settings → Server.');
  }
  const { provider, baseUrl, model, apiKey } = getActiveLlmPassthroughUpstream(settings);
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
  const localContextBlock = formatSearchHitsForContext(hits);
  const webContextBlock = await getWebContextForPassthrough(settings, trimmedPrompt, warnings);
  const contextBlock = combineContextBlocks(localContextBlock, webContextBlock);
  const contextForModel =
    contextBlock ||
    'No relevant chunks were retrieved from the knowledge base or web search for this query. Answer using general knowledge and say that no retrieved context was found.';

  const systemPreamble = [
    'You are a helpful assistant.',
    'The user message may be followed by instructions to use retrieved context.',
    'Use the following retrieved context from indexed documents and web search when it helps answer the question.',
    'If the context is irrelevant, say so briefly and answer without inventing retrieved details.',
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

/** @param {unknown} content */
function messageContentToString(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = [];
    for (const p of content) {
      if (p && typeof p === 'object' && p.type === 'text' && typeof p.text === 'string') {
        parts.push(p.text);
      }
    }
    return parts.join('\n');
  }
  return '';
}

/**
 * @param {unknown[]} messages
 * @returns {{ role: string, content: string }[]}
 */
function normalizeChatMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const out = [];
  for (const m of messages) {
    if (!m || typeof m !== 'object') continue;
    const role = typeof m.role === 'string' ? m.role : 'user';
    const content = messageContentToString(m.content);
    out.push({ role, content });
  }
  return out;
}

/**
 * @param {{ role: string, content: string }[]} messages
 */
function getRagQueryFromMessages(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user' && messages[i].content.trim()) {
      return messages[i].content.trim();
    }
  }
  return messages.length && messages[0].content.trim() ? messages[0].content.trim() : '';
}

/**
 * @param {{ role: string, content: string }[]} messages
 * @param {string} contextForModel
 */
function injectRagIntoMessages(messages, contextForModel) {
  const ragBlock = [
    'You are a helpful assistant.',
    'Use the following retrieved context from indexed documents and web search when it helps answer the question.',
    'If the context is irrelevant, say so briefly and answer without inventing retrieved details.',
    '',
    '### Retrieved context',
    '',
    contextForModel
  ].join('\n');

  const copy = messages.map((m) => ({ ...m, content: m.content }));
  if (copy.length && copy[0].role === 'system') {
    copy[0] = {
      role: 'system',
      content: `${ragBlock}\n\n---\n\n${copy[0].content}`
    };
  } else {
    copy.unshift({ role: 'system', content: ragBlock });
  }
  return copy;
}

/**
 * Full non-streaming proxy: RAG over last user turn, then forward to configured upstream. Returns upstream JSON and metadata.
 * @param {*} ragService
 * @param {{ messages?: unknown[], model?: string, temperature?: number, max_tokens?: number, stream?: boolean }} inboundBody
 * @param {{ namespace?: string, topK?: number, algorithm?: string, abortSignal?: AbortSignal }} [options]
 * @returns {Promise<{ upstreamJson: object, contextBlock: string, warnings: string[], errors: string[], scope?: object }>}
 */
async function completeChatProxy(ragService, inboundBody, options = {}) {
  const settings = ragService.getSettings();
  if (!settings.llmPassthroughEnabled) {
    throw new Error('LLM Passthrough is disabled. Enable it under Settings → Server.');
  }
  const { provider: outbound, baseUrl, model: defaultModel, apiKey } =
    getActiveLlmPassthroughUpstream(settings);
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
  if (!defaultModel) {
    throw new Error('LLM Passthrough model name is required.');
  }

  if (inboundBody && inboundBody.stream === true) {
    const e = new Error(
      'Streaming is not supported on the inbound passthrough listener. Set stream to false.'
    );
    e.code = 'STREAM_NOT_SUPPORTED';
    throw e;
  }

  const rawMessages = inboundBody && inboundBody.messages;
  const messages = normalizeChatMessages(rawMessages);
  if (!messages.length) {
    throw new Error('messages array is required and must contain at least one message.');
  }

  const ragQuery = getRagQueryFromMessages(messages);
  if (!ragQuery) {
    throw new Error('Could not derive a user message for RAG retrieval.');
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

  const upstreamAbortSignal =
    options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined;

  const searchOut = await searchCorpusInNamespaces(ragService, {
    namespace: namespaceArg,
    query: ragQuery,
    topK,
    algorithm
  });
  const warnings = Array.isArray(searchOut.warnings) ? [...searchOut.warnings] : [];
  const errors = Array.isArray(searchOut.errors) ? [...searchOut.errors] : [];
  const hits = searchOut.results || [];
  const scope = searchOut.scope;
  const localContextBlock = formatSearchHitsForContext(hits);
  const webContextBlock = await getWebContextForPassthrough(settings, ragQuery, warnings);
  const contextBlock = combineContextBlocks(localContextBlock, webContextBlock);
  const contextForModel =
    contextBlock ||
    'No relevant chunks were retrieved from the knowledge base or web search for this query. Answer using general knowledge and say that no retrieved context was found.';

  const augmented = injectRagIntoMessages(messages, contextForModel);
  const model =
    typeof inboundBody.model === 'string' && inboundBody.model.trim()
      ? inboundBody.model.trim()
      : defaultModel;

  let upstreamJson;
  if (outbound === 'ollama') {
    const url = `${baseUrl}/api/chat`;
    const body = {
      model,
      messages: augmented,
      stream: false
    };
    if (inboundBody && inboundBody.options && typeof inboundBody.options === 'object') {
      body.options = inboundBody.options;
    }
    upstreamJson = await postJson(url, body, {}, timeoutMs, upstreamAbortSignal);
  } else {
    const url = `${baseUrl}/chat/completions`;
    const headers = {};
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }
    const body = {
      model,
      messages: augmented,
      stream: false,
      temperature:
        typeof inboundBody.temperature === 'number' && Number.isFinite(inboundBody.temperature)
          ? inboundBody.temperature
          : 0.7
    };
    if (typeof inboundBody.max_tokens === 'number' && Number.isFinite(inboundBody.max_tokens)) {
      body.max_tokens = inboundBody.max_tokens;
    }
    upstreamJson = await postJson(url, body, headers, timeoutMs, upstreamAbortSignal);
  }

  return { upstreamJson, contextBlock, warnings, errors, scope };
}

/**
 * Extract assistant text from upstream JSON after completeChatProxy (shape matches inbound HTTP body).
 * @param {Record<string, unknown>} settings
 * @param {unknown} upstreamJson
 */
function extractPassthroughUpstreamReply(settings, upstreamJson) {
  const { provider } = getActiveLlmPassthroughUpstream(settings);
  if (provider === 'openai') return extractOpenAiStyleReply(upstreamJson);
  return extractOllamaReply(upstreamJson);
}

module.exports = {
  runLlmPassthrough,
  completeChatProxy,
  extractPassthroughUpstreamReply,
  formatSearchHitsForContext,
  combineContextBlocks,
  normalizeChatMessages,
  getRagQueryFromMessages,
  injectRagIntoMessages,
  getActiveLlmPassthroughUpstream
};

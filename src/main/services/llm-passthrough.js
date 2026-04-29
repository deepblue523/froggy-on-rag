/**
 * RAG-augmented chat: retrieve chunks from the corpus (same scoping as MCP search), then call Ollama or an OpenAI-compatible API.
 */

const { searchCorpusInNamespaces } = require('./mcp/corpus-namespace-query');
const { inferDefaultCorpusNamespaceName } = require('./mcp/namespace-scope');
const { searchGoogleCustomSearch } = require('./web-search');
const path = require('path');
const paths = require('../../paths');
const { readJsonObject } = require('../../settings-files');

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

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function appendSetValue(map, key, value) {
  const entryKey = String(key || '').trim();
  if (!entryKey) return;
  const values = Array.isArray(value) ? value : [value];
  if (!map.has(entryKey)) map.set(entryKey, new Set());
  const bucket = map.get(entryKey);
  for (const raw of values) {
    const entryValue = String(raw || '').trim();
    if (entryValue) bucket.add(entryValue);
  }
}

function splitMetadataTagString(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const eq = text.indexOf('=');
  const colon = text.indexOf(':');
  const idx =
    eq >= 0 && colon >= 0
      ? Math.min(eq, colon)
      : eq >= 0
        ? eq
        : colon;
  if (idx <= 0) return null;
  const key = text.slice(0, idx).trim();
  const val = text.slice(idx + 1).trim();
  return key && val ? { key, value: val } : null;
}

function collectMixedTags(value, simpleTags, metadata) {
  if (Array.isArray(value)) {
    for (const item of value) collectMixedTags(item, simpleTags, metadata);
    return;
  }
  if (typeof value === 'string') {
    const parts = value.split(',').map((part) => part.trim()).filter(Boolean);
    const entries = parts.length > 1 ? parts : [value.trim()];
    for (const entry of entries) {
      const metadataEntry = splitMetadataTagString(entry);
      if (metadataEntry) appendSetValue(metadata, metadataEntry.key, metadataEntry.value);
      else appendSetValue(simpleTags, 'tags', entry);
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, raw] of Object.entries(value)) {
      if (key === 'tags' || key === 'tag') {
        collectMixedTags(raw, simpleTags, metadata);
      } else if (Array.isArray(raw)) {
        appendSetValue(metadata, key, raw);
      } else if (raw && typeof raw === 'object') {
        appendSetValue(metadata, key, safeJson(raw));
      } else {
        appendSetValue(metadata, key, raw);
      }
    }
  }
}

const METADATA_DISPLAY_EXCLUDE_KEYS = new Set([
  'chunkGroupId',
  'chunkIndex',
  'chunkPart',
  'createdAt',
  'docProfile',
  'fileName',
  'filePath',
  'fileSize',
  'fileType',
  'namespace',
  'pages',
  'sheetCount',
  'tags'
]);

function collectTopLevelMetadata(meta, metadata) {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return;
  for (const [key, raw] of Object.entries(meta)) {
    if (METADATA_DISPLAY_EXCLUDE_KEYS.has(key)) continue;
    if (raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw)) appendSetValue(metadata, key, raw);
    else if (raw && typeof raw === 'object') appendSetValue(metadata, key, safeJson(raw));
    else appendSetValue(metadata, key, raw);
  }
}

function collectRetrievedMetadata(results) {
  const simpleTags = new Map();
  const metadata = new Map();
  for (const r of results || []) {
    const meta = r && r.metadata;
    collectMixedTags(meta && meta.tags, simpleTags, metadata);
    collectTopLevelMetadata(meta, metadata);
    if (r && Array.isArray(r.chunks)) {
      for (const ch of r.chunks) {
        const chunkMeta = ch && ch.metadata;
        collectMixedTags(chunkMeta && chunkMeta.tags, simpleTags, metadata);
        collectTopLevelMetadata(chunkMeta, metadata);
      }
    }
  }
  return { simpleTags, metadata };
}

function formatMetadataMap(tagMap) {
  const lines = [];
  const entries =
    tagMap instanceof Map
      ? Array.from(tagMap.entries())
      : tagMap && typeof tagMap === 'object'
        ? Object.entries(tagMap).map(([key, value]) => [key, new Set(Array.isArray(value) ? value : [value])])
        : [];
  for (const [key, values] of entries) {
    const joined = Array.from(values).map((v) => String(v || '').trim()).filter(Boolean).sort((a, b) => a.localeCompare(b)).join(', ');
    if (joined) lines.push(`- ${key}: ${joined}`);
  }
  return lines;
}

function firstTagValues(tagMap) {
  const first = tagMap.values().next();
  if (first.done) return '';
  return Array.from(first.value).sort((a, b) => a.localeCompare(b)).join(', ');
}

function buildRagMetadataSection(results, config) {
  const retrieved = collectRetrievedMetadata(results);
  const requestedTags = normalizeStringArray(config && config.requestedTags).join(', ') || 'none';
  const requestMetadataLines = formatMetadataMap(config && config.metadata);
  const retrievedTags = firstTagValues(retrieved.simpleTags);
  const retrievedMetadataLines = formatMetadataMap(retrieved.metadata);
  const namespace = String((config && config.namespace) || 'general').trim() || 'general';
  const promptProfile = String((config && config.promptProfileName) || '').trim() || 'none';
  return [
    '[METADATA]',
    'Request metadata:',
    `- namespace: ${namespace}`,
    `- requested tags: ${requestedTags}`,
    `- prompt profile: ${promptProfile}`,
    ...requestMetadataLines,
    '',
    'Retrieved Tags:',
    ...(retrievedTags ? retrievedTags.split(', ').map((tag) => `- ${tag}`) : ['- none']),
    '',
    'Retrieved metadata:',
    ...(retrievedMetadataLines.length ? retrievedMetadataLines : ['- none'])
  ].join('\n');
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
        const lines = [`[${i++}] Source: ${src}`];
        lines.push(text.trim());
        blocks.push(lines.join('\n'));
      }
    } else {
      const meta = r.metadata || {};
      const baseSrc = meta.fileName || meta.filePath || 'document';
      const ns = meta.namespace ? ` [${meta.namespace}]` : '';
      const src = `${baseSrc}${ns}`;
      const text = (r.content || '').trim();
      if (!text) continue;
      const lines = [`[${i++}] Source: ${src}`];
      lines.push(text);
      blocks.push(lines.join('\n'));
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

async function getWebContextForPassthrough(settings, query, warnings, options = {}) {
  const includeWebSearch =
    typeof options.includeWebSearch === 'boolean'
      ? options.includeWebSearch
      : settings.llmPassthroughIncludeWebResults === true;
  if (includeWebSearch !== true) {
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

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeFroggyPayload(value) {
  if (!isPlainObject(value)) return {};
  return value;
}

function normalizePositiveInt(value, fallback, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(max, Math.floor(n));
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v || '').trim()).filter(Boolean);
}

function normalizeVariables(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (raw === undefined || raw === null) continue;
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
      out[key] = String(raw);
    } else {
      out[key] = safeJson(raw);
    }
  }
  return out;
}

function applyPromptVariables(template, variables) {
  const text = String(template || '');
  if (!text || !variables || typeof variables !== 'object') return text;
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}|\$\{\s*([A-Za-z0-9_.-]+)\s*\}/g, (match, a, b) => {
    const key = a || b;
    return Object.prototype.hasOwnProperty.call(variables, key) ? variables[key] : match;
  });
}

function promptProfileToText(profile) {
  if (typeof profile === 'string') return profile;
  if (Array.isArray(profile)) return normalizeStringArray(profile).join('\n');
  if (!isPlainObject(profile)) return '';

  const parts = [];
  for (const key of ['body', 'system', 'prompt', 'template', 'instructions']) {
    const value = profile[key];
    if (typeof value === 'string' && value.trim()) {
      parts.push(value.trim());
    } else if (Array.isArray(value)) {
      const lines = normalizeStringArray(value);
      if (lines.length) parts.push(lines.join('\n'));
    }
  }
  return parts.join('\n\n');
}

function readPromptProfileForNamespace(ragService, namespaceName, profileName) {
  const name = String(profileName || '').trim();
  if (!name) return { text: '', found: false };

  let namespaceSettings = null;
  const activeNamespace = inferDefaultCorpusNamespaceName(ragService);
  if (!namespaceName || namespaceName === activeNamespace) {
    namespaceSettings = ragService.getSettings();
  } else if (paths.isValidNamespaceName(namespaceName)) {
    namespaceSettings = readJsonObject(
      path.join(paths.getDataDirForNamespace(namespaceName), 'namespace.json')
    );
  }

  const profiles = namespaceSettings && isPlainObject(namespaceSettings.promptProfiles)
    ? namespaceSettings.promptProfiles
    : {};
  if (!Object.prototype.hasOwnProperty.call(profiles, name)) {
    return { text: '', found: false };
  }
  return { text: promptProfileToText(profiles[name]), found: true };
}

function buildRetrievalQuery(userQuery, tags) {
  const cleanTags = normalizeStringArray(tags);
  if (!cleanTags.length) return userQuery;
  return `${userQuery}\n\nRequest tags: ${cleanTags.join(', ')}`;
}

function normalizeFroggyMetadata(value) {
  if (!isPlainObject(value)) return {};
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    const cleanKey = String(key || '').trim();
    if (!cleanKey || raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw)) {
      const values = raw.map((v) => String(v || '').trim()).filter(Boolean);
      if (values.length) out[cleanKey] = values;
    } else if (raw && typeof raw === 'object') {
      out[cleanKey] = safeJson(raw);
    } else {
      out[cleanKey] = String(raw).trim();
    }
  }
  return out;
}

function buildFroggyInstructionSections(promptProfileText, extraInstructions, tags) {
  const sections = [];
  const profile = String(promptProfileText || '').trim();
  if (profile) {
    sections.push(['### Prompt profile instructions', '', profile].join('\n'));
  }
  const extra = normalizeStringArray(extraInstructions);
  if (extra.length) {
    sections.push(['### Extra instructions', '', extra.map((line) => `- ${line}`).join('\n')].join('\n'));
  }
  const cleanTags = normalizeStringArray(tags);
  if (cleanTags.length) {
    sections.push(['### Request tags', '', cleanTags.join(', ')].join('\n'));
  }
  return sections.join('\n\n');
}

function buildSystemPreamble(contextForModel, promptSections, includeContext) {
  const lines = [
    'You are a helpful assistant.',
    includeContext
      ? 'Use the following retrieved context from indexed documents and web search when it helps answer the question.'
      : 'Follow the Froggy request instructions when they are relevant to the user message.',
    includeContext
      ? 'If the context is irrelevant, say so briefly and answer without inventing retrieved details.'
      : 'Do not invent facts that are not present in the conversation or your available knowledge.'
  ];

  const sections = String(promptSections || '').trim();
  if (sections) {
    lines.push('', sections);
  }

  if (includeContext) {
    lines.push('', '### Retrieved context', '', contextForModel);
  }
  return lines.join('\n');
}

function resolveFroggyConfig(ragService, settings, inboundBody, options, defaultUserQuery) {
  const froggy = normalizeFroggyPayload(
    options && isPlainObject(options.froggy) ? options.froggy : inboundBody && inboundBody.froggy
  );
  const namespace =
    typeof froggy.namespace === 'string' && froggy.namespace.trim()
      ? froggy.namespace.trim()
      : options.namespace !== undefined && options.namespace !== null && String(options.namespace).trim() !== ''
        ? String(options.namespace).trim()
        : 'general';
  const topK = normalizePositiveInt(
    froggy.topK !== undefined ? froggy.topK : options.topK,
    settings.retrievalTopK || 10,
    100
  );
  const algorithm =
    typeof froggy.algorithm === 'string' && ALLOWED_ALGORITHMS.has(froggy.algorithm)
      ? froggy.algorithm
      : typeof options.algorithm === 'string' && ALLOWED_ALGORITHMS.has(options.algorithm)
        ? options.algorithm
        : settings.llmPassthroughSearchAlgorithm || 'hybrid';
  const ragEnabled = froggy.rag === false ? false : true;
  const includeMetadata = froggy.includeMetadata === true;
  const includeWebSearch =
    typeof froggy.includeWebSearch === 'boolean' ? froggy.includeWebSearch : false;
  const tags = normalizeStringArray(froggy.tags);
  const metadata = normalizeFroggyMetadata(froggy.metadata);
  const filters = {};
  if (tags.length) filters.tags = tags;
  if (Object.keys(metadata).length) filters.metadata = metadata;
  const requestedTags = tags;
  const extraInstructions = normalizeStringArray(froggy.extraInstructions);
  const variables = normalizeVariables(froggy.variables);
  const promptProfileName =
    typeof froggy.promptProfile === 'string' && froggy.promptProfile.trim()
      ? froggy.promptProfile.trim()
      : '';
  const promptProfile = readPromptProfileForNamespace(ragService, namespace, promptProfileName);
  const promptProfileText = applyPromptVariables(promptProfile.text, variables).trim();
  const promptSections = buildFroggyInstructionSections(promptProfileText, extraInstructions, tags);
  const warnings = [];
  if (promptProfileName && !promptProfile.found) {
    warnings.push(
      namespace
        ? `Prompt profile not found in namespace "${namespace}": ${promptProfileName}`
        : `Prompt profile not found for active namespace: ${promptProfileName}`
    );
  }

  return {
    namespace,
    topK,
    algorithm,
    ragEnabled,
    includeMetadata,
    includeWebSearch,
    filters,
    tags,
    metadata,
    requestedTags,
    promptProfileName,
    promptSections,
    warnings,
    retrievalQuery: buildRetrievalQuery(defaultUserQuery, tags)
  };
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
    throw new Error('LLM Passthrough is disabled. Enable it under Settings → LLM Passthrough.');
  }
  const { provider, baseUrl, model, apiKey } = getActiveLlmPassthroughUpstream(settings);
  const timeoutMs =
    Number.isFinite(settings.llmPassthroughTimeoutMs) && settings.llmPassthroughTimeoutMs > 0
      ? settings.llmPassthroughTimeoutMs
      : 120000;

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

  const froggyConfig = resolveFroggyConfig(
    ragService,
    settings,
    options && options.froggy ? { froggy: options.froggy } : {},
    options,
    trimmedPrompt
  );

  let contextBlock = '';
  let warnings = [...froggyConfig.warnings];
  let errors = [];
  let scope = undefined;
  if (froggyConfig.ragEnabled) {
    const searchOut = await searchCorpusInNamespaces(ragService, {
      namespace: froggyConfig.namespace,
      query: froggyConfig.retrievalQuery,
      topK: froggyConfig.topK,
      algorithm: froggyConfig.algorithm,
      filters: froggyConfig.filters
    });
    warnings.push(...(Array.isArray(searchOut.warnings) ? searchOut.warnings : []));
    errors = Array.isArray(searchOut.errors) ? [...searchOut.errors] : [];
    const hits = searchOut.results || [];
    scope = searchOut.scope;
    const localContextBlock = formatSearchHitsForContext(hits);
    const webContextBlock = await getWebContextForPassthrough(
      settings,
      froggyConfig.retrievalQuery,
      warnings,
      { includeWebSearch: froggyConfig.includeWebSearch }
    );
    contextBlock = combineContextBlocks(localContextBlock, webContextBlock);
    if (froggyConfig.includeMetadata) {
      contextBlock = [
        buildRagMetadataSection(hits, froggyConfig),
        contextBlock
      ].filter(Boolean).join('\n\n');
    }
  }
  const contextForModel =
    contextBlock ||
    'No relevant chunks were retrieved from the knowledge base or web search for this query. Answer using general knowledge and say that no retrieved context was found.';

  const systemPreamble = buildSystemPreamble(
    contextForModel,
    froggyConfig.promptSections,
    froggyConfig.ragEnabled
  );

  const messages =
    froggyConfig.ragEnabled || froggyConfig.promptSections
      ? buildMessages(systemPreamble, trimmedPrompt)
      : [{ role: 'user', content: trimmedPrompt }];

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
 * @param {{ includeContext?: boolean, promptSections?: string }} [options]
 */
function injectRagIntoMessages(messages, contextForModel, options = {}) {
  const includeContext = options.includeContext !== false;
  const ragBlock = buildSystemPreamble(
    contextForModel,
    options.promptSections || '',
    includeContext
  );

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
    throw new Error('LLM Passthrough is disabled. Enable it under Settings → LLM Passthrough.');
  }
  const { provider: outbound, baseUrl, model: defaultModel, apiKey } =
    getActiveLlmPassthroughUpstream(settings);
  const timeoutMs =
    Number.isFinite(settings.llmPassthroughTimeoutMs) && settings.llmPassthroughTimeoutMs > 0
      ? settings.llmPassthroughTimeoutMs
      : 120000;

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

  const upstreamAbortSignal =
    options.abortSignal instanceof AbortSignal ? options.abortSignal : undefined;

  const froggyConfig = resolveFroggyConfig(ragService, settings, inboundBody, options, ragQuery);
  let contextBlock = '';
  let warnings = [...froggyConfig.warnings];
  let errors = [];
  let scope = undefined;
  if (froggyConfig.ragEnabled) {
    const searchOut = await searchCorpusInNamespaces(ragService, {
      namespace: froggyConfig.namespace,
      query: froggyConfig.retrievalQuery,
      topK: froggyConfig.topK,
      algorithm: froggyConfig.algorithm,
      filters: froggyConfig.filters
    });
    warnings.push(...(Array.isArray(searchOut.warnings) ? searchOut.warnings : []));
    errors = Array.isArray(searchOut.errors) ? [...searchOut.errors] : [];
    const hits = searchOut.results || [];
    scope = searchOut.scope;
    const localContextBlock = formatSearchHitsForContext(hits);
    const webContextBlock = await getWebContextForPassthrough(
      settings,
      froggyConfig.retrievalQuery,
      warnings,
      { includeWebSearch: froggyConfig.includeWebSearch }
    );
    contextBlock = combineContextBlocks(localContextBlock, webContextBlock);
    if (froggyConfig.includeMetadata) {
      contextBlock = [
        buildRagMetadataSection(hits, froggyConfig),
        contextBlock
      ].filter(Boolean).join('\n\n');
    }
  }
  const contextForModel =
    contextBlock ||
    'No relevant chunks were retrieved from the knowledge base or web search for this query. Answer using general knowledge and say that no retrieved context was found.';

  const augmented =
    froggyConfig.ragEnabled || froggyConfig.promptSections
      ? injectRagIntoMessages(
          messages,
          contextForModel,
          {
            includeContext: froggyConfig.ragEnabled,
            promptSections: froggyConfig.promptSections
          }
        )
      : messages.map((m) => ({ ...m, content: m.content }));
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
  getActiveLlmPassthroughUpstream,
  __testing: {
    buildRagMetadataSection,
    collectRetrievedMetadata,
    normalizeFroggyMetadata,
    resolveFroggyConfig
  }
};

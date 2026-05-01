const test = require('node:test');
const assert = require('node:assert/strict');

const {
  combineContextBlocks,
  completeChatProxy,
  extractPassthroughUpstreamReply,
  formatSearchHitsForContext,
  getActiveLlmPassthroughUpstream,
  getRagQueryFromMessages,
  injectRagIntoMessages,
  normalizeChatMessages,
  __testing
} = require('../src/main/services/llm-passthrough');

const {
  buildRagMetadataSection,
  collectRetrievedMetadata,
  normalizeFroggyMetadata,
  resolveFroggyConfig,
  stripFroggySections
} = __testing;
const paths = require('../src/paths');

function makeRagService(promptProfiles = {}) {
  return {
    dataDir: paths.getDataDirForNamespace('general'),
    getSettings() {
      return {
        retrievalTopK: 10,
        llmPassthroughSearchAlgorithm: 'hybrid',
        promptProfiles
      };
    }
  };
}

test('normalizeChatMessages converts OpenAI text parts into plain content', () => {
  const messages = normalizeChatMessages([
    {
      role: 'user',
      content: [
        { type: 'text', text: 'first' },
        { type: 'image_url', image_url: { url: 'ignored' } },
        { type: 'text', text: 'second' }
      ]
    },
    { role: 'assistant', content: 'ok' }
  ]);

  assert.deepEqual(messages, [
    { role: 'user', content: 'first\nsecond' },
    { role: 'assistant', content: 'ok' }
  ]);
});

test('getRagQueryFromMessages uses the last non-empty user message', () => {
  const query = getRagQueryFromMessages([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: '  final question  ' }
  ]);

  assert.equal(query, 'final question');
});

test('formatSearchHitsForContext preserves source namespace and content', () => {
  const context = formatSearchHitsForContext([
    {
      content: 'select * from patient',
      metadata: {
        fileName: 'examples.sql',
        namespace: 'rxstream-sql-rag'
      }
    }
  ]);

  assert.match(context, /\[1\] Source: examples\.sql \[rxstream-sql-rag\]/);
  assert.match(context, /select \* from patient/);
  assert.doesNotMatch(context, /Metadata:/);
});

test('normalizeFroggyMetadata trims scalars and drops empty values', () => {
  assert.deepEqual(
    normalizeFroggyMetadata({
      platform: ' databricks ',
      empty: '',
      missing: null,
      systems: [' idi ', '', 'rxstream'],
      nested: { mode: 'sql' }
    }),
    {
      platform: 'databricks',
      systems: ['idi', 'rxstream'],
      nested: '{"mode":"sql"}'
    }
  );
});

test('resolveFroggyConfig applies canonical defaults and request filters', () => {
  const config = resolveFroggyConfig(
    makeRagService(),
    { retrievalTopK: 10, llmPassthroughSearchAlgorithm: 'hybrid' },
    {
      froggy: {
        rag: true,
        topK: 8,
        tags: ['phi', 'patient', 'prescription'],
        metadata: {
          platform: 'databricks',
          system: 'idi'
        }
      }
    },
    {},
    'generate sql'
  );

  assert.equal(config.namespace, 'general');
  assert.equal(config.topK, 8);
  assert.equal(config.includeWebSearch, false);
  assert.deepEqual(config.filters, {
    tags: ['phi', 'patient', 'prescription'],
    metadata: {
      platform: 'databricks',
      system: 'idi'
    }
  });
  assert.match(config.retrievalQuery, /Request tags: phi, patient, prescription/);
});

test('resolveFroggyConfig replaces variables in namespace prompt profiles', () => {
  const config = resolveFroggyConfig(
    makeRagService({
      'sql-generation': {
        instructions: [
          'Write {{outputStyle}}.',
          'Use ${dialect}.'
        ]
      }
    }),
    {
      retrievalTopK: 10,
      llmPassthroughSearchAlgorithm: 'hybrid',
      promptProfiles: {
        'sql-generation': {
          instructions: [
            'Write {{outputStyle}}.',
            'Use ${dialect}.'
          ]
        }
      }
    },
    {
      froggy: {
        promptProfile: 'sql-generation',
        variables: {
          outputStyle: 'production SQL',
          dialect: 'Databricks SQL'
        }
      }
    },
    {},
    'generate sql'
  );

  assert.match(config.promptSections, /Write production SQL\./);
  assert.match(config.promptSections, /Use Databricks SQL\./);
  assert.equal(config.promptProfileName, 'sql-generation');
});

test('resolveFroggyConfig warns when prompt profile is missing', () => {
  const config = resolveFroggyConfig(
    makeRagService(),
    { retrievalTopK: 10, llmPassthroughSearchAlgorithm: 'hybrid' },
    { froggy: { promptProfile: 'missing-profile' } },
    {},
    'question'
  );

  assert.equal(config.warnings.length, 1);
  assert.match(config.warnings[0], /Prompt profile not found/);
});

test('collectRetrievedMetadata separates simple tags from key/value metadata', () => {
  const collected = collectRetrievedMetadata([
    {
      metadata: {
        tags: ['phi', 'platform=databricks', { system: 'idi' }],
        owner: 'analytics',
        fileName: 'ignored.txt'
      }
    },
    {
      chunks: [
        {
          metadata: {
            tags: 'patient, voltage-decryption',
            platform: 'databricks'
          }
        }
      ]
    }
  ]);

  assert.deepEqual(Array.from(collected.simpleTags.get('tags')).sort(), [
    'patient',
    'phi',
    'voltage-decryption'
  ]);
  assert.deepEqual(Array.from(collected.metadata.get('platform')).sort(), ['databricks']);
  assert.deepEqual(Array.from(collected.metadata.get('system')).sort(), ['idi']);
  assert.deepEqual(Array.from(collected.metadata.get('owner')).sort(), ['analytics']);
  assert.equal(collected.metadata.has('fileName'), false);
});

test('buildRagMetadataSection formats request and retrieved metadata', () => {
  const section = buildRagMetadataSection(
    [
      {
        metadata: {
          tags: ['phi', 'patient', 'platform=databricks'],
          system: 'idi'
        }
      },
      {
        metadata: {
          tags: ['prescription', 'voltage-decryption']
        }
      }
    ],
    {
      namespace: 'rxstream-sql-rag',
      requestedTags: ['phi', 'patient', 'prescription'],
      promptProfileName: 'sql-generation',
      metadata: {
        platform: 'databricks',
        system: 'idi'
      }
    }
  );

  assert.match(section, /^\[METADATA\]/);
  assert.match(section, /Request metadata:\n- namespace: rxstream-sql-rag/);
  assert.match(section, /- requested tags: phi, patient, prescription/);
  assert.match(section, /- prompt profile: sql-generation/);
  assert.match(section, /- platform: databricks/);
  assert.match(section, /- system: idi/);
  assert.match(section, /Retrieved Tags:\n- patient\n- phi\n- prescription\n- voltage-decryption/);
  assert.match(section, /Retrieved metadata:\n- platform: databricks\n- system: idi/);
});

test('buildRagMetadataSection uses none for absent optional metadata', () => {
  const section = buildRagMetadataSection([], {
    namespace: 'general',
    requestedTags: [],
    promptProfileName: '',
    metadata: {}
  });

  assert.match(section, /- requested tags: none/);
  assert.match(section, /- prompt profile: none/);
  assert.match(section, /Retrieved Tags:\n- none/);
  assert.match(section, /Retrieved metadata:\n- none/);
});

test('stripFroggySections removes froggy keys recursively', () => {
  const sanitized = stripFroggySections({
    model: 'qwen',
    froggy: { namespace: 'general', rag: true },
    options: {
      temperature: 0.2,
      froggy: { tags: ['phi'] }
    },
    messages: [
      { role: 'user', content: 'hello', froggy: { test: true } },
      { role: 'assistant', content: 'world' }
    ]
  });

  assert.deepEqual(sanitized, {
    model: 'qwen',
    options: {
      temperature: 0.2
    },
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'world' }
    ]
  });
});

test('getActiveLlmPassthroughUpstream resolves Ollama fields with legacy fallbacks', () => {
  const u = getActiveLlmPassthroughUpstream({
    llmPassthroughProvider: 'ollama',
    llmPassthroughOllamaBaseUrl: 'http://ollama:11434/',
    llmPassthroughOllamaModel: 'mistral',
    llmPassthroughOllamaApiKey: 'secret'
  });
  assert.deepEqual(u, {
    provider: 'ollama',
    baseUrl: 'http://ollama:11434',
    model: 'mistral',
    apiKey: 'secret'
  });
});

test('getActiveLlmPassthroughUpstream uses legacy base URL and model when provider-specific fields absent', () => {
  const u = getActiveLlmPassthroughUpstream({
    llmPassthroughBaseUrl: 'http://legacy/',
    llmPassthroughModel: 'legacy-model'
  });
  assert.equal(u.provider, 'ollama');
  assert.equal(u.baseUrl, 'http://legacy');
  assert.equal(u.model, 'legacy-model');
});

test('getActiveLlmPassthroughUpstream resolves OpenAI-specific URLs and keys', () => {
  const u = getActiveLlmPassthroughUpstream({
    llmPassthroughProvider: 'openai',
    llmPassthroughOpenAiBaseUrl: 'https://api.example/v1/',
    llmPassthroughOpenAiModel: 'gpt-4',
    llmPassthroughOpenAiApiKey: 'sk-test'
  });
  assert.deepEqual(u, {
    provider: 'openai',
    baseUrl: 'https://api.example/v1',
    model: 'gpt-4',
    apiKey: 'sk-test'
  });
});

test('combineContextBlocks joins local and web sections when both present', () => {
  const out = combineContextBlocks('chunk a', 'result b');
  assert.match(out, /### Local vector store results/);
  assert.match(out, /chunk a/);
  assert.match(out, /### Web search results/);
  assert.match(out, /result b/);
});

test('combineContextBlocks returns a single block when only one side has content', () => {
  assert.equal(combineContextBlocks('only local', ''), 'only local');
  assert.equal(combineContextBlocks('', '  web  '), 'web');
});

test('injectRagIntoMessages prepends a system message with RAG preamble', () => {
  const augmented = injectRagIntoMessages(
    [{ role: 'user', content: 'hi' }],
    'CTX',
    { includeContext: true, promptSections: '' }
  );
  assert.equal(augmented[0].role, 'system');
  assert.match(augmented[0].content, /### Retrieved context/);
  assert.match(augmented[0].content, /CTX/);
  assert.equal(augmented[1].role, 'user');
  assert.equal(augmented[1].content, 'hi');
});

test('injectRagIntoMessages merges RAG preamble into an existing system message', () => {
  const augmented = injectRagIntoMessages(
    [
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'ping' }
    ],
    'DOC',
    { includeContext: true }
  );
  assert.equal(augmented.length, 2);
  assert.match(augmented[0].content, /### Retrieved context/);
  assert.match(augmented[0].content, /You are terse\./);
});

test('extractPassthroughUpstreamReply reads Ollama chat shape', () => {
  const settings = { llmPassthroughProvider: 'ollama' };
  const text = extractPassthroughUpstreamReply(settings, {
    message: { content: '  reply  ' }
  });
  assert.equal(text, '  reply  ');
});

test('extractPassthroughUpstreamReply reads OpenAI choices shape', () => {
  const settings = { llmPassthroughProvider: 'openai' };
  const text = extractPassthroughUpstreamReply(settings, {
    choices: [{ message: { content: 'ok' } }]
  });
  assert.equal(text, 'ok');
});

test('completeChatProxy rejects when LLM passthrough is disabled', async () => {
  const rag = makeRagService();
  rag.getSettings = () => ({
    llmPassthroughEnabled: false,
    retrievalTopK: 10,
    llmPassthroughSearchAlgorithm: 'hybrid'
  });
  await assert.rejects(
    () =>
      completeChatProxy(rag, {
        messages: [{ role: 'user', content: 'x' }],
        froggy: { rag: false }
      }),
    /LLM Passthrough is disabled/
  );
});

test('completeChatProxy rejects streaming inbound requests', async () => {
  const rag = makeRagService();
  rag.getSettings = () => ({
    llmPassthroughEnabled: true,
    llmPassthroughBaseUrl: 'http://127.0.0.1:1',
    llmPassthroughModel: 'm',
    retrievalTopK: 10,
    llmPassthroughSearchAlgorithm: 'hybrid'
  });
  await assert.rejects(
    () =>
      completeChatProxy(rag, {
        stream: true,
        messages: [{ role: 'user', content: 'x' }],
        froggy: { rag: false }
      }),
    (e) => e.code === 'STREAM_NOT_SUPPORTED' && /Streaming is not supported/.test(String(e.message))
  );
});

test('completeChatProxy forwards to Ollama upstream when froggy.rag is false', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/api\/chat$/);
    const body = JSON.parse(String(init.body));
    assert.equal(body.stream, false);
    assert.equal(body.model, 'upstream-model');
    assert.ok(Array.isArray(body.messages));
    assert.equal(body.messages[body.messages.length - 1].content, 'plain ask');
    return new Response(JSON.stringify({ message: { content: 'upstream says hi' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const rag = makeRagService();
  rag.getSettings = () => ({
    llmPassthroughEnabled: true,
    llmPassthroughBaseUrl: 'http://127.0.0.1:9',
    llmPassthroughModel: 'upstream-model',
    retrievalTopK: 10,
    llmPassthroughSearchAlgorithm: 'hybrid'
  });

  const out = await completeChatProxy(rag, {
    model: 'upstream-model',
    messages: [{ role: 'user', content: 'plain ask' }],
    froggy: { rag: false }
  });

  assert.equal(out.upstreamJson.message.content, 'upstream says hi');
  assert.equal(out.contextBlock, '');
  assert.deepEqual(out.errors, []);
});

test('completeChatProxy sends Bearer token for OpenAI-style upstream', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });

  globalThis.fetch = async (url, init) => {
    assert.match(String(url), /\/chat\/completions$/);
    assert.equal(init.headers.Authorization, 'Bearer sk-xyz');
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ai' } }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  const rag = makeRagService();
  rag.getSettings = () => ({
    llmPassthroughEnabled: true,
    llmPassthroughProvider: 'openai',
    llmPassthroughOpenAiBaseUrl: 'https://api.openai.com/v1',
    llmPassthroughOpenAiModel: 'gpt',
    llmPassthroughOpenAiApiKey: 'sk-xyz',
    retrievalTopK: 10,
    llmPassthroughSearchAlgorithm: 'hybrid'
  });

  const out = await completeChatProxy(rag, {
    messages: [{ role: 'user', content: 'q' }],
    froggy: { rag: false }
  });

  assert.equal(out.upstreamJson.choices[0].message.content, 'ai');
});

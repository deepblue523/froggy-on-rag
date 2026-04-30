const test = require('node:test');
const assert = require('node:assert/strict');

const {
  formatSearchHitsForContext,
  getRagQueryFromMessages,
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

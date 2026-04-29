const test = require('node:test');
const assert = require('node:assert/strict');

const { SearchService } = require('../src/main/services/search-service');

function makeService() {
  return new SearchService(null);
}

function chunk(id, content, metadata) {
  return {
    id,
    document_id: `doc-${id}`,
    content,
    metadata
  };
}

test('buildChunkFilter returns null when no tag or metadata constraints exist', () => {
  const service = makeService();

  assert.equal(service.buildChunkFilter({}), null);
  assert.equal(service.buildChunkFilter({ filters: {} }), null);
  assert.equal(service.buildChunkFilter({ filters: { tags: [], metadata: {} } }), null);
});

test('simple tag filter matches array tags', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      tags: ['phi', 'patient']
    }
  });

  assert.equal(filter(chunk('1', 'content', { tags: ['phi', 'patient', 'sql'] })), true);
  assert.equal(filter(chunk('2', 'content', { tags: ['phi'] })), false);
});

test('simple tag filter matches comma-separated string tags', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      tags: ['voltage-decryption']
    }
  });

  assert.equal(filter(chunk('1', 'content', { tags: 'phi, voltage-decryption, sql' })), true);
  assert.equal(filter(chunk('2', 'content', { tags: 'phi, patient' })), false);
});

test('tag filter can match metadata values', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      tags: ['databricks', 'idi']
    }
  });

  assert.equal(
    filter(chunk('1', 'content', { metadataOnly: 'ignored', platform: 'databricks', system: 'idi' })),
    true
  );
  assert.equal(filter(chunk('2', 'content', { platform: 'databricks', system: 'rxstream' })), false);
});

test('tag filter can match metadata keys', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      tags: ['platform']
    }
  });

  assert.equal(filter(chunk('1', 'content', { platform: 'databricks' })), true);
  assert.equal(filter(chunk('2', 'content', { system: 'idi' })), false);
});

test('tag filter can match key=value entries stored in metadata.tags', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      tags: ['platform=databricks', 'system=idi']
    }
  });

  assert.equal(
    filter(chunk('1', 'content', { tags: ['phi', 'platform=databricks', 'system=idi'] })),
    true
  );
  assert.equal(
    filter(chunk('2', 'content', { tags: ['phi', 'platform=snowflake', 'system=idi'] })),
    false
  );
});

test('metadata filter requires exact requested key/value pairs', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      metadata: {
        platform: 'databricks',
        system: 'idi'
      }
    }
  });

  assert.equal(filter(chunk('1', 'content', { platform: 'databricks', system: 'idi' })), true);
  assert.equal(filter(chunk('2', 'content', { platform: 'databricks', system: 'rxstream' })), false);
});

test('metadata filter can match key/value pairs stored inside tags', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      metadata: {
        platform: 'databricks'
      }
    }
  });

  assert.equal(filter(chunk('1', 'content', { tags: ['platform=databricks', 'phi'] })), true);
  assert.equal(filter(chunk('2', 'content', { tags: ['platform=snowflake', 'phi'] })), false);
});

test('metadata filter supports array request values', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      metadata: {
        platform: ['databricks', 'spark']
      }
    }
  });

  assert.equal(filter(chunk('1', 'content', { platform: ['spark', 'databricks'] })), true);
  assert.equal(filter(chunk('2', 'content', { platform: ['databricks'] })), false);
});

test('combined tag and metadata filters must both match', () => {
  const service = makeService();
  const filter = service.buildChunkFilter({
    filters: {
      tags: ['phi'],
      metadata: {
        platform: 'databricks'
      }
    }
  });

  assert.equal(filter(chunk('1', 'content', { tags: ['phi'], platform: 'databricks' })), true);
  assert.equal(filter(chunk('2', 'content', { tags: ['phi'], platform: 'snowflake' })), false);
  assert.equal(filter(chunk('3', 'content', { tags: ['patient'], platform: 'databricks' })), false);
});

test('in-memory BM25 search narrows candidates by simple tags before ranking', async () => {
  const service = makeService();
  const results = await service.search(
    'patient prescription',
    null,
    [
      chunk('1', 'patient prescription databricks sql example', { tags: ['phi'] }),
      chunk('2', 'patient prescription sql example', { tags: ['public'] })
    ],
    10,
    'bm25',
    {
      filters: {
        tags: ['phi']
      }
    },
    {},
    null,
    null
  );

  assert.deepEqual(results.map(r => r.id), ['1']);
});

test('in-memory BM25 search narrows candidates by request metadata before ranking', async () => {
  const service = makeService();
  const results = await service.search(
    'patient prescription',
    null,
    [
      chunk('1', 'patient prescription databricks sql example', {
        tags: ['phi'],
        platform: 'databricks',
        system: 'idi'
      }),
      chunk('2', 'patient prescription databricks sql example', {
        tags: ['phi'],
        platform: 'databricks',
        system: 'other'
      }),
      chunk('3', 'patient prescription databricks sql example', {
        tags: ['phi'],
        platform: 'snowflake',
        system: 'idi'
      })
    ],
    10,
    'bm25',
    {
      filters: {
        tags: ['phi'],
        metadata: {
          platform: 'databricks',
          system: 'idi'
        }
      }
    },
    {},
    null,
    null
  );

  assert.deepEqual(results.map(r => r.id), ['1']);
});

test('in-memory search returns no results when filters remove all candidates', async () => {
  const service = makeService();
  const results = await service.search(
    'patient prescription',
    null,
    [
      chunk('1', 'patient prescription databricks sql example', {
        tags: ['phi'],
        platform: 'databricks'
      })
    ],
    10,
    'bm25',
    {
      filters: {
        metadata: {
          platform: 'snowflake'
        }
      }
    },
    {},
    null,
    null
  );

  assert.deepEqual(results, []);
});

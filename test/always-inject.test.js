const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  collectAlwaysInjectHits,
  collectAlwaysInjectFilePaths,
  readNamespaceSettings
} = require('../src/main/services/rag-rest/always-inject');

const {
  formatSearchHitsForContext,
  __testing
} = require('../src/main/services/llm-passthrough');

const { partitionAlwaysInjectHits, isAlwaysInjectHit } = __testing;

function makeFakeStore(docsByPath, chunksByDocId) {
  return {
    getDocumentByFilePath(filePath) {
      const resolved = path.resolve(filePath);
      const matchKey = Object.keys(docsByPath).find(
        (k) => path.resolve(k) === resolved
      );
      return matchKey ? docsByPath[matchKey] : null;
    },
    getDocumentChunks(documentId) {
      return chunksByDocId[documentId] || [];
    }
  };
}

test('collectAlwaysInjectFilePaths picks files with alwaysInject=true and active!=false', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'froggy-aij-'));
  const fileA = path.join(tmp, 'a.md');
  const fileB = path.join(tmp, 'b.md');
  const fileC = path.join(tmp, 'c.md');
  fs.writeFileSync(fileA, 'a');
  fs.writeFileSync(fileB, 'b');
  fs.writeFileSync(fileC, 'c');

  const settings = {
    files: [
      { path: fileA, alwaysInject: true },
      { path: fileB, alwaysInject: false },
      { path: fileC, alwaysInject: true, active: false }
    ],
    directories: []
  };

  const paths = collectAlwaysInjectFilePaths(settings);
  assert.deepEqual(paths.map((p) => path.resolve(p)).sort(), [path.resolve(fileA)].sort());

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('collectAlwaysInjectFilePaths expands recursive folders to supported files only', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'froggy-aij-'));
  const sub = path.join(tmp, 'sub');
  fs.mkdirSync(sub);
  const md1 = path.join(tmp, 'one.md');
  const md2 = path.join(sub, 'two.md');
  const skipped = path.join(tmp, 'skip.bin');
  fs.writeFileSync(md1, '1');
  fs.writeFileSync(md2, '2');
  fs.writeFileSync(skipped, 'binary');

  const recursive = collectAlwaysInjectFilePaths({
    files: [],
    directories: [{ path: tmp, alwaysInject: true, recursive: true }]
  });
  assert.deepEqual(
    recursive.map((p) => path.resolve(p)).sort(),
    [path.resolve(md1), path.resolve(md2)].sort()
  );

  const flat = collectAlwaysInjectFilePaths({
    files: [],
    directories: [{ path: tmp, alwaysInject: true, recursive: false }]
  });
  assert.deepEqual(flat.map((p) => path.resolve(p)).sort(), [path.resolve(md1)].sort());

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('collectAlwaysInjectHits emits one hit per chunk with alwaysInject metadata', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'froggy-aij-'));
  const filePath = path.join(tmp, 'standard.md');
  fs.writeFileSync(filePath, 'standard');

  const ragService = {
    dataDir: tmp,
    getSettings: () => ({
      files: [{ path: filePath, alwaysInject: true }],
      directories: []
    })
  };

  const docsByPath = {
    [filePath]: {
      id: 'doc-1',
      file_name: 'standard.md',
      file_path: filePath,
      file_type: '.md'
    }
  };
  const chunksByDocId = {
    'doc-1': [
      { id: 'chunk-1', content: 'chunk one', metadata: { author: 'jane' } },
      { id: 'chunk-2', content: 'chunk two', metadata: null }
    ]
  };

  const ns = path.basename(tmp);
  // readNamespaceSettings prefers in-memory settings when dataDir matches the active dataDir.
  const fakeNamespace = ns;
  // Override readNamespaceSettings path resolution: stub the namespace-data dir lookup is unsafe
  // here, so we instead use the active-namespace path by aligning ragService.dataDir to the
  // `getDataDirForNamespace(fakeNamespace)` value via paths module.
  const hits = collectAlwaysInjectHits(
    {
      // Mimic active namespace match by using the lookup value as dataDir
      dataDir: require('../src/paths').getDataDirForNamespace('general'),
      getSettings: ragService.getSettings
    },
    'general',
    makeFakeStore(docsByPath, chunksByDocId)
  );

  assert.equal(hits.length, 2);
  for (const h of hits) {
    assert.equal(h.metadata.alwaysInject, true);
    assert.equal(h.metadata.fileName, 'standard.md');
    assert.equal(h.metadata.namespace, 'general');
    assert.equal(h.algorithm, 'always-inject');
  }
  assert.equal(hits[0].content, 'chunk one');
  assert.equal(hits[0].metadata.author, 'jane');
  assert.equal(hits[1].content, 'chunk two');

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('collectAlwaysInjectHits returns empty list when no alwaysInject entries exist', () => {
  const ragService = {
    dataDir: require('../src/paths').getDataDirForNamespace('general'),
    getSettings: () => ({ files: [], directories: [] })
  };
  const hits = collectAlwaysInjectHits(ragService, 'general', makeFakeStore({}, {}));
  assert.deepEqual(hits, []);
});

test('readNamespaceSettings returns active in-memory settings when namespace matches dataDir', () => {
  const dataDir = require('../src/paths').getDataDirForNamespace('general');
  const ragService = {
    dataDir,
    getSettings: () => ({
      files: [{ path: 'x.md', alwaysInject: true }],
      directories: []
    })
  };
  const out = readNamespaceSettings(ragService, 'general');
  assert.deepEqual(out.files, [{ path: 'x.md', alwaysInject: true }]);
});

test('isAlwaysInjectHit detects metadata flag', () => {
  assert.equal(isAlwaysInjectHit({ metadata: { alwaysInject: true } }), true);
  assert.equal(isAlwaysInjectHit({ metadata: { alwaysInject: false } }), false);
  assert.equal(isAlwaysInjectHit({ metadata: {} }), false);
  assert.equal(isAlwaysInjectHit({}), false);
  assert.equal(isAlwaysInjectHit(null), false);
});

test('partitionAlwaysInjectHits splits standard context from regular search hits', () => {
  const { standard, regular } = partitionAlwaysInjectHits([
    { metadata: { alwaysInject: true }, content: 's1' },
    { metadata: { alwaysInject: false }, content: 'r1' },
    { metadata: {}, content: 'r2' },
    { metadata: { alwaysInject: true }, content: 's2' }
  ]);
  assert.equal(standard.length, 2);
  assert.equal(regular.length, 2);
  assert.equal(standard[0].content, 's1');
  assert.equal(regular[0].content, 'r1');
});

test('formatSearchHitsForContext renders standard context section before regular hits', () => {
  const text = formatSearchHitsForContext([
    {
      content: 'standard content one',
      metadata: { alwaysInject: true, fileName: 'std-a.md', namespace: 'general' }
    },
    {
      content: 'standard content two',
      metadata: { alwaysInject: true, fileName: 'std-b.md', namespace: 'general' }
    },
    {
      content: 'top-k chunk',
      metadata: { fileName: 'doc.md', namespace: 'general' }
    }
  ]);

  const standardIdx = text.indexOf('Standard context (always injected)');
  const regularIdx = text.indexOf('top-k chunk');
  assert.notEqual(standardIdx, -1, 'expected a standard-context heading');
  assert.notEqual(regularIdx, -1, 'expected the regular chunk to appear');
  assert.ok(standardIdx < regularIdx, 'standard context must come before top-k results');
  assert.match(text, /\(always-inject\) Source: std-a\.md \[general\]/);
  assert.match(text, /\(always-inject\) Source: std-b\.md \[general\]/);
});

test('formatSearchHitsForContext groups standard context per namespace', () => {
  const text = formatSearchHitsForContext([
    {
      content: 'general doc',
      metadata: { alwaysInject: true, fileName: 'g.md', namespace: 'general' }
    },
    {
      content: 'work doc',
      metadata: { alwaysInject: true, fileName: 'w.md', namespace: 'work-docs' }
    }
  ]);

  assert.match(text, /Standard context \(always injected\) — namespace: general/);
  assert.match(text, /Standard context \(always injected\) — namespace: work-docs/);
});

test('formatSearchHitsForContext omits standard context heading when no always-inject hits exist', () => {
  const text = formatSearchHitsForContext([
    { content: 'just a chunk', metadata: { fileName: 'doc.md' } }
  ]);
  assert.doesNotMatch(text, /Standard context/);
  assert.match(text, /Source: doc\.md/);
});

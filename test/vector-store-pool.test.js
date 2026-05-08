const test = require('node:test');
const assert = require('node:assert/strict');

const path = require('path');
const paths = require('../src/paths');
const { VectorStorePool, DEFAULT_IDLE_TTL_MS } = require('../src/main/services/vector-store-pool');

/** A minimal in-memory stub that records open/close lifecycle for the pool to manage. */
class FakeStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.closed = false;
    FakeStore.instances += 1;
  }
  close() {
    this.closed = true;
    FakeStore.closed += 1;
  }
}
FakeStore.instances = 0;
FakeStore.closed = 0;

function resetFakeStore() {
  FakeStore.instances = 0;
  FakeStore.closed = 0;
}

function makeRagService(activeNamespace = 'general') {
  // Use real paths so _isPrimary's namespace validation passes; the active store is a FakeStore.
  const activeStore = new FakeStore(paths.getDataDirForNamespace(activeNamespace));
  return {
    dataDir: paths.getDataDirForNamespace(activeNamespace),
    vectorStore: activeStore
  };
}

function makePool(opts = {}) {
  const ragService = makeRagService(opts.activeNamespace || 'general');
  const pool = new VectorStorePool(ragService, {
    idleTtlMs: opts.idleTtlMs != null ? opts.idleTtlMs : 50,
    vectorStoreFactory: (dir) => new FakeStore(dir)
  });
  return { pool, ragService };
}

test('default idle TTL is 5 minutes', () => {
  assert.equal(DEFAULT_IDLE_TTL_MS, 5 * 60 * 1000);
});

test('acquire on the active namespace returns the primary store and never closes it', async () => {
  resetFakeStore();
  const { pool, ragService } = makePool({ activeNamespace: 'general', idleTtlMs: 5 });

  const lease = pool.acquire('general');
  assert.equal(lease.primary, true);
  assert.equal(lease.vs, ragService.vectorStore);
  lease.release();
  assert.equal(pool.size, 0, 'primary should never enter the pool');

  // Wait past TTL just to be sure no close fires for the primary
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(ragService.vectorStore.closed, false, 'primary store must not be closed by pool');
});

test('non-primary acquire opens a single store, reuses it for concurrent acquires', () => {
  resetFakeStore();
  const { pool } = makePool();

  const lease1 = pool.acquire('work-docs');
  const lease2 = pool.acquire('work-docs');

  assert.equal(FakeStore.instances - 1, 1, 'only one secondary store opened (primary excluded)');
  assert.equal(lease1.vs, lease2.vs);
  assert.equal(pool.size, 1);

  const stats = pool.getStats();
  assert.equal(stats.entries[0].refCount, 2);

  lease1.release();
  lease2.release();
});

test('idle timeout closes the store after the last release', async () => {
  resetFakeStore();
  const { pool } = makePool({ idleTtlMs: 30 });

  const lease = pool.acquire('work-docs');
  const vs = lease.vs;
  lease.release();
  assert.equal(vs.closed, false, 'store stays resident through TTL window');

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(vs.closed, true, 'store closed after idle TTL elapsed');
  assert.equal(pool.size, 0);
});

test('re-acquire before the idle timer fires cancels the close', async () => {
  resetFakeStore();
  const { pool } = makePool({ idleTtlMs: 60 });

  const lease1 = pool.acquire('work-docs');
  lease1.release();

  // Re-acquire well within the TTL window
  await new Promise((r) => setTimeout(r, 10));
  const lease2 = pool.acquire('work-docs');
  assert.equal(lease2.vs, lease1.vs, 'same in-memory handle reused');

  // Wait past the original timer and confirm no close fired
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(lease2.vs.closed, false);

  lease2.release();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(lease2.vs.closed, true);
});

test('different namespaces get separate stores and can run concurrently', () => {
  resetFakeStore();
  const { pool } = makePool();

  const a = pool.acquire('work-docs');
  const b = pool.acquire('personal-notes');

  assert.notEqual(a.vs, b.vs);
  assert.equal(pool.size, 2);

  a.release();
  b.release();
});

test('release is idempotent and only decrements refcount once', async () => {
  resetFakeStore();
  const { pool } = makePool({ idleTtlMs: 30 });

  const lease = pool.acquire('work-docs');
  lease.release();
  lease.release(); // second call must be a no-op

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(lease.vs.closed, true);

  // Acquiring again after close opens a fresh store (the pool entry was deleted)
  const lease2 = pool.acquire('work-docs');
  assert.notEqual(lease2.vs, lease.vs);
  lease2.release();
});

test('dispose closes every pooled store and prevents further acquires', () => {
  resetFakeStore();
  const { pool } = makePool();

  const a = pool.acquire('work-docs');
  const b = pool.acquire('personal-notes');
  // Don't release; dispose still closes them.

  pool.dispose();
  assert.equal(a.vs.closed, true);
  assert.equal(b.vs.closed, true);
  assert.equal(pool.size, 0);

  assert.throws(() => pool.acquire('work-docs'), /disposed/);
});

test('setIdleTtlMs takes effect on the next release', async () => {
  resetFakeStore();
  const { pool } = makePool({ idleTtlMs: 5000 });

  pool.setIdleTtlMs(20);

  const lease = pool.acquire('work-docs');
  const vs = lease.vs;
  lease.release();
  assert.equal(vs.closed, false);

  await new Promise((r) => setTimeout(r, 50));
  assert.equal(vs.closed, true, 'shorter TTL took effect immediately');
});

test('setIdleTtlMs ignores invalid values', () => {
  const { pool } = makePool({ idleTtlMs: 1000 });
  pool.setIdleTtlMs(0);
  assert.equal(pool.idleTtlMs, 1000);
  pool.setIdleTtlMs(-1);
  assert.equal(pool.idleTtlMs, 1000);
  pool.setIdleTtlMs(NaN);
  assert.equal(pool.idleTtlMs, 1000);
});

test('acquire requires a non-empty namespace', () => {
  const { pool } = makePool();
  assert.throws(() => pool.acquire(''), /namespace is required/);
  assert.throws(() => pool.acquire(null), /namespace is required/);
});

test('acquire rejects invalid namespace names via paths validation', () => {
  const { pool } = makePool();
  assert.throws(() => pool.acquire('not a valid name!'), /Invalid namespace name/);
});

test('withCorpusForNamespace leases through the pool when one is attached', () => {
  resetFakeStore();
  const ragService = {
    dataDir: paths.getDataDirForNamespace('general'),
    vectorStore: new FakeStore(paths.getDataDirForNamespace('general'))
  };
  const pool = new VectorStorePool(ragService, {
    idleTtlMs: 5000,
    vectorStoreFactory: (dir) => new FakeStore(dir)
  });
  ragService.vectorStorePool = pool;

  const { withCorpusForNamespace } = require('../src/main/services/rag-rest/namespace-scope');

  let leasedVs = null;
  const out = withCorpusForNamespace(ragService, 'general', (vs) => {
    leasedVs = vs;
    return 'ok';
  });
  assert.equal(out, 'ok');
  assert.equal(leasedVs, ragService.vectorStore, 'active namespace returns primary store');

  // Non-active namespace: the helper goes through the pool. Stub the pool so this doesn't try to
  // open a real path (the pool would otherwise hit paths.getDataDirForNamespace which is fine for
  // FakeStore but we want to verify lease/release plumbing).
  let acquiredCount = 0;
  let releasedCount = 0;
  ragService.vectorStorePool = {
    acquire(ns) {
      acquiredCount += 1;
      return {
        vs: { id: ns },
        primary: false,
        release: () => {
          releasedCount += 1;
        }
      };
    }
  };
  const result = withCorpusForNamespace(ragService, 'work-docs', (vs) => vs.id);
  assert.equal(result, 'work-docs');
  assert.equal(acquiredCount, 1);
  assert.equal(releasedCount, 1);

  pool.dispose();
});

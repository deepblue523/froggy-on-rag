/**
 * Resident pool of VectorStore handles for non-active namespaces.
 *
 * Purpose: API passthrough and admin REST routes can target any namespace, including ones that
 * aren't the currently active corpus. Opening a fresh `new VectorStore(dir)` per request is
 * wasteful (file handle churn, SQLite cold starts) and racy under concurrent traffic. This pool:
 *
 *   - Returns the active corpus's `ragService.vectorStore` for the active namespace (no caching;
 *     RAGService owns its lifecycle).
 *   - For any other namespace, opens a `VectorStore` on first acquire and keeps it resident.
 *   - Reference-counts concurrent acquires so two parallel requests for the same namespace share
 *     one connection (better-sqlite3 is synchronous; sharing avoids duplicate handles).
 *   - When refCount drops to zero, schedules a timeout-based close. Re-acquire before the
 *     timeout cancels the pending close and reuses the in-memory handle.
 *   - On `dispose()` (e.g. namespace switch tears down the parent RAGService), closes everything.
 */

const path = require('path');
const paths = require('../../paths');
const { VectorStore } = require('./vector-store');

const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000; // 5 minutes

class VectorStorePool {
  /**
   * @param {{ dataDir?: string, vectorStore?: VectorStore }} ragService
   * @param {{ idleTtlMs?: number, vectorStoreFactory?: (dir: string) => VectorStore }} [opts]
   */
  constructor(ragService, opts = {}) {
    this.ragService = ragService;
    this.idleTtlMs =
      Number.isFinite(opts.idleTtlMs) && opts.idleTtlMs > 0
        ? opts.idleTtlMs
        : DEFAULT_IDLE_TTL_MS;
    this._factory =
      typeof opts.vectorStoreFactory === 'function'
        ? opts.vectorStoreFactory
        : (dir) => new VectorStore(dir);
    /** @type {Map<string, { vs: VectorStore, refCount: number, idleTimer: any, dataDir: string }>} */
    this._entries = new Map();
    this._disposed = false;
  }

  /**
   * Update the idle TTL at runtime. Existing pending close timers continue with the value they
   * were scheduled under; the next release uses the new value.
   * @param {number} ms
   */
  setIdleTtlMs(ms) {
    if (Number.isFinite(ms) && ms > 0) {
      this.idleTtlMs = ms;
    }
  }

  /**
   * Returns true when the namespace's data dir matches the parent RAGService's active dataDir.
   * The active corpus is owned by RAGService and must not be cached or closed by the pool.
   * @param {string} namespace
   */
  _isPrimary(namespace) {
    if (!this.ragService || !this.ragService.dataDir) return false;
    let target;
    try {
      target = path.resolve(paths.getDataDirForNamespace(namespace));
    } catch {
      return false;
    }
    const primary = path.resolve(this.ragService.dataDir);
    return target === primary;
  }

  /**
   * Acquire a VectorStore for `namespace`. The returned handle stays valid until `release()` is
   * called. Pair every acquire with exactly one release (use try/finally).
   *
   * @param {string} namespace
   * @returns {{ vs: VectorStore, release: () => void, primary: boolean }}
   */
  acquire(namespace) {
    if (this._disposed) {
      throw new Error('VectorStorePool is disposed');
    }
    const ns = String(namespace || '').trim();
    if (!ns) {
      throw new Error('namespace is required');
    }

    if (this._isPrimary(ns)) {
      const primaryVs = this.ragService && this.ragService.vectorStore;
      if (!primaryVs) {
        throw new Error(`Primary VectorStore not available for active namespace "${ns}"`);
      }
      return {
        vs: primaryVs,
        primary: true,
        release: () => {
          /* primary store is owned by RAGService */
        }
      };
    }

    let entry = this._entries.get(ns);
    if (!entry) {
      const dataDir = paths.getDataDirForNamespace(ns);
      const vs = this._factory(dataDir);
      entry = { vs, refCount: 0, idleTimer: null, dataDir };
      this._entries.set(ns, entry);
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.refCount += 1;

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      entry.refCount -= 1;
      if (entry.refCount > 0 || this._disposed) {
        return;
      }
      const ttl = this.idleTtlMs;
      if (!Number.isFinite(ttl) || ttl <= 0) {
        // Immediate close when TTL is non-positive (useful for tests).
        this._closeEntry(ns);
        return;
      }
      entry.idleTimer = setTimeout(() => {
        this._closeEntry(ns);
      }, ttl);
      // Keep the event loop free; an idle pooled handle should not delay app shutdown.
      if (entry.idleTimer && typeof entry.idleTimer.unref === 'function') {
        entry.idleTimer.unref();
      }
    };
    return { vs: entry.vs, release, primary: false };
  }

  /**
   * Synchronously close + remove a pooled entry, but only if it's currently idle. A re-acquire
   * after the timer fires (race) would leave refCount > 0; in that case the close is skipped.
   * @param {string} namespace
   */
  _closeEntry(namespace) {
    const entry = this._entries.get(namespace);
    if (!entry) return;
    if (entry.refCount > 0) {
      // Re-acquired between timer schedule and fire: leave it open.
      return;
    }
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    try {
      entry.vs.close();
    } catch (e) {
      console.error(`[VectorStorePool] Error closing namespace "${namespace}":`, e);
    }
    this._entries.delete(namespace);
  }

  /**
   * Force-close a single namespace entry now (used by tests; production code typically waits for
   * the idle timer).
   * @param {string} namespace
   */
  closeNow(namespace) {
    const ns = String(namespace || '').trim();
    if (!ns) return;
    const entry = this._entries.get(ns);
    if (!entry) return;
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    if (entry.refCount > 0) {
      // Caller still holds a reference; record close-on-release by zeroing refCount via the next
      // release path. We can't safely close while in use.
      return;
    }
    try {
      entry.vs.close();
    } catch (e) {
      console.error(`[VectorStorePool] Error closing namespace "${ns}":`, e);
    }
    this._entries.delete(ns);
  }

  /**
   * Diagnostic snapshot of currently-pooled namespaces and their refcounts. Does not include the
   * active corpus (which is owned by RAGService).
   */
  getStats() {
    const out = [];
    for (const [ns, entry] of this._entries.entries()) {
      out.push({
        namespace: ns,
        refCount: entry.refCount,
        hasIdleTimer: entry.idleTimer !== null,
        dataDir: entry.dataDir
      });
    }
    return {
      idleTtlMs: this.idleTtlMs,
      poolSize: this._entries.size,
      entries: out
    };
  }

  has(namespace) {
    return this._entries.has(String(namespace || '').trim());
  }

  get size() {
    return this._entries.size;
  }

  /**
   * Close every pooled handle and prevent further acquires. Safe to call multiple times.
   */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    for (const [ns, entry] of this._entries.entries()) {
      if (entry.idleTimer) {
        clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
      }
      try {
        entry.vs.close();
      } catch (e) {
        console.error(`[VectorStorePool] dispose close error for "${ns}":`, e);
      }
    }
    this._entries.clear();
  }
}

module.exports = { VectorStorePool, DEFAULT_IDLE_TTL_MS };

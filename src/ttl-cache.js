/**
 * Small TTL cache with a bounded entry count.
 *
 * Both caches in this addon are keyed by unbounded input — every title ever
 * requested, every host ever seen — so an entry limit matters as much as the TTL.
 * Map iterates in insertion order and set() re-inserts, which makes the front of
 * the map the least recently written and gives a usable eviction order.
 */
// How long the expiry sweep may be skipped for. The sweep walks every entry, and
// on a cache written to per proxy hop that is a full scan on a hot path; expired
// entries are already dropped lazily by get(), so this only governs the memory held
// by entries nothing reads again. The size cap is enforced on every write
// regardless, so the bound the cache promises never depends on this.
const SWEEP_INTERVAL_MS = 30 * 1000;

function createTtlCache({ maxEntries = 500 } = {}) {
  const entries = new Map();
  let lastSweptAt = 0;

  function sweepExpired(now) {
    lastSweptAt = now;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function enforceMaxEntries() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  }

  /** Explicit request: always sweeps. */
  function prune() {
    sweepExpired(Date.now());
    enforceMaxEntries();
  }

  /** Automatic, on write: sweeps only when due, or when the cap forces it. */
  function pruneOnWrite() {
    const now = Date.now();

    // Sweeping when full is what makes room before anything unexpired is evicted.
    if (entries.size > maxEntries || now - lastSweptAt >= SWEEP_INTERVAL_MS) {
      sweepExpired(now);
    }

    enforceMaxEntries();
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;

      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }

      return entry.value;
    },

    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      pruneOnWrite();
      return value;
    },

    delete(key) {
      return entries.delete(key);
    },

    get size() {
      return entries.size;
    },

    prune,

    clear() {
      entries.clear();
    }
  };
}

module.exports = { createTtlCache };

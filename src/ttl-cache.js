/**
 * Small TTL cache with a bounded entry count.
 *
 * Both caches in this addon are keyed by unbounded input — every title ever
 * requested, every host ever seen — so an entry limit matters as much as the TTL.
 * Map iterates in insertion order and set() re-inserts, which makes the front of
 * the map the least recently written and gives a usable eviction order.
 */
function createTtlCache({ maxEntries = 500 } = {}) {
  const entries = new Map();

  function prune() {
    const now = Date.now();

    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }

    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
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
      prune();
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

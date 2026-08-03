/**
 * TorBox's instant-availability check: https://api.torbox.app/v1/api/torrents/checkcached
 * Confirmed reachable and working from this environment (unlike
 * torrentio.strem.fun, which Cloudflare blocks here) - it answers with a
 * structured JSON error for a bad/expired key rather than a challenge page,
 * which is how the configured key was confirmed to fail authentication.
 */

const TORBOX_CHECK_TIMEOUT_MS = 8000;
const TORBOX_BATCH_SIZE = 100;

async function checkBatch(hashes, apiKey) {
  const url = `https://api.torbox.app/v1/api/torrents/checkcached?hash=${hashes.join(',')}&format=list`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TORBOX_CHECK_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: controller.signal
    });
    const json = await res.json().catch(() => null);

    if (!res.ok || !json || json.success === false) {
      console.warn(`TorBox: cache check failed (HTTP ${res.status}): ${json?.detail || json?.error || 'unknown error'}`);
      return [];
    }

    const entries = Array.isArray(json.data) ? json.data : Object.values(json.data || {});
    return entries
      .map((entry) => (typeof entry === 'string' ? entry : entry?.hash || entry?.info_hash))
      .filter(Boolean)
      .map((hash) => hash.toLowerCase());
  } catch (error) {
    console.warn(`TorBox: cache check request failed: ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {string[]} hashes info hashes to check
 * @param {string} apiKey TorBox API key
 * @returns {Promise<Set<string>>} the subset of `hashes` (lowercased) that are cached
 */
async function checkTorboxCached(hashes, apiKey) {
  const unique = [...new Set(hashes.filter(Boolean).map((h) => h.toLowerCase()))];
  if (unique.length === 0 || !apiKey) return new Set();

  const cached = new Set();
  for (let i = 0; i < unique.length; i += TORBOX_BATCH_SIZE) {
    const batch = unique.slice(i, i + TORBOX_BATCH_SIZE);
    const cachedInBatch = await checkBatch(batch, apiKey);
    cachedInBatch.forEach((hash) => cached.add(hash));
  }
  return cached;
}

module.exports = { checkTorboxCached };

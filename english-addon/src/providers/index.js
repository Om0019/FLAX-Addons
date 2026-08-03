/**
 * Registry over the vendored Nuvio providers in ../../providers/.
 *
 * Those files are unmodified local-scraper plugins from the All-in-One-Nuvio
 * repo (https://github.com/D3adlyRocket/All-in-One-Nuvio) — obfuscated, but
 * still plain CommonJS modules exporting `getStreams(tmdbId, mediaType,
 * seasonNum, episodeNum)`. Nuvio's own sandbox is what's restricted (no
 * Node built-ins, no async/await); this addon runs them in ordinary Node, so
 * they work as-is with no rewriting.
 */

const path = require('path');
const { configureTorrentioSettings } = require('../torrentio-settings');

configureTorrentioSettings();

const PROVIDER_TIMEOUT_MS = 15000;

// vixsrc.js was deliberately left out: a 1.1MB bundle pulling in sqlite/
// worker_threads/http2, ~16s per call in testing, and returned nothing.
const PROVIDERS = [
  { id: 'vidsrc', name: 'VidSrc', file: 'vidsrc.js' },
  { id: 'vidfast', name: 'VidFast', file: 'vidfast.js' },
  { id: 'vidlink', name: 'VidLink', file: 'vidlink.js' },
  { id: 'videasy', name: 'VidEasy', file: 'videasy.js' },
  { id: 'allwish', name: 'All-Wish', file: 'allwish.js' },
  { id: 'castle', name: 'Castle', file: 'castle.js' },
  { id: 'netmirror', name: 'NetMirror', file: 'netmirror.js' },
  { id: '4khdhubnew', name: '4KHDHub', file: '4khdhubnew.js' },
  { id: 'hdhub4u', name: 'HDHub4u', file: 'hdhub4u.js' },
  { id: 'uhdmovies', name: 'UHDMovies', file: 'uhdmovies.js' },
  // Needs a debrid API key configured before it returns anything; see
  // README.md. Left enabled so it's a no-op (empty result, not an error)
  // until that's wired up.
  { id: 'torrentio', name: 'Torrentio', file: 'torrentio.js' }
];

const loaded = PROVIDERS.map((entry) => {
  try {
    const module = require(path.join(__dirname, '..', '..', 'providers', entry.file));
    return { ...entry, module };
  } catch (error) {
    console.error(`Provider registry: failed to load ${entry.id}:`, error.message);
    return null;
  }
}).filter(Boolean);

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

/**
 * Calls every loaded provider's getStreams in parallel, tolerating
 * individual failures/timeouts, and returns { providerId, providerName,
 * streams }[] for whichever came back with results.
 */
async function fetchAllStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  const attempts = loaded.map(async (provider) => {
    try {
      const streams = await withTimeout(
        Promise.resolve(provider.module.getStreams(tmdbId, mediaType, seasonNum, episodeNum)),
        PROVIDER_TIMEOUT_MS,
        provider.id
      );
      return { providerId: provider.id, providerName: provider.name, streams: Array.isArray(streams) ? streams : [] };
    } catch (error) {
      console.warn(`Provider ${provider.id} failed:`, error.message);
      return { providerId: provider.id, providerName: provider.name, streams: [] };
    }
  });

  return Promise.all(attempts);
}

module.exports = { PROVIDERS, fetchAllStreams };

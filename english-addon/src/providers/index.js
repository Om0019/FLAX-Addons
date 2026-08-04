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
const { checkTorboxCached } = require('../torbox-cache');
const { createTtlCache } = require('../../src/ttl-cache');

configureTorrentioSettings();

const PROVIDER_TIMEOUT_MS = 15000;
const TORRENTIO_RESULT_CACHE_TTL_MS = 10 * 60 * 1000;
const TORRENTIO_RESULT_CACHE_MAX_ENTRIES = 500;

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

// The vendored Torrentio adapter reformats its response and drops the upstream
// `TB+` marker. Capture that marker while its request is in flight so the
// result can still be filtered as an actual TorBox cache hit. This must be
// serialized because the adapter reads the global fetch function.
let torrentioRequestQueue = Promise.resolve();
const torrentioResultCache = createTtlCache({ maxEntries: TORRENTIO_RESULT_CACHE_MAX_ENTRIES });

function isTorrentioCachedLabel(name) {
  return /(?:^|[^A-Z0-9])TB\+(?:$|[^A-Z0-9])/i.test(name || '');
}

function queueTorrentioRequest(task) {
  const result = torrentioRequestQueue.then(task, task);
  torrentioRequestQueue = result.catch(() => {});
  return result;
}

function torrentioCacheKey(tmdbId, mediaType, seasonNum, episodeNum) {
  return [tmdbId, mediaType, seasonNum || '', episodeNum || ''].join(':');
}

function getCachedTorrentioStreams(key) {
  const cached = torrentioResultCache.get(key);
  return cached ? cached.map((stream) => ({ ...stream })) : null;
}

async function fetchTorrentioStreams(provider, tmdbId, mediaType, seasonNum, episodeNum, { diagnostics = false } = {}) {
  return queueTorrentioRequest(async () => {
    const originalFetch = global.fetch;
    let cacheStates = [];
    const cacheKey = torrentioCacheKey(tmdbId, mediaType, seasonNum, episodeNum);
    const upstream = {
      httpStatus: null,
      streamCount: null,
      cachedLabelCount: null
    };

    global.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const url = String(args[0]);
      if (url.includes('torrentio.strem.fun/') && url.includes('/stream/')) {
        upstream.httpStatus = response.status;
        const payload = await response.clone().json().catch(() => null);
        const upstreamStreams = Array.isArray(payload?.streams) ? payload.streams : [];
        upstream.streamCount = payload ? upstreamStreams.length : null;
        upstream.cachedLabelCount = upstreamStreams.filter((stream) => isTorrentioCachedLabel(stream.name)).length;
        cacheStates = upstreamStreams.slice(0, 15).map((stream) => isTorrentioCachedLabel(stream.name));
      }
      return response;
    };

    try {
      const streams = await withTimeout(
        Promise.resolve(provider.module.getStreams(tmdbId, mediaType, seasonNum, episodeNum)),
        PROVIDER_TIMEOUT_MS,
        provider.id
      );
      const decorated = (Array.isArray(streams) ? streams : []).map((stream, index) => ({
        ...stream,
        __torrentioCached: cacheStates[index] === true
      }));
      if (decorated.length > 0) {
        torrentioResultCache.set(
          cacheKey,
          decorated.map((stream) => ({ ...stream })),
          TORRENTIO_RESULT_CACHE_TTL_MS
        );
      }
      return diagnostics ? { streams: decorated, upstream } : decorated;
    } catch (error) {
      const cached = getCachedTorrentioStreams(cacheKey);
      if (!cached) throw error;

      console.warn(`Torrentio: request failed (${error.message}); serving ${cached.length} cached result(s).`);
      return diagnostics
        ? { streams: cached, upstream: { ...upstream, servedFromCache: true } }
        : cached;
    } finally {
      global.fetch = originalFetch;
    }
  });
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

/**
 * A torrent that isn't cached on the configured debrid service means
 * playback would have to wait for it to download first, so uncached results
 * are dropped rather than shown - this is the only provider here where that
 * concept applies, since every other source hands back a direct link that
 * either plays or doesn't. Only TorBox is wired up for the cache check right
 * now (see ../torbox-cache.js): if a different debrid provider is
 * configured, or the check itself fails, everything is dropped rather than
 * risk showing something unplayable. Torrentio labels instant TorBox cache
 * hits `TB+`; plain `TB` entries would first need TorBox to download them.
 * The marker is captured before the vendored adapter reformats the response.
 */
async function filterCachedTorrentioStreams(streams) {
  const settings = global.SCRAPER_SETTINGS || {};
  if (settings.debridProvider !== 'torbox' || !settings.debridKey) {
    console.warn('Torrentio: no TorBox key configured; cannot verify cache status, dropping all results.');
    return [];
  }

  const hashes = streams.map((stream) => stream.infoHash).filter(Boolean);
  const cachedHashes = await checkTorboxCached(hashes, settings.debridKey);
  return streams
    .filter((stream) => (
      (stream.infoHash && cachedHashes.has(stream.infoHash.toLowerCase())) ||
      stream.__torrentioCached === true
    ))
    .map((stream) => ({ ...stream, __cached: true }));
}

function torrentioResolutionTier(stream) {
  const value = `${stream.quality || ''} ${stream.title || ''} ${stream.name || ''}`.toLowerCase();
  if (/\b(2160p|2160|4k)\b/.test(value)) return '2160p';
  if (/\b(1080p|1080)\b/.test(value)) return '1080p';
  if (/\b(720p|720)\b/.test(value)) return '720p';
  return 'other';
}

// Intentionally exposes counts only: no source URLs, raw titles, hashes, or
// debrid credentials. It shares the normal Torrentio request path so its
// measurements reflect the same upstream response and cache filtering.
async function diagnoseTorrentio(tmdbId, mediaType, seasonNum, episodeNum) {
  const provider = loaded.find((entry) => entry.id === 'torrentio');
  const startedAt = Date.now();
  const settings = global.SCRAPER_SETTINGS || {};

  if (!provider) {
    return { loaded: false, elapsedMs: Date.now() - startedAt };
  }

  try {
    const { streams, upstream } = await fetchTorrentioStreams(
      provider, tmdbId, mediaType, seasonNum, episodeNum, { diagnostics: true }
    );
    const cachedStreams = await filterCachedTorrentioStreams(streams);
    const cachedByResolution = { '2160p': 0, '1080p': 0, '720p': 0, other: 0 };
    for (const stream of cachedStreams) {
      cachedByResolution[torrentioResolutionTier(stream)] += 1;
    }

    return {
      loaded: true,
      debridProvider: settings.debridProvider || null,
      debridKeyPresent: Boolean(settings.debridKey),
      upstream,
      adapterStreamCount: streams.length,
      cachedStreamCount: cachedStreams.length,
      cachedByResolution,
      selectedTiers: {
        '2160p': cachedByResolution['2160p'] > 0,
        '1080p': cachedByResolution['1080p'] > 0
      },
      elapsedMs: Date.now() - startedAt
    };
  } catch (error) {
    console.warn('Torrentio diagnostics failed:', error.message);
    return {
      loaded: true,
      debridProvider: settings.debridProvider || null,
      debridKeyPresent: Boolean(settings.debridKey),
      error: 'torrentio_request_failed',
      elapsedMs: Date.now() - startedAt
    };
  }
}

/**
 * Calls every loaded provider's getStreams in parallel, tolerating
 * individual failures/timeouts, and returns { providerId, providerName,
 * streams }[] for whichever came back with results.
 */
async function fetchAllStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  const attempts = loaded.map(async (provider) => {
    try {
      let streams = provider.id === 'torrentio'
        ? await fetchTorrentioStreams(provider, tmdbId, mediaType, seasonNum, episodeNum)
        : await withTimeout(
          Promise.resolve(provider.module.getStreams(tmdbId, mediaType, seasonNum, episodeNum)),
          PROVIDER_TIMEOUT_MS,
          provider.id
        );
      streams = Array.isArray(streams) ? streams : [];
      if (provider.id === 'torrentio') {
        streams = await filterCachedTorrentioStreams(streams);
      }
      return { providerId: provider.id, providerName: provider.name, streams };
    } catch (error) {
      console.warn(`Provider ${provider.id} failed:`, error.message);
      return { providerId: provider.id, providerName: provider.name, streams: [] };
    }
  });

  return Promise.all(attempts);
}

module.exports = { PROVIDERS, fetchAllStreams, diagnoseTorrentio };

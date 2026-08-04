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
const fs = require('fs');
const Module = require('module');
const { configureTorrentioSettings } = require('../torrentio-settings');
const { checkTorboxCached } = require('../torbox-cache');

configureTorrentioSettings();

const PROVIDER_TIMEOUT_MS = 8000;
const TORRENTIO_TIMEOUT_MS = 6000;
// Never wait so briefly that a healthy provider cannot finish; below this the
// caller is better served by whatever has already arrived.
const MIN_PROVIDER_TIMEOUT_MS = 1500;
const TORRENTIO_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Stremio English Addon)',
  Accept: 'application/json'
};

// vixsrc.js was deliberately left out: a 1.1MB bundle pulling in sqlite/
// worker_threads/http2, ~16s per call in testing, and returned nothing.
//
// Three more have been removed since, each for a reason established by
// fetching what they hand back rather than by whether they return something:
//
//   vidlink  - its API marks every quality `"requiresProxy": true`, and hands
//              out the raw bcdn*.hakunaymatata.com URL anyway, which the CDN
//              refuses (426, HTML body) regardless of headers. vidlink's
//              player bundle builds the real proxied URL as
//                {proxy}/mp{path}?{sign,t}&headers={json}&host={origin}
//              keeping only auth/expires/hash/key/sign/t/token from the
//              original query (chunk 3922, module 5196). Reproducing that
//              exactly does get further - past Cloudflare and into the
//              proxy's own handler - but it still answers 427/428, so there
//              is a further gate (session, cookie or IP reputation) this
//              addon cannot satisfy.
//   vidfast  - aborts every call at "Incomplete decryption config"; 0 streams
//              on 4/4 titles tested. Its key material is stale, not its luck.
//   vidsrc   - resolves its RCP server and then scrapes 0 streams; likewise
//              0 on 4/4 titles.
//
// netmirror had the same shape of bug - its net27.cc path also says
// `"mode":"proxy"`/`"direct":false` and points at the same refused CDN - but
// it turned out fixable: providers/netmirror.js is no longer the
// All-in-One-Nuvio original. It's a newer build (from yoruix/nuvio-providers)
// that drops the net27.cc attempt and goes straight to a working fallback
// path already present, but unreachable, in the original file. See that
// file's docblock for how it was verified.
const PROVIDERS = [
  { id: 'videasy', name: 'VidEasy', file: 'videasy.js' },
  { id: 'peachify', name: 'Peachify', file: 'peachify.js' },
  { id: 'streamflix', name: 'StreamFlix', file: 'streamflix.js' },
  { id: 'allwish', name: 'All-Wish', file: 'allwish.js' },
  { id: 'castle', name: 'Castle', file: 'castle.js' },
  { id: 'netmirror', name: 'NetMirror', file: 'netmirror.js' },
  { id: '4khdhubnew', name: '4KHDHub', file: '4khdhubnew.js' },
  { id: 'hdhub4u', name: 'HDHub4u', file: 'hdhub4u.js' },
  { id: 'uhdmovies', name: 'UHDMovies', file: 'uhdmovies.js' },
  { id: 'torrentio', name: 'Torrentio', file: 'torrentio.js' }
];

const PATCHED_PROVIDERS = ['hdhub4u', 'castle', 'peachify'];

function loadPatchedProvider(entry, file) {
  let source = fs.readFileSync(file, 'utf8');

  if (entry.id === 'peachify') {
    // Peachify queries five servers and waits for all of them, with a 15s
    // per-server timeout (TIMEOUT=0x3a98). Two of the five hang to that
    // timeout on every call, so the whole provider always took 15s - and
    // PROVIDER_TIMEOUT_MS killed it at 8 every single time. It was ranked
    // second and had contributed nothing, ever, including on titles where it
    // does have streams.
    //
    // The three servers that answer do so in about a second. Cutting the
    // per-server timeout to 6s lets their results through inside our own
    // deadline: measured 15.0s -> 6.2s, and 0 streams -> 3 (Inception) and 5
    // (Dune: Part Two) on titles that previously always returned nothing.
    const before = source;
    source = source.replace('TIMEOUT=0x3a98', 'TIMEOUT=0x1770');
    if (source === before) {
      console.warn('Provider registry: peachify timeout constant not found; leaving it at its 15s default.');
    }
  }

  if (entry.id === 'hdhub4u') {
    // Its original 0.3 score accepts partial matches such as "P.S. I Love
    // You" for "I Love You Phillip Morris". This is the source selector,
    // before it opens any download pages or emits streams.
    //
    // The vendored scorer (findBestTitleMatch) is Jaccard token overlap
    // (intersection/union). Real hdhub4u titles carry release cruft — "Fight
    // Club (1999) BluRay [Hindi (ORG 2.0) & English] 1080p 720p & 480p
    // [x264/10Bit-HEVC] | Full Movie" — which deflates the ratio, so even an
    // exact title scores below the scorer's own 0.3 gate. In practice the
    // correct row is only ever selected by the `|| results[0]` first-result
    // fallback that follows. That fallback is exactly what accepts wrong
    // partial matches ("P.S. I Love You" for "I Love You Phillip Morris").
    //
    // So: keep the fallback (removing it dropped every legitimate movie —
    // Fight Club returned zero), but gate it on token coverage — accept the
    // first result only when it actually covers the query's significant title
    // tokens. Coverage survives release cruft where Jaccard does not.
    const coverageHelper = `function __englishHdhubCovers(candidate, target) {
      const tokens = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1 && !['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to'].includes(token));
      const wanted = [...new Set(tokens(target))];
      if (wanted.length === 0) return false;
      const found = new Set(tokens(candidate));
      return wanted.filter((token) => found.has(token)).length >= Math.ceil(wanted.length * 0.75);
    }\n`;
    source = source.replace('function calculateTitleSimilarity', `${coverageHelper}function calculateTitleSimilarity`);
    // _0x2fa81d is the query object (.title/.year); _0x424e15 the search
    // results; _0x250433 the scorer's pick (usually null here).
    source = source.replace(
      '_0x8b1a29=_0x250433||_0x424e15[0x0]',
      "_0x8b1a29=_0x250433||(_0x424e15[0x0]&&__englishHdhubCovers(_0x424e15[0x0]['title'],_0x2fa81d['title'])?_0x424e15[0x0]:null)"
    );
    // A failed selector must not silently become the first search result.
    source = source.replace(
      '_0x8b1a29=_0x250433||(_0x424e15[0x0]&&__englishHdhubCovers(_0x424e15[0x0][\'title\'],_0x2fa81d[\'title\'])?_0x424e15[0x0]:null);console',
      '_0x8b1a29=_0x250433||(_0x424e15[0x0]&&__englishHdhubCovers(_0x424e15[0x0][\'title\'],_0x2fa81d[\'title\'])?_0x424e15[0x0]:null);if(!_0x8b1a29)return[];console'
    );
  }

  if (entry.id === 'castle') {
    const helper = `function __englishStrictTitleMatch(candidate, target) {
      const tokens = (value) => String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1 && !['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to'].includes(token));
      const wanted = [...new Set(tokens(target))];
      if (wanted.length < 2) return false;
      const found = new Set(tokens(candidate));
      return wanted.filter((token) => found.has(token)).length >= Math.ceil(wanted.length * 0.75);
    }\n`;
    source = source.replace('function findCastleMovieId', `${helper}function findCastleMovieId`);
    source = source.replace(
      'if(_0x20be27[_0x1728f4(0x20b)](_0x4f2b66)||_0x4f2b66[_0x1728f4(0x20b)](_0x20be27)){',
      'if(__englishStrictTitleMatch(_0x20be27,_0x4f2b66)){'
    );
    // No exact match must be an empty result, not the first search row.
    source = source.replace(
      /const _0x4d2a6e=_0x8a8050\[0x0\],[\s\S]*?throw new Error\(_0x1728f4\(0x24a\)\);/,
      "throw new Error('No strict Castle title match');"
    );
  }

  const patched = new Module(file, module);
  patched.filename = file;
  patched.paths = Module._nodeModulePaths(path.dirname(file));
  patched._compile(source, file);
  return patched.exports;
}

const loaded = PROVIDERS.map((entry) => {
  try {
    const file = path.join(__dirname, '..', '..', 'providers', entry.file);
    const module = PATCHED_PROVIDERS.includes(entry.id)
      ? loadPatchedProvider(entry, file)
      : require(file);
    return { ...entry, module };
  } catch (error) {
    console.error(`Provider registry: failed to load ${entry.id}:`, error.message);
    return null;
  }
}).filter(Boolean);

function isTorrentioCachedLabel(name) {
  return /(?:^|[^A-Z0-9])TB\+(?:$|[^A-Z0-9])/i.test(name || '');
}

// The old vendored adapter first did another TMDB lookup and temporarily
// replaced global.fetch, forcing every cold English lookup through one queue.
// We already have the IMDb id at the HTTP boundary, so call Torrentio directly:
// one request, no global state, no queue, and a real abortable deadline.
async function fetchTorrentioStreams(imdbId, mediaType, seasonNum, episodeNum, { diagnostics = false, timeoutMs = TORRENTIO_TIMEOUT_MS } = {}) {
  const settings = global.SCRAPER_SETTINGS || {};
  if (!settings.debridProvider || !settings.debridKey) {
    throw new Error('Torrentio debrid settings are unavailable');
  }
  // Checked before the request, not after it. filterCachedTorrentioStreams drops
  // everything when the provider is not TorBox — that is the only cache check
  // wired up — so on any other provider this spent a full round trip, up to the
  // 6s deadline, to produce a list it was always going to discard.
  if (settings.debridProvider !== 'torbox') {
    throw new Error(`Torrentio cache status cannot be verified for debrid provider "${settings.debridProvider}"`);
  }

  const contentId = mediaType === 'tv'
    ? `series/${imdbId}:${seasonNum}:${episodeNum}`
    : `movie/${imdbId}`;
  const debrid = `${encodeURIComponent(settings.debridProvider)}=${encodeURIComponent(settings.debridKey)}`;
  const url = `https://torrentio.strem.fun/${debrid}/stream/${contentId}.json`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const upstream = { httpStatus: null, streamCount: null, cachedLabelCount: null };

  try {
    const response = await fetch(url, { headers: TORRENTIO_HEADERS, signal: controller.signal });
    upstream.httpStatus = response.status;
    const payload = await response.json().catch(() => null);
    const upstreamStreams = Array.isArray(payload?.streams) ? payload.streams : [];
    upstream.streamCount = payload ? upstreamStreams.length : null;
    upstream.cachedLabelCount = upstreamStreams.filter((stream) => isTorrentioCachedLabel(stream.name)).length;
    const streams = upstreamStreams.slice(0, 15).map((stream) => ({
      name: stream.name || 'Torrentio',
      title: stream.title || stream.name || 'Torrentio',
      url: stream.url,
      infoHash: stream.infoHash,
      __torrentioCached: isTorrentioCachedLabel(stream.name)
    })).filter((stream) => Boolean(stream.url));
    return diagnostics ? { streams, upstream } : streams;
  } catch (error) {
    if (error.name === 'AbortError') throw new Error(`Torrentio timed out after ${timeoutMs}ms`);
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Bounds how long the caller waits. The vendored providers take no abort signal,
 * so the work itself cannot be cancelled — but the timer must still be cleared,
 * or every provider that answers quickly leaves a rejection armed for the full
 * deadline, twelve of them per request, holding the event loop open long after
 * the response went out.
 */
function withTimeout(promise, ms, label) {
  let timeoutId;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]).finally(() => clearTimeout(timeoutId));
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
async function diagnoseTorrentio(imdbId, mediaType, seasonNum, episodeNum) {
  const startedAt = Date.now();
  const settings = global.SCRAPER_SETTINGS || {};

  // Deliberately does not gate on the vendored providers/torrentio.js being
  // loadable. Torrentio is fetched directly by fetchTorrentioStreams and that
  // module is not on the path at all, so a failure to load it made diagnostics
  // report the source as unavailable while it was in fact working normally —
  // the one answer a diagnostic route must never give wrongly.
  try {
    const { streams, upstream } = await fetchTorrentioStreams(imdbId, mediaType, seasonNum, episodeNum, { diagnostics: true });
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
async function fetchAllStreams(tmdbId, imdbId, mediaType, seasonNum, episodeNum, { timeoutMs } = {}) {
  // The caller owns the request budget and tells us what is left of it. Without
  // this the provider deadline was a fixed 8s that knew nothing about the time
  // TMDB had already spent, so a slow lookup pushed the whole response past the
  // point where probing could run and unverified links went out.
  const deadline = Math.max(
    MIN_PROVIDER_TIMEOUT_MS,
    Math.min(PROVIDER_TIMEOUT_MS, timeoutMs ?? PROVIDER_TIMEOUT_MS)
  );

  const attempts = loaded.map(async (provider) => {
    try {
      let streams = provider.id === 'torrentio'
        ? await fetchTorrentioStreams(imdbId, mediaType, seasonNum, episodeNum, {
          timeoutMs: Math.min(TORRENTIO_TIMEOUT_MS, deadline)
        })
        : await withTimeout(
          Promise.resolve(provider.module.getStreams(tmdbId, mediaType, seasonNum, episodeNum)),
          deadline,
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

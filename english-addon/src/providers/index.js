/**
 * Registry over the vendored Nuvio providers in ../../providers/, plus
 * AIOStreams (src/providers/aiostreams.js), which is fetched directly by
 * IMDb id rather than loaded as a vendored file.
 *
 * The vendored files are unmodified local-scraper plugins from the All-in-One-Nuvio
 * repo (https://github.com/D3adlyRocket/All-in-One-Nuvio) — obfuscated, but
 * still plain CommonJS modules exporting `getStreams(tmdbId, mediaType,
 * seasonNum, episodeNum)`. Nuvio's own sandbox is what's restricted (no
 * Node built-ins, no async/await); this addon runs them in ordinary Node, so
 * they work as-is with no rewriting.
 */

const path = require('path');
const fs = require('fs');
const Module = require('module');
const { fetchAiostreamsStreams } = require('./aiostreams');

const PROVIDER_TIMEOUT_MS = 8000;
const AIOSTREAMS_TIMEOUT_MS = 6000;
// Never wait so briefly that a healthy provider cannot finish; below this the
// caller is better served by whatever has already arrived.
const MIN_PROVIDER_TIMEOUT_MS = 1500;

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
// netmirror was dropped: providers/netmirror.js and its docblock above are
// history now, not a currently-loaded provider.
//
// torrentio was replaced by AIOStreams (see aiostreams.js): fetched directly
// below by IMDb id, not loaded from providers/*.js.
const PROVIDERS = [
  { id: 'videasy', name: 'VidEasy', file: 'videasy.js' },
  { id: 'peachify', name: 'Peachify', file: 'peachify.js' },
  { id: 'streamflix', name: 'StreamFlix', file: 'streamflix.js' },
  { id: 'allwish', name: 'All-Wish', file: 'allwish.js' },
  { id: 'castle', name: 'Castle', file: 'castle.js' },
  { id: '4khdhubnew', name: '4KHDHub', file: '4khdhubnew.js' },
  { id: 'hdhub4u', name: 'HDHub4u', file: 'hdhub4u.js' },
  { id: 'uhdmovies', name: 'UHDMovies', file: 'uhdmovies.js' }
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
 * AIOStreams needs only the IMDb id - no TMDB lookup - unlike every other
 * provider here, which is keyed on tmdbId. Exposed standalone so the caller
 * can start it the moment a request arrives instead of waiting behind TMDB,
 * which is pure dead time on AIOStreams' own budget: TMDB's own timeout is
 * up to 3s, and until it resolved, AIOStreams' clock would not even have
 * started.
 * Never throws - failures are logged and folded into an empty result, the
 * same contract fetchAllStreams gives every other provider. No HDR
 * filtering, cache-provider gating, or retry logic here: whatever the
 * AIOStreams instance returns is what's shown, curated the same as every
 * other provider (see src/curate.js).
 */
async function fetchAiostreamsProviderStreams(imdbId, mediaType, seasonNum, episodeNum, { timeoutMs = AIOSTREAMS_TIMEOUT_MS } = {}) {
  try {
    const streams = await fetchAiostreamsStreams(imdbId, mediaType, seasonNum, episodeNum, { timeoutMs });
    return { providerId: 'aiostreams', providerName: 'AIOStreams', streams };
  } catch (error) {
    console.warn('Provider aiostreams failed:', error.message);
    return { providerId: 'aiostreams', providerName: 'AIOStreams', streams: [] };
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
      const streams = await withTimeout(
        Promise.resolve(provider.module.getStreams(tmdbId, mediaType, seasonNum, episodeNum)),
        deadline,
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

module.exports = { PROVIDERS, fetchAllStreams, fetchAiostreamsProviderStreams };

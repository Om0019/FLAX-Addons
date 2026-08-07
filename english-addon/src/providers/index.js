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
// AIOStreams (see aiostreams.js) is the debrid-backed source: fetched
// directly below by IMDb id, not loaded from providers/*.js.
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

const PATCHED_PROVIDERS = ['hdhub4u', 'castle', 'peachify', 'uhdmovies'];

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
    //
    // For a TV request specifically, coverage alone isn't enough: every
    // season of a show shares the same "Breaking Bad" tokens, so a plain
    // `results[0]` fallback picks whichever season the search API ranked
    // first (observed: always the newest season) regardless of which one
    // was asked for. findBestTitleMatch's own season +0.5/-0.8 adjustment
    // can't rescue this either - these page titles carry 15-20 release-tag
    // tokens ("BluRay", "Hindi", "DD2.0", "x264", "10Bit-HEVC"...) a 2-word
    // TMDB title shares almost none of, so the base Jaccard score is deeply
    // negative and every candidate lands under the scorer's own 0.3 floor no
    // matter its season. So the TV fallback requires an explicit,
    // non-conflicting season marker in the title before accepting a page,
    // instead of defaulting to whichever one sorted first.
    const coverageHelper = `function __englishHdhubTokens(value) {
      return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((token) => token.length > 1 && !['a', 'an', 'and', 'for', 'in', 'of', 'the', 'to'].includes(token));
    }
    function __englishHdhubCovers(candidate, target) {
      const wanted = [...new Set(__englishHdhubTokens(target))];
      if (wanted.length === 0) return false;
      const found = new Set(__englishHdhubTokens(candidate));
      return wanted.filter((token) => found.has(token)).length >= Math.ceil(wanted.length * 0.75);
    }
    function __englishHdhubSelectFallback(results, target, mediaType, season) {
      if (mediaType === 'tv' && season) {
        const seasonStr = String(season);
        const seasonPatterns = ['season ' + seasonStr, 's' + seasonStr, 'season ' + seasonStr.padStart(2, '0'), 's' + seasonStr.padStart(2, '0')];
        return results.find((result) => {
          const lower = String(result.title || '').toLowerCase();
          const matchesPattern = seasonPatterns.some((pattern) => lower.includes(pattern));
          const seasonMatch = lower.match(/season\\s*(\\d+)|s(\\d+)/i);
          const noConflict = !seasonMatch || parseInt(seasonMatch[1] || seasonMatch[2], 10) === season;
          return matchesPattern && noConflict && __englishHdhubCovers(result.title, target);
        }) || null;
      }
      return results[0] && __englishHdhubCovers(results[0].title, target) ? results[0] : null;
    }\n`;
    source = source.replace('function calculateTitleSimilarity', `${coverageHelper}function calculateTitleSimilarity`);
    // _0x2fa81d is the query object (.title/.year); _0x424e15 the search
    // results; _0x250433 the scorer's pick (usually null here); _0x44e130
    // the requested mediaType; _0xe589e2 the requested season.
    source = source.replace(
      '_0x8b1a29=_0x250433||_0x424e15[0x0]',
      "_0x8b1a29=_0x250433||__englishHdhubSelectFallback(_0x424e15,_0x2fa81d['title'],_0x44e130,_0xe589e2)"
    );
    // A failed selector must not silently become the first search result.
    source = source.replace(
      "_0x8b1a29=_0x250433||__englishHdhubSelectFallback(_0x424e15,_0x2fa81d['title'],_0x44e130,_0xe589e2);console",
      "_0x8b1a29=_0x250433||__englishHdhubSelectFallback(_0x424e15,_0x2fa81d['title'],_0x44e130,_0xe589e2);if(!_0x8b1a29)return[];console"
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

  if (entry.id === 'uhdmovies') {
    // getTvEpisodeLink tracked "which season am I in" by reading only the
    // single paragraph immediately before each quality-tier's episode-links
    // block, incrementing a counter once per such block regardless of
    // whether a new season heading was actually seen. On a real UHDMovies
    // page that counter never resyncs: the "Season N" heading sits inside a
    // <pre> wrapped by a <p> that never closes before it, so the heading
    // text never ends up as the block immediately preceding a quality-tier
    // paragraph, and the counter just climbs by one per quality tier across
    // the *entire* page. A season 2 request was silently served whatever
    // quality tier the drifted counter happened to land on - almost never
    // season 2's own episodes.
    //
    // Fixed by finding every season heading's raw position up front (only
    // counting one that stands alone between two tags, ">Season N<", so
    // prose like "Breaking Bad Season 01-05" in the page title isn't read
    // as a heading) and slicing the page into per-season ranges before
    // doing the existing block-by-block episode-link scan within just the
    // requested season's slice. Verified against a real Breaking Bad
    // download page: the old code returned season 1's links (or nothing)
    // for every other season; this returns each season's own distinct set.
    const oldGetTvEpisodeLink = "function getTvEpisodeLink(_0x3a4002,_0x1df587,_0x29b6e3){var _0x274bcb={_0x498c50:0x1b3,_0x5abd35:0x205,_0x2cea05:0x1fd},_0x8bbfac={_0x374408:0x207,_0x3f7c19:0x1c8,_0x117b64:0x201,_0x33ffcb:0x1f7},_0x750392=_0x4d6001;return console['log'](_0x750392(0x1c5)+_0x1df587+'E'+_0x29b6e3+':\\x20'+_0x3a4002),fetchText(_0x3a4002)[_0x750392(0x1bd)](function(_0x2685c2){var _0x3c2482=_0x750392,_0x14ea44=[],_0x381fcd=/<(p|div)(\\s[^>]*)?>[\\s\\S]*?<\\/\\1>/gi,_0xb0db41='',_0x1be2ec=0x1,_0x1fbd0a;while((_0x1fbd0a=_0x381fcd['exec'](_0x2685c2))!==null){var _0x13bc67=_0x1fbd0a[0x0],_0x1bceda=stripTags(_0x13bc67),_0x2d1da0=/episode/i[_0x3c2482(_0x8bbfac._0x374408)](_0x13bc67)&&/<a\\b/i['test'](_0x13bc67);if(_0x2d1da0){var _0x22c7bf=_0xb0db41[_0x3c2482(0x204)](/(?:Season\\s+|S0?)(\\d+)/i);if(_0x22c7bf)_0x1be2ec=parseInt(_0x22c7bf[0x1]);if(_0x1be2ec===_0x1df587){var _0x33c14b=[],_0x18fb32=/<a\\b[^>]*href=\"([^\"]+)\"[^>]*>[\\s\\S]*?<\\/a>/gi,_0x43b038;while((_0x43b038=_0x18fb32['exec'](_0x13bc67))!==null){if(/episode/i[_0x3c2482(0x207)](_0x43b038[0x0]))_0x33c14b[_0x3c2482(_0x8bbfac._0x3f7c19)](_0x43b038[0x1]);}if(_0x29b6e3<=_0x33c14b[_0x3c2482(_0x8bbfac._0x117b64)]&&_0x29b6e3>=0x1){var _0x583457=_0x33c14b[_0x29b6e3-0x1],_0xe967d5=_0xb0db41['match'](/(\\d+(?:\\.\\d+)?\\s*(?:MB|GB))/i);_0x14ea44['push']({'sourceLink':_0x583457,'quality':buildQualityLabel(_0xb0db41),'size':_0xe967d5?_0xe967d5[0x1]:null,'details':_0xb0db41});}}_0x1be2ec++;}_0xb0db41=_0x1bceda;}return console[_0x3c2482(0x1f0)](_0x3c2482(_0x8bbfac._0x33ffcb)+_0x14ea44[_0x3c2482(0x201)]),_0x14ea44;})['catch'](function(_0x2bbfd1){var _0x1f48f5=_0x750392;return console[_0x1f48f5(_0x274bcb._0x498c50)](_0x1f48f5(_0x274bcb._0x5abd35)+_0x2bbfd1[_0x1f48f5(_0x274bcb._0x2cea05)]),[];});}";
    const newGetTvEpisodeLink = "function getTvEpisodeLink(pageUrl, season, episode) {\n  console.log('[UHDMovies] TV S' + season + 'E' + episode + ': ' + pageUrl);\n  return fetchText(pageUrl).then(function (html) {\n    var results = [];\n\n    // A \"Season N\" heading sits several paragraphs before its first quality\n    // tier's episode-links block (heading, then one <p> per quality tier,\n    // each followed by its own episode-links <p>) - looking only at the\n    // immediately preceding block misses it entirely, because the <p> that\n    // would wrap the heading doesn't close before the heading's own <pre>\n    // tag on real UHDMovies pages. Finding every heading's raw position up\n    // front and slicing the page into season ranges survives that\n    // malformed nesting. Matching only headings that stand alone between\n    // two tags (\">Season N<\") - not \"Season\\s+\\d+\" anywhere in the text -\n    // is what keeps prose like \"Breaking Bad Season 01-05\" in the page\n    // title from being read as a heading.\n    var seasonMarks = [];\n    var headingRegex = />\\s*(?:Season\\s+|S0?)(\\d+)\\s*</gi;\n    var headingMatch;\n    while ((headingMatch = headingRegex.exec(html)) !== null) {\n      seasonMarks.push({ index: headingMatch.index, season: parseInt(headingMatch[1], 10) });\n    }\n\n    var rangeStart = 0;\n    var rangeEnd = html.length;\n    var found = false;\n    for (var i = 0; i < seasonMarks.length; i++) {\n      if (seasonMarks[i].season === season) {\n        rangeStart = seasonMarks[i].index;\n        rangeEnd = i + 1 < seasonMarks.length ? seasonMarks[i + 1].index : html.length;\n        found = true;\n        break;\n      }\n    }\n    // Season headings exist on the page but not the one that was asked for.\n    if (!found && seasonMarks.length > 0) {\n      console.log('[UHDMovies] Episode links found: 0');\n      return results;\n    }\n    var segment = html.slice(rangeStart, rangeEnd);\n\n    var blockRegex = /<(p|div)(\\s[^>]*)?>[\\s\\S]*?<\\/\\1>/gi;\n    var prevText = '';\n    var match;\n    while ((match = blockRegex.exec(segment)) !== null) {\n      var block = match[0];\n      var strippedBlock = stripTags(block);\n      var isEpisodeBlock = /episode/i.test(block) && /<a\\b/i.test(block);\n      if (isEpisodeBlock) {\n        var links = [];\n        var anchorRegex = /<a\\b[^>]*href=\"([^\"]+)\"[^>]*>[\\s\\S]*?<\\/a>/gi;\n        var anchorMatch;\n        while ((anchorMatch = anchorRegex.exec(block)) !== null) {\n          if (/episode/i.test(anchorMatch[0])) links.push(anchorMatch[1]);\n        }\n        if (episode <= links.length && episode >= 1) {\n          var link = links[episode - 1];\n          var sizeMatch = prevText.match(/(\\d+(?:\\.\\d+)?\\s*(?:MB|GB))/i);\n          results.push({\n            sourceLink: link,\n            quality: buildQualityLabel(prevText),\n            size: sizeMatch ? sizeMatch[1] : null,\n            details: prevText\n          });\n        }\n      }\n      prevText = strippedBlock;\n    }\n\n    console.log('[UHDMovies] Episode links found: ' + results.length);\n    return results;\n  }).catch(function (err) {\n    console.error('[UHDMovies] getTvEpisodeLink error: ' + err.message);\n    return [];\n  });\n}\n";
    const beforePatch = source;
    source = source.replace(oldGetTvEpisodeLink, newGetTvEpisodeLink);
    if (source === beforePatch) {
      console.warn('Provider registry: uhdmovies getTvEpisodeLink not found; leaving its season-tracking bug unpatched.');
    }
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
 * AIOStreams instance returns is capped to three streams (2160p, 1080p, and
 * one lower-or-unlabeled) by curateAiostreams (see src/curate.js).
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

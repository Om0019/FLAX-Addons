/**
 * Torrentio, wrapping the vendored Nuvio provider at src/vendor/torrentio.js
 * (unmodified, from All-in-One-Nuvio) behind this addon's own scrape()
 * interface. Unlike every other scraper here it needs a TMDB id rather than
 * a title match, so the orchestrator (src/scrapers/index.js) passes one
 * through in `options.tmdbId` — it already resolves one for every request
 * anyway.
 *
 * Torrentio is constrained to Spanish-language indexers before it returns
 * results. Their labels often omit an explicit audio tag, so source selection
 * is the reliable language signal; only their already-cached `TB+` entries
 * are returned. (english-addon/ uses the same vendored file without these
 * Latino-specific constraints.)
 *
 * Cache-only filtering is intentionally not re-implemented here. Torrentio's
 * own backend already scopes by debrid config; a second local TorBox cache
 * check was redundant and could fail-closed to zero results when TorBox's
 * checkcached endpoint had auth/outage issues.
 */

const vendoredTorrentio = require('../vendor/torrentio');
const { configureTorrentioSettings } = require('../torrentio-settings');

configureTorrentioSettings();

const TORRENTIO_LANGUAGE_CONFIG = 'providers=mejortorrent,wolfmax4k,cinecalidad|language=latino,spanish';
let torrentioRequestQueue = Promise.resolve();

function queueTorrentioRequest(task) {
  const result = torrentioRequestQueue.then(task, task);
  torrentioRequestQueue = result.catch(() => {});
  return result;
}

/**
 * The vendored provider only supplies the debrid segment (for example,
 * `torbox=<key>`) to Torrentio. Add Torrentio's language-preference segment
 * before that request is made, so its results come only from Spanish-language
 * indexers. The vendored provider reads global fetch, so calls are serialized
 * while its request is temporarily rewritten.
 */
async function getSpanishPreferredStreams(tmdbId, mediaType, season, episode) {
  return queueTorrentioRequest(async () => {
    const originalFetch = global.fetch;

    global.fetch = async (input, init) => {
      const requestUrl = new URL(String(input));
      const isTorrentioStreamRequest = (
        requestUrl.host === 'torrentio.strem.fun' &&
        requestUrl.pathname.includes('/stream/')
      );
      if (
        isTorrentioStreamRequest &&
        !requestUrl.pathname.includes(`/${TORRENTIO_LANGUAGE_CONFIG}/`)
      ) {
        requestUrl.pathname = `/${TORRENTIO_LANGUAGE_CONFIG}|${requestUrl.pathname.slice(1)}`;
      }

      const response = await originalFetch(requestUrl, init);
      if (!isTorrentioStreamRequest) return response;

      const payload = await response.clone().json().catch(() => null);
      if (!Array.isArray(payload?.streams)) return response;

      payload.streams = payload.streams.filter(isCachedTorrentioStream);
      return new Response(JSON.stringify(payload), {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
      });
    };

    try {
      return await vendoredTorrentio.getStreams(tmdbId, mediaType, season, episode);
    } finally {
      global.fetch = originalFetch;
    }
  });
}

// Flags for every country whose primary/co-official language is Spanish.
// Torrentio's title field carries whatever the release scene/tracker wrote,
// and a flag emoji is the most consistent signal across trackers — a
// keyword match alone missed releases that only ever wrote a flag.
const SPANISH_FLAG_EMOJIS = [
  '🇪🇸', '🇲🇽', '🇦🇷', '🇨🇴', '🇨🇱', '🇵🇪', '🇻🇪', '🇺🇾', '🇧🇴', '🇪🇨',
  '🇵🇾', '🇨🇷', '🇵🇦', '🇩🇴', '🇬🇹', '🇭🇳', '🇳🇮', '🇸🇻', '🇵🇷', '🇬🇶'
];
const SPANISH_KEYWORD_PATTERN = /\b(spanish|espa[nñ]ol|castellano|latino|lat(?:am)?)\b/i;

function isSpanishLanguageStream(stream) {
  const text = `${stream?.title || ''} ${stream?.name || ''}`;
  if (SPANISH_FLAG_EMOJIS.some((flag) => text.includes(flag))) return true;
  return SPANISH_KEYWORD_PATTERN.test(text);
}

function isCachedTorrentioStream(stream) {
  return /(?:^|[^A-Z0-9])TB\+(?:$|[^A-Z0-9])/i.test(`${stream?.title || ''} ${stream?.name || ''}`);
}

function torrentioResolutionTier(stream) {
  const text = `${stream?.title || ''} ${stream?.name || ''}`.toLowerCase();
  if (/\b(2160p|4k)\b/.test(text)) return '2160p';
  if (/\b1080p\b/.test(text)) return '1080p';
  return null;
}

function selectTorrentioStreams(streams) {
  return ['2160p', '1080p'].flatMap((tier) => {
    const stream = streams.find((candidate) => torrentioResolutionTier(candidate) === tier);
    return stream ? [stream] : [];
  });
}

function toInternalStream(raw) {
  const headers = raw.headers && Object.keys(raw.headers).length > 0 ? raw.headers : null;
  return {
    name: 'Torrentio',
    title: raw.title || raw.name || 'Torrentio',
    url: raw.url,
    // Cached status is determined upstream by Torrentio/debrid config.
    __cached: true,
    behaviorHints: {
      notWebReady: true,
      ...(headers ? { proxyHeaders: { request: headers } } : {})
    }
  };
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { tmdbId } = options;
  if (!tmdbId) {
    console.warn('Torrentio: no TMDB id available for this request; skipping.');
    return [];
  }

  const mediaType = type === 'series' ? 'tv' : 'movie';

  try {
    const rawStreams = await getSpanishPreferredStreams(tmdbId, mediaType, season, episode);
    // getSpanishPreferredStreams has already restricted this response to
    // Spanish-source, `TB+` cached entries before the vendor reformats them.
    const spanishStreams = selectTorrentioStreams(rawStreams || []);

    console.log(`Torrentio: ${rawStreams?.length || 0} Spanish-source stream(s) total, ${spanishStreams.length} cached high-quality`);

    return spanishStreams.map(toInternalStream).filter((stream) => Boolean(stream.url));
  } catch (error) {
    console.error(`Torrentio scrape error for tmdbId ${tmdbId}:`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: { isSpanishLanguageStream, isCachedTorrentioStream, torrentioResolutionTier, selectTorrentioStreams }
};

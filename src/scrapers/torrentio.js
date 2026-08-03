/**
 * Torrentio, wrapping the vendored Nuvio provider at src/vendor/torrentio.js
 * (unmodified, from All-in-One-Nuvio) behind this addon's own scrape()
 * interface. Unlike every other scraper here it needs a TMDB id rather than
 * a title match, so the orchestrator (src/scrapers/index.js) passes one
 * through in `options.tmdbId` — it already resolves one for every request
 * anyway.
 *
 * Torrentio itself aggregates torrents in whatever language(s) the release
 * happens to carry, most of it not Spanish, so results are filtered down to
 * ones that look Spanish/Latino before being handed back — this addon is
 * Spanish-only. (english-addon/ uses the same vendored file, unfiltered.)
 */

const vendoredTorrentio = require('../vendor/torrentio');
const { configureTorrentioSettings } = require('../torrentio-settings');

configureTorrentioSettings();

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

function toInternalStream(raw) {
  const headers = raw.headers && Object.keys(raw.headers).length > 0 ? raw.headers : null;
  return {
    name: 'Torrentio',
    title: raw.title || raw.name || 'Torrentio',
    url: raw.url,
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
    const rawStreams = await vendoredTorrentio.getStreams(tmdbId, mediaType, season, episode);
    const spanishStreams = (rawStreams || []).filter(isSpanishLanguageStream);

    console.log(`Torrentio: ${rawStreams?.length || 0} stream(s) total, ${spanishStreams.length} Spanish/Latino after filtering`);

    return spanishStreams.map(toInternalStream).filter((stream) => Boolean(stream.url));
  } catch (error) {
    console.error(`Torrentio scrape error for tmdbId ${tmdbId}:`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: { isSpanishLanguageStream }
};

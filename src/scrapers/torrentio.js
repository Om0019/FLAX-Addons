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
 * Spanish-only. (english-addon/ uses the same vendored file, Spanish-
 * filtering skipped, cached-only filtering applied the same way.)
 *
 * A torrent that isn't cached on the configured debrid service means
 * playback would have to wait for it to download first, so uncached results
 * are dropped entirely rather than shown - this is the only scraper here
 * where that concept applies, since every other source hands back a direct
 * link that either plays or doesn't. Only TorBox is wired up for the cache
 * check right now (see ../torbox-cache.js): if a different debrid provider
 * is configured, or the check itself fails, everything is dropped rather
 * than risk showing something unplayable.
 */

const vendoredTorrentio = require('../vendor/torrentio');
const { configureTorrentioSettings } = require('../torrentio-settings');
const { checkTorboxCached } = require('../torbox-cache');

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
    // Every stream reaching this point already passed the cache check.
    __cached: true,
    behaviorHints: {
      notWebReady: true,
      ...(headers ? { proxyHeaders: { request: headers } } : {})
    }
  };
}

/** Drops every stream that isn't confirmed cached on the configured debrid service. */
async function filterCachedOnly(streams) {
  const settings = global.SCRAPER_SETTINGS || {};
  if (settings.debridProvider !== 'torbox' || !settings.debridKey) {
    console.warn('Torrentio: no TorBox key configured; cannot verify cache status, dropping all results.');
    return [];
  }

  const hashes = streams.map((stream) => stream.infoHash).filter(Boolean);
  const cachedHashes = await checkTorboxCached(hashes, settings.debridKey);
  return streams.filter((stream) => stream.infoHash && cachedHashes.has(stream.infoHash.toLowerCase()));
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
    const cachedSpanishStreams = await filterCachedOnly(spanishStreams);

    console.log(`Torrentio: ${rawStreams?.length || 0} stream(s) total, ${spanishStreams.length} Spanish/Latino, ${cachedSpanishStreams.length} cached`);

    return cachedSpanishStreams.map(toInternalStream).filter((stream) => Boolean(stream.url));
  } catch (error) {
    console.error(`Torrentio scrape error for tmdbId ${tmdbId}:`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: { isSpanishLanguageStream }
};

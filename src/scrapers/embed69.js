/**
 * Embed69, wrapping the vendored Nuvio provider at src/vendor/embed69.js
 * (unmodified, from KennethJYS/Nuvio-Providers-Latino) behind this addon's
 * own scrape() interface. Like Torrentio it keys off a TMDB id rather than a
 * title match — it derives the IMDb id from it and fetches
 * embed69.org/f/<imdb> — so the orchestrator (src/scrapers/index.js) passes
 * one through in `options.tmdbId`, which it already resolves for every
 * request.
 *
 * Embed69 is a Latino source: it exposes LAT (Latino) and SUB tracks and the
 * vendored provider already prefers LAT, solving a proof-of-work challenge
 * with crypto-js and resolving the underlying VidHide/StreamWish/VOE embeds
 * to direct HLS. Its raw output is `{ name, title, url, quality, headers }`;
 * this maps that onto the internal stream shape (quality is inferred by the
 * orchestrator's own claimedQuality from the title/URL, so a malformed
 * quality field from the vendor is harmless).
 */

const vendoredEmbed69 = require('../vendor/embed69');

// The vendor occasionally hands back a non-string quality (an unresolved
// Promise leaks through for one resolver), which would otherwise render as
// "[object Promise]" in the label. Keep only a clean resolution token; the
// orchestrator infers the rest from the URL.
function cleanQualityLabel(quality) {
  const value = String(quality || '').trim();
  return /^\d{3,4}p$/i.test(value) || /^(4k|2160p|1080p|720p|480p|360p)$/i.test(value) ? value : '';
}

function toInternalStream(raw) {
  if (!raw || !raw.url) return null;
  const headers = raw.headers && Object.keys(raw.headers).length > 0 ? raw.headers : null;
  const quality = cleanQualityLabel(raw.quality);
  const label = ['🇲🇽 Latino', quality, raw.servername].filter(Boolean).join(' ').trim();

  return {
    name: 'Embed69',
    title: label || raw.title || 'Embed69',
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
    console.warn('Embed69: no TMDB id available for this request; skipping.');
    return [];
  }

  const mediaType = type === 'series' ? 'tv' : 'movie';

  try {
    const rawStreams = await vendoredEmbed69.getStreams(tmdbId, mediaType, season, episode);
    return (rawStreams || []).map(toInternalStream).filter((stream) => Boolean(stream && stream.url));
  } catch (error) {
    console.error(`Embed69 scrape error for tmdbId ${tmdbId}:`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: { cleanQualityLabel, toInternalStream }
};

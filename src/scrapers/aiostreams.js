/**
 * AIOStreams, fetched directly by IMDb id against the same self-hosted
 * AIOStreams instance the english-addon uses (english-addon/src/providers/aiostreams.js) —
 * same search API, same auth, same env vars. Unlike every other scraper here,
 * which matches on title, this needs `options.imdbId`, which the orchestrator
 * (src/scrapers/index.js) already resolves for every request.
 *
 * AIOStreams itself is not Latino-specific, so its results are filtered down
 * to Latino-audio streams only before they are returned — everything else is
 * dropped here rather than left for the orchestrator's general-purpose
 * filtering, which has no notion of audio language.
 */

const AIOSTREAMS_BASE_URL = (typeof process !== "undefined" && process.env ? process.env.AIOSTREAMS_BASE_URL : undefined)
  || 'https://aiostreamsfortheweebsstable.midnightignite.me/api/v1/search';
const AIOSTREAMS_UUID = (typeof process !== "undefined" && process.env ? process.env.AIOSTREAMS_UUID : undefined) || '4b990cd7-9058-41f6-a099-224272656e63';
const AIOSTREAMS_PASSWORD = (typeof process !== "undefined" && process.env ? process.env.AIOSTREAMS_PASSWORD : undefined) || ((typeof process !== "undefined" && process.env ? process.env.AIOSTREAMS_PASSWORD : undefined));
const AIOSTREAMS_TIMEOUT_MS = 8000;

function authHeader() {
  return `Basic ${Buffer.from(`${AIOSTREAMS_UUID}:${AIOSTREAMS_PASSWORD}`).toString('base64')}`;
}

// Flags for Latin American Spanish-speaking countries only — deliberately
// excludes 🇪🇸. Release titles that carry both an audio-language tag list a
// separate "castellano" (Spain) track from "latino" ("ENG.LATINO.CASTELLANO...")
// as two distinct dubs, so castellano/español/spanish are not treated as
// synonyms for latino here: including them would pull in Spain-only audio.
const LATINO_FLAG_EMOJIS = [
  '🇲🇽', '🇦🇷', '🇨🇴', '🇨🇱', '🇵🇪', '🇻🇪', '🇺🇾', '🇧🇴', '🇪🇨',
  '🇵🇾', '🇨🇷', '🇵🇦', '🇩🇴', '🇬🇹', '🇭🇳', '🇳🇮', '🇸🇻', '🇵🇷', '🇬🇶'
];
const LATINO_KEYWORD_PATTERN = /\b(latino|lat(?:am)?)\b/i;

function isLatinoAudioStream(title) {
  const text = String(title || '');
  if (LATINO_FLAG_EMOJIS.some((flag) => text.includes(flag))) return true;
  return LATINO_KEYWORD_PATTERN.test(text);
}

function toInternalStream(result) {
  if (!result?.url) return null;
  return {
    name: result.addon || result.indexer || 'AIOStreams',
    title: result.filename || result.parsedFile?.title || 'AIOStreams',
    url: result.url,
    __cached: result.cached === true,
    behaviorHints: { notWebReady: true }
  };
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { imdbId } = options;
  if (!imdbId) {
    console.warn('AIOStreams: no IMDb id available for this request; skipping.');
    return [];
  }

  const mediaType = type === 'series' ? 'series' : 'movie';
  const id = mediaType === 'series' ? `${imdbId}:${season || 1}:${episode || 1}` : imdbId;
  const url = `${AIOSTREAMS_BASE_URL}?type=${mediaType}&id=${encodeURIComponent(id)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AIOSTREAMS_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    const results = payload?.success ? payload.data?.results : null;
    if (!Array.isArray(results)) return [];

    const latinoResults = results.filter((result) => (
      isLatinoAudioStream(result.filename || result.parsedFile?.title)
    ));

    console.log(`AIOStreams: ${results.length} stream(s) total, ${latinoResults.length} Latino-audio`);

    return latinoResults.map(toInternalStream).filter(Boolean);
  } catch (error) {
    console.error(`AIOStreams scrape error for imdbId ${imdbId}:`, error.message);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  scrape,
  __test: { isLatinoAudioStream, toInternalStream }
};

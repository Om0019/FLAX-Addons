/**
 * AIOStreams search API. GET /api/v1/search?type=movie|series&id=<imdbId[:season:episode]>,
 * authenticated with Authorization: Basic base64(uuid:password). Response shape:
 *   { success, data: { results: [{ url, filename, parsedFile: { resolution, ... }, cached, addon, ... }] } }
 *
 * Filtering (quality, HDR, cache status, etc.) is configured on the AIOStreams
 * instance itself, not here - this just forwards the request and shapes the
 * response into the { name, title, url, quality, __cached } stream objects
 * every other provider in this addon returns.
 *
 * One exception: this is the English addon, and the same AIOStreams instance
 * also backs the Latino addon (src/scrapers/aiostreams.js) at the repo root,
 * so its results are a mix of every audio language. Latino-audio results are
 * dropped here so this addon's list stays English-only; the Latino addon
 * does the mirror-image filter, keeping only Latino-audio results.
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
// synonyms for latino here: including them would exclude a stream from this
// English-only list purely for also carrying a Spain-Spanish track.
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

async function fetchAiostreamsStreams(imdbId, mediaType, seasonNum, episodeNum, { timeoutMs = AIOSTREAMS_TIMEOUT_MS } = {}) {
  const type = mediaType === 'tv' ? 'series' : 'movie';
  const id = type === 'series' ? `${imdbId}:${seasonNum || 1}:${episodeNum || 1}` : imdbId;
  const url = `${AIOSTREAMS_BASE_URL}?type=${type}&id=${encodeURIComponent(id)}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Authorization: authHeader(), Accept: 'application/json' },
      signal: controller.signal
    });
    const payload = await response.json().catch(() => null);
    const results = payload?.success ? payload.data?.results : null;
    if (!Array.isArray(results)) return [];

    return results
      .filter((result) => !isLatinoAudioStream(result.filename || result.parsedFile?.title))
      .map((result) => ({
        name: result.addon || result.indexer || 'AIOStreams',
        title: result.filename || result.parsedFile?.title || 'AIOStreams',
        url: result.url,
        quality: result.parsedFile?.resolution || null,
        size: result.size || null,
        __cached: result.cached === true
      }));
  } catch (error) {
    console.warn(`AIOStreams request failed: ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { fetchAiostreamsStreams, __test: { isLatinoAudioStream } };

/**
 * AIOStreams search API. GET /api/v1/search?type=movie|series&id=<imdbId[:season:episode]>,
 * authenticated with Authorization: Basic base64(uuid:password). Response shape:
 *   { success, data: { results: [{ url, filename, parsedFile: { resolution, ... }, cached, addon, ... }] } }
 *
 * Filtering (quality, HDR, cache status, etc.) is configured on the AIOStreams
 * instance itself, not here - this just forwards the request and shapes the
 * response into the { name, title, url, quality, __cached } stream objects
 * every other provider in this addon returns.
 */

const AIOSTREAMS_BASE_URL = process.env.AIOSTREAMS_BASE_URL
  || 'https://aiostreamsfortheweebsstable.midnightignite.me/api/v1/search';
const AIOSTREAMS_UUID = process.env.AIOSTREAMS_UUID || '4b990cd7-9058-41f6-a099-224272656e63';
const AIOSTREAMS_PASSWORD = process.env.AIOSTREAMS_PASSWORD || 'Jason001$';

const AIOSTREAMS_TIMEOUT_MS = 8000;

function authHeader() {
  return `Basic ${Buffer.from(`${AIOSTREAMS_UUID}:${AIOSTREAMS_PASSWORD}`).toString('base64')}`;
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
      .map((result) => ({
        name: result.addon || result.indexer || 'AIOStreams',
        title: result.filename || result.parsedFile?.title || 'AIOStreams',
        url: result.url,
        quality: result.parsedFile?.resolution || null,
        size: result.size || null,
        __cached: result.cached === true
      }))
      .filter((stream) => Boolean(stream.url));
  } catch (error) {
    console.warn(`AIOStreams request failed: ${error.message}`);
    return [];
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = { fetchAiostreamsStreams };

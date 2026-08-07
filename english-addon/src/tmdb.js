/**
 * Minimal TMDB lookup: Stremio identifies content by IMDb id
 * (`tt1234567`, optionally `:season:episode`), but every vendored provider
 * in providers/ expects a TMDB id per the Nuvio getStreams(tmdbId, ...)
 * contract. This resolves one to the other.
 */

const TMDB_API_KEY = ((typeof process !== "undefined" && process.env ? process.env.TMDB_API_KEY : undefined) || '');
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT_MS = 3000;

async function fetchJson(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TMDB_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { res, data };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @param {string} imdbId e.g. "tt0137523"
 * @param {'movie'|'series'} type
 * @returns {Promise<{ id: number, title: string, year: number|null } | null>}
 */
async function findByImdbId(imdbId, type) {
  const url = `${TMDB_BASE_URL}/find/${imdbId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`;
  try {
    const { res, data } = await fetchJson(url);
    if (!res.ok || !data) return null;

    if (type === 'movie') {
      const result = data.movie_results?.[0];
      if (!result) return null;
      const year = result.release_date ? new Date(result.release_date).getFullYear() : null;
      return { id: result.id, title: result.title || result.original_title, year };
    }

    const result = data.tv_results?.[0];
    if (!result) return null;
    const year = result.first_air_date ? new Date(result.first_air_date).getFullYear() : null;
    return { id: result.id, title: result.name || result.original_name, year };
  } catch (error) {
    console.error(`TMDB: find failed for ${imdbId}:`, error.message);
    return null;
  }
}

module.exports = { findByImdbId };

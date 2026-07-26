const { fetchJsonWithTimeout } = require('./http');

const TMDB_API_KEY = 'af3fa2d2239e9d0e6c04a1076d3df76f';
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT_MS = 5000;

/**
 * Helper to fetch JSON from TMDB API with optional language fallback.
 */
async function fetchFromTMDB(path, params = {}) {
  const queryParams = new URLSearchParams({
    api_key: TMDB_API_KEY,
    ...params
  });
  
  const url = `${TMDB_BASE_URL}${path}?${queryParams.toString()}`;

  // The deadline has to span the body too: TMDB returning headers and then
  // stalling would otherwise hang the whole stream request indefinitely.
  const { res, data } = await fetchJsonWithTimeout(url, {}, TMDB_TIMEOUT_MS);

  if (!res.ok) {
    throw new Error(`TMDB API Error: ${res.status} ${res.statusText} at ${path}`);
  }
  if (data === null) {
    throw new Error(`TMDB API returned an unparseable body at ${path}`);
  }
  return data;
}

/**
 * Finds a movie or series details using an IMDb ID.
 * Returns Spanish and English titles and release year.
 */
async function findByImdbId(imdbId) {
  try {
    const data = await fetchFromTMDB(`/find/${imdbId}`, {
      external_source: 'imdb_id',
      language: 'es-MX'
    });

    const movieResult = data.movie_results?.[0];
    const tvResult = data.tv_results?.[0];

    if (movieResult) {
      const year = movieResult.release_date ? new Date(movieResult.release_date).getFullYear() : null;
      return {
        id: movieResult.id,
        imdbId,
        type: 'movie',
        title: movieResult.title || movieResult.original_title,
        originalTitle: movieResult.original_title,
        year
      };
    } else if (tvResult) {
      const year = tvResult.first_air_date ? new Date(tvResult.first_air_date).getFullYear() : null;
      return {
        id: tvResult.id,
        imdbId,
        type: 'series',
        title: tvResult.name || tvResult.original_name,
        originalTitle: tvResult.original_name,
        year
      };
    }
    return null;
  } catch (error) {
    console.error(`Error finding IMDb ID ${imdbId} on TMDB:`, error.message);
    return null;
  }
}

/**
 * Fetches popular/trending content to power Stremio catalogs.
 */
async function getTrending(type, page = 1) {
  const tmdbType = type === 'series' ? 'tv' : 'movie';
  try {
    const data = await fetchFromTMDB(`/trending/${tmdbType}/week`, {
      language: 'es-MX',
      page: page.toString()
    });

    return (data.results || []).map(item => ({
      id: `tmdb:${type}:${item.id}`,
      type,
      name: item.title || item.name || item.original_title || item.original_name,
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
      description: item.overview,
      releaseInfo: (item.release_date || item.first_air_date || '').substring(0, 4)
    }));
  } catch (error) {
    console.error(`Error fetching trending ${type} from TMDB:`, error.message);
    return [];
  }
}

/**
 * Searches TMDB for catalog searches.
 */
async function searchCatalog(type, query, page = 1) {
  const tmdbType = type === 'series' ? 'tv' : 'movie';
  try {
    const data = await fetchFromTMDB(`/search/${tmdbType}`, {
      query,
      language: 'es-MX',
      page: page.toString()
    });

    return (data.results || []).map(item => ({
      id: `tmdb:${type}:${item.id}`,
      type,
      name: item.title || item.name || item.original_title || item.original_name,
      poster: item.poster_path ? `https://image.tmdb.org/t/p/w500${item.poster_path}` : null,
      background: item.backdrop_path ? `https://image.tmdb.org/t/p/original${item.backdrop_path}` : null,
      description: item.overview,
      releaseInfo: (item.release_date || item.first_air_date || '').substring(0, 4)
    }));
  } catch (error) {
    console.error(`Error searching catalog ${type} for "${query}":`, error.message);
    return [];
  }
}

/**
 * Gets detailed metadata for an item to respond to /meta.
 */
async function getMetaDetails(type, tmdbId, options = {}) {
  const tmdbType = type === 'series' ? 'tv' : 'movie';
  const { includeEpisodes = true } = options;
  try {
    const data = await fetchFromTMDB(`/${tmdbType}/${tmdbId}`, {
      language: 'es-MX',
      append_to_response: 'external_ids,credits'
    });

    const imdbId = data.external_ids?.imdb_id || null;
    const name = data.title || data.name || data.original_title || data.original_name;
    const originalTitle = data.original_title || data.original_name;
    const year = (data.release_date || data.first_air_date || '').substring(0, 4);

    const meta = {
      id: `tmdb:${type}:${tmdbId}`,
      type,
      name,
      originalTitle,
      description: data.overview || '',
      poster: data.poster_path ? `https://image.tmdb.org/t/p/w500${data.poster_path}` : null,
      background: data.backdrop_path ? `https://image.tmdb.org/t/p/original${data.backdrop_path}` : null,
      logo: null,
      imdb_id: imdbId,
      releaseInfo: year,
      genres: (data.genres || []).map(g => g.name),
      director: (data.credits?.crew || []).filter(c => c.job === 'Director').map(d => d.name),
      cast: (data.credits?.cast || []).slice(0, 5).map(c => c.name),
      runtime: data.runtime ? `${data.runtime} min` : null
    };

    if (includeEpisodes && type === 'series' && data.seasons) {
      // Add episodes structure for series
      meta.videos = [];
      for (const season of data.seasons) {
        if (season.season_number === 0) continue; // Skip specials usually
        
        try {
          const seasonData = await fetchFromTMDB(`/${tmdbType}/${tmdbId}/season/${season.season_number}`, {
            language: 'es-MX'
          });
          
          for (const ep of (seasonData.episodes || [])) {
            meta.videos.push({
              id: `tmdb:${type}:${tmdbId}:${season.season_number}:${ep.episode_number}`,
              season: season.season_number,
              episode: ep.episode_number,
              title: ep.name || `Episodio ${ep.episode_number}`,
              released: ep.air_date ? new Date(ep.air_date).toISOString() : null,
              overview: ep.overview,
              thumbnail: ep.still_path ? `https://image.tmdb.org/t/p/w300${ep.still_path}` : null
            });
          }
        } catch (e) {
          console.error(`Error fetching season ${season.season_number} details:`, e.message);
        }
      }
    }

    return meta;
  } catch (error) {
    console.error(`Error fetching meta for ${type} ${tmdbId}:`, error.message);
    return null;
  }
}

/**
 * Fetches every Spanish-dub title TMDB has on file for a movie/series,
 * across regions (e.g. "Anatomía de Grey" for ES vs "Anatomía según Grey"
 * for MX). Sites don't consistently use the same regional dub name as our
 * primary es-MX lookup, so this widens the pool of titles scrapers can
 * search for. Uses /translations rather than /alternative_titles because
 * the latter is crowd-sourced and frequently missing Spanish entries
 * entirely, while /translations reliably carries the official localized
 * name TMDB itself displays per region.
 */
async function getAlternativeTitles(type, tmdbId) {
  if (!tmdbId) return [];
  const tmdbType = type === 'series' ? 'tv' : 'movie';

  try {
    const data = await fetchFromTMDB(`/${tmdbType}/${tmdbId}/translations`);
    const entries = data.translations || [];
    const titles = new Set();

    for (const entry of entries) {
      if (entry.iso_639_1 !== 'es') continue;
      const value = (entry.data?.name || entry.data?.title || '').trim();
      if (value) titles.add(value);
    }

    return [...titles];
  } catch (error) {
    console.warn(`Error fetching alternative titles for ${tmdbType}/${tmdbId}:`, error.message);
    return [];
  }
}

module.exports = {
  findByImdbId,
  getTrending,
  searchCatalog,
  getMetaDetails,
  getAlternativeTitles
};

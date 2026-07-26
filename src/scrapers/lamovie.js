const unpacker = require('../unpacker');
const { fetchJsonWithTimeout } = require('../http');
const { cleanText, extractYear, mapWithConcurrency } = require('./common');

const BASE_URL = 'https://lamovie.org';
const API_URL = `${BASE_URL}/wp-api/v1`;
const SEARCH_TIMEOUT_MS = 8000;
const PLAYER_TIMEOUT_MS = 5500;
const EPISODES_TIMEOUT_MS = 5000;
const PLAYER_CONCURRENCY = 4;



function scoreCandidate(result, title, originalTitle, year, type, extraTitles = []) {
  if (type === 'movie' && result.type !== 'movies') return 0;
  if (type === 'series' && result.type !== 'tvshows') return 0;

  const cleanTitle = cleanText(title);
  const cleanOriginal = cleanText(originalTitle);
  const cleanExtras = extraTitles.map(cleanText).filter(Boolean);
  const cleanResult = cleanText(result.title);
  const cleanOriginalResult = cleanText(result.original_title);
  const cleanSlug = cleanText(String(result.slug || '').replace(/-/g, ' '));
  let score = 0;

  if (cleanTitle && (cleanResult.includes(cleanTitle) || cleanSlug.includes(cleanTitle))) score += 4;
  if (cleanOriginal && (cleanOriginalResult.includes(cleanOriginal) || cleanSlug.includes(cleanOriginal))) score += 4;
  if (cleanTitle && cleanResult === cleanTitle) score += 5;
  if (cleanOriginal && cleanOriginalResult === cleanOriginal) score += 5;

  for (const cleanExtra of cleanExtras) {
    if (cleanResult.includes(cleanExtra) || cleanSlug.includes(cleanExtra) || cleanOriginalResult.includes(cleanExtra)) score += 4;
    if (cleanResult === cleanExtra || cleanOriginalResult === cleanExtra) score += 5;
  }

  if (year) {
    const resultYear = extractYear(result.release_date || result.title || result.slug);
    if (resultYear && resultYear !== year) return 0;
    if (resultYear === year) score += 8;
  }

  return score;
}

async function search(title, originalTitle, year, type, userAgent, signal, extraTitles = []) {
  const queries = [...new Set([title, originalTitle, ...extraTitles].filter(Boolean))];

  for (const query of queries) {
    const url = new URL(`${API_URL}/search`);
    url.searchParams.set('postType', 'any');
    url.searchParams.set('q', query);
    url.searchParams.set('postsPerPage', '10');

    try {
      const { res, data } = await fetchJsonWithTimeout(url.toString(), {
        headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
        signal
      }, SEARCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const posts = Array.isArray(data?.data?.posts) ? data.data.posts : [];
      let bestMatch = null;
      let bestScore = 0;

      for (const post of posts) {
        const score = scoreCandidate(post, title, originalTitle, year, type, extraTitles);
        if (score > bestScore) {
          bestMatch = post;
          bestScore = score;
        }
      }

      if (bestMatch) return bestMatch;
    } catch (error) {
      console.warn(`LaMovie: Search failed for "${query}": ${error.message}`);
    }
  }

  return null;
}

async function getEpisodePostId(seriesId, season, episode, userAgent, signal) {
  if (!seriesId || !season || !episode) return null;

  const url = new URL(`${API_URL}/single/episodes/list`);
  url.searchParams.set('_id', seriesId);
  url.searchParams.set('season', season);
  url.searchParams.set('page', '1');
  url.searchParams.set('postsPerPage', '80');

  try {
    const { res, data } = await fetchJsonWithTimeout(url.toString(), {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json' },
      signal
    }, EPISODES_TIMEOUT_MS);
    if (!res.ok) return null;
    const posts = Array.isArray(data?.data?.posts) ? data.data.posts : [];
    const match = posts.find((post) => String(post.episode_number || post.episode) === String(episode));
    return match?._id || null;
  } catch (error) {
    console.warn(`LaMovie: Episode lookup failed for ${seriesId} S${season}E${episode}: ${error.message}`);
    return null;
  }
}


async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const match = await search(title, originalTitle, year, type, userAgent, signal, extraTitles);
    if (!match) {
      console.log(`LaMovie: No matching content found for "${title}"`);
      return [];
    }

    let postId = match._id;
    if (type === 'series') {
      postId = await getEpisodePostId(match._id, season, episode, userAgent, signal);
      if (!postId) {
        console.log(`LaMovie: No episode found for "${title}" S${season}E${episode}`);
        return [];
      }
    }

    const playerUrl = new URL(`${API_URL}/player`);
    playerUrl.searchParams.set('postId', postId);
    playerUrl.searchParams.set('demo', '0');

    const { res: playerRes, data: playerData } = await fetchJsonWithTimeout(playerUrl.toString(), {
      headers: { 'User-Agent': userAgent, 'Accept': 'application/json', 'Referer': BASE_URL },
      signal
    }, PLAYER_TIMEOUT_MS);
    if (!playerRes.ok) return [];
    const embeds = Array.isArray(playerData?.data?.embeds) ? playerData.data.embeds : [];
    console.log(`LaMovie: Found ${embeds.length} embeds for ${match.title}`);

    return await mapWithConcurrency(embeds, PLAYER_CONCURRENCY, async (embed, index) => {
      const embedUrl = embed.url;
      if (!embedUrl || /^magnet:/i.test(embedUrl)) return null;

      const resolvedUrl = await unpacker.resolvePlayerStream(embedUrl, userAgent, BASE_URL, { signal });
      if (!resolvedUrl) return null;

      return {
        name: 'LaMovie',
        title: `🇲🇽 ${embed.lang || 'Latino'} ${embed.quality || embed.server || `Opcion ${index + 1}`}`.trim(),
        url: resolvedUrl,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': userAgent,
              'Referer': embedUrl
            }
          }
        }
      };
    });
  } catch (error) {
    console.error(`LaMovie scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = { scrape };

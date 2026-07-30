const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, normalizeUrl } = require('../http');
const { cleanText, mapWithConcurrency, raceTitleSearches } = require('./common');

const BASE_URL = 'https://novelas360.com';
const SEARCH_TIMEOUT_MS = 5000;
const PAGE_TIMEOUT_MS = 6500;
const PLAYER_CONCURRENCY = 3;

function browserHeaders(userAgent, extra = {}) {
  return {
    'User-Agent': userAgent,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    ...extra
  };
}

function slugifyTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' y ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleHasTrailingNumber(value) {
  return /\b\d+\s*$/.test(String(value || '').trim());
}

function buildSearchTitles(title, originalTitle, season, extraTitles = []) {
  const seen = new Set();
  const candidates = [];

  function add(value) {
    const text = String(value || '').trim();
    const key = cleanText(text);
    if (!text || seen.has(key)) return;
    seen.add(key);
    candidates.push(text);
  }

  for (const value of [title, originalTitle, ...extraTitles]) {
    if (season && season > 1 && value && !titleHasTrailingNumber(value)) {
      add(`${value} ${season}`);
    }
    add(value);
  }

  return candidates;
}

function episodeNumberFromText(value) {
  const match = String(value || '').match(/cap[ií]tulo\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function titleWithoutEpisode(value) {
  return String(value || '')
    .replace(/\s+cap[ií]tulo\s*\d+[\s\S]*$/i, '')
    .trim();
}

function scoreEpisodeCandidate(result, query, originalTitle, extraTitles = []) {
  const cleanQuery = cleanText(query);
  const cleanOriginal = cleanText(originalTitle);
  const cleanResultTitle = cleanText(titleWithoutEpisode(result.title));
  const cleanSlugTitle = cleanText(titleWithoutEpisode(
    result.url.match(/\/video\/([^/?#]+)/)?.[1]?.replace(/-/g, ' ')
  ));
  const cleanExtras = extraTitles.map(cleanText).filter(Boolean);
  let score = 0;

  if (cleanQuery && cleanResultTitle === cleanQuery) score += 8;
  if (cleanQuery && cleanSlugTitle === cleanQuery) score += 8;
  if (cleanOriginal && cleanResultTitle === cleanOriginal) score += 6;
  if (cleanOriginal && cleanSlugTitle === cleanOriginal) score += 6;

  if (cleanQuery && (cleanResultTitle.includes(cleanQuery) || cleanSlugTitle.includes(cleanQuery))) score += 3;
  if (cleanOriginal && (cleanResultTitle.includes(cleanOriginal) || cleanSlugTitle.includes(cleanOriginal))) score += 2;

  for (const cleanExtra of cleanExtras) {
    if (cleanResultTitle === cleanExtra || cleanSlugTitle === cleanExtra) score += 5;
    else if (cleanResultTitle.includes(cleanExtra) || cleanSlugTitle.includes(cleanExtra)) score += 2;
  }

  return score;
}

function extractEpisodeResults(html) {
  const $ = cheerio.load(html || '');
  const results = [];
  const seen = new Set();

  $('article, .post, .video').each((_, el) => {
    const href = $(el).find('a[href*="/video/"]').first().attr('href');
    const url = normalizeUrl(href, BASE_URL);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const title = (
      $(el).find('h1,h2,h3,h4,.entry-title,.post-title').first().text()
      || $(el).find('img').attr('alt')
      || $(el).find('a[href*="/video/"]').text()
    ).trim().replace(/\s+/g, ' ');

    if (title) results.push({ url, title });
  });

  $('a[href*="/video/"]').each((_, el) => {
    const url = normalizeUrl($(el).attr('href'), BASE_URL);
    if (!url || seen.has(url)) return;

    const text = ($(el).text() || $(el).attr('title') || $(el).find('img').attr('alt') || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!text || !/cap[ií]tulo\s*\d+/i.test(`${text} ${url}`)) return;

    seen.add(url);
    results.push({ url, title: text });
  });

  return results;
}

function extractPlayerUrls(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const urls = [];
  const seen = new Set();

  function addUrl(value) {
    const url = normalizeUrl(value, pageUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  }

  $('iframe[src],embed[src],video[src],source[src]').each((_, el) => addUrl($(el).attr('src')));

  const scriptText = $('script').map((_, el) => $(el).html() || '').get().join('\n');
  const patterns = [
    /\b(?:file|src|url)\s*:\s*['"]([^'"]+)['"]/g,
    /\b(?:file|src|url)\s*=\s*['"]([^'"]+)['"]/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(scriptText)) !== null) {
      addUrl(match[1]);
    }
  }

  return urls;
}

function isPlayableCandidate(url) {
  return /novelas360\.cyou\/player\/embed_player\.php/i.test(url)
    || /\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(url);
}

async function fetchPageOk(url, userAgent, signal) {
  try {
    const { res, text } = await fetchTextWithTimeout(url, {
      headers: browserHeaders(userAgent),
      signal
    }, PAGE_TIMEOUT_MS);
    if (!res.ok || /P[aá]gina no encontrada|Esto es algo embarazoso/i.test(text)) return null;
    return text;
  } catch {
    return null;
  }
}

async function findEpisodeUrl(title, originalTitle, season, episode, userAgent, signal, extraTitles = []) {
  const queries = buildSearchTitles(title, originalTitle, season, extraTitles);

  for (const query of queries) {
    const slug = slugifyTitle(query);
    if (!slug) continue;
    const url = `${BASE_URL}/video/${slug}-capitulo-${episode}-1/`;
    const html = await fetchPageOk(url, userAgent, signal);
    if (html) return { url, html };
  }

  async function runQuery(query) {
    try {
      const searchUrl = `${BASE_URL}/?s=${encodeURIComponent(query)}`;
      const { res, text: html } = await fetchTextWithTimeout(searchUrl, {
        headers: browserHeaders(userAgent),
        signal
      }, SEARCH_TIMEOUT_MS);
      if (!res.ok) return null;

      let bestMatch = null;
      let bestScore = 0;
      for (const result of extractEpisodeResults(html)) {
        if (episodeNumberFromText(`${result.title} ${result.url}`) !== Number(episode)) continue;
        const score = scoreEpisodeCandidate(result, query, originalTitle, [title, ...extraTitles]);
        if (score > bestScore) {
          bestMatch = result;
          bestScore = score;
        }
      }

      console.log(`Novelas360 search "${query}" best episode score ${bestScore}`);
      return bestMatch?.url || null;
    } catch (error) {
      console.warn(`Novelas360: Search failed for "${query}": ${error.message}`);
      return null;
    }
  }

  const racedMatch = await raceTitleSearches(queries.slice(0, 2), runQuery);
  if (racedMatch) return { url: racedMatch, html: null };

  for (const query of queries.slice(2)) {
    const match = await runQuery(query);
    if (match) return { url: match, html: null };
  }

  return null;
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  if (type !== 'series') return [];

  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const episodeMatch = await findEpisodeUrl(title, originalTitle, season, episode, userAgent, signal, extraTitles);
    if (!episodeMatch) {
      console.log(`Novelas360: No episode found for "${title}" episode ${episode}`);
      return [];
    }

    const episodeHtml = episodeMatch.html || await fetchPageOk(episodeMatch.url, userAgent, signal);
    if (!episodeHtml) return [];

    const playerUrls = extractPlayerUrls(episodeHtml, episodeMatch.url).filter(isPlayableCandidate);
    console.log(`Novelas360: Found ${playerUrls.length} player URLs`);

    return await mapWithConcurrency(playerUrls, PLAYER_CONCURRENCY, async (playerUrl, index) => {
      try {
        const resolvedUrl = await unpacker.resolvePlayerStream(playerUrl, userAgent, episodeMatch.url, { signal });
        if (!resolvedUrl) return null;

        return {
          name: 'Novelas360',
          title: `Opcion ${index + 1}`,
          url: resolvedUrl,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'User-Agent': userAgent,
                'Referer': playerUrl
              }
            }
          }
        };
      } catch (error) {
        console.warn(`Novelas360: Player ${playerUrl} failed: ${error.message}`);
        return null;
      }
    });
  } catch (error) {
    console.error(`Novelas360 scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: {
    buildSearchTitles,
    episodeNumberFromText,
    extractEpisodeResults,
    extractPlayerUrls,
    isPlayableCandidate,
    scoreEpisodeCandidate,
    slugifyTitle,
    titleWithoutEpisode
  }
};

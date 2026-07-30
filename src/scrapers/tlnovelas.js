const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, normalizeUrl } = require('../http');
const { cleanText, mapWithConcurrency, raceTitleSearches } = require('./common');

const BASE_URL = 'https://ww2.tlnovelas.net';
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const PLAYER_CONCURRENCY = 4;

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

function scoreCandidate(result, title, originalTitle, extraTitles = []) {
  const cleanTitle = cleanText(title);
  const cleanOriginal = cleanText(originalTitle);
  const cleanExtras = extraTitles.map(cleanText).filter(Boolean);
  const cleanResult = cleanText(result.title);
  const cleanSlug = cleanText(result.url.match(/\/novela\/([^/?#]+)/)?.[1]?.replace(/-/g, ' '));
  let score = 0;

  if (cleanTitle && cleanResult === cleanTitle) score += 8;
  if (cleanTitle && cleanSlug === cleanTitle) score += 8;
  if (cleanOriginal && cleanResult === cleanOriginal) score += 6;
  if (cleanOriginal && cleanSlug === cleanOriginal) score += 6;

  if (cleanTitle && (cleanResult.includes(cleanTitle) || cleanSlug.includes(cleanTitle))) score += 3;
  if (cleanOriginal && (cleanResult.includes(cleanOriginal) || cleanSlug.includes(cleanOriginal))) score += 2;

  for (const cleanExtra of cleanExtras) {
    if (cleanResult === cleanExtra || cleanSlug === cleanExtra) score += 5;
    else if (cleanResult.includes(cleanExtra) || cleanSlug.includes(cleanExtra)) score += 2;
  }

  return score;
}

function extractSearchResults(html) {
  const $ = cheerio.load(html || '');
  const results = [];
  const seen = new Set();

  $('a[href*="/novela/"]').each((_, el) => {
    const url = normalizeUrl($(el).attr('href'), BASE_URL);
    if (!url || seen.has(url)) return;
    seen.add(url);

    const card = $(el).closest('.vk-poster,.p-content,li,.thel');
    const title = (
      card.find('.vk-info p,.p-title,.nakama').first().text()
      || $(el).attr('title')
      || $(el).find('img').attr('alt')
      || $(el).text()
    ).replace(/^(?:Ver|Capitulos de|Ver Novela|Ver capitulos de)\s+/i, '')
      .replace(/\s+Online$/i, '')
      .trim()
      .replace(/\s+/g, ' ');

    if (title) results.push({ url, title });
  });

  return results;
}

async function search(title, originalTitle, userAgent, signal, extraTitles = []) {
  const queries = [...new Set([title, originalTitle, ...extraTitles].filter(Boolean))];

  async function runQuery(query) {
    try {
      const searchUrl = `${BASE_URL}/buscar/?q=${encodeURIComponent(query)}`;
      const { res, text: html } = await fetchTextWithTimeout(searchUrl, {
        headers: browserHeaders(userAgent),
        signal
      }, SEARCH_TIMEOUT_MS);
      if (!res.ok) return null;

      let bestMatch = null;
      let bestScore = 0;
      for (const result of extractSearchResults(html)) {
        const score = scoreCandidate(result, title, originalTitle, extraTitles);
        if (score > bestScore) {
          bestMatch = result;
          bestScore = score;
        }
      }

      console.log(`TLNovelas search "${query}" best score ${bestScore}`);
      return bestMatch ? bestMatch.url : null;
    } catch (error) {
      console.warn(`TLNovelas: Search failed for "${query}": ${error.message}`);
      return null;
    }
  }

  const racedMatch = await raceTitleSearches(queries.slice(0, 2), runQuery);
  if (racedMatch) return racedMatch;

  for (const query of queries.slice(2)) {
    const match = await runQuery(query);
    if (match) return match;
  }

  for (const candidate of [title, originalTitle, ...extraTitles]) {
    const slug = slugifyTitle(candidate);
    if (!slug) continue;
    const url = `${BASE_URL}/novela/${slug}/`;
    try {
      const { res } = await fetchTextWithTimeout(url, {
        headers: browserHeaders(userAgent),
        signal
      }, SEARCH_TIMEOUT_MS);
      if (res.ok) return url;
    } catch {
      // Try the next direct slug.
    }
  }

  return null;
}

function episodeNumberFromText(value) {
  const match = String(value || '').match(/cap[ií]tulo\s*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function findEpisodeUrl(html, pageUrl, episode) {
  if (!episode) return null;
  const $ = cheerio.load(html || '');
  const candidates = [];

  $('a[href*="/ver/"]').each((_, el) => {
    const url = normalizeUrl($(el).attr('href'), pageUrl);
    const text = `${$(el).attr('title') || ''} ${$(el).text() || ''} ${url || ''}`;
    if (url && episodeNumberFromText(text) === Number(episode)) {
      candidates.push(url);
    }
  });

  return candidates[0] || null;
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
    /\be\[\d+\]\s*=\s*['"]([^'"]+)['"]/g,
    /v_ideo\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\b(?:file|src|url)\s*:\s*['"]([^'"]+)['"]/g
  ];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(scriptText)) !== null) {
      addUrl(match[1]);
    }
  }

  return urls;
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  if (type !== 'series') return [];

  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const pageUrl = await search(title, originalTitle, userAgent, signal, extraTitles);
    if (!pageUrl) {
      console.log(`TLNovelas: No matching content found for "${title}"`);
      return [];
    }

    const { res: seriesRes, text: seriesHtml } = await fetchTextWithTimeout(pageUrl, {
      headers: browserHeaders(userAgent),
      signal
    }, PAGE_TIMEOUT_MS);
    if (!seriesRes.ok) return [];

    const episodeUrl = findEpisodeUrl(seriesHtml, pageUrl, episode);
    if (!episodeUrl) {
      console.log(`TLNovelas: No episode found for "${title}" episode ${episode}`);
      return [];
    }

    const { res: episodeRes, text: episodeHtml } = await fetchTextWithTimeout(episodeUrl, {
      headers: browserHeaders(userAgent, { Referer: pageUrl }),
      signal
    }, PAGE_TIMEOUT_MS);
    if (!episodeRes.ok) return [];

    const playerUrls = extractPlayerUrls(episodeHtml, episodeUrl);
    console.log(`TLNovelas: Found ${playerUrls.length} player URLs`);

    return await mapWithConcurrency(playerUrls, PLAYER_CONCURRENCY, async (playerUrl, index) => {
      try {
        const resolvedUrl = await unpacker.resolvePlayerStream(playerUrl, userAgent, episodeUrl, { signal });
        if (!resolvedUrl) return null;

        return {
          name: 'TLNovelas',
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
        console.warn(`TLNovelas: Player ${playerUrl} failed: ${error.message}`);
        return null;
      }
    });
  } catch (error) {
    console.error(`TLNovelas scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: {
    extractPlayerUrls,
    extractSearchResults,
    findEpisodeUrl,
    scoreCandidate,
    slugifyTitle
  }
};

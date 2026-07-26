const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, fetchWithTimeout, normalizeUrl } = require('../http');

const BASE_URL = 'https://pelispedia.mov';
const SEARCH_TIMEOUT_MS = 5000;
const PAGE_TIMEOUT_MS = 5500;
const PLAYER_CONCURRENCY = 4;

function cleanText(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function slugifyTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractYear(value) {
  const match = String(value || '').match(/\b(?:19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

function scoreCandidate(result, title, originalTitle, year, extraTitles = []) {
  const cleanTitle = cleanText(title);
  const cleanOriginal = cleanText(originalTitle);
  const cleanExtras = extraTitles.map(cleanText).filter(Boolean);
  const cleanResult = cleanText(result.title);
  const cleanSlug = cleanText(result.url.split('/').pop()?.replace(/-/g, ' '));
  let score = 0;

  if (cleanTitle && (cleanResult.includes(cleanTitle) || cleanSlug.includes(cleanTitle))) score += 4;
  if (cleanOriginal && (cleanResult.includes(cleanOriginal) || cleanSlug.includes(cleanOriginal))) score += 3;
  if (cleanTitle && cleanResult === cleanTitle) score += 5;
  if (cleanOriginal && cleanSlug === cleanOriginal) score += 5;

  for (const cleanExtra of cleanExtras) {
    if (cleanResult.includes(cleanExtra) || cleanSlug.includes(cleanExtra)) score += 3;
    if (cleanResult === cleanExtra || cleanSlug === cleanExtra) score += 5;
  }

  if (year) {
    const resultYear = extractYear(`${result.title} ${result.year || ''} ${result.url}`);
    if (resultYear && resultYear !== year) return 0;
    if (resultYear === year) score += 8;
  }

  return score;
}

function buildFallbackUrls(type, title, originalTitle, year, extraTitles = []) {
  const basePath = type === 'series' ? 'serie' : 'pelicula';
  const candidates = [];
  const seen = new Set();

  for (const value of [title, originalTitle, ...extraTitles]) {
    const slug = slugifyTitle(value);
    if (!slug) continue;

    for (const candidateSlug of [slug, year ? `${slug}-${year}` : '']) {
      if (!candidateSlug || seen.has(candidateSlug)) continue;
      seen.add(candidateSlug);
      candidates.push(`${BASE_URL}/${basePath}/${candidateSlug}`);
    }
  }

  return candidates;
}

async function search(title, originalTitle, year, type, userAgent, signal, extraTitles = []) {
  const queries = [...new Set([title, originalTitle, ...extraTitles].filter(Boolean))];
  const pathNeedle = type === 'series' ? '/serie/' : '/pelicula/';

  for (const query of queries) {
    try {
      const searchUrl = `${BASE_URL}/search?s=${encodeURIComponent(query)}`;
      const { res, text: html } = await fetchTextWithTimeout(searchUrl, {
        headers: { 'User-Agent': userAgent },
        signal
      }, SEARCH_TIMEOUT_MS);
      if (!res.ok) continue;
      const $ = cheerio.load(html);
      const results = [];

      $('a[href]').each((_, el) => {
        const url = normalizeUrl($(el).attr('href'), BASE_URL);
        if (!url || !url.includes(pathNeedle)) return;
        const card = $(el).closest('.movie-card');
        const titleText = (card.find('h4,h10,h3').first().text() || $(el).text()).trim().replace(/\s+/g, ' ');
        const yearText = card.find('.year').first().text().trim();
        if (titleText) results.push({ url, title: titleText, year: yearText });
      });

      let bestMatch = null;
      let bestScore = 0;
      for (const result of results) {
        const score = scoreCandidate(result, title, originalTitle, year, extraTitles);
        if (score > bestScore) {
          bestMatch = result;
          bestScore = score;
        }
      }

      if (bestMatch) return bestMatch.url;
    } catch (error) {
      console.warn(`PelisPedia: Search failed for "${query}": ${error.message}`);
    }
  }

  for (const candidateUrl of buildFallbackUrls(type, title, originalTitle, year, extraTitles)) {
    try {
      const res = await fetchWithTimeout(candidateUrl, {
        headers: { 'User-Agent': userAgent },
        signal
      }, SEARCH_TIMEOUT_MS);
      if (res.ok) return candidateUrl;
    } catch {
      // Try the next fallback.
    }
  }

  return null;
}

function extractIframeUrls(html, pageUrl) {
  const $ = cheerio.load(html);
  const urls = [];

  $('iframe[src]').each((_, el) => {
    const url = normalizeUrl($(el).attr('src'), pageUrl);
    if (url) urls.push(url);
  });

  return [...new Set(urls)];
}

function findEpisodeUrl(html, pageUrl, season, episode) {
  if (!season || !episode) return null;
  const $ = cheerio.load(html);
  const patterns = [
    new RegExp(`(?:temporada|season)[^0-9]*${season}[^0-9]+(?:episodio|episode|capitulo|capítulo)[^0-9]*${episode}`, 'i'),
    new RegExp(`\\b${season}\\s*x\\s*${episode}\\b`, 'i'),
    new RegExp(`\\bs${season}\\s*e${episode}\\b`, 'i')
  ];

  let match = null;
  $('a[href]').each((_, el) => {
    if (match) return;
    const href = normalizeUrl($(el).attr('href'), pageUrl);
    const text = `${$(el).text()} ${href}`;
    if (href && patterns.some((pattern) => pattern.test(text))) {
      match = href;
    }
  });

  return match;
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const currentIndex = index++;
      const result = await worker(items[currentIndex], currentIndex);
      if (result) results.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext())
  );

  return results;
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const pageUrl = await search(title, originalTitle, year, type, userAgent, signal, extraTitles);
    if (!pageUrl) {
      console.log(`PelisPedia: No matching content found for "${title}"`);
      return [];
    }

    let targetUrl = pageUrl;
    let page = await fetchTextWithTimeout(targetUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, PAGE_TIMEOUT_MS);
    if (!page.res.ok) return [];

    let pageHtml = page.text;
    if (type === 'series') {
      const episodeUrl = findEpisodeUrl(pageHtml, pageUrl, season, episode);
      if (!episodeUrl) {
        console.log(`PelisPedia: No episode found for "${title}" S${season}E${episode}`);
        return [];
      }
      targetUrl = episodeUrl;
      page = await fetchTextWithTimeout(targetUrl, {
        headers: { 'User-Agent': userAgent },
        signal
      }, PAGE_TIMEOUT_MS);
      if (!page.res.ok) return [];
      pageHtml = page.text;
    }

    const iframeUrls = extractIframeUrls(pageHtml, targetUrl);
    console.log(`PelisPedia: Found ${iframeUrls.length} iframe players`);

    return await mapWithConcurrency(iframeUrls, PLAYER_CONCURRENCY, async (iframeUrl, index) => {
      const resolvedUrl = await unpacker.resolvePlayerStream(iframeUrl, userAgent, targetUrl, { signal });
      if (!resolvedUrl) return null;

      return {
        name: 'PelisPedia',
        title: `🇲🇽 Opcion ${index + 1}`,
        url: resolvedUrl,
        behaviorHints: {
          notWebReady: true,
          proxyHeaders: {
            request: {
              'User-Agent': userAgent,
              'Referer': iframeUrl
            }
          }
        }
      };
    });
  } catch (error) {
    console.error(`PelisPedia scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = { scrape };

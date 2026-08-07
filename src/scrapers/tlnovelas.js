const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, normalizeUrl } = require('../http');
const { cleanText, mapWithConcurrency, raceTitleSearches } = require('./common');

const BASE_URL = 'https://ww2.tlnovelas.net';
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const PLAYER_CONCURRENCY = 4;
// Player lists are short — four servers is the most any episode carries — and every
// extra entry costs a wrapper fetch inside the scraper's ten-second budget.
const MAX_PLAYER_URLS = 6;
// A trailing number this large is part of the novela's name (a year, a channel), not
// a season marker. "El Señor De Los Cielos 10" is a season; "Rubí 2020" is not.
const MAX_SEASON_NUMBER = 30;

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

/**
 * The season-like number a title ends with, or null. Numbers past a plausible season
 * count are names rather than markers and are reported as absent.
 */
function seasonNumberFromTitle(value) {
  const match = String(value || '').trim().match(/(\d+)\s*$/);
  if (!match) return null;

  const number = parseInt(match[1], 10);
  return number >= 1 && number <= MAX_SEASON_NUMBER ? number : null;
}

/**
 * TLNovelas files each season as its own novela — "El Señor De Los Cielos 10" is a
 * separate page from "El señor de los cielos", with its own capítulo 1. Scoring on
 * title text alone ranked the unnumbered original *highest* for a season-10 request
 * (it matches the TMDB title exactly), so whenever the numbered search lost the race
 * or timed out, the viewer was served season 1's episode under season 10's label.
 * A candidate whose number disagrees with the season being asked for is the wrong
 * novela no matter how well its words match, so it scores nothing at all.
 */
function scoreCandidate(result, title, originalTitle, extraTitles = [], season = null) {
  const cleanTitle = cleanText(title);
  const cleanOriginal = cleanText(originalTitle);
  const cleanExtras = extraTitles.map(cleanText).filter(Boolean);
  const cleanResult = cleanText(result.title);
  const slugWords = result.url.match(/\/novela\/([^/?#]+)/)?.[1]?.replace(/-/g, ' ');
  const cleanSlug = cleanText(slugWords);
  let score = 0;

  // The season wanted: the request's, or the one the title itself already names
  // (TMDB hands back "Rosario Tijeras 5" for a show the site files under that name).
  const wantedSeason = (season && season > 1 ? season : null)
    ?? seasonNumberFromTitle(title)
    ?? seasonNumberFromTitle(originalTitle);
  const candidateSeason = seasonNumberFromTitle(result.title) ?? seasonNumberFromTitle(slugWords);

  if (candidateSeason !== wantedSeason) return 0;

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

async function search(title, originalTitle, season, userAgent, signal, extraTitles = []) {
  const queries = buildSearchTitles(title, originalTitle, season, extraTitles);

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
        const score = scoreCandidate(result, query, originalTitle, [title, ...extraTitles], season);
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

  for (const candidate of queries) {
    const slug = slugifyTitle(candidate);
    if (!slug) continue;
    const url = `${BASE_URL}/novela/${slug}/`;
    try {
      const { res, text } = await fetchTextWithTimeout(url, {
        headers: browserHeaders(userAgent),
        signal
      }, SEARCH_TIMEOUT_MS);
      // The site answers 200 with a "no encontrado" shell for a novela it does not
      // have, so res.ok says nothing about whether the guess landed. A real novela
      // page lists its capítulos; that is the check worth making.
      if (res.ok && isNovelaPage(text)) return url;
    } catch {
      // Try the next direct slug.
    }
  }

  return null;
}

/** Whether a page is a real novela page rather than the site's soft-404 shell. */
function isNovelaPage(html) {
  return /href=["'][^"']*\/ver\/[^"']*["']/i.test(String(html || ''));
}

// The separator is deliberately loose: the number lives in the link text on some
// layouts ("Capítulo 17") and only in the href on others ("…-capitulo-17/"), and a
// whitespace-only separator never matched the second.
function episodeNumberFromText(value) {
  const match = String(value || '').match(/cap[ií]tulo[\s._-]*(\d+)/i);
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

/**
 * The hosts behind the site's own player shorthand. Episode pages do not always
 * carry a URL: the older layouts store `e[0]='bLLNfskCqRvm|1'`, and the page's
 * v_ideo() helper (themes/dark/js/dodo.min.js) turns the trailing digit into one of
 * these prefixes before building the iframe. Read literally, those entries resolve
 * against the episode page itself and every one of them was fetched as
 * `…/ver/<episode>/bLLNfskCqRvm|1` — a 404 on the novela site, so the episodes that
 * use this layout offered nothing at all.
 */
const PLAYER_SHORTHAND_HOSTS = {
  1: 'https://hqq.to/e/',
  2: 'https://dood.yt/e/',
  3: 'https://player.ojearanime.com/e/',
  4: 'https://player.vernovelastv.net/e/'
};

function expandPlayerEntry(value) {
  const text = String(value || '').trim();
  const match = text.match(/^([A-Za-z0-9_-]+)\|(\d)$/);
  const prefix = match ? PLAYER_SHORTHAND_HOSTS[match[2]] : null;
  // An unknown suffix is left alone, exactly as v_ideo() leaves it: the site treats
  // anything it does not recognise as a ready-made URL.
  return prefix ? `${prefix}${match[1]}` : text;
}

/** Static assets and the novela site's own pages are never players. */
function isPlayerCandidate(url) {
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (/(^|\.)tlnovelas\.net$/i.test(parsed.hostname)) return false;
    return !/\.(?:js|css|png|jpe?g|gif|webp|svg|ico|woff2?|ttf|eot)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

/** Whether a URL has the shape of a video wrapper or a stream, rather than a guess. */
function looksLikePlayer(url) {
  try {
    const path = new URL(url).pathname;
    return /\.(?:m3u8|mp4|mkv)$/i.test(path)
      || /^\/(?:e|v|f|d)\//i.test(path)
      || /\/embed/i.test(path);
  } catch {
    return false;
  }
}

function extractPlayerUrls(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const urls = [];
  const seen = new Set();

  function addUrl(value) {
    const url = normalizeUrl(expandPlayerEntry(value), pageUrl);
    if (!url || seen.has(url) || !isPlayerCandidate(url)) return;
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

  // The last pattern is a wide net — it catches ad tags and analytics endpoints
  // alongside players — so anything that does not look like a wrapper follows the
  // ones that do instead of taking their place in the concurrency window.
  return [...urls.filter(looksLikePlayer), ...urls.filter((url) => !looksLikePlayer(url))]
    .slice(0, MAX_PLAYER_URLS);
}

/**
 * Names the wrapper a stream came from. The list is built in completion order and
 * failed players are dropped, so a positional label reads "Opcion 2, Opcion 4" for
 * two working servers and tells the viewer nothing about either.
 */
function playerLabel(url) {
  try {
    const labels = new URL(url).hostname.toLowerCase().split('.');
    const name = labels.find((label) => !['www', 'player', 'embed', 'cdn', 'play'].includes(label))
      || labels[0];
    return name.charAt(0).toUpperCase() + name.slice(1);
  } catch {
    return 'Opcion';
  }
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  if (type !== 'series') return [];

  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    const pageUrl = await search(title, originalTitle, season, userAgent, signal, extraTitles);
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

    return await mapWithConcurrency(playerUrls, PLAYER_CONCURRENCY, async (playerUrl) => {
      try {
        const resolvedUrl = await unpacker.resolvePlayerStream(playerUrl, userAgent, episodeUrl, { signal });
        if (!resolvedUrl) return null;

        return {
          name: 'TLNovelas',
          title: `🇲🇽 ${playerLabel(playerUrl)}`,
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
    expandPlayerEntry,
    extractPlayerUrls,
    extractSearchResults,
    buildSearchTitles,
    episodeNumberFromText,
    findEpisodeUrl,
    isNovelaPage,
    playerLabel,
    scoreCandidate,
    seasonNumberFromTitle,
    slugifyTitle
  }
};

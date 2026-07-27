const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, fetchWithTimeout } = require('../http');
const { cleanText, extractCandidateYears } = require('./common');
const TOKEN_CONCURRENCY = 4;
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const PROBE_TIMEOUT_MS = 2500;
const TOKEN_FAST_MIN_RESULTS = 3;
const TOKEN_FAST_MIN_WAIT_MS = 2500;
const TOKEN_COLLECTION_TIMEOUT_MS = 6500;

function isP2POption(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('p2p') || text.includes('torrent') || text.includes('strp2p.com');
}

function scoreServerToken(serverInfo) {
  const name = (serverInfo.name || '').toLowerCase();
  const decodedUrl = b64_to_utf8(serverInfo.token).toLowerCase();
  const text = `${name} ${decodedUrl}`;

  if (isP2POption(text)) return 100;
  if (text.includes('upfast') || text.includes('player') || text.includes('pelisplus.upns.pro') || text.includes('4meplayer.pro')) return 0;
  if (text.includes('tioplus') || text.includes('plus') || text.includes('emturbovid') || text.includes('turboviplay') || text.includes('turbovidhls')) return 1;
  if (text.includes('opción 1') || text.includes('opcion 1') || text.includes('vidhide')) return 2;
  if (text.includes('lulu') || text.includes('luluvdo')) return 3;
  if (text.includes('hlswish') || text.includes('streamwish')) return 4;
  if (text.includes('netu') || text.includes('waaw')) return 9;
  if (text.includes('mobilefast') || text.includes('vudeo')) return 10;
  if (text.includes('hidefast') || text.includes('ahvsh')) return 11;
  if (text.includes('vidg') || text.includes('listeamed')) return 12;
  // Filemoon gates playback behind a captcha and VOE behind a DDoS-Guard JS
  // check; no server-side resolver can answer either, so they go last among the
  // direct players.
  if (text.includes('filemoon') || text.includes('voe')) return 13;
  return 6;
}

function sortServerTokens(serverTokens) {
  return [...serverTokens].sort((a, b) => scoreServerToken(a) - scoreServerToken(b));
}


function extractSlug(url) {
  const match = url.match(/\/(?:pelicula|serie)\/([^/?#]+)/);
  return match?.[1] || '';
}


function scoreCandidate(result, targetTitle, originalTargetTitle, year, extraTitles = []) {
  const cleanTargetTitle = cleanText(targetTitle);
  const cleanOriginalTitle = cleanText(originalTargetTitle);
  const cleanExtraTitles = extraTitles.map(cleanText).filter(Boolean);
  const cleanResultTitle = cleanText(result.title);
  const slug = extractSlug(result.url);
  const cleanSlug = cleanText(slug.replace(/-/g, ' '));
  let score = 0;

  if (year) {
    const yearStr = year.toString();
    const candidateYears = extractCandidateYears(result.title, slug);
    if (candidateYears.size > 0 && !candidateYears.has(yearStr)) {
      return 0;
    }
  }

  if (cleanTargetTitle && (cleanResultTitle.includes(cleanTargetTitle) || cleanTargetTitle.includes(cleanResultTitle))) {
    score += 3;
  }
  if (cleanOriginalTitle && (cleanResultTitle.includes(cleanOriginalTitle) || cleanOriginalTitle.includes(cleanResultTitle))) {
    score += 2;
  }
  for (const cleanExtra of cleanExtraTitles) {
    if (cleanResultTitle.includes(cleanExtra) || cleanExtra.includes(cleanResultTitle)) score += 2;
  }
  if (cleanSlug && (cleanSlug === cleanTargetTitle || cleanSlug === cleanOriginalTitle || cleanExtraTitles.includes(cleanSlug))) {
    score += 4;
  }
  if (cleanSlug && (cleanTargetTitle.includes(cleanSlug) || cleanOriginalTitle.includes(cleanSlug))) {
    score += 1;
  }

  if (year) {
    const yearStr = year.toString();
    if (result.title.includes(yearStr) || cleanResultTitle.includes(yearStr) || cleanSlug.includes(yearStr)) {
      score += 8;
    }
  }

  return score;
}

function slugifyTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/\by\b/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildFallbackUrls(type, title, originalTitle, extraTitles = []) {
  const basePath = type === 'series' ? 'serie' : 'pelicula';
  const candidates = [];
  const seen = new Set();

  for (const value of [title, originalTitle, ...extraTitles]) {
    const slug = slugifyTitle(value);
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    candidates.push({
      url: `https://tioplus.app/${basePath}/${slug}`,
      title: value || slug
    });
  }

  return candidates;
}

// Distinct from the shared mapWithConcurrency: this one can return early once
// enough tokens have resolved, leaving slower ones in flight.
async function mapWithConcurrencyUntilEnough(items, concurrency, worker, options = {}) {
  const results = [];
  let index = 0;
  let completed = 0;
  let settled = false;
  let fastReturnEnabled = false;
  let minWaitTimer = null;
  let timeoutTimer = null;

  const minResults = options.minResults || Infinity;
  const minWaitMs = options.minWaitMs || 0;
  const timeoutMs = options.timeoutMs || 0;
  const signal = options.signal;

  return new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      if (minWaitTimer) clearTimeout(minWaitTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (signal) signal.removeEventListener('abort', finish);
      resolve([...results]);
    };

    if (signal) {
      if (signal.aborted) {
        finish();
        return;
      }
      signal.addEventListener('abort', finish, { once: true });
    }

    const maybeFinish = () => {
      if (completed >= items.length) {
        finish();
        return;
      }

      if (fastReturnEnabled && results.length >= minResults) {
        console.log(`TioPlus: Returning ${results.length} fast token results; slow tokens still pending.`);
        finish();
      }
    };

    if (minWaitMs > 0) {
      minWaitTimer = setTimeout(() => {
        fastReturnEnabled = true;
        maybeFinish();
      }, minWaitMs);
    } else {
      fastReturnEnabled = true;
    }

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        console.warn(`TioPlus: Token collection timed out with ${results.length} streams.`);
        finish();
      }, timeoutMs);
    }

    async function runNext() {
      while (!settled && index < items.length) {
        const currentIndex = index++;
        try {
          const result = await worker(items[currentIndex], currentIndex);
          if (result) {
            results.push(result);
          }
        } finally {
          completed += 1;
          maybeFinish();
        }
      }
    }

    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext());
  });
}

/**
 * TioPlus takes the query as a URL path segment, and two characters break it
 * regardless of encoding. A plain apostrophe returns HTTP 500 (%27 fails too, so
 * their server unescapes before choking on it) and a slash returns 404 even as
 * %2F. Both are silent losses: the search attempt is spent and nothing comes back.
 * Dropping the apostrophe and spacing out the slash turns both into working
 * queries — "Schindler's List" and "Face/Off" each go from 0 hits to 1.
 *
 * A curly apostrophe is fine and is left alone. This only shapes the outgoing
 * query; matching still scores against the real title, and cleanText discards
 * punctuation anyway, so nothing downstream is affected.
 */
function toSearchQuery(value) {
  return String(value || '')
    .replace(/'/g, '')
    .replace(/\//g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Decodes base64 string to UTF-8.
 */
function b64_to_utf8(str) {
  try {
    return Buffer.from(str, 'base64').toString('utf8');
  } catch (e) {
    return '';
  }
}

/**
 * Encodes string to base64.
 */
function utf8_to_b64(str) {
  return Buffer.from(str, 'utf8').toString('base64');
}

/**
 * TioPlus Scraper
 */
async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  async function performSearch(searchQuery) {
    const searchUrl = `https://tioplus.app/api/search/${encodeURIComponent(toSearchQuery(searchQuery))}`;
    const { res, text: html } = await fetchTextWithTimeout(searchUrl, {
      headers: {
        'User-Agent': userAgent,
        'x-requested-with': 'XMLHttpRequest'
      },
      signal
    }, SEARCH_TIMEOUT_MS);
    console.log(`TioPlus search HTTP status for ${searchQuery}:`, res.status);
    if (!res.ok) return null;
    const $ = cheerio.load(html);
    const results = [];

    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim().replace(/\s+/g, ' ');
      const isMovieLink = href.includes('/pelicula/');
      const isSeriesLink = href.includes('/serie/');

      if (href && (isMovieLink || isSeriesLink)) {
        if ((type === 'movie' && isMovieLink) || (type === 'series' && isSeriesLink)) {
          results.push({ url: href, title: text });
        }
      }
    });
    console.log(`TioPlus performSearch("${searchQuery}") found ${results.length} candidate(s)`);

    let bestMatch = null;
    let bestScore = 0;

    for (const r of results) {
      const score = scoreCandidate(r, title, originalTitle, year, extraTitles);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = r;
      }
    }

    return bestMatch;
  }

  try {
    let bestMatch = await performSearch(title);

    if (!bestMatch && originalTitle && cleanText(originalTitle) !== cleanText(title)) {
      console.log(`TioPlus: No match for "${title}", trying originalTitle "${originalTitle}"`);
      bestMatch = await performSearch(originalTitle);
    }

    const triedClean = new Set([cleanText(title), cleanText(originalTitle)]);
    for (const extraTitle of extraTitles) {
      if (bestMatch) break;
      const cleanExtra = cleanText(extraTitle);
      if (!cleanExtra || triedClean.has(cleanExtra)) continue;
      triedClean.add(cleanExtra);
      console.log(`TioPlus: No match yet, trying alternative title "${extraTitle}"`);
      bestMatch = await performSearch(extraTitle);
    }

    if (!bestMatch) {
      for (const candidate of buildFallbackUrls(type, title, originalTitle, extraTitles)) {
        try {
          const probeRes = await fetchWithTimeout(candidate.url, {
            headers: { 'User-Agent': userAgent },
            signal
          }, PROBE_TIMEOUT_MS);
          if (probeRes.ok) {
            console.log(`TioPlus: Using direct URL fallback ${candidate.url}`);
            bestMatch = candidate;
            break;
          }
        } catch (err) {
          console.warn(`TioPlus: Fallback probe failed for ${candidate.url}:`, err.message);
        }
      }
    }

    if (!bestMatch) {
      console.log(`TioPlus: No matching content found for "${title}"`);
      return [];
    }

    // Determine target page URL (movie page vs episode page)
    let targetPageUrl = bestMatch.url;
    if (type === 'series') {
      // Structure: https://tioplus.app/serie/slug/season/X/episode/Y
      const baseUrlClean = bestMatch.url.replace(/\/$/, '');
      targetPageUrl = `${baseUrlClean}/season/${season}/episode/${episode}`;
    }

    console.log(`TioPlus: Matched content URL: ${targetPageUrl}`);

    // 2. Fetch target page to extract player server tokens
    const { res: pageRes, text: pageHtml } = await fetchTextWithTimeout(targetPageUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, PAGE_TIMEOUT_MS);
    if (!pageRes.ok) {
      console.warn(`TioPlus: Failed to fetch target page: ${targetPageUrl} (${pageRes.status})`);
      return [];
    }
    const pageDoc = cheerio.load(pageHtml);

    // Collect all data-server and data-tr tokens
    const serverTokens = [];
    
    // Check main player div data-tr
    const mainTr = pageDoc('#player-tr').attr('data-tr');
    if (mainTr) {
      serverTokens.push({
        name: 'Opción 1',
        token: mainTr
      });
    }

    // Check list item options
    pageDoc('li[data-server]').each((i, el) => {
      const token = pageDoc(el).attr('data-server');
      const name = pageDoc(el).text().trim() || `Opción ${i + 2}`;
      if (token && !serverTokens.some(t => t.token === token)) {
        serverTokens.push({ name, token });
      }
    });

    console.log(`TioPlus: Found ${serverTokens.length} server tokens`);
    const sortedServerTokens = sortServerTokens(serverTokens);
    const tokenController = new AbortController();
    const abortTokenResolvers = () => tokenController.abort();
    if (signal) {
      if (signal.aborted) {
        tokenController.abort();
      } else {
        signal.addEventListener('abort', abortTokenResolvers, { once: true });
      }
    }

    // 3. For each token, resolve player redirect
    const streams = await mapWithConcurrencyUntilEnough(sortedServerTokens, TOKEN_CONCURRENCY, async (sInfo) => {
      try {
        if (isP2POption(sInfo.name) || isP2POption(sInfo.token)) {
          console.log(`TioPlus: Skipping P2P/torrent server ${sInfo.name}`);
          return null;
        }

        const ol = b64_to_utf8(sInfo.token);
        if (!ol) return null;

        if (isP2POption(ol)) {
          console.log(`TioPlus: Skipping P2P/torrent decoded URL for ${sInfo.name}`);
          return null;
        }

        // Shortcut: if the decoded token is a pelisplus or emturbovid URL,
        // resolve it directly without going through the obfuscated tioplus player page
        const isPelisplus = ol.includes('pelisplus.upns.pro') || ol.includes('4meplayer.pro') || ol.includes('strp2p.com');
        const isEmturbovid = ol.includes('emturbovid') || ol.includes('turbovidhls') || ol.includes('turboviplay');

        let directStreamUrl = null;

        if (isPelisplus || isEmturbovid) {
          directStreamUrl = ol; // resolve directly below
        } else {
          // Double base64 encode for the tioplus player page
          const innerPath = utf8_to_b64(utf8_to_b64(ol));
          const playerUrl = `https://tioplus.app/player/${innerPath}`;

          // Fetch player page
          const { res: playerRes, text: playerHtml } = await fetchTextWithTimeout(playerUrl, {
            headers: {
              'User-Agent': userAgent,
              'Referer': 'https://tioplus.app/'
            },
            signal: tokenController.signal
          }, PAGE_TIMEOUT_MS);
          if (!playerRes.ok) return null;

          // Extract redirect URL using Regex
          const redirectMatch = playerHtml.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
          if (redirectMatch && redirectMatch[1]) {
            directStreamUrl = redirectMatch[1];
          }
        }

        if (!directStreamUrl) return null;
          
        let resolvedDirectUrl = null;
        try {
          resolvedDirectUrl = await unpacker.resolvePlayerStream(directStreamUrl, userAgent, 'https://tioplus.app/', { signal: tokenController.signal });
        } catch (e) {
          console.error(`TioPlus: Error resolving hosting redirect for ${sInfo.name}:`, e.message);
        }

        if (resolvedDirectUrl) {
          return {
            name: `TioPlus`,
            title: `🇲🇽 ${sInfo.name}`,
            url: resolvedDirectUrl,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: {
                request: {
                  "User-Agent": userAgent,
                  "Referer": directStreamUrl || "https://tioplus.app/"
                }
              }
            }
          };
        }
      } catch (err) {
        console.error(`TioPlus: Error resolving player token for ${sInfo.name}:`, err.message);
      }
      return null;
    }, {
      minResults: TOKEN_FAST_MIN_RESULTS,
      minWaitMs: TOKEN_FAST_MIN_WAIT_MS,
      timeoutMs: TOKEN_COLLECTION_TIMEOUT_MS,
      signal: tokenController.signal
    });
    tokenController.abort();
    if (signal) {
      signal.removeEventListener('abort', abortTokenResolvers);
    }

    return streams;
  } catch (error) {
    console.error(`TioPlus scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: { toSearchQuery }
};

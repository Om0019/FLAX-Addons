const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchJsonWithTimeout, fetchTextWithTimeout, fetchWithTimeout } = require('../http');
const { cleanText, extractCandidateYears, mapWithConcurrency, raceTitleSearches } = require('./common');
const TOKEN_CONCURRENCY = 3;
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const API_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;


function slugifyTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' y ')
    .replace(/\band\b/g, 'y')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
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

  if (cleanTargetTitle && cleanResultTitle === cleanTargetTitle) score += 5;
  if (cleanOriginalTitle && cleanResultTitle === cleanOriginalTitle) score += 4;
  if (cleanSlug && cleanSlug === cleanTargetTitle) score += 5;
  if (cleanSlug && cleanSlug === cleanOriginalTitle) score += 4;

  if (cleanTargetTitle && (cleanResultTitle.includes(cleanTargetTitle) || cleanTargetTitle.includes(cleanResultTitle))) {
    score += 2;
  }
  if (cleanOriginalTitle && (cleanResultTitle.includes(cleanOriginalTitle) || cleanOriginalTitle.includes(cleanResultTitle))) {
    score += 2;
  }

  for (const cleanExtra of cleanExtraTitles) {
    if (cleanResultTitle === cleanExtra || cleanSlug === cleanExtra) score += 4;
    else if (cleanResultTitle.includes(cleanExtra) || cleanExtra.includes(cleanResultTitle)) score += 2;
  }

  if (year) {
    const yearStr = year.toString();
    if (result.title.includes(yearStr) || cleanResultTitle.includes(yearStr) || cleanSlug.includes(yearStr)) {
      score += 8;
    }
  }

  return score;
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
      url: `https://sololatino.net/${basePath}/${slug}`,
      title: value || slug
    });
  }

  return candidates;
}

function extractPageIdentityText(html) {
  const $ = cheerio.load(html || '');
  return [
    $('title').text(),
    $('meta[property="og:title"]').attr('content'),
    $('meta[name="description"]').attr('content'),
    $('h1').first().text(),
    $('h2').first().text()
  ].filter(Boolean).join(' ');
}

function pageHasRequestedYear(html, year) {
  if (!year) return true;
  const identityText = extractPageIdentityText(html);
  const years = extractCandidateYears(identityText);
  return years.has(year.toString());
}

async function probeFallbackCandidate(candidate, year, userAgent, signal) {
  const { res: probeRes, text: html } = await fetchTextWithTimeout(candidate.url, {
    headers: { 'User-Agent': userAgent },
    signal
  }, PROBE_TIMEOUT_MS);

  if (!probeRes.ok) {
    return null;
  }
  if (year && !pageHasRequestedYear(html, year)) {
    console.log(`SoloLatino: Rejecting fallback ${candidate.url}; page does not contain requested year ${year}`);
    return null;
  }

  return candidate;
}

function scorePlayerToken(playerInfo) {
  const label = (playerInfo.name || '').toLowerCase();

  if (label.includes('latino') || label.includes('slplayer') || label.includes('servidor 1')) return 0;
  if (label.includes('premium')) return 3;
  if (label.includes('vip')) return 7;
  return 4;
}

function sortPlayerTokens(playerTokens) {
  return [...playerTokens].sort((a, b) => scorePlayerToken(a) - scorePlayerToken(b));
}


const PELISSERIESHOY_ORIGIN = 'https://player.pelisserieshoy.com';
// The handshake lists every mirror it knows about. Only the first was ever tried,
// so a dead lead mirror meant the whole player resolved to nothing even though the
// next entry would have worked. Bounded because each attempt is two round-trips.
const PELISSERIESHOY_MAX_SERVERS = 4;

function pelisserieshoyHeaders(userAgent, streamUrl) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
    'Referer': streamUrl,
    'Origin': PELISSERIESHOY_ORIGIN
  };
}

/**
 * Turns one entry of the pelisserieshoy server list into a direct URL. The `a=2`
 * call answers with a path on the player's own origin that 302s to the file.
 */
async function resolvePelisserieshoyServer(serverValue, token, userAgent, streamUrl, signal) {
  const { res: playValRes, data: playValJson } = await fetchJsonWithTimeout(`${PELISSERIESHOY_ORIGIN}/s.php`, {
    method: 'POST',
    headers: pelisserieshoyHeaders(userAgent, streamUrl),
    signal,
    body: new URLSearchParams({ a: '2', v: serverValue, tok: token })
  }, API_TIMEOUT_MS);

  if (!playValRes.ok || !playValJson?.u) return null;

  const pathUrl = `${PELISSERIESHOY_ORIGIN}${playValJson.u}`;
  const redirectCheck = await fetchWithTimeout(pathUrl, {
    method: 'GET',
    headers: { 'User-Agent': userAgent, 'Referer': streamUrl },
    redirect: 'manual',
    signal
  }, API_TIMEOUT_MS);

  const directUrl = [301, 302].includes(redirectCheck.status)
    ? redirectCheck.headers.get('location')
    : pathUrl;
  if (!directUrl) return null;

  // A .bin payload is an MP4 with the extension filed off; players route on the
  // extension, so give them one they act on.
  return directUrl.includes('.bin') ? `${directUrl}#.mp4` : directUrl;
}

/**
 * SoloLatino's own player. It gates the stream behind a three-step token
 * handshake rather than putting anything extractable in the page.
 */
async function resolvePelisserieshoy(streamUrl, userAgent, signal) {
  const { res: pageRes, text: html } = await fetchTextWithTimeout(streamUrl, {
    headers: { 'User-Agent': userAgent, 'Referer': 'https://sololatino.net/' },
    signal
  }, PAGE_TIMEOUT_MS);
  if (!pageRes.ok) return null;

  const token = html.match(/const\s+_t\s*=\s*['"]([^'"]+)['"]/)?.[1];
  if (!token) return null;

  // Register the click the player would have made; the list call is refused without it.
  await fetchWithTimeout(`${PELISSERIESHOY_ORIGIN}/s.php`, {
    method: 'POST',
    headers: pelisserieshoyHeaders(userAgent, streamUrl),
    signal,
    body: new URLSearchParams({ a: 'click', tok: token })
  }, API_TIMEOUT_MS);

  const { res: sListRes, data: sListJson } = await fetchJsonWithTimeout(`${PELISSERIESHOY_ORIGIN}/s.php`, {
    method: 'POST',
    headers: pelisserieshoyHeaders(userAgent, streamUrl),
    signal,
    body: new URLSearchParams({ a: '1', tok: token })
  }, API_TIMEOUT_MS);

  if (!sListRes.ok || !Array.isArray(sListJson?.s)) return null;

  for (const entry of sListJson.s.slice(0, PELISSERIESHOY_MAX_SERVERS)) {
    const serverValue = Array.isArray(entry) ? entry[1] : entry;
    if (!serverValue) continue;

    try {
      const directUrl = await resolvePelisserieshoyServer(serverValue, token, userAgent, streamUrl, signal);
      if (directUrl) return directUrl;
    } catch (error) {
      console.warn(`SoloLatino: pelisserieshoy server ${serverValue} failed: ${error.message}`);
    }
  }

  return null;
}

/**
 * SoloLatino Scraper
 */
async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  async function performSearch(searchQuery) {
    const searchUrl = `https://sololatino.net/buscar?q=${encodeURIComponent(searchQuery)}`;
    const { res, text: html } = await fetchTextWithTimeout(searchUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, SEARCH_TIMEOUT_MS);
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

    const uniqueResults = [];
    const seenUrls = new Set();
    for (const r of results) {
      if (r.url.includes('/serie/') && !/\/serie\/[^/]+\/?$/.test(r.url)) {
        continue;
      }

      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        uniqueResults.push(r);
      }
    }

    let bestMatch = null;
    let bestScore = 0;

    for (const r of uniqueResults) {
      const score = scoreCandidate(r, title, originalTitle, year, extraTitles);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = r;
      }
    }

    return bestMatch;
  }

  try {
    const racedTitles = originalTitle && cleanText(originalTitle) !== cleanText(title)
      ? [title, originalTitle]
      : [title];
    let bestMatch = await raceTitleSearches(racedTitles, performSearch);

    const triedClean = new Set([cleanText(title), cleanText(originalTitle)]);
    for (const extraTitle of extraTitles) {
      if (bestMatch) break;
      const cleanExtra = cleanText(extraTitle);
      if (!cleanExtra || triedClean.has(cleanExtra)) continue;
      triedClean.add(cleanExtra);
      console.log(`SoloLatino: No match yet, trying alternative title "${extraTitle}"`);
      bestMatch = await performSearch(extraTitle);
    }

    if (!bestMatch) {
      for (const candidate of buildFallbackUrls(type, title, originalTitle, extraTitles)) {
        try {
          const probedCandidate = await probeFallbackCandidate(candidate, year, userAgent, signal);
          if (probedCandidate) {
            console.log(`SoloLatino: Using direct URL fallback ${probedCandidate.url}`);
            bestMatch = probedCandidate;
            break;
          }
        } catch (err) {
          console.warn(`SoloLatino: Fallback probe failed for ${candidate.url}:`, err.message);
        }
      }
    }

    if (!bestMatch) {
      console.log(`SoloLatino: No matching content found for "${title}"`);
      return [];
    }

    // Determine target page URL based on movie vs TV series episode
    let targetPageUrl = bestMatch.url;
    if (type === 'series') {
      // Structure: https://sololatino.net/serie/slug/temporada-X/episodio-Y
      // Ensure there are no trailing slashes in bestMatch.url
      const baseUrlClean = bestMatch.url.replace(/\/$/, '');
      targetPageUrl = `${baseUrlClean}/temporada-${season}/episodio-${episode}`;
    }

    console.log(`SoloLatino: Matched content URL: ${targetPageUrl}`);

    // 2. Establish session cookies and load the content page. The page request
    // carries no cookies, so it does not depend on the handshake and there is no
    // reason to queue behind it — running them one after the other spent a whole
    // round trip inside the longest scraper budget of the six, which is the one
    // that most often decides whether the orchestrator's fast return fires.
    // Settled rather than Promise.all: a rejection here must not leave the other
    // request's rejection unhandled, and the handshake failure is still the one
    // reported first.
    const csrfRequest = fetchWithTimeout('https://sololatino.net/sanctum/csrf-cookie', {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/json'
      },
      signal
    }, API_TIMEOUT_MS);
    const pageRequest = fetchTextWithTimeout(targetPageUrl, {
      headers: {
        'User-Agent': userAgent
      },
      signal
    }, PAGE_TIMEOUT_MS);

    const [csrfOutcome, pageOutcome] = await Promise.allSettled([csrfRequest, pageRequest]);
    if (csrfOutcome.status === 'rejected') throw csrfOutcome.reason;
    if (pageOutcome.status === 'rejected') throw pageOutcome.reason;

    const csrfRes = csrfOutcome.value;
    if (!csrfRes.ok) {
      console.warn(`SoloLatino: Sanctum handshake failed with status ${csrfRes.status}`);
      return [];
    }

    const setCookies = csrfRes.headers.getSetCookie();
    let xsrfCookieVal = '';
    let sessionCookieVal = '';
    for (const cookie of setCookies) {
      if (cookie.startsWith('XSRF-TOKEN=')) {
        xsrfCookieVal = cookie.split(';')[0].substring('XSRF-TOKEN='.length);
      } else if (cookie.startsWith('sololatinonet-session=')) {
        sessionCookieVal = cookie.split(';')[0].substring('sololatinonet-session='.length);
      }
    }

    if (!xsrfCookieVal) {
      console.warn('SoloLatino: Sanctum response did not return XSRF-TOKEN cookie.');
      return [];
    }

    const decodedXSRF = decodeURIComponent(xsrfCookieVal);
    const cookieString = `XSRF-TOKEN=${xsrfCookieVal}; sololatinonet-session=${sessionCookieVal}`;

    // 3. Read the content page (movie or episode details) fetched above for the
    // CSRF token and the player tokens.
    const { res: pageRes, text: pageHtml } = pageOutcome.value;
    if (!pageRes.ok) {
      console.warn(`SoloLatino: Failed to fetch target page: ${targetPageUrl} (${pageRes.status})`);
      return [];
    }
    const pageDoc = cheerio.load(pageHtml);

    // Read the CSRF token from HTML metadata
    const csrfToken = pageDoc('meta[name="csrf-token"]').attr('content');
    if (!csrfToken) {
      console.warn('SoloLatino: CSRF token not found in meta tags.');
      return [];
    }

    // Extract all player tokens from the server buttons
    const playerTokens = [];
    pageDoc('.server-btn').each((i, el) => {
      const token = pageDoc(el).attr('data-player-token');
      const serverName = pageDoc(el).text().trim() || `Servidor ${i + 1}`;
      if (token) {
        playerTokens.push({
          name: serverName,
          token: token
        });
      }
    });

    console.log(`SoloLatino: Found ${playerTokens.length} player tokens`);
    const sortedPlayerTokens = sortPlayerTokens(playerTokens);

    // 4. Query the /api/player-url endpoint for each token
    const streams = await mapWithConcurrency(sortedPlayerTokens, TOKEN_CONCURRENCY, async (pInfo) => {
      try {
        const { res: apiRes, data: apiJson } = await fetchJsonWithTimeout('https://sololatino.net/api/player-url', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-XSRF-TOKEN': decodedXSRF,
            'User-Agent': userAgent,
            'Cookie': cookieString,
            'Referer': targetPageUrl,
            'Origin': 'https://sololatino.net'
          },
          signal,
          body: JSON.stringify({ t: pInfo.token })
        }, API_TIMEOUT_MS);

        if (apiRes.status === 200) {
          if (apiJson && apiJson.url) {
            const streamUrl = apiJson.url;
            const isIframe = apiJson.type === 'iframe' || streamUrl.includes('embed') || streamUrl.includes('player') || streamUrl.includes('/f/');
            

            let directUrl = null;
            if (isIframe) {
              try {
                directUrl = streamUrl.includes('player.pelisserieshoy.com')
                  ? await resolvePelisserieshoy(streamUrl, userAgent, signal)
                  // Standard direct extraction / Dean Edwards unpacker fallback / Embed69 recursive resolution
                  : await unpacker.resolvePlayerStream(streamUrl, userAgent, 'https://sololatino.net/', { signal });
              } catch (e) {
                console.error(`SoloLatino: Error unpacking iframe ${streamUrl}:`, e.message);
              }
            } else {
              directUrl = streamUrl;
            }


            if (directUrl) {
              return {
                name: `SoloLatino`,
                title: `🇲🇽 ${pInfo.name}`,
                url: directUrl,
                behaviorHints: {
                  notWebReady: true,
                  proxyHeaders: {
                    request: {
                      "User-Agent": userAgent,
                      "Referer": streamUrl || "https://sololatino.net/"
                    }
                  }
                }
              };
            }
          }
        } else {
          console.warn(`SoloLatino: API /api/player-url returned status ${apiRes.status} for server ${pInfo.name}`);
        }
      } catch (err) {
        console.error(`SoloLatino: Error requesting player URL for server ${pInfo.name}:`, err.message);
      }
      return null;
    });

    return streams;
  } catch (error) {
    console.error(`SoloLatino scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: {
    scoreCandidate,
    extractPageIdentityText,
    pageHasRequestedYear,
    buildFallbackUrls
  }
};

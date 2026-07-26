const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchWithTimeout } = require('../http');
const TOKEN_CONCURRENCY = 3;
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const API_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;

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
    .replace(/&/g, ' y ')
    .replace(/\band\b/g, 'y')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractSlug(url) {
  const match = url.match(/\/(?:pelicula|serie)\/([^/?#]+)/);
  return match?.[1] || '';
}

function extractCandidateYears(...values) {
  const years = new Set();

  for (const value of values) {
    const matches = String(value || '').match(/\b(?:19|20)\d{2}\b/g) || [];
    for (const match of matches) {
      years.add(match);
    }
  }

  return years;
}

function scoreCandidate(result, targetTitle, originalTargetTitle, year) {
  const cleanTargetTitle = cleanText(targetTitle);
  const cleanOriginalTitle = cleanText(originalTargetTitle);
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

  if (year) {
    const yearStr = year.toString();
    if (result.title.includes(yearStr) || cleanResultTitle.includes(yearStr) || cleanSlug.includes(yearStr)) {
      score += 8;
    }
  }

  return score;
}

function buildFallbackUrls(type, title, originalTitle) {
  const basePath = type === 'series' ? 'serie' : 'pelicula';
  const candidates = [];
  const seen = new Set();

  for (const value of [title, originalTitle]) {
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
  const probeRes = await fetchWithTimeout(candidate.url, {
    headers: { 'User-Agent': userAgent },
    signal
  }, PROBE_TIMEOUT_MS);

  if (!probeRes.ok) {
    return null;
  }

  const html = await probeRes.text();
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

async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const currentIndex = index++;
      const result = await worker(items[currentIndex], currentIndex);
      if (result) {
        results.push(result);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext())
  );

  return results;
}

/**
 * SoloLatino Scraper
 */
async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  async function performSearch(searchQuery) {
    const searchUrl = `https://sololatino.net/buscar?q=${encodeURIComponent(searchQuery)}`;
    const res = await fetchWithTimeout(searchUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, SEARCH_TIMEOUT_MS);
    if (!res.ok) return null;

    const html = await res.text();
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
      const score = scoreCandidate(r, title, originalTitle, year);
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
      console.log(`SoloLatino: No match for "${title}", trying originalTitle "${originalTitle}"`);
      bestMatch = await performSearch(originalTitle);
    }

    if (!bestMatch) {
      for (const candidate of buildFallbackUrls(type, title, originalTitle)) {
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

    // 2. Fetch Laravel Sanctum CSRF cookie to establish session cookies
    const csrfRes = await fetchWithTimeout('https://sololatino.net/sanctum/csrf-cookie', {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/json'
      },
      signal
    }, API_TIMEOUT_MS);
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

    // 3. Fetch the actual content page (movie or episode details page) to get the CSRF token and player tokens
    const pageRes = await fetchWithTimeout(targetPageUrl, {
      headers: {
        'User-Agent': userAgent
      },
      signal
    }, PAGE_TIMEOUT_MS);
    if (!pageRes.ok) {
      console.warn(`SoloLatino: Failed to fetch target page: ${targetPageUrl} (${pageRes.status})`);
      return [];
    }

    const pageHtml = await pageRes.text();
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
        const apiRes = await fetchWithTimeout('https://sololatino.net/api/player-url', {
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
          const apiJson = await apiRes.json();
          if (apiJson && apiJson.url) {
            const streamUrl = apiJson.url;
            const isIframe = apiJson.type === 'iframe' || streamUrl.includes('embed') || streamUrl.includes('player') || streamUrl.includes('/f/');
            

            let directUrl = null;
            if (isIframe) {
              try {
                // If it is player.pelisserieshoy.com, perform the s.php handshake to fetch direct streams!
                if (streamUrl.includes('player.pelisserieshoy.com')) {
                  const pPageRes = await fetchWithTimeout(streamUrl, {
                    headers: { 'User-Agent': userAgent, 'Referer': 'https://sololatino.net/' },
                    signal
                  }, PAGE_TIMEOUT_MS);
                  if (pPageRes.ok) {
                    const pHtml = await pPageRes.text();
                    const tokenMatch = pHtml.match(/const\s+_t\s*=\s*['"]([^'"]+)['"]/);
                    if (tokenMatch) {
                      const tToken = tokenMatch[1];
                      
                      // 1. Register click
                      await fetchWithTimeout('https://player.pelisserieshoy.com/s.php', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/x-www-form-urlencoded',
                          'User-Agent': userAgent,
                          'Referer': streamUrl,
                          'Origin': 'https://player.pelisserieshoy.com'
                        },
                        signal,
                        body: new URLSearchParams({ a: 'click', tok: tToken })
                      }, API_TIMEOUT_MS);

                      // 2. Fetch server list
                      const sListRes = await fetchWithTimeout('https://player.pelisserieshoy.com/s.php', {
                        method: 'POST',
                        headers: {
                          'Content-Type': 'application/x-www-form-urlencoded',
                          'User-Agent': userAgent,
                          'Referer': streamUrl,
                          'Origin': 'https://player.pelisserieshoy.com'
                        },
                        signal,
                        body: new URLSearchParams({ a: '1', tok: tToken })
                      }, API_TIMEOUT_MS);

                      if (sListRes.ok) {
                        const sListJson = await sListRes.json();
                        if (sListJson && sListJson.s && sListJson.s.length > 0) {
                          // Extract first server
                          const [sLabel, sVal] = sListJson.s[0];
                          // 3. Request direct file path
                          const playValRes = await fetchWithTimeout('https://player.pelisserieshoy.com/s.php', {
                            method: 'POST',
                            headers: {
                              'Content-Type': 'application/x-www-form-urlencoded',
                              'User-Agent': userAgent,
                              'Referer': streamUrl,
                              'Origin': 'https://player.pelisserieshoy.com'
                            },
                            signal,
                            body: new URLSearchParams({ a: '2', v: sVal, tok: tToken })
                          }, API_TIMEOUT_MS);

                          if (playValRes.ok) {
                            const playValJson = await playValRes.json();
                            if (playValJson && playValJson.u) {
                              const pathUrl = 'https://player.pelisserieshoy.com' + playValJson.u;
                              // 4. Resolve mediafire/direct redirect location header
                              const redirectCheck = await fetchWithTimeout(pathUrl, {
                                method: 'GET',
                                headers: { 'User-Agent': userAgent, 'Referer': streamUrl },
                                redirect: 'manual',
                                signal
                              }, API_TIMEOUT_MS);
                              if (redirectCheck.status === 302 || redirectCheck.status === 301) {
                                directUrl = redirectCheck.headers.get('location');
                              } else {
                                directUrl = pathUrl;
                              }
                              if (directUrl && directUrl.includes('.bin')) {
                                directUrl += '#.mp4';
                              }
                            }
                          }
                        }
                      }
                    }
                  }
                } else {
                  // Standard direct extraction / Dean Edwards unpacker fallback / Embed69 recursive resolution
                  directUrl = await unpacker.resolvePlayerStream(streamUrl, userAgent, 'https://sololatino.net/', { signal });
                }
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

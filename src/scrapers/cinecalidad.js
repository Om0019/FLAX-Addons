const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, fetchWithTimeout } = require('../http');
const { cleanText } = require('./common');

const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const VALIDATION_TIMEOUT_MS = 2500;
const PLAYER_FAST_MIN_WAIT_MS = 1000;
const PLAYER_FAST_MIN_STREAMS = 1;
const PLAYER_COLLECTION_TIMEOUT_MS = 7500;


function extractSeriesSlug(url) {
  const match = url.match(/\/(?:ver-serie|serie)\/([^/]+)/);
  return match?.[1] || null;
}

function buildEpisodeUrlFromSeriesSlug(slug, season, episode) {
  return `https://www.cinecalidad.am/ver-el-episodio/${slug}-${season}x${episode}/`;
}

function normalizeServerName(label) {
  return (label || '')
    .replace('Recomendado', '')
    .replace(/Contraseña:.*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractDownloadPageLinks(movieDoc) {
  const links = [];
  const seen = new Set();

  movieDoc('a[href*="?download="]').each((i, el) => {
    const href = movieDoc(el).attr('href');
    const serverName = normalizeServerName(movieDoc(el).text()) || `Descarga ${i + 1}`;
    if (!href || seen.has(href)) return;
    seen.add(href);
    links.push({ downloadPageUrl: href, serverName });
  });

  return links;
}

function extractExternalDownloadLinks(movieDoc) {
  const links = [];
  const seen = new Set();

  movieDoc('a').each((i, el) => {
    const href = movieDoc(el).attr('href');
    const serverName = normalizeServerName(movieDoc(el).text());
    if (!href || !serverName) return;
    if (href.includes('cinecalidad.am/ver-') && href.includes('?download=')) return;
    if (!/mediafire|1fichier|megaup|fireload/i.test(serverName + ' ' + href)) return;
    if (seen.has(href)) return;
    seen.add(href);
    links.push({ downloadUrl: href, serverName });
  });

  return links;
}

async function isPlayableDownloadTarget(url, userAgent, referer, signal) {
  try {
    const res = await fetchWithTimeout(url, {
      method: 'HEAD',
      redirect: 'manual',
      headers: {
        'User-Agent': userAgent,
        'Referer': referer
      },
      signal
    }, VALIDATION_TIMEOUT_MS);

    const contentType = (res.headers.get('content-type') || '').toLowerCase();
    const contentDisposition = (res.headers.get('content-disposition') || '').toLowerCase();

    if (contentType.startsWith('video/') || contentType.includes('application/vnd.apple.mpegurl')) {
      return true;
    }

    if (contentDisposition.includes('attachment') && !contentType.startsWith('text/html')) {
      return true;
    }

    if (/\.(m3u8|mp4|mkv)(?:$|[?#])/i.test(url) && !contentType.startsWith('text/html')) {
      return true;
    }
  } catch (error) {
    console.error(`Cinecalidad: Error validating download target ${url}:`, error.message);
  }

  return false;
}

async function resolveDownloadPage(downloadPageUrl, userAgent, referer, signal) {
  try {
    const { res, text: html } = await fetchTextWithTimeout(downloadPageUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': referer
      },
      signal
    }, PAGE_TIMEOUT_MS);
    if (!res.ok) return null;
    const matches = [...new Set(html.match(/https?:[^"'`\s<>]+/g) || [])];

    return matches.find((url) => {
      if (url.includes('cinecalidad.am') || url.includes('t.me/')) return false;
      return /1fichier|megaup|mediafire|fireload/i.test(url);
    }) || null;
  } catch (error) {
    console.error(`Cinecalidad: Error resolving download page ${downloadPageUrl}:`, error.message);
    return null;
  }
}

function scorePlayerOption(option) {
  const text = `${option.serverName || ''} ${option.playerUrl || ''}`.toLowerCase();

  if (text.includes('vimeos')) return 0;
  if (text.includes('goodstream')) return 1;
  if (text.includes('hlswish') || text.includes('streamwish')) return 2;
  if (text.includes('filemoon')) return 8;
  if (text.includes('voe')) return 9;
  if (text.includes('waaw')) return 10;
  return 5;
}

function sortPlayerOptions(playerOptions) {
  return [...playerOptions].sort((a, b) => scorePlayerOption(a) - scorePlayerOption(b));
}

async function waitForPlayerResolvers(playerPromises, streams) {
  let fastReturnEnabled = false;
  let resolveFastReturn;

  const fastReturnPromise = new Promise((resolve) => {
    resolveFastReturn = resolve;
    setTimeout(() => {
      fastReturnEnabled = true;
      if (streams.length >= PLAYER_FAST_MIN_STREAMS) {
        resolve('enough-streams');
      }
    }, PLAYER_FAST_MIN_WAIT_MS);
  });

  const trackedPromises = playerPromises.map((promise) => (
    promise.finally(() => {
      if (fastReturnEnabled && streams.length >= PLAYER_FAST_MIN_STREAMS) {
        resolveFastReturn('enough-streams');
      }
    })
  ));

  const completed = await Promise.race([
    Promise.allSettled(trackedPromises).then(() => 'complete'),
    new Promise((resolve) => setTimeout(() => resolve('timeout'), PLAYER_COLLECTION_TIMEOUT_MS)),
    fastReturnPromise
  ]);

  if (completed !== 'complete') {
    const reason = completed === 'enough-streams' ? 'fast player target met' : 'timeout';
    console.warn(`Cinecalidad: Returning ${streams.length} resolved player streams (${reason}); slow wrappers still pending.`);
  }

  return completed;
}

/**
 * Cinecalidad Scraper (Direct Streams)
 */
async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  async function performSearch(searchQuery) {
    const searchUrl = `https://www.cinecalidad.am/?s=${encodeURIComponent(searchQuery)}`;
    const { res, text: html } = await fetchTextWithTimeout(searchUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, SEARCH_TIMEOUT_MS);
    if (!res.ok) return null;
    const $ = cheerio.load(html);
    const results = [];

    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      const text = $(el).text().trim();
      const titleAttr = $(el).attr('title') || '';
      
      const isMovieLink = href.includes('/ver-pelicula/') || href.includes('/pelicula/');
      const isSeriesLink = href.includes('/ver-serie/') || href.includes('/serie/');

      if (isMovieLink || isSeriesLink) {
        if ((type === 'movie' && isMovieLink) || (type === 'series' && isSeriesLink)) {
          const fullTitle = titleAttr || text;
          if (fullTitle) {
            results.push({ url: href, title: fullTitle });
          }
        }
      }
    });

    const uniqueResults = [];
    const seenUrls = new Set();
    for (const r of results) {
      if (type === 'series' && !extractSeriesSlug(r.url)) {
        continue;
      }

      if (!seenUrls.has(r.url)) {
        seenUrls.add(r.url);
        uniqueResults.push(r);
      }
    }

    const cleanTargetTitle = cleanText(title);
    const cleanOriginalTitle = cleanText(originalTitle);
    const cleanExtraTitles = extraTitles.map(cleanText).filter(Boolean);
    let bestMatch = null;
    let bestScore = -1;

    for (const r of uniqueResults) {
      const cleanResultTitle = cleanText(r.title);
      const slug = extractSeriesSlug(r.url) || '';
      const cleanSlug = cleanText(slug.replace(/-/g, ' '));
      const matchesTitle = cleanTargetTitle && (cleanResultTitle.includes(cleanTargetTitle) || cleanTargetTitle.includes(cleanResultTitle));
      const matchesOriginal = cleanOriginalTitle && (cleanResultTitle.includes(cleanOriginalTitle) || cleanOriginalTitle.includes(cleanResultTitle));
      const matchesExtra = cleanExtraTitles.some((extra) => cleanResultTitle.includes(extra) || extra.includes(cleanResultTitle));
      const cleanSlugMatchesExtra = cleanExtraTitles.includes(cleanSlug);

      if (matchesTitle || matchesOriginal || matchesExtra || cleanSlug === cleanTargetTitle || cleanSlug === cleanOriginalTitle || cleanSlugMatchesExtra) {
        let score = 0;

        if (matchesTitle) score += 3;
        if (matchesOriginal) score += 2;
        if (matchesExtra) score += 2;
        if (cleanSlug === cleanTargetTitle || cleanSlug === cleanOriginalTitle || cleanSlugMatchesExtra) score += 4;
        if (cleanResultTitle === cleanTargetTitle || cleanResultTitle === cleanOriginalTitle || cleanExtraTitles.includes(cleanResultTitle)) score += 3;

        if (year) {
          const hasYear = r.title.includes(year.toString()) || cleanResultTitle.includes(year.toString()) || cleanSlug.includes(year.toString());
          if (hasYear) score += 2;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = r;
        }
      }
    }
    return bestMatch;
  }

  try {
    let bestMatch = await performSearch(title);

    if (!bestMatch && originalTitle && cleanText(originalTitle) !== cleanText(title)) {
      console.log(`Cinecalidad: No match for "${title}", trying originalTitle "${originalTitle}"`);
      bestMatch = await performSearch(originalTitle);
    }

    const triedClean = new Set([cleanText(title), cleanText(originalTitle)]);
    for (const extraTitle of extraTitles) {
      if (bestMatch) break;
      const cleanExtra = cleanText(extraTitle);
      if (!cleanExtra || triedClean.has(cleanExtra)) continue;
      triedClean.add(cleanExtra);
      console.log(`Cinecalidad: No match yet, trying alternative title "${extraTitle}"`);
      bestMatch = await performSearch(extraTitle);
    }

    if (!bestMatch) {
      console.log(`Cinecalidad: No matching content found for "${title}"`);
      return [];
    }

    let targetPageUrl = bestMatch.url;
    if (type === 'series') {
      const slug = extractSeriesSlug(targetPageUrl);
      if (!slug) {
        console.log(`Cinecalidad: Could not extract a series slug for "${title}"`);
        return [];
      }
      targetPageUrl = buildEpisodeUrlFromSeriesSlug(slug, season, episode);
    }

    console.log(`Cinecalidad: Matched target page: ${bestMatch.title} (${targetPageUrl})`);

    // Fetch movie page to get player tabs
    const { res: movieRes, text: movieHtml } = await fetchTextWithTimeout(targetPageUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, PAGE_TIMEOUT_MS);
    if (!movieRes.ok) return [];
    const movieDoc = cheerio.load(movieHtml);

    const playerOptions = [];

    // Parse player options from the playeroptionsul list
    movieDoc('#playeroptionsul li').each((i, el) => {
      const playerUrl = movieDoc(el).attr('data-option');
      let serverName = movieDoc(el).text().trim() || `Servidor ${i + 1}`;
      
      // Skip trailer
      if (serverName.toLowerCase().includes('trailer') || (playerUrl && playerUrl.includes('youtube.com'))) {
        return;
      }

      if (playerUrl) {
        playerOptions.push({
          playerUrl,
          serverName: normalizeServerName(serverName)
        });
      }
    });

    console.log(`Cinecalidad: Found ${playerOptions.length} player options. Fetching stream sources...`);
    const sortedPlayerOptions = sortPlayerOptions(playerOptions);

    const streams = [];
    const downloadPageLinks = extractDownloadPageLinks(movieDoc);
    const externalDownloadLinks = extractExternalDownloadLinks(movieDoc);

    // Concurrently fetch player pages and extract direct video streams
    const playerController = new AbortController();
    const abortPlayerResolvers = () => playerController.abort();
    if (signal) {
      if (signal.aborted) {
        playerController.abort();
      } else {
        signal.addEventListener('abort', abortPlayerResolvers, { once: true });
      }
    }

    const playerPromises = sortedPlayerOptions.map(async (opt) => {
      try {
        const directUrl = await unpacker.resolvePlayerStream(opt.playerUrl, userAgent, targetPageUrl, { signal: playerController.signal });

        if (directUrl) {
          const streamObj = {
            name: `Cinecalidad`,
            title: `🇲🇽 ${opt.serverName}`,
            url: directUrl,
            behaviorHints: {
              notWebReady: true,
              proxyHeaders: {
                request: {
                  "User-Agent": userAgent,
                  "Referer": opt.playerUrl
                }
              }
            }
          };
          streams.push(streamObj);
        }
      } catch (err) {
        console.error(`Cinecalidad: Error resolving direct stream for ${opt.serverName}:`, err.message);
      }
    });

    const playerCompletion = await waitForPlayerResolvers(playerPromises, streams);
    if (playerCompletion !== 'complete') {
      playerController.abort();
    }
    if (signal) {
      signal.removeEventListener('abort', abortPlayerResolvers);
    }

    const downloadTargets = await Promise.all(
      downloadPageLinks.map(async (downloadLink) => {
        const resolvedUrl = await resolveDownloadPage(downloadLink.downloadPageUrl, userAgent, targetPageUrl, signal);
        if (!resolvedUrl) return null;
        const isPlayable = await isPlayableDownloadTarget(resolvedUrl, userAgent, targetPageUrl, signal);
        if (!isPlayable) return null;

        return {
          name: 'Cinecalidad',
          title: `⬇ ${downloadLink.serverName}`,
          url: resolvedUrl,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'User-Agent': userAgent,
                'Referer': targetPageUrl
              }
            }
          }
        };
      })
    );

    for (const stream of downloadTargets.filter(Boolean)) {
      streams.push(stream);
    }

    for (const link of externalDownloadLinks) {
      const isPlayable = await isPlayableDownloadTarget(link.downloadUrl, userAgent, targetPageUrl, signal);
      if (!isPlayable) continue;

      if (!streams.some((stream) => stream.url === link.downloadUrl)) {
        streams.push({
          name: 'Cinecalidad',
          title: `⬇ ${link.serverName}`,
          url: link.downloadUrl,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'User-Agent': userAgent,
                'Referer': targetPageUrl
              }
            }
          }
        });
      }
    }

    const resolvedStreams = [...streams];
    console.log(`Cinecalidad: Resolved ${resolvedStreams.length} stream options`);
    return resolvedStreams;

  } catch (error) {
    console.error(`Cinecalidad scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = { scrape };

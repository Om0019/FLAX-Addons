const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, fetchWithTimeout } = require('../http');
const { cleanText, mapWithConcurrency } = require('./common');
const PLAYER_CONCURRENCY = 5;
const PLAYER_RESOLVE_TIMEOUT_MS = 1800;
const PAGE_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;


function slugifyTitle(str, options = {}) {
  if (!str) return '';

  const { ampersandWord = 'y' } = options;

  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ` ${ampersandWord} `)
    .replace(/\band\b/g, ampersandWord)
    .replace(/\by\b/g, ampersandWord)
    .replace(/['’:.!,?()[\]/]+/g, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function buildSlugCandidates(title, originalTitle, extraTitles = []) {
  const candidates = [];
  const seen = new Set();
  const values = [title, originalTitle, ...extraTitles].filter(Boolean);
  const ampWords = ['y', 'and'];

  for (const value of values) {
    for (const ampWord of ampWords) {
      const slug = slugifyTitle(value, { ampersandWord: ampWord });
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      candidates.push(slug);
    }
  }

  return candidates;
}

function buildPageCandidates(type, title, originalTitle, extraTitles = []) {
  const basePath = type === 'series' ? 'serie' : 'pelicula';
  return buildSlugCandidates(title, originalTitle, extraTitles).map((slug) => ({
    slug,
    url: `https://cuevana3i.you/${basePath}/${slug}`
  }));
}


async function resolveWithTimeout(url, userAgent, referer, signal) {
  let timer;
  try {
    return await Promise.race([
      unpacker.resolvePlayerStream(url, userAgent, referer, { signal }),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(null), PLAYER_RESOLVE_TIMEOUT_MS);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Looked up by comparing attribute values rather than by building a selector out
// of the URL: wrapper URLs carry quotes and brackets that break selector parsing,
// and a parse error here would abort the whole scrape.
function findOptionLabel(pageDoc, wrapperUrl) {
  let label = '';
  pageDoc('[data-url]').each((_, el) => {
    if (label) return;
    if (pageDoc(el).attr('data-url') === wrapperUrl) {
      label = pageDoc(el).text().trim();
    }
  });
  return label;
}

function extractWrapperUrls(html) {
  const matches = html.match(/https:\/\/tungtungsahur\.cuevana3i\.you\/\?(?:token|v)=[^"'`\s<>]+/g) || [];
  return [...new Set(matches)];
}

function isTokenWrapper(wrapperUrl) {
  try {
    return new URL(wrapperUrl).searchParams.has('token');
  } catch {
    return false;
  }
}

function sortWrapperUrls(wrapperUrls) {
  const tokenWrappers = wrapperUrls.filter(isTokenWrapper);
  const otherWrappers = wrapperUrls.filter((url) => !isTokenWrapper(url));

  if (tokenWrappers.length > 0) {
    return [...tokenWrappers].sort((a, b) => scoreDecodedWrapper(a) - scoreDecodedWrapper(b));
  }

  return otherWrappers.slice(0, 2);
}

function scoreDecodedWrapper(wrapperUrl) {
  const decodedUrl = decodeWrapperUrl(wrapperUrl) || wrapperUrl;
  const host = (() => {
    try {
      return new URL(decodedUrl).hostname.toLowerCase();
    } catch {
      return '';
    }
  })();

  if (host.includes('tiktokshopping.xyz')) return 0;
  if (host.includes('filemoon')) return 7;
  if (host.includes('dood')) return 8;
  if (host.includes('vidlink.pro') || host.includes('vidapi.xyz') || host.includes('videasy') || host.includes('vsembed')) return 9;
  return 4;
}

function decodeWrapperUrl(wrapperUrl) {
  try {
    const parsed = new URL(wrapperUrl);
    const token = parsed.searchParams.get('token');
    if (token) {
      const servers = {
        1: 'https://tiktokshopping.xyz/v/',
        2: 'https://filemoon.sx/e/',
        3: 'https://martinshop.xyz/e/',
        4: 'https://dood.li/e/'
      };
      const baseUrl = servers[token[0]];
      if (baseUrl) {
        const key = 'a45f04ce-2394-47c3-b718-0ecd97ce51d6';
        const decoded = Buffer.from(token.slice(1), 'base64').toString('binary');
        let decrypted = '';
        for (let i = 0; i < decoded.length; i++) {
          decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }

        if (decrypted) {
          return baseUrl + decrypted;
        }
      }
    }

    const v = parsed.searchParams.get('v');
    if (v) {
      const decoded = Buffer.from(v, 'base64').toString('utf8').trim();
      if (decoded.startsWith('http')) {
        return decoded;
      }
    }
  } catch (err) {
    // Ignore malformed wrappers.
  }

  return null;
}

async function probePage(candidate, userAgent, signal) {
  try {
    const res = await fetchWithTimeout(candidate.url, {
      headers: { 'User-Agent': userAgent },
      signal
    }, PROBE_TIMEOUT_MS);

    if (!res.ok) return null;
    return candidate;
  } catch (err) {
    return null;
  }
}

async function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  try {
    let bestMatch = null;
    const candidates = buildPageCandidates(type, title, originalTitle, extraTitles);

    for (const candidate of candidates) {
      bestMatch = await probePage(candidate, userAgent, signal);
      if (bestMatch) {
        console.log(`Cuevana3i: Using candidate URL ${bestMatch.url}`);
        break;
      }
    }

    if (!bestMatch) {
      console.log(`Cuevana3i: No matching content found for "${title}"`);
      return [];
    }

    const targetPageUrl = type === 'series'
      ? `${bestMatch.url}/episodio-${season}x${episode}`
      : bestMatch.url;

    const { res: pageRes, text: pageHtml } = await fetchTextWithTimeout(targetPageUrl, {
      headers: { 'User-Agent': userAgent },
      signal
    }, PAGE_TIMEOUT_MS);
    if (!pageRes.ok) {
      console.warn(`Cuevana3i: Failed to fetch target page ${targetPageUrl} (${pageRes.status})`);
      return [];
    }
    const pageDoc = cheerio.load(pageHtml);

    const wrapperUrls = sortWrapperUrls(extractWrapperUrls(pageHtml));
    console.log(`Cuevana3i: Found ${wrapperUrls.length} player wrappers`);

    const streams = await mapWithConcurrency(wrapperUrls, PLAYER_CONCURRENCY, async (wrapperUrl, index) => {
      const decodedUrl = decodeWrapperUrl(wrapperUrl);
      const optionName = findOptionLabel(pageDoc, wrapperUrl) || `Opcion ${index + 1}`;

      let directUrl = null;
      if (decodedUrl) {
        try {
          directUrl = await resolveWithTimeout(decodedUrl, userAgent, targetPageUrl, signal);
        } catch (err) {
          console.error(`Cuevana3i: Error resolving decoded player for ${optionName}:`, err.message);
        }
      }

      if (directUrl) {
        return {
          name: 'Cuevana3i',
          title: `🇲🇽 ${optionName}`,
          url: directUrl,
          behaviorHints: {
            notWebReady: true,
            proxyHeaders: {
              request: {
                'User-Agent': userAgent,
                'Referer': decodedUrl || targetPageUrl
              }
            }
          }
        };
      }

      return null;
    });

    return streams;
  } catch (error) {
    console.error(`Cuevana3i scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: { findOptionLabel }
};

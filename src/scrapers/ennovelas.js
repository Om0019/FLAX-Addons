const cheerio = require('cheerio');
const unpacker = require('../unpacker');
const { fetchTextWithTimeout, normalizeUrl } = require('../http');
const { cleanText, mapWithConcurrency, raceTitleSearches } = require('./common');

const BASE_URL = 'https://l.ennovelas-tv.com';
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const PLAYER_CONCURRENCY = 3;
// Each miss costs about 600ms against the 10s a scraper gets, and the search
// fallback still needs room, so this buys the season-specific shapes below
// without crowding it out.
const MAX_DIRECT_PROBES = 5;

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
  const match = String(value || '').match(/(?:cap[ií]tulo|ep)[\s._-]*(\d+)/i);
  return match ? parseInt(match[1], 10) : null;
}

function titleWithoutEpisode(value) {
  return String(value || '')
    .replace(/\s+(?:cap[ií]tulo|ep)\s*\d+[\s\S]*$/i, '')
    .trim();
}

function scoreEpisodeCandidate(result, query, originalTitle, extraTitles = [], season = null) {
  const cleanQuery = cleanText(query);
  const cleanOriginal = cleanText(originalTitle);
  const slugText = result.url.match(/\/([^/?#]+)\/?$/)?.[1]?.replace(/-/g, ' ');
  const cleanResultTitle = cleanText(titleWithoutEpisode(result.title));
  const cleanSlugTitle = cleanText(titleWithoutEpisode(slugText));
  const cleanExtras = extraTitles.map(cleanText).filter(Boolean);

  // A show's episode numbering restarts every season, so a result that names a
  // different season than the one asked for is the same episode number from the
  // wrong run of the show — not a weaker match, a wrong one. "40 y 20" is the case
  // that exposed this: its title ends in a number, so the season is never appended
  // to the query, and a search for season 7 episode 12 scored the season 1 page
  // exactly as highly as the season 7 one and picked whichever came first.
  const resultSeason = seasonFromText(`${result.title} ${slugText || ''}`);
  if (season && resultSeason && resultSeason !== Number(season)) return -1;

  let score = 0;
  if (season && resultSeason === Number(season)) score += 6;

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

/**
 * The two URL shapes every stem is tried in. Counted over the site's own sitemap
 * (9000 episode slugs): 8997 are `<stem>-capitulo-<n>` and 94 of those end in
 * `-final`, which is why the last episode of a run needs its own candidate.
 *
 * `-episodio-<n>` used to be probed here and has been dropped: the sitemap
 * contains zero of them, so it never matched anything and only spent a slot out
 * of the probe budget that the season shapes below now use.
 */
function episodeUrlCandidates(slug, episode) {
  return [
    `${BASE_URL}/${slug}-capitulo-${episode}/`,
    `${BASE_URL}/${slug}-capitulo-${episode}-final/`
  ];
}

/**
 * Slug stems for a specific season. The site writes a season into the slug three
 * different ways, and the plain title is not one of them — for a multi-season show
 * `<slug>-capitulo-<n>` is either a 404 or, worse, the same episode number from a
 * different season. Frequencies over the same 9000 slugs:
 *
 *   <slug>-<season>-temporada-capitulo-<n>   967
 *   <slug>-<season>-capitulo-<n>             522   (via the season-augmented query)
 *   <slug>-temporada-<season>-capitulo-<n>   112
 *
 * The bare-number form arrives already slugged from buildSearchTitles, so only the
 * two "temporada" spellings are built here.
 *
 * Season 1 gets them too. A show that numbers its seasons in the slug numbers the
 * first one as well — `40-y-20-temporada-1-capitulo-13` is a live page while the
 * plain `40-y-20-capitulo-13` is a 404 — and search cannot rescue that case: the
 * site returns one page of results, newest season first, so season 1 of a
 * nine-season show is never on it. The caller decides the order, and puts these
 * behind the plain stem when the season is 1.
 */
function seasonSlugStems(baseSlug, season) {
  if (!baseSlug || !(season >= 1)) return [];
  return [
    `${baseSlug}-${season}-temporada`,
    `${baseSlug}-temporada-${season}`
  ];
}

/** The season a result names, or null when it names none. */
function seasonFromText(value) {
  const text = String(value || '');
  const match = text.match(/temporada[\s._-]*(\d+)/i) || text.match(/(\d+)[\s._-]*temporada/i);
  return match ? parseInt(match[1], 10) : null;
}

function isEpisodePage(html, episode) {
  const text = String(html || '');
  return new RegExp(`(?:cap[ií]tulo|ep)\\s*${Number(episode)}\\b`, 'i').test(text)
    && /novel\.php\?post=|\/emb\/\?vid=|twitter:player/i.test(text);
}

async function fetchPageOk(url, userAgent, signal, episode) {
  try {
    const { res, text } = await fetchTextWithTimeout(url, {
      headers: browserHeaders(userAgent),
      signal
    }, PAGE_TIMEOUT_MS);
    if (!res.ok || /No result found|P[aá]gina no encontrada/i.test(text)) return null;
    if (episode && !isEpisodePage(text, episode)) return null;
    return text;
  } catch {
    return null;
  }
}

function extractEpisodeResults(html) {
  const $ = cheerio.load(html || '');
  const results = [];
  const seen = new Set();

  $('article, .post, .item, .ml-item').each((_, el) => {
    const href = $(el).find('a[href*="capitulo"],a[href*="episodio"]').first().attr('href');
    const url = normalizeUrl(href, BASE_URL);
    if (!url || seen.has(url)) return;

    const title = (
      $(el).find('h1,h2,h3,h4,.entry-title,.title').first().text()
      || $(el).find('img').attr('alt')
      || $(el).find('a[href*="capitulo"],a[href*="episodio"]').first().attr('title')
      || $(el).find('a[href*="capitulo"],a[href*="episodio"]').first().text()
    ).trim().replace(/\s+/g, ' ');

    if (title) {
      seen.add(url);
      results.push({ url, title });
    }
  });

  $('a[href*="capitulo"],a[href*="episodio"]').each((_, el) => {
    const url = normalizeUrl($(el).attr('href'), BASE_URL);
    if (!url || seen.has(url)) return;

    const title = ($(el).attr('title') || $(el).find('img').attr('alt') || $(el).text() || '')
      .trim()
      .replace(/\s+/g, ' ');
    if (!title || !episodeNumberFromText(`${title} ${url}`)) return;

    seen.add(url);
    results.push({ url, title });
  });

  return results;
}

async function findEpisodeUrl(title, originalTitle, season, episode, userAgent, signal, extraTitles = []) {
  const queries = buildSearchTitles(title, originalTitle, season, extraTitles);

  const seasonStems = [];
  const plainStems = [];

  for (const baseTitle of [title, originalTitle, ...extraTitles]) {
    // Deliberately the unaugmented title: slugifying "40 y 20" and stripping a
    // trailing number to find the base would leave "40 y", so the base has to come
    // from the title as given rather than from a query built out of it.
    seasonStems.push(...seasonSlugStems(slugifyTitle(baseTitle), season));
  }
  for (const query of queries) plainStems.push(slugifyTitle(query));

  // Past season 1 the season-specific stems lead, because the plain slug is then
  // either a 404 or another season's episode with the same number. At season 1 the
  // plain slug is the overwhelming majority — 8997 of the site's 9000 episodes —
  // so it goes first and the season shapes back it up.
  const orderedStems = season > 1
    ? [...seasonStems, ...plainStems]
    : [...plainStems, ...seasonStems];

  const stems = [];
  const seenStems = new Set();
  for (const stem of orderedStems) {
    if (!stem || seenStems.has(stem)) continue;
    seenStems.add(stem);
    stems.push(stem);
  }

  // Every stem's plain form is tried before any stem's "-final" form: only 94 of
  // the site's 9000 episodes end a run, so a "-final" probe is far likelier to be
  // a wasted slot than a hit.
  const candidateUrls = stems.flatMap((stem) => episodeUrlCandidates(stem, episode));
  const orderedUrls = [
    ...candidateUrls.filter((url) => !url.endsWith('-final/')),
    ...candidateUrls.filter((url) => url.endsWith('-final/'))
  ];

  let probesLeft = MAX_DIRECT_PROBES;
  for (const url of orderedUrls) {
    if (probesLeft <= 0) break;
    probesLeft -= 1;
    const html = await fetchPageOk(url, userAgent, signal, episode);
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
        const score = scoreEpisodeCandidate(result, query, originalTitle, [title, ...extraTitles], season);
        if (score > bestScore) {
          bestMatch = result;
          bestScore = score;
        }
      }

      console.log(`Ennovelas search "${query}" best episode score ${bestScore}`);
      return bestMatch?.url || null;
    } catch (error) {
      console.warn(`Ennovelas: Search failed for "${query}": ${error.message}`);
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

function extractPostWrapperUrls(value) {
  const urls = [];
  let payload;
  try {
    const parsed = new URL(value);
    payload = parsed.searchParams.get('post');
  } catch {
    payload = null;
  }
  if (!payload) return urls;

  try {
    const decoded = Buffer.from(payload, 'base64').toString('utf8');
    const data = JSON.parse(decoded);
    for (const url of Object.values(data)) {
      if (typeof url === 'string') urls.push(url.replace(/\\\//g, '/'));
    }
  } catch {
    // Leave malformed or changed wrappers out rather than leaking them as streams.
  }

  return urls;
}

/**
 * Repairs the two malformed player URLs this source publishes.
 *
 * The wrapper payloads carry a doubled embed prefix on a share of their uqload
 * links — `/embed-embed-<id>.html`, which is a 404 every time, while the same id
 * at `/embed-<id>.html` serves the stream. It was 7 of the 22 uqload.co links in a
 * 40-novela sample, and none of those 22 resolved before this.
 *
 * VK is also given both as the embed endpoint and as a watch page
 * (`/video<oid>_<id>`). Only the embed endpoint serves a player, so the watch form
 * is rewritten to it rather than followed to a page with no config in it.
 */
function normalizePlayerUrl(url) {
  let normalized = url.replace(/\/embed-(?:embed-)+/i, '/embed-');

  try {
    const parsed = new URL(normalized);
    const watchMatch = /(^|\.)vk\.com$/i.test(parsed.hostname)
      && parsed.pathname.match(/^\/video(-?\d+)_(\d+)/);
    if (watchMatch) {
      normalized = `${parsed.origin}/video_ext.php?oid=${watchMatch[1]}&id=${watchMatch[2]}`;
    }
  } catch {
    // Leave anything that will not parse to isPlayableCandidate to reject.
  }

  return normalized;
}

function extractPlayerUrls(html, pageUrl) {
  const $ = cheerio.load(html || '');
  const urls = [];
  const seen = new Set();

  function addUrl(value) {
    const normalized = normalizeUrl(value, pageUrl);
    if (!normalized) return;
    const url = normalizePlayerUrl(normalized);
    if (seen.has(url) || !isPlayableCandidate(url)) return;
    seen.add(url);
    urls.push(url);
  }

  $('a[href*="novel.php?post="]').each((_, el) => {
    for (const url of extractPostWrapperUrls($(el).attr('href'))) {
      addUrl(url);
    }
  });

  $('iframe[src],embed[src],video[src],source[src]').each((_, el) => addUrl($(el).attr('src')));
  $('meta[property="og:video:secure_url"],meta[name="twitter:player"]').each((_, el) => addUrl($(el).attr('content')));

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
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return false;
    if (/(^|\.)ennovelas-tv\.com$/i.test(parsed.hostname)) return false;
    return /^\/(?:embed-|e|f|v|video_ext\.php)/i.test(parsed.pathname)
      || /\/embed/i.test(parsed.pathname)
      || /\.(?:m3u8|mp4|mkv)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

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
    const episodeMatch = await findEpisodeUrl(title, originalTitle, season, episode, userAgent, signal, extraTitles);
    if (!episodeMatch) {
      console.log(`Ennovelas: No episode found for "${title}" episode ${episode}`);
      return [];
    }

    const episodeHtml = episodeMatch.html || await fetchPageOk(episodeMatch.url, userAgent, signal, episode);
    if (!episodeHtml) return [];

    const playerUrls = extractPlayerUrls(episodeHtml, episodeMatch.url);
    console.log(`Ennovelas: Found ${playerUrls.length} player URLs`);

    return await mapWithConcurrency(playerUrls, PLAYER_CONCURRENCY, async (playerUrl) => {
      try {
        const resolvedUrl = await unpacker.resolvePlayerStream(playerUrl, userAgent, episodeMatch.url, { signal });
        if (!resolvedUrl) return null;

        return {
          name: 'Ennovelas',
          title: `Latino ${playerLabel(playerUrl)}`,
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
        console.warn(`Ennovelas: Player ${playerUrl} failed: ${error.message}`);
        return null;
      }
    });
  } catch (error) {
    console.error(`Ennovelas scrape error for "${title}":`, error.message);
    return [];
  }
}

module.exports = {
  scrape,
  __test: {
    buildSearchTitles,
    episodeNumberFromText,
    episodeUrlCandidates,
    extractEpisodeResults,
    extractPlayerUrls,
    extractPostWrapperUrls,
    isPlayableCandidate,
    normalizePlayerUrl,
    playerLabel,
    scoreEpisodeCandidate,
    seasonFromText,
    seasonSlugStems,
    slugifyTitle,
    titleWithoutEpisode
  }
};

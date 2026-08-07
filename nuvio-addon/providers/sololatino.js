/**
 * SoloLatino provider for Nuvio Local Scrapers.
 *
 * Ported from the "Latino" Stremio addon (src/scrapers/sololatino.js +
 * src/unpacker.js + src/tmdb.js + src/http.js). That addon ran as an Express
 * server and used Node's `http`/`crypto`/`Buffer` plus several sibling
 * modules loaded with `require`. Nuvio's local-scraper sandbox instead:
 *   - loads exactly this one file and calls `getStreams(...)` on it
 *   - has no Node built-ins (no `crypto`, no `Buffer`, no `fs`)
 *   - has no `async`/`await` support, so everything here is Promise chains
 *
 * Three of the original addon's iframe resolvers depend on Node's `crypto`
 * module for real cryptography (AES-GCM / AES-CBC / SHA-256) that cannot be
 * reasonably reimplemented by hand in a single file:
 *   - Filemoon (AES-128/256-GCM playback payloads) — and per the original
 *     code's own findings, gated behind a captcha on effectively every file
 *     anyway, so little is lost by dropping it.
 *   - Pelisplus mirrors (AES-128-CBC API responses)
 *   - embed69 (AES-256-CBC + a SHA-256 proof-of-work)
 * Those three are stubbed out below (they log and return null) rather than
 * silently mis-resolving. Everything else from the original unpacker —
 * SoloLatino's own pelisserieshoy player, Dean Edwards `eval(function(p,a,c,k,e,d)`
 * unpacking, VOE, Dood, Streamtape, Nupload, MediaFire, VidGuard, Xupalace
 * multi-server pages, JS redirects and iframe chasing — is ported faithfully.
 */

// Nuvio's sandbox is documented to provide `cheerio-without-node-native` as an
// available tool (alongside `fetch`); this falls back to `require('cheerio')`
// so the file can also be run/tested under plain Node.
let cheerio;
try {
  cheerio = require('cheerio');
} catch {
  cheerio = typeof global !== 'undefined' ? global.cheerio : undefined;
}

// ---------------------------------------------------------------------------
// base64 helpers (replacement for Node's Buffer, which isn't available here)
// ---------------------------------------------------------------------------

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decodes a base64 string into an array of byte values (0-255). */
function base64ToBytes(b64) {
  const clean = String(b64 || '').replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  let buffer = 0;
  let bits = 0;

  for (let i = 0; i < clean.length; i += 1) {
    const c = clean[i];
    if (c === '=') break;
    const val = BASE64_CHARS.indexOf(c);
    if (val === -1) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }

  return bytes;
}

/** Encodes a JS string (treated byte-for-byte, i.e. latin1) as base64. */
function bytesToBase64(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;

    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 3) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 15) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 63];
  }
  return out;
}

/** Decodes base64 into a "binary string" (one char per byte, like Buffer's 'binary'/'latin1'). */
function base64ToBinaryString(b64) {
  return base64ToBytes(b64).map((byte) => String.fromCharCode(byte)).join('');
}

/** Decodes a UTF-8 byte sequence (as produced by base64ToBytes) into a JS string. */
function bytesToUtf8String(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 >= 0xc0 && b0 < 0xe0 && i < bytes.length) {
      const b1 = bytes[i++];
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if (b0 >= 0xe0 && b0 < 0xf0 && i + 1 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else if (b0 >= 0xf0 && i + 2 < bytes.length) {
      const b1 = bytes[i++];
      const b2 = bytes[i++];
      const b3 = bytes[i++];
      let codepoint = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      codepoint -= 0x10000;
      out += String.fromCharCode(0xd800 + (codepoint >> 10), 0xdc00 + (codepoint & 0x3ff));
    } else {
      out += String.fromCharCode(b0);
    }
  }
  return out;
}

function base64ToUtf8String(b64) {
  return bytesToUtf8String(base64ToBytes(b64));
}

// ---------------------------------------------------------------------------
// http helpers (fetch + timeout/abort, no Node `http` module)
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 6000;

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(value, baseUrl) {
  if (!value) return null;
  let url = decodeHtmlEntities(value).trim();
  url = url.replace(/\\\//g, '/');
  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

/** Promise-chain equivalent of the original addon's fetchWithDeadline. */
function fetchWithDeadline(url, options, timeoutMs, consume) {
  return new Promise((resolve, reject) => {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);

    const externalSignal = options.signal;
    const abortFromExternalSignal = () => controller.abort();
    if (externalSignal) {
      if (externalSignal.aborted) controller.abort();
      else externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
    }

    const { signal, ...fetchOptions } = options;

    function cleanup() {
      clearTimeout(timeoutId);
      if (externalSignal) externalSignal.removeEventListener('abort', abortFromExternalSignal);
    }

    fetch(url, { ...fetchOptions, signal: controller.signal })
      .then((res) => Promise.resolve(consume(res)))
      .then((result) => {
        cleanup();
        resolve(result);
      })
      .catch((error) => {
        cleanup();
        if (error && error.name === 'AbortError') {
          reject(new Error(timedOut ? `Fetch timeout after ${timeoutMs}ms: ${url}` : `Fetch aborted: ${url}`));
        } else {
          reject(error);
        }
      });
  });
}

function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchWithDeadline(url, options, timeoutMs, (res) => res);
}

function fetchTextWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchWithDeadline(url, options, timeoutMs, (res) => res.text().then((text) => ({ res, text })));
}

function fetchJsonWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchTextWithTimeout(url, options, timeoutMs).then(({ res, text }) => {
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    return { res, text, data };
  });
}

// ---------------------------------------------------------------------------
// small TTL cache (sync; ported unchanged from src/ttl-cache.js)
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 30 * 1000;

function createTtlCache({ maxEntries = 500 } = {}) {
  const entries = new Map();
  let lastSweptAt = 0;

  function sweepExpired(now) {
    lastSweptAt = now;
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
  }

  function enforceMaxEntries() {
    while (entries.size > maxEntries) {
      const oldestKey = entries.keys().next().value;
      if (oldestKey === undefined) break;
      entries.delete(oldestKey);
    }
  }

  function pruneOnWrite() {
    const now = Date.now();
    if (entries.size > maxEntries || now - lastSweptAt >= SWEEP_INTERVAL_MS) {
      sweepExpired(now);
    }
    enforceMaxEntries();
  }

  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= Date.now()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value, ttlMs) {
      entries.delete(key);
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
      pruneOnWrite();
      return value;
    }
  };
}

// ---------------------------------------------------------------------------
// concurrency helpers (Promise-chain ports of src/concurrency.js + common.js)
// ---------------------------------------------------------------------------

/**
 * Runs `worker` over `items` with at most `concurrency` in flight and resolves
 * to the result of the *earliest* item that produced a truthy result, not
 * whichever settles first.
 */
function firstResultInOrder(items, concurrency, worker) {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve(null);
      return;
    }

    const results = new Array(items.length);
    const done = new Array(items.length).fill(false);
    let cursor = 0;
    let settledIndex = -1;
    let stopped = false;

    function checkOrder() {
      while (settledIndex + 1 < items.length && done[settledIndex + 1]) {
        settledIndex += 1;
        if (results[settledIndex]) {
          stopped = true;
          resolve(results[settledIndex]);
          return true;
        }
      }
      if (settledIndex === items.length - 1) {
        resolve(null);
        return true;
      }
      return false;
    }

    function runNext() {
      if (stopped) return;
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;

      Promise.resolve()
        .then(() => worker(items[index], index))
        .catch(() => null)
        .then((outcome) => {
          results[index] = outcome;
          done[index] = true;
          if (!checkOrder()) runNext();
        });
    }

    const runners = Math.max(1, Math.min(concurrency, items.length));
    for (let i = 0; i < runners; i += 1) runNext();
  });
}

/** Runs `worker` over `items` with bounded concurrency, collecting truthy results. */
function mapWithConcurrency(items, concurrency, worker) {
  return new Promise((resolve) => {
    if (items.length === 0) {
      resolve([]);
      return;
    }

    const results = [];
    let cursor = 0;
    let doneCount = 0;

    function runNext() {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        Promise.resolve()
          .then(() => worker(items[index], index))
          .catch(() => null)
          .then((result) => {
            if (result) results.push(result);
            doneCount += 1;
            if (doneCount === items.length) resolve(results);
          });
        return;
      }
    }

    const runners = Math.max(1, Math.min(concurrency, items.length));
    for (let i = 0; i < runners; i += 1) runNext();
  });
}

/**
 * Searches every title in `titles`, preferring the match belonging to the
 * earliest title even though the requests are fired concurrently.
 */
function raceTitleSearches(titles, search) {
  const attempts = titles.map((title) =>
    Promise.resolve()
      .then(() => search(title))
      .then((match) => ({ match }), (error) => ({ error }))
  );

  function checkIndex(i) {
    if (i >= attempts.length) return Promise.resolve(null);
    return attempts[i].then(({ match, error }) => {
      if (error) throw error;
      if (match) return match;
      return checkIndex(i + 1);
    });
  }

  return checkIndex(0);
}

function cleanText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function extractCandidateYears(...values) {
  const years = new Set();
  for (const value of values) {
    const matches = String(value || '').match(/\b(?:19|20)\d{2}\b/g) || [];
    for (const match of matches) years.add(match);
  }
  return years;
}

// ---------------------------------------------------------------------------
// TMDB lookup (Nuvio hands us a tmdbId, not a title, so this replaces the
// addon's own /stream route which received the title already resolved)
// ---------------------------------------------------------------------------

const TMDB_API_KEY = ((typeof process !== "undefined" && process.env ? process.env.TMDB_API_KEY : undefined) || '');
const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
const TMDB_TIMEOUT_MS = 5000;
const tmdbCache = createTtlCache({ maxEntries: 200 });

function fetchFromTmdb(path, params = {}) {
  const queryParams = new URLSearchParams({ api_key: TMDB_API_KEY, ...params });
  const url = `${TMDB_BASE_URL}${path}?${queryParams.toString()}`;

  const cached = tmdbCache.get(url);
  if (cached !== undefined) return Promise.resolve(cached);

  return fetchJsonWithTimeout(url, {}, TMDB_TIMEOUT_MS).then(({ res, data }) => {
    if (!res.ok || data === null) {
      throw new Error(`TMDB API error ${res.status} at ${path}`);
    }
    return tmdbCache.set(url, data, 6 * 60 * 60 * 1000);
  });
}

function fetchTmdbDetails(tmdbId, mediaType) {
  const tmdbType = mediaType === 'tv' ? 'tv' : 'movie';
  return fetchFromTmdb(`/${tmdbType}/${tmdbId}`, { language: 'es-MX' })
    .then((data) => {
      const title = data.title || data.name || data.original_title || data.original_name;
      const originalTitle = data.original_title || data.original_name;
      const year = (data.release_date || data.first_air_date || '').substring(0, 4) || null;
      return { title, originalTitle, year: year ? Number(year) : null };
    })
    .catch((error) => {
      console.error(`SoloLatino: TMDB lookup failed for ${mediaType}/${tmdbId}:`, error.message);
      return null;
    });
}

function getAlternativeTitles(mediaType, tmdbId) {
  const tmdbType = mediaType === 'tv' ? 'tv' : 'movie';
  return fetchFromTmdb(`/${tmdbType}/${tmdbId}/translations`)
    .then((data) => {
      const entries = data.translations || [];
      const titles = new Set();
      for (const entry of entries) {
        if (entry.iso_639_1 !== 'es') continue;
        const value = (entry.data?.name || entry.data?.title || '').trim();
        if (value) titles.add(value);
      }
      return [...titles];
    })
    .catch(() => []);
}

// ---------------------------------------------------------------------------
// generic iframe/player unpacking (ported from src/unpacker.js, minus the
// three AES-gated resolvers noted at the top of this file)
// ---------------------------------------------------------------------------

const PLAYER_FETCH_TIMEOUT_MS = 5000;
const MAX_RESOLVE_DEPTH = 5;
const DOOD_DIRECT_TIMEOUT_MS = 1800;
const EMBED_RESOLVE_CONCURRENCY = 3;
const MAX_EMBED69_ATTEMPTS = 5;
const MAX_VOE_PAYLOADS = 6;

function unpack(p, a, c, k) {
  const e_func = function (c) {
    return (c < a ? '' : e_func(Math.floor(c / a))) + ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  };
  c = Math.min(Number(c) || 0, k.length);
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp('\\b' + e_func(c) + '\\b', 'g'), k[c]);
    }
  }
  return p;
}

function* iterUnpackedScripts(html) {
  const packerRegex = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]*?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)/gi;
  let match;
  while ((match = packerRegex.exec(html || '')) !== null) {
    try {
      const p = match[2].trim();
      const a = parseInt(match[3]);
      const c = parseInt(match[4]);
      const k = match[6].trim().split('|');
      yield unpack(p, a, c, k);
    } catch (err) {
      console.error('SoloLatino unpacker: failed to decode script block:', err.message);
    }
  }
}

const NON_STREAM_MARKERS = ['google-analytics', 'analytics.js', 'tagmanager', 'test-videos.co.uk', 'big_buck_bunny'];
const AD_SEGMENT_PATTERN = /(?:^|[/.])(?:ads?|advert(?:s|ising)?|adserver|doubleclick)(?:[/.]|$)/;

function cleanEscapedStreamUrl(link) {
  return String(link || '')
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+u003[dD]/g, '=')
    .replace(/\\+u002[fF]/g, '/')
    .replace(/\\+u003[fF]/g, '?')
    .replace(/\\+$/, '');
}

function isPlausibleStreamUrl(link) {
  const lower = String(link || '').toLowerCase();
  if (NON_STREAM_MARKERS.some((marker) => lower.includes(marker))) return false;
  try {
    const parsed = new URL(lower);
    return !AD_SEGMENT_PATTERN.test(`${parsed.hostname}${parsed.pathname}`);
  } catch {
    return !AD_SEGMENT_PATTERN.test(lower);
  }
}

function extractDirectStream(html, baseUrl) {
  if (!html) return null;

  const normalizedHtml = decodeHtmlEntities(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\\//g, '/');

  const directRegex = /(https?:[^\s'"`<>]+?\.(?:m3u8|mp4|mkv)[^\s'"`<>]*)/gi;
  const protocolRelativeRegex = /(\/\/[^\s'"`<>]+?\.(?:m3u8|mp4|mkv)[^\s'"`<>]*)/gi;
  const relativeRegex = /((?:\/|\.\/|\.\.\/)[^\s'"`<>]+?\.(?:m3u8|mp4|mkv)[^\s'"`<>]*)/gi;
  const directMatches = normalizedHtml.match(directRegex) || [];
  const protocolRelativeMatches = normalizedHtml.match(protocolRelativeRegex) || [];
  const relativeMatches = normalizedHtml.match(relativeRegex) || [];

  const configuredMatches = [];
  const configPatterns = [
    /(?:file|source|src|url)\s*[:=]\s*['"]([^'"]+\.(?:m3u8|mp4|mkv)[^'"]*)['"]/gi,
    /["'](?:file|source|src|url)["']\s*:\s*["']([^"']+\.(?:m3u8|mp4|mkv)[^"']*)["']/gi,
    /playerjs\.file\s*=\s*['"]([^'"]+)['"]/gi
  ];
  for (const pattern of configPatterns) {
    let configMatch;
    while ((configMatch = pattern.exec(normalizedHtml)) !== null) {
      configuredMatches.push(configMatch[1]);
    }
  }

  const base64Regex = /['"]([A-Za-z0-9+/=]{40,})['"]/g;
  let encodedMatch;
  while ((encodedMatch = base64Regex.exec(normalizedHtml)) !== null) {
    try {
      const decoded = base64ToUtf8String(encodedMatch[1]).replace(/\\\//g, '/');
      if (!decoded.includes('.m3u8') && !decoded.includes('.mp4') && !decoded.includes('.mkv')) continue;
      configuredMatches.push(...(decoded.match(directRegex) || []));
      configuredMatches.push(...(decoded.match(protocolRelativeRegex) || []));
      configuredMatches.push(...(decoded.match(relativeRegex) || []));
    } catch {
      // Ignore non-base64 player config strings.
    }
  }

  const validDirect = [...directMatches, ...protocolRelativeMatches, ...relativeMatches, ...configuredMatches]
    .map(cleanEscapedStreamUrl)
    .map((link) => normalizeUrl(link, baseUrl))
    .filter(Boolean)
    .filter(isPlausibleStreamUrl);

  if (validDirect.length > 0) return [...new Set(validDirect)][0];

  for (const unpacked of iterUnpackedScripts(normalizedHtml)) {
    const streamMatches = unpacked.match(directRegex) || [];
    const validStreams = streamMatches
      .map(cleanEscapedStreamUrl)
      .map((link) => normalizeUrl(link, baseUrl))
      .filter(Boolean)
      .filter(isPlausibleStreamUrl);
    if (validStreams.length > 0) return [...new Set(validStreams)][0];
  }

  return null;
}

function isHttpUrl(value) {
  return /^https?:\/\//i.test(value || '');
}

function getHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isDoodHost(value) {
  const host = getHostname(value);
  return /(^|\.)dood\.(?:li|to|stream|watch|so|pm|ws|re|yt|video)$/i.test(host)
    || /(^|\.)(?:d0{2,4}d|d0o0d|dooood|all3do|doply|vide0)\.(?:com|net|to)$/i.test(host)
    || /(^|\.)(?:doodstream|ds2play|ds2video)\.(?:com|co|net)$/i.test(host)
    || /(^|\.)playmogo\.com$/i.test(host);
}

function isVoeHost(value) {
  const host = getHostname(value);
  return /(^|\.)voe(?:-?un-?bl?o?ck)?\.[a-z]{2,}$/i.test(host) || host.includes('pamelachangemission.com');
}

function isNetuFamilyHost(value) {
  const host = getHostname(value);
  return /(^|\.)(?:waaw\d?|netu|netuplayer|hqq\d?)\.(?:to|tv|ac|watch|com|net)$/i.test(host)
    || /(^|\.)novelas360\.cyou$/i.test(host);
}

const DEFUNCT_HOST_PATTERN = /^(?:www\.)?(?:fembed\.com|gounlimited\.to)$/i;
function isDefunctHost(value) {
  return DEFUNCT_HOST_PATTERN.test(getHostname(value));
}

function isNuploadHost(value) {
  const host = getHostname(value);
  return /(^|\.)n(?:u)?upload\.(?:top|me)$/i.test(host);
}

function isXupalaceHost(value) {
  return /(^|\.)xupalace\.org$/i.test(getHostname(value));
}

function isStreamtapeHost(value) {
  return /(^|\.)(?:streamtape|streamadblockplus|stape|tapewithadblock|streamta)\.(?:com|net|to|xyz|cc|site)$/i.test(getHostname(value));
}

function extractStreamtapeStream(html, baseUrl) {
  if (!html) return null;
  const assignment = html.match(
    /getElementById\(\s*['"]robotlink['"]\s*\)\s*\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]*)['"]\s*\)\s*\.substring\(\s*(\d+)\s*\)/i
  );
  if (!assignment) return null;
  const [, head, tail, offset] = assignment;
  const combined = `${head}${tail.substring(Number(offset))}`;
  if (!combined.includes('get_video')) return null;
  const absolute = combined.startsWith('//') ? `https:${combined}` : normalizeUrl(combined, baseUrl);
  return absolute && isHttpUrl(absolute) ? absolute : null;
}

const VIDGUARD_HOST_PATTERN = /(^|\.)(?:vidguard\.to|vid-guard\.com|listeamed\.net|bembed\.net|v6embed\.xyz|vgembed\.com|vgfplay\.com|embedv\.net|fslinks\.org|818ing\.com|moviesm4u\.com)$/i;
function isVidguardHost(value) {
  return VIDGUARD_HOST_PATTERN.test(getHostname(value));
}

function isMediafireHost(value) {
  return /(^|\.)mediafire\.com$/i.test(getHostname(value));
}

const EMBED_PATH_HOST_PATTERNS = [
  /(^|\.)(?:ahvsh|streamhide|guccihide|movhide)\.(?:com|to|net|pro)$/i,
  /(^|\.)(?:luluvdo|lulustream|lulu)\.(?:com|st|to|net)$/i,
  /(^|\.)vudeo\.(?:io|net|co)$/i,
  VIDGUARD_HOST_PATTERN
];
function isEmbedPathHost(value) {
  const host = getHostname(value);
  return EMBED_PATH_HOST_PATTERNS.some((pattern) => pattern.test(host));
}

function toEmbedPathUrl(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/(?:v|f|d|file|download|embed)\/([^/?#]+)/i);
    if (!match) return url;
    parsed.pathname = `/e/${match[1]}`;
    return parsed.toString();
  } catch {
    return url;
  }
}

const FILE_LOCKER_SERVERS = ['1fichier', 'fichier', 'mega', 'uptobox', 'drive', 'gofile', 'wetransfer', 'terabox', 'pixeldrain', 'zippyshare'];
function isFileLockerServer(server) {
  const name = (server || '').toLowerCase().trim();
  if (!name) return false;
  return FILE_LOCKER_SERVERS.some((locker) => name.includes(locker));
}

function scoreXupalaceServer(server) {
  const s = (server || '').toLowerCase();
  if (s.includes('streamwish') || s.includes('hlswish') || s.includes('vidhide')) return 0;
  if (s.includes('vidguard') || s.includes('listeamed')) return 4;
  if (s.includes('waaw') || s.includes('netu') || s.includes('hqq')) return 5;
  if (s.includes('lulu') || s.includes('vudeo') || s.includes('ahvsh') || s.includes('streamhide')) return 5;
  if (s.includes('filemoon') || s.includes('voe') || s.includes('dood') || s.includes('playmogo')) return 6;
  return 3;
}

function extractXupalaceServers(html, baseUrl) {
  const $ = cheerio.load(html || '');
  const results = [];
  const seen = new Set();

  $('[onclick*="go_to_playerVast"]').each((_, el) => {
    const onclick = $(el).attr('onclick') || '';
    const match = onclick.match(/go_to_playerVast\(\s*['"]([^'"]+)['"]/);
    if (!match) return;
    const url = normalizeUrl(decodeHtmlEntities(match[1]), baseUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const imgName = ($(el).find('img').attr('src') || '').split('/').pop().replace(/\.[a-z0-9]+$/i, '').toLowerCase();
    const label = ($(el).find('span').first().text() || imgName || '').trim().toLowerCase();
    results.push({ url, server: label });
  });

  return results;
}

function resolveXupalaceServers(html, baseUrl, userAgent, options) {
  const { depth, visited, signal } = options;
  const servers = extractXupalaceServers(html, baseUrl)
    .filter((entry) => !isFileLockerServer(entry.server))
    .sort((a, b) => scoreXupalaceServer(a.server) - scoreXupalaceServer(b.server));

  return firstResultInOrder(servers, EMBED_RESOLVE_CONCURRENCY, (entry) =>
    resolvePlayerStream(entry.url, userAgent, baseUrl, { depth: depth + 1, visited, signal }).catch((e) => {
      console.warn(`SoloLatino unpacker: Xupalace server ${entry.server || entry.url} failed: ${e.message}`);
      return null;
    })
  );
}

function normalizeNetuEmbedUrl(url, referer) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/f\/([^/?#]+)/i);
    if (!match) return url;
    const embedUrl = new URL(`/e/${match[1]}`, parsed.origin);
    embedUrl.searchParams.set('http_referer', referer || 'https://sololatino.net/');
    return embedUrl.toString();
  } catch {
    return url;
  }
}

function normalizeEmbedUrl(url, referer) {
  if (isNetuFamilyHost(url)) return normalizeNetuEmbedUrl(url, referer);
  if (isEmbedPathHost(url)) return toEmbedPathUrl(url);
  return url;
}

function extractNetuDirectStream(html, baseUrl) {
  const directUrl = extractDirectStream(html, baseUrl);
  if (!directUrl) return null;
  const lower = directUrl.toLowerCase();
  if (lower.startsWith('data:') || lower.includes('/hls-vod-s03/flv/api/files/videos/2018/08/01/')) return null;
  return directUrl;
}

function rot13(value) {
  return String(value || '').replace(/[a-zA-Z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function decodeVoePayload(encoded, options = {}) {
  try {
    let value = rot13(encoded);
    for (const marker of ['@$', '^^', '~@', '%?', '*~', '!!', '#&']) {
      value = value.split(marker).join('_');
    }
    value = value.split('_').join('');

    const firstDecodedBytes = base64ToBytes(value);
    const firstDecoded = firstDecodedBytes.map((b) => String.fromCharCode(b)).join('');

    let shifted = '';
    for (let index = 0; index < firstDecoded.length; index += 1) {
      shifted += String.fromCharCode(firstDecoded.charCodeAt(index) - 3);
    }

    const reversed = shifted.split('').reverse().join('');
    const json = base64ToUtf8String(reversed);
    return JSON.parse(json);
  } catch (error) {
    if (!options.quiet) console.warn(`SoloLatino unpacker: VOE payload decode failed: ${error.message}`);
    return null;
  }
}

function collectVoeEncodedPayloads(html) {
  const payloads = [];
  let match;

  const scriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while (payloads.length < MAX_VOE_PAYLOADS && (match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const encoded = Array.isArray(parsed) ? parsed.find((item) => typeof item === 'string' && item.length > 0) : null;
      if (encoded) payloads.push(encoded);
    } catch {
      // Ignore unrelated JSON script tags.
    }
  }

  const varRegex = /(?:var|let|const)\s+[A-Za-z_$][\w$]*\s*=\s*["']([A-Za-z0-9+/=_@$^~%*!#&-]{120,})["']/g;
  while (payloads.length < MAX_VOE_PAYLOADS && (match = varRegex.exec(html)) !== null) {
    payloads.push(match[1]);
  }

  return payloads;
}

function normalizeVoeCandidate(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^https?:\/\//i.test(value)) return value;
  try {
    const decoded = base64ToUtf8String(value);
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    // Not base64; nothing usable here.
  }
  return null;
}

function extractVoeDirectStream(html, baseUrl, options = {}) {
  if (!html) return null;
  for (const encoded of collectVoeEncodedPayloads(html)) {
    const data = decodeVoePayload(encoded, options);
    if (!data) continue;
    const fallback = Array.isArray(data.fallback) ? data.fallback.map((item) => item?.file) : [];
    const candidates = [data.source, data.file, data.hls, ...fallback, data.direct_access_allowed ? data.direct_access_url : null]
      .map(normalizeVoeCandidate)
      .filter(Boolean);
    const direct = candidates.find((candidate) => /\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(candidate));
    if (direct) return normalizeUrl(direct, baseUrl);
  }
  return null;
}

function extractMediafireDirectUrl(html, baseUrl) {
  if (!html) return null;
  const $ = cheerio.load(html);
  const button = $('#downloadButton').first();

  const href = normalizeUrl(button.attr('href'), baseUrl);
  if (href && !/(^|\.)mediafire\.com\/file\//i.test(href) && isHttpUrl(href)) return href;

  const scrambled = button.attr('data-scrambled-url');
  if (scrambled) {
    try {
      const decoded = base64ToUtf8String(scrambled);
      if (isHttpUrl(decoded)) return decoded;
    } catch {
      // Not base64; fall through to the page scan.
    }
  }

  const match = html.match(/https?:\/\/download[^"'`\s<>\\]+\.mediafire\.com\/[^"'`\s<>\\]+/i);
  return match ? normalizeUrl(match[0], baseUrl) : null;
}

function extractNuploadDirectStream(html, baseUrl) {
  if (!html) return null;
  try {
    const fileVarMatch = html.match(/file\s*:\s*([A-Za-z_$][\w$]*)\s*\+/);
    const fileVarName = fileVarMatch?.[1];
    const loopRegex = fileVarName
      ? new RegExp(`var\\s+${fileVarName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*"";\\s*([A-Za-z_$][\\w$]*)\\.forEach[\\s\\S]{0,500}?-\\s*(\\d+)`)
      : null;
    const loopMatch = loopRegex ? html.match(loopRegex) : null;
    const loopMatches = loopMatch ? [loopMatch] : [];

    if (loopMatches.length === 0) {
      const fallbackRegex = /var\s+([A-Za-z_$][\w$]*)\s*=\s*"";\s*([A-Za-z_$][\w$]*)\.forEach[\s\S]{0,500}?-\s*(\d+)/g;
      let fallbackMatch;
      while ((fallbackMatch = fallbackRegex.exec(html)) !== null) loopMatches.push(fallbackMatch);
    }

    for (const candidateMatch of loopMatches) {
      const arrayName = fileVarName ? candidateMatch[1] : candidateMatch[2];
      const subtractValue = parseInt(fileVarName ? candidateMatch[2] : candidateMatch[3], 10);
      const arrayPattern = new RegExp(`var\\s+${arrayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\\[[\\s\\S]*?\\]);`);
      const arrayMatch = html.match(arrayPattern);
      if (!arrayMatch) continue;

      const encodedParts = JSON.parse(arrayMatch[1]);
      const streamUrl = encodedParts
        .map((part) => {
          const digits = base64ToUtf8String(part).replace(/\D/g, '');
          return String.fromCharCode(parseInt(digits, 10) - subtractValue);
        })
        .join('');

      if (!/\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(streamUrl)) continue;

      const sessionMatch = html.match(/\bsesz\s*=\s*["']([^"']+)["']/);
      const directUrl = normalizeUrl(streamUrl, baseUrl);
      if (!directUrl || !sessionMatch) return directUrl;

      const parsed = new URL(directUrl);
      if (!parsed.searchParams.has('s')) parsed.searchParams.set('s', sessionMatch[1]);
      return parsed.toString();
    }
  } catch (error) {
    console.warn(`SoloLatino unpacker: Nupload decode failed: ${error.message}`);
  }
  return null;
}

/**
 * VidGuard obfuscates its stream URL's `sig` parameter (hex XOR -> base64 ->
 * byte reversal/swap). This is plain byte math, not AES, so it ports without
 * Node's `crypto` module — only the base64 helpers above are needed.
 */
function decodeVidguardSignature(streamUrl) {
  try {
    const parsed = new URL(streamUrl);
    const sig = parsed.searchParams.get('sig');
    if (!sig || sig.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(sig)) return streamUrl;

    let deobfuscated = '';
    for (let index = 0; index < sig.length; index += 2) {
      deobfuscated += String.fromCharCode(parseInt(sig.slice(index, index + 2), 16) ^ 2);
    }

    const bytes = base64ToBytes(deobfuscated);
    if (bytes.length <= 10) return streamUrl;

    const characters = bytes.slice(0, bytes.length - 5).reverse().map((byte) => String.fromCharCode(byte));
    for (let index = 0; index + 1 < characters.length; index += 2) {
      const swap = characters[index];
      characters[index] = characters[index + 1];
      characters[index + 1] = swap;
    }

    parsed.searchParams.set('sig', characters.join('').slice(0, -5));
    return parsed.toString();
  } catch (error) {
    console.warn(`SoloLatino unpacker: VidGuard signature decode failed: ${error.message}`);
    return streamUrl;
  }
}

function extractVidguardStream(html, baseUrl) {
  for (const source of [html, ...iterUnpackedScripts(html)]) {
    if (!source) continue;
    const normalized = source.replace(/\\\//g, '/');
    const configMatch =
      normalized.match(/["'](?:stream|hls|file)["']\s*:\s*["']([^"']+)["']/i)
      || normalized.match(/(https?:\/\/[^\s'"`<>]+[?&]sig=[^\s'"`<>]+)/i);
    const candidate = normalizeUrl(configMatch?.[1], baseUrl);
    if (candidate) return decodeVidguardSignature(candidate);
  }
  return null;
}

function extractAssignedRedirect(html, baseUrl) {
  const linkMatch = html.match(/\b(?:var|let|const)\s+redirect_link\s*=\s*['"]([^'"]+)['"]/i);
  if (!linkMatch) return null;
  const fallbackMatch = html.match(/redirect\(\s*['"]([^'"]+)['"]\s*\)/);
  return normalizeUrl(`${linkMatch[1]}${fallbackMatch?.[1] || 'fp=-7'}`, baseUrl);
}

/** Dood's /pass_md5/ handshake. */
function resolveDood(html, url, userAgent, signal, pageUrl = url) {
  if (!isDoodHost(url) && !isDoodHost(pageUrl)) return Promise.resolve(null);

  const passMatch = html.match(/(["'])(\/pass_md5\/[^"'<>]+)\1/i) || html.match(/(["'])(https?:\/\/[^"'<>]+\/pass_md5\/[^"'<>]+)\1/i);
  const passUrl = normalizeUrl(passMatch?.[2], pageUrl);
  if (!passUrl) return Promise.resolve(null);

  return fetchTextWithTimeout(
    passUrl,
    { headers: { 'User-Agent': userAgent, Referer: pageUrl, 'X-Requested-With': 'XMLHttpRequest' }, signal },
    DOOD_DIRECT_TIMEOUT_MS
  )
    .then(({ res, text }) => {
      if (!res.ok) return null;
      const direct = text.trim().replace(/\\\//g, '/');
      return /^https?:\/\/.+\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(direct) ? direct : null;
    })
    .catch(() => null);
}

/**
 * Filemoon (AES-GCM playback payload), Pelisplus mirrors (AES-CBC API
 * response) and embed69 (AES-CBC + SHA-256 proof-of-work) all need real
 * cryptographic primitives that Node's `crypto` provided in the original
 * addon. Nuvio's sandbox has no `crypto` module, and hand-rolling AES/SHA-256
 * in this file was judged not worth it for this first port — especially
 * since the original code's own comments note Filemoon is captcha-gated on
 * effectively every file anyway. These stubs keep resolvePlayerStream's
 * control flow intact; they just never produce a stream for these three.
 */
function resolveFilemoon() {
  return Promise.resolve(null);
}
function resolvePelisplus() {
  return Promise.resolve(null);
}
function decryptEmbed69() {
  return null;
}
function isFilemoonHost(value) {
  return /(^|\.)filemoon\.(?:sx|to|in|nl|wt|eu|art)$/i.test(getHostname(value))
    || /(^|\.)bysejikuar\.com$/i.test(getHostname(value))
    || /(^|\.)q8y5z\.com$/i.test(getHostname(value));
}
const PELISPLUS_HOST_PATTERN = /(^|\.)(?:pelisplus[a-z0-9-]*\.[a-z0-9.-]+|4meplayer\.pro|upns\.pro|strp2p\.com|rpmstream\.live)$/i;
function isPelisplusHost(value) {
  if (!PELISPLUS_HOST_PATTERN.test(getHostname(value))) return false;
  try {
    return new URL(value).hash.length > 1;
  } catch {
    return false;
  }
}

/**
 * Advanced recursive player resolver: handles known external players to
 * extract a final direct .m3u8/.mp4 URL. Ported from src/unpacker.js's
 * resolvePlayerStream with async/await replaced by Promise chains.
 */
function resolvePlayerStream(url, userAgent, referer, options = {}) {
  const depth = options.depth || 0;
  const visited = options.visited || new Set();
  const signal = options.signal;
  const normalizedInputUrl = normalizeUrl(url, referer);
  if (!normalizedInputUrl || depth > MAX_RESOLVE_DEPTH || visited.has(normalizedInputUrl)) {
    return Promise.resolve(null);
  }
  visited.add(normalizedInputUrl);
  url = normalizeEmbedUrl(normalizedInputUrl, referer);
  if (visited.has(url) && url !== normalizedInputUrl) return Promise.resolve(null);
  visited.add(url);

  if (isDefunctHost(url)) {
    console.log(`SoloLatino unpacker: skipping ${getHostname(url)}, which accepts no connections`);
    return Promise.resolve(null);
  }

  let step = Promise.resolve(null);

  if (isPelisplusHost(url)) {
    step = resolvePelisplus(url, userAgent, referer, signal);
  }

  return step
    .then((result) => {
      if (result) return result;
      if (isFilemoonHost(url)) return resolveFilemoon(url, userAgent, referer, signal);
      return null;
    })
    .then((result) => {
      if (result || isFilemoonHost(url)) return result;
      return fetchTextWithTimeout(url, { headers: { 'User-Agent': userAgent, Referer: referer }, signal }, PLAYER_FETCH_TIMEOUT_MS).then(
        ({ res, text: html }) => {
          if (!res.ok) return null;
          return resolveFromPage(url, html, res, userAgent, referer, depth, visited, signal);
        }
      );
    })
    .catch((e) => {
      console.warn(`SoloLatino unpacker: player wrapper skipped (${getHostname(url) || url}): ${e.message}`);
      return null;
    });
}

function resolveFromPage(url, html, res, userAgent, referer, depth, visited, signal) {
  let chain = Promise.resolve(null);

  if (isXupalaceHost(url) || html.includes('go_to_playerVast')) {
    chain = chain.then((result) => result || resolveXupalaceServers(html, url, userAgent, { depth, visited, signal }));
  }

  chain = chain.then((result) => {
    if (result) return result;
    if (isVoeHost(url)) return extractVoeDirectStream(html, url);
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    if (isNetuFamilyHost(url)) {
      const netuDirectUrl = extractNetuDirectStream(html, url);
      if (netuDirectUrl) return netuDirectUrl;
      const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
      const iframeUrl = normalizeUrl(iframeMatch?.[1], url);
      if (iframeUrl && iframeUrl !== url && isNetuFamilyHost(iframeUrl)) {
        return resolvePlayerStream(iframeUrl, userAgent, url, { depth: depth + 1, visited, signal });
      }
      return NETU_TERMINAL;
    }
    return null;
  });

  chain = chain.then((result) => {
    if (result === NETU_TERMINAL) return null;
    if (result) return result;
    if (isVidguardHost(url)) return extractVidguardStream(html, url);
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    if (isMediafireHost(url)) return extractMediafireDirectUrl(html, url);
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    if (isNuploadHost(url)) return extractNuploadDirectStream(html, url);
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    if (isStreamtapeHost(url)) return extractStreamtapeStream(html, url);
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    if (url.includes('emturbovid') || url.includes('turbovidhls') || url.includes('turboviplay')) {
      const dataHash = html.match(/data-hash=["']([^"']+\.m3u8[^"']*)/);
      if (dataHash) return normalizeUrl(dataHash[1], url);
      const urlPlay = html.match(/var\s+urlPlay\s*=\s*["']([^"']+\.m3u8[^"']*)/);
      if (urlPlay) return normalizeUrl(urlPlay[1], url);
    }
    return null;
  });

  chain = chain.then((result) => (result ? result : resolveDood(html, url, userAgent, signal, res.url || url)));

  chain = chain.then((result) => {
    if (result) return result;
    if (url.includes('embed69') || (html.includes('POW_CHALLENGE') && html.includes('dataLink'))) {
      // AES-gated; see decryptEmbed69 stub above.
      const embed69Links = decryptEmbed69(html);
      if (embed69Links && embed69Links.length > 0) {
        const attemptedEmbeds = embed69Links
          .filter((embed) => !isFileLockerServer(embed.server))
          .slice(0, MAX_EMBED69_ATTEMPTS);
        return firstResultInOrder(attemptedEmbeds, EMBED_RESOLVE_CONCURRENCY, (embed) =>
          resolvePlayerStream(embed.url, userAgent, url, { depth: depth + 1, visited, signal })
        );
      }
    }
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    if (!isVoeHost(url)) {
      const voeMirrorUrl = extractVoeDirectStream(html, url, { quiet: true });
      if (voeMirrorUrl) {
        console.log(`SoloLatino unpacker: recognised ${getHostname(url)} as a VOE mirror by payload`);
        return voeMirrorUrl;
      }
    }
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    const jsRedirectMatch = html.match(
      /(?:(?:window|self)\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|(?:(?:window|self)\.)?location\.(?:replace|assign)\s*\(\s*['"]([^'"]+)['"]\s*\)/
    );
    const redirectUrl = normalizeUrl(jsRedirectMatch?.[1] || jsRedirectMatch?.[2], url);
    if (redirectUrl && redirectUrl !== url && isHttpUrl(redirectUrl)) {
      console.log(`SoloLatino unpacker: following JS redirect to ${redirectUrl}`);
      return resolvePlayerStream(redirectUrl, userAgent, referer, { depth: depth + 1, visited, signal });
    }
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    const assignedRedirectUrl = extractAssignedRedirect(html, url);
    if (assignedRedirectUrl && assignedRedirectUrl !== url && isHttpUrl(assignedRedirectUrl)) {
      console.log(`SoloLatino unpacker: following assigned redirect to ${assignedRedirectUrl}`);
      return resolvePlayerStream(assignedRedirectUrl, userAgent, referer, { depth: depth + 1, visited, signal });
    }
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
    const iframeUrl = normalizeUrl(iframeMatch?.[1], url);
    if (iframeUrl && iframeUrl !== url && isHttpUrl(iframeUrl)) {
      return resolvePlayerStream(iframeUrl, userAgent, url, { depth: depth + 1, visited, signal });
    }
    return null;
  });

  chain = chain.then((result) => {
    if (result) return result;
    const directUrl = extractDirectStream(html, url);
    return directUrl ? normalizeUrl(directUrl, url) : null;
  });

  return chain;
}

const NETU_TERMINAL = Symbol('netu-terminal');

// ---------------------------------------------------------------------------
// SoloLatino-specific scraping (ported from src/scrapers/sololatino.js)
// ---------------------------------------------------------------------------

const TOKEN_CONCURRENCY = 3;
const SEARCH_TIMEOUT_MS = 4500;
const PAGE_TIMEOUT_MS = 5500;
const API_TIMEOUT_MS = 5000;
const PROBE_TIMEOUT_MS = 2500;

const REFUSAL_STATUSES = new Set([401, 403, 405, 429, 503]);
const REFUSAL_TTL_MS = 5 * 60 * 1000;
const refusalCache = createTtlCache({ maxEntries: 4 });
const REFUSAL_KEY = 'sololatino.net';

function browserHeaders(userAgent, extra = {}) {
  return {
    'User-Agent': userAgent,
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    ...extra
  };
}

function noteRefusal(status, where) {
  if (!REFUSAL_STATUSES.has(status)) return false;
  if (refusalCache.get(REFUSAL_KEY) === undefined) {
    console.warn(`SoloLatino: host refused us with HTTP ${status} at ${where}; skipping this source for ${REFUSAL_TTL_MS / 1000}s`);
  }
  refusalCache.set(REFUSAL_KEY, status, REFUSAL_TTL_MS);
  return true;
}

function slugifyTitle(str) {
  if (!str) return '';
  return str
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
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
    if (candidateYears.size > 0 && !candidateYears.has(yearStr)) return 0;
  }

  if (cleanTargetTitle && cleanResultTitle === cleanTargetTitle) score += 5;
  if (cleanOriginalTitle && cleanResultTitle === cleanOriginalTitle) score += 4;
  if (cleanSlug && cleanSlug === cleanTargetTitle) score += 5;
  if (cleanSlug && cleanSlug === cleanOriginalTitle) score += 4;

  if (cleanTargetTitle && (cleanResultTitle.includes(cleanTargetTitle) || cleanTargetTitle.includes(cleanResultTitle))) score += 2;
  if (cleanOriginalTitle && (cleanResultTitle.includes(cleanOriginalTitle) || cleanOriginalTitle.includes(cleanResultTitle))) score += 2;

  for (const cleanExtra of cleanExtraTitles) {
    if (cleanResultTitle === cleanExtra || cleanSlug === cleanExtra) score += 4;
    else if (cleanResultTitle.includes(cleanExtra) || cleanExtra.includes(cleanResultTitle)) score += 2;
  }

  if (year) {
    const yearStr = year.toString();
    if (result.title.includes(yearStr) || cleanResultTitle.includes(yearStr) || cleanSlug.includes(yearStr)) score += 8;
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
    candidates.push({ url: `https://sololatino.net/${basePath}/${slug}`, title: value || slug });
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
  ]
    .filter(Boolean)
    .join(' ');
}

function pageHasRequestedYear(html, year) {
  if (!year) return true;
  const identityText = extractPageIdentityText(html);
  const years = extractCandidateYears(identityText);
  return years.has(year.toString());
}

function probeFallbackCandidate(candidate, year, userAgent, signal) {
  return fetchTextWithTimeout(candidate.url, { headers: browserHeaders(userAgent), signal }, PROBE_TIMEOUT_MS).then(
    ({ res: probeRes, text: html }) => {
      if (!probeRes.ok) {
        console.warn(`SoloLatino: fallback probe ${candidate.url} returned HTTP ${probeRes.status}`);
        noteRefusal(probeRes.status, 'fallback probe');
        return null;
      }
      if (year && !pageHasRequestedYear(html, year)) {
        console.log(`SoloLatino: rejecting fallback ${candidate.url}; page does not contain requested year ${year}`);
        return null;
      }
      return candidate;
    }
  );
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
const PELISSERIESHOY_MAX_SERVERS = 4;
const PELISSERIESHOY_CONCURRENCY = 2;

function pelisserieshoyHeaders(userAgent, streamUrl) {
  return {
    'Content-Type': 'application/x-www-form-urlencoded',
    'User-Agent': userAgent,
    Referer: streamUrl,
    Origin: PELISSERIESHOY_ORIGIN
  };
}

function resolvePelisserieshoyServer(serverValue, token, userAgent, streamUrl, signal) {
  return fetchJsonWithTimeout(
    `${PELISSERIESHOY_ORIGIN}/s.php`,
    { method: 'POST', headers: pelisserieshoyHeaders(userAgent, streamUrl), signal, body: new URLSearchParams({ a: '2', v: serverValue, tok: token }) },
    API_TIMEOUT_MS
  ).then(({ res: playValRes, data: playValJson }) => {
    if (!playValRes.ok || !playValJson?.u) return null;

    const pathUrl = `${PELISSERIESHOY_ORIGIN}${playValJson.u}`;
    return fetchWithTimeout(
      pathUrl,
      { method: 'GET', headers: { 'User-Agent': userAgent, Referer: streamUrl }, redirect: 'manual', signal },
      API_TIMEOUT_MS
    ).then((redirectCheck) => {
      const directUrl = [301, 302].includes(redirectCheck.status) ? redirectCheck.headers.get('location') : pathUrl;
      if (!directUrl) return null;
      return directUrl.includes('.bin') ? `${directUrl}#.mp4` : directUrl;
    });
  });
}

function resolvePelisserieshoy(streamUrl, userAgent, signal) {
  return fetchTextWithTimeout(streamUrl, { headers: { 'User-Agent': userAgent, Referer: 'https://sololatino.net/' }, signal }, PAGE_TIMEOUT_MS).then(
    ({ res: pageRes, text: html }) => {
      if (!pageRes.ok) return null;

      const token = html.match(/const\s+_t\s*=\s*['"]([^'"]+)['"]/)?.[1];
      if (!token) return null;

      return fetchWithTimeout(
        `${PELISSERIESHOY_ORIGIN}/s.php`,
        { method: 'POST', headers: pelisserieshoyHeaders(userAgent, streamUrl), signal, body: new URLSearchParams({ a: 'click', tok: token }) },
        API_TIMEOUT_MS
      )
        .then(() =>
          fetchJsonWithTimeout(
            `${PELISSERIESHOY_ORIGIN}/s.php`,
            { method: 'POST', headers: pelisserieshoyHeaders(userAgent, streamUrl), signal, body: new URLSearchParams({ a: '1', tok: token }) },
            API_TIMEOUT_MS
          )
        )
        .then(({ res: sListRes, data: sListJson }) => {
          if (!sListRes.ok || !Array.isArray(sListJson?.s)) return null;

          const serverValues = sListJson.s
            .slice(0, PELISSERIESHOY_MAX_SERVERS)
            .map((entry) => (Array.isArray(entry) ? entry[1] : entry))
            .filter(Boolean);

          return firstResultInOrder(serverValues, PELISSERIESHOY_CONCURRENCY, (serverValue) =>
            resolvePelisserieshoyServer(serverValue, token, userAgent, streamUrl, signal).catch((error) => {
              console.warn(`SoloLatino: pelisserieshoy server ${serverValue} failed: ${error.message}`);
              return null;
            })
          );
        });
    }
  );
}

/** SoloLatino scraper: title/year -> list of internal stream descriptors. */
function scrape(title, originalTitle, year, type, season, episode, options = {}) {
  const { signal, extraTitles = [] } = options;
  const userAgent =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

  const activeRefusal = refusalCache.get(REFUSAL_KEY);
  if (activeRefusal !== undefined) {
    console.log(`SoloLatino: skipping source; host last refused us with HTTP ${activeRefusal}`);
    return Promise.resolve([]);
  }

  let hostRefused = false;

  function performSearch(searchQuery) {
    const searchUrl = `https://sololatino.net/buscar?q=${encodeURIComponent(searchQuery)}`;
    return fetchTextWithTimeout(searchUrl, { headers: browserHeaders(userAgent), signal }, SEARCH_TIMEOUT_MS).then(({ res, text: html }) => {
      console.log(`SoloLatino search HTTP status for ${searchQuery}: ${res.status}`);
      if (!res.ok) {
        if (noteRefusal(res.status, 'search')) hostRefused = true;
        return null;
      }

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
        if (r.url.includes('/serie/') && !/\/serie\/[^/]+\/?$/.test(r.url)) continue;
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

      console.log(`SoloLatino performSearch("${searchQuery}") found ${uniqueResults.length} candidate(s), best score ${bestScore}`);
      return bestMatch;
    });
  }

  const racedTitles = originalTitle && cleanText(originalTitle) !== cleanText(title) ? [title, originalTitle] : [title];

  return raceTitleSearches(racedTitles, performSearch)
    .then((bestMatch) => {
      const triedClean = new Set([cleanText(title), cleanText(originalTitle)]);

      function tryExtras(i, current) {
        if (current || hostRefused || i >= extraTitles.length) return Promise.resolve(current);
        const extraTitle = extraTitles[i];
        const cleanExtra = cleanText(extraTitle);
        if (!cleanExtra || triedClean.has(cleanExtra)) return tryExtras(i + 1, current);
        triedClean.add(cleanExtra);
        console.log(`SoloLatino: no match yet, trying alternative title "${extraTitle}"`);
        return performSearch(extraTitle).then((match) => tryExtras(i + 1, match));
      }

      return tryExtras(0, bestMatch);
    })
    .then((bestMatch) => {
      if (!bestMatch && hostRefused) {
        console.log('SoloLatino: skipping direct URL fallbacks; the host refused the search');
        return { bestMatch: null, aborted: true };
      }
      if (bestMatch) return { bestMatch, aborted: false };

      const candidates = buildFallbackUrls(type, title, originalTitle, extraTitles);
      function tryCandidates(i) {
        if (i >= candidates.length) return Promise.resolve(null);
        const candidate = candidates[i];
        return probeFallbackCandidate(candidate, year, userAgent, signal)
          .then((probedCandidate) => {
            if (probedCandidate) {
              console.log(`SoloLatino: using direct URL fallback ${probedCandidate.url}`);
              return probedCandidate;
            }
            return tryCandidates(i + 1);
          })
          .catch((err) => {
            console.warn(`SoloLatino: fallback probe failed for ${candidate.url}:`, err.message);
            return tryCandidates(i + 1);
          });
      }
      return tryCandidates(0).then((bestMatch2) => ({ bestMatch: bestMatch2, aborted: false }));
    })
    .then(({ bestMatch, aborted }) => {
      if (aborted) return [];
      if (!bestMatch) {
        console.log(`SoloLatino: no matching content found for "${title}"`);
        return [];
      }

      let targetPageUrl = bestMatch.url;
      if (type === 'series') {
        const baseUrlClean = bestMatch.url.replace(/\/$/, '');
        targetPageUrl = `${baseUrlClean}/temporada-${season}/episodio-${episode}`;
      }
      console.log(`SoloLatino: matched content URL: ${targetPageUrl}`);

      const csrfRequest = fetchWithTimeout(
        'https://sololatino.net/sanctum/csrf-cookie',
        { headers: browserHeaders(userAgent, { Accept: 'application/json', 'Sec-Fetch-Dest': 'empty', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Site': 'same-origin' }), signal },
        API_TIMEOUT_MS
      );
      const pageRequest = fetchTextWithTimeout(targetPageUrl, { headers: browserHeaders(userAgent), signal }, PAGE_TIMEOUT_MS);

      return Promise.allSettled([csrfRequest, pageRequest]).then(([csrfOutcome, pageOutcome]) => {
        if (csrfOutcome.status === 'rejected') throw csrfOutcome.reason;
        if (pageOutcome.status === 'rejected') throw pageOutcome.reason;

        const csrfRes = csrfOutcome.value;
        if (!csrfRes.ok) {
          console.warn(`SoloLatino: sanctum handshake failed with status ${csrfRes.status}`);
          noteRefusal(csrfRes.status, 'sanctum handshake');
          return [];
        }

        const setCookies = csrfRes.headers.getSetCookie();
        let xsrfCookieVal = '';
        let sessionCookieVal = '';
        for (const cookie of setCookies) {
          if (cookie.startsWith('XSRF-TOKEN=')) xsrfCookieVal = cookie.split(';')[0].substring('XSRF-TOKEN='.length);
          else if (cookie.startsWith('sololatinonet-session=')) sessionCookieVal = cookie.split(';')[0].substring('sololatinonet-session='.length);
        }

        if (!xsrfCookieVal) {
          console.warn('SoloLatino: sanctum response did not return XSRF-TOKEN cookie.');
          return [];
        }

        const decodedXSRF = decodeURIComponent(xsrfCookieVal);
        const cookieString = `XSRF-TOKEN=${xsrfCookieVal}; sololatinonet-session=${sessionCookieVal}`;

        const { res: pageRes, text: pageHtml } = pageOutcome.value;
        if (!pageRes.ok) {
          console.warn(`SoloLatino: failed to fetch target page: ${targetPageUrl} (${pageRes.status})`);
          noteRefusal(pageRes.status, 'content page');
          return [];
        }
        const pageDoc = cheerio.load(pageHtml);

        const csrfToken = pageDoc('meta[name="csrf-token"]').attr('content');
        if (!csrfToken) {
          console.warn('SoloLatino: CSRF token not found in meta tags.');
          return [];
        }

        const playerTokens = [];
        pageDoc('.server-btn').each((i, el) => {
          const token = pageDoc(el).attr('data-player-token');
          const serverName = pageDoc(el).text().trim() || `Servidor ${i + 1}`;
          if (token) playerTokens.push({ name: serverName, token });
        });

        console.log(`SoloLatino: found ${playerTokens.length} player tokens`);
        const sortedPlayerTokens = sortPlayerTokens(playerTokens);

        return mapWithConcurrency(sortedPlayerTokens, TOKEN_CONCURRENCY, (pInfo) =>
          fetchJsonWithTimeout(
            'https://sololatino.net/api/player-url',
            {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                'X-XSRF-TOKEN': decodedXSRF,
                'User-Agent': userAgent,
                Cookie: cookieString,
                Referer: targetPageUrl,
                Origin: 'https://sololatino.net'
              },
              signal,
              body: JSON.stringify({ t: pInfo.token })
            },
            API_TIMEOUT_MS
          )
            .then(({ res: apiRes, data: apiJson }) => {
              if (apiRes.status !== 200) {
                console.warn(`SoloLatino: API /api/player-url returned status ${apiRes.status} for server ${pInfo.name}`);
                return null;
              }
              if (!apiJson || !apiJson.url) return null;

              const streamUrl = apiJson.url;
              const isIframe = apiJson.type === 'iframe' || streamUrl.includes('embed') || streamUrl.includes('player') || streamUrl.includes('/f/');

              const resolvePromise = !isIframe
                ? Promise.resolve(streamUrl)
                : streamUrl.includes('player.pelisserieshoy.com')
                ? resolvePelisserieshoy(streamUrl, userAgent, signal)
                : resolvePlayerStream(streamUrl, userAgent, 'https://sololatino.net/', { signal });

              return resolvePromise
                .then((directUrl) => {
                  if (!directUrl) return null;
                  return {
                    name: 'SoloLatino',
                    title: `🇲🇽 ${pInfo.name}`,
                    url: directUrl,
                    headers: { 'User-Agent': userAgent, Referer: streamUrl || 'https://sololatino.net/' }
                  };
                })
                .catch((e) => {
                  console.error(`SoloLatino: error unpacking iframe ${streamUrl}:`, e.message);
                  return null;
                });
            })
            .catch((err) => {
              console.error(`SoloLatino: error requesting player URL for server ${pInfo.name}:`, err.message);
              return null;
            })
        );
      });
    })
    .catch((error) => {
      console.error(`SoloLatino scrape error for "${title}":`, error.message);
      return [];
    });
}

// ---------------------------------------------------------------------------
// Nuvio entry point
// ---------------------------------------------------------------------------

function toNuvioStream(internalStream, mediaTitle) {
  return {
    name: internalStream.name,
    title: mediaTitle ? `${internalStream.title} - ${mediaTitle}` : internalStream.title,
    url: internalStream.url,
    quality: 'Unknown',
    size: 'Unknown',
    headers: internalStream.headers,
    provider: 'sololatino'
  };
}

/**
 * Required Nuvio local-scraper entry point.
 * @param {string|number} tmdbId
 * @param {'movie'|'tv'} mediaType
 * @param {number|null} seasonNum
 * @param {number|null} episodeNum
 * @returns {Promise<Array<object>>}
 */
function getStreams(tmdbId, mediaType, seasonNum, episodeNum) {
  const type = mediaType === 'tv' ? 'series' : 'movie';

  return fetchTmdbDetails(tmdbId, mediaType)
    .then((details) => {
      if (!details || !details.title) return [];

      return getAlternativeTitles(mediaType, tmdbId).then((extraTitles) =>
        scrape(details.title, details.originalTitle, details.year, type, seasonNum, episodeNum, { extraTitles }).then((results) =>
          (results || []).map((stream) => toNuvioStream(stream, details.title))
        )
      );
    })
    .catch((error) => {
      console.error('SoloLatino (Nuvio): getStreams failed:', error && error.message);
      return [];
    });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}

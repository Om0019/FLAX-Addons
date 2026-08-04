/**
 * Dean Edwards Unpacker Utility
 */
const cheerio = require('cheerio');
const { decodeHtmlEntities, fetchTextWithTimeout, normalizeUrl } = require('./http');
const { firstResultInOrder } = require('./concurrency');

const PLAYER_FETCH_TIMEOUT_MS = 5000;
const PELISPLUS_FETCH_TIMEOUT_MS = 4500;
const MAX_RESOLVE_DEPTH = 5;
const DOOD_DIRECT_TIMEOUT_MS = 1800;
const FILEMOON_API_TIMEOUT_MS = 3500;
// How many candidate mirrors may be resolved at once when a page offers several.
// Deliberately small: every candidate is a different third-party host, so this
// trades a bounded increase in requests for cutting the length of a chain of
// failures, not a burst against everything a page lists.
const EMBED_RESOLVE_CONCURRENCY = 3;
// embed69 states its own proof-of-work difficulty, and the search costs 16^difficulty
// hashes. Node is single-threaded, so an unbounded search stalls every other in-flight
// request: difficulty 6 measures ~58s of blocked event loop, difficulty 7 ~15 minutes.
// Bound it in wall-clock time so the damage is capped regardless of CPU speed, and
// reject difficulties that are hopeless up front. Difficulty 5 (~1.3s expected) still
// completes ~90% of the time; anything slower is not worth the shared event loop.
const MAX_POW_DIFFICULTY = 6;
const MAX_POW_MS = 3000;
// A VOE mirror (matthewhotelscience.com, and whatever domain it rotates to next)
// gates its player page behind an Altcha proof-of-work challenge: PBKDF2 with a
// server-chosen cost, searching for a counter whose derived key starts with a
// given prefix. Unlike embed69's own cheap SHA-256 challenge above, each guess
// here is a full PBKDF2 derivation (~5ms measured at cost=10000) rather than a
// hash, so the search space has to be bounded far more tightly: one prefix byte
// (256 expected guesses) costs about a second, two bytes would cost minutes.
// Refuse anything longer up front rather than let a raised server-side
// difficulty block the event loop for the length of a movie.
const MAX_ALTCHA_KEY_PREFIX_HEX_LENGTH = 2;
const MAX_ALTCHA_POW_MS = 4000;
// embed69 lists every server it knows about, and each one costs a fetch. The gate
// below admits anything that is not an unresolvable file locker, so the number of
// attempts has to be capped here instead of by the shortness of an allowlist.
const MAX_EMBED69_ATTEMPTS = 5;
// VOE rotates its mirror domains constantly, so pages are recognised by their
// payload rather than their hostname. Bounded because the scan runs on every page
// that reaches the fallback.
const MAX_VOE_PAYLOADS = 6;

function unpack(p, a, c, k, e, d) {
  const e_func = function(c) {
    return (c < a ? '' : e_func(Math.floor(c / a))) +
      ((c = c % a) > 35 ? String.fromCharCode(c + 29) : c.toString(36));
  };
  // `c` is parsed straight out of the remote page and is only ever used to index
  // into `k`, so anything past the dictionary length is a no-op loop. Clamping
  // keeps a bogus value from spinning the event loop (c=5e8 measures ~2.8s).
  c = Math.min(Number(c) || 0, k.length);
  while (c--) {
    if (k[c]) {
      p = p.replace(new RegExp('\\b' + e_func(c) + '\\b', 'g'), k[c]);
    }
  }
  return p;
}

/**
 * Yields the decoded body of every Dean Edwards packed script in the page. Hosts
 * that hide a player config rather than a bare stream URL (VidGuard, for one) need
 * the same decode pass the direct extractor does, so it lives here rather than
 * inline in one caller.
 */
function* iterUnpackedScripts(html) {
  const packerRegex = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]*?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)/gi;

  let match;
  while ((match = packerRegex.exec(html || '')) !== null) {
    try {
      const p = match[2].trim();
      const a = parseInt(match[3]);
      const c = parseInt(match[4]);
      const k = match[6].trim().split('|');

      yield unpack(p, a, c, k, {}, {});
    } catch (err) {
      console.error('Unpacker: Failed to decode script block:', err.message);
    }
  }
}

// Assets that look like streams but never are: analytics bundles, and the sample
// clips player templates ship with. Matched as substrings because they only ever
// appear in one form.
const NON_STREAM_MARKERS = [
  'google-analytics',
  'analytics.js',
  'tagmanager',
  'test-videos.co.uk',
  'big_buck_bunny'
];

// Ad hosts and ad paths, matched on segment boundaries. A bare `includes('ads')`
// also matches "uploads" and "downloads", which is where a large share of real
// stream URLs live — that check threw away the stream it was meant to protect.
const AD_SEGMENT_PATTERN = /(?:^|[/.])(?:ads?|advert(?:s|ising)?|adserver|doubleclick)(?:[/.]|$)/;

/**
 * Undoes JSON string escaping left inside a URL that was scraped out of an
 * embedded payload rather than out of markup.
 *
 * ok.ru is the case this was written for: its player config is JSON escaped twice
 * over, so the manifest URL arrives as
 * `...?cmd=videoPlayerCdn\\u0026expires=...\\u0026sig=...`. Every separator after
 * the first is then part of one enormous parameter value, and the host answers 400.
 * Decoding the escapes and dropping the trailing backslash the capture picks up
 * turns exactly that URL into a 200 and a real #EXTM3U playlist.
 *
 * Only the escapes that can legitimately appear in a URL are decoded — an
 * arbitrary \uXXXX would be re-encoding territory, not repair.
 */
function cleanEscapedStreamUrl(link) {
  return String(link || '')
    .replace(/\\+u0026/gi, '&')
    .replace(/\\+u003[dD]/g, '=')
    .replace(/\\+u002[fF]/g, '/')
    .replace(/\\+u003[fF]/g, '?')
    .replace(/\\+$/, '');
}

/** True when a URL looks like a real media asset rather than an ad or analytics one. */
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

/**
 * Parses HTML, finds any packed scripts, unpacks them, and looks for .m3u8/.mp4 stream URLs.
 * Also scans the HTML directly for any un-packed stream URLs as a fallback.
 */
function extractDirectStream(html, baseUrl) {
  if (!html) return null;

  const normalizedHtml = decodeHtmlEntities(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\\\//g, '/');

  // 1. Check for un-packed HLS/MP4 links directly first (e.g. goodstream, emturbovid)
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
      const decoded = Buffer.from(encodedMatch[1], 'base64').toString('utf8').replace(/\\\//g, '/');
      if (!decoded.includes('.m3u8') && !decoded.includes('.mp4') && !decoded.includes('.mkv')) continue;
      configuredMatches.push(...(decoded.match(directRegex) || []));
      configuredMatches.push(...(decoded.match(protocolRelativeRegex) || []));
      configuredMatches.push(...(decoded.match(relativeRegex) || []));
    } catch {
      // Ignore non-base64 player config strings.
    }
  }
  
  // Filter out non-video assets or ad servers
  const validDirect = [
    ...directMatches,
    ...protocolRelativeMatches,
    ...relativeMatches,
    ...configuredMatches
  ].map(cleanEscapedStreamUrl)
    .map((link) => normalizeUrl(link, baseUrl))
    .filter(Boolean)
    .filter(isPlausibleStreamUrl);

  if (validDirect.length > 0) {
    return [...new Set(validDirect)][0];
  }

  // 2. Scan and unpack packed scripts (e.g. vidhide, hlswish, vimeos)
  for (const unpacked of iterUnpackedScripts(normalizedHtml)) {
    const streamMatches = unpacked.match(directRegex) || [];
    const validStreams = streamMatches
      .map(cleanEscapedStreamUrl)
      .map((link) => normalizeUrl(link, baseUrl))
      .filter(Boolean)
      .filter(isPlausibleStreamUrl);

    if (validStreams.length > 0) {
      return [...new Set(validStreams)][0];
    }
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

// DoodStream rebranded to playmogo.com: every mirror below — the dood.* names, the
// zero-spelled ones and the ds2*/doply aliases — now answers 301 to
// playmogo.com/e/<code>, path preserved. Recognising only the old dood.* set meant a
// source handing over d000d.com or playmogo.com directly was never routed here at
// all. See resolveDood for what playmogo currently serves.
function isDoodHost(value) {
  const host = getHostname(value);
  return /(^|\.)dood\.(?:li|to|stream|watch|so|pm|ws|re|yt|video)$/i.test(host)
    || /(^|\.)(?:d0{2,4}d|d0o0d|dooood|all3do|doply|vide0)\.(?:com|net|to)$/i.test(host)
    || /(^|\.)(?:doodstream|ds2play|ds2video)\.(?:com|co|net)$/i.test(host)
    || /(^|\.)playmogo\.com$/i.test(host);
}

function isFilemoonHost(value) {
  return /(^|\.)filemoon\.(?:sx|to|in|nl|wt|eu|art)$/i.test(getHostname(value))
    || /(^|\.)bysejikuar\.com$/i.test(getHostname(value))
    || /(^|\.)q8y5z\.com$/i.test(getHostname(value));
}

// voe.sx itself only ever serves a redirect stub; the player lives on a mirror
// whose domain rotates every few weeks, so no list of them stays accurate. Hosts
// named here are recognised up front, and everything else falls back to
// recognising a VOE page by whether its payload decodes (see extractVoeDirectStream).
function isVoeHost(value) {
  const host = getHostname(value);
  return /(^|\.)voe(?:-?un-?bl?o?ck)?\.[a-z]{2,}$/i.test(host)
    || host.includes('pamelachangemission.com');
}

// waaw.to, netu.tv and hqq.tv are the same player behind different brands: the
// same /f/ -> /e/ rewrite and http_referer parameter applies to all of them.
//
// Sites that license the player serve it from their own domain: novelas360.cyou is
// netu's embed_player.php verbatim, down to the get_md5.php handshake and the
// support@netu.tv address in its markup. Those belong here too — on the generic
// path, the only plain-text .m3u8 such a page carries is netu's placeholder clip,
// and a viewer would have been handed it as if it were the episode.
function isNetuFamilyHost(value) {
  const host = getHostname(value);
  return /(^|\.)(?:waaw\d?|netu|netuplayer|hqq\d?)\.(?:to|tv|ac|watch|com|net)$/i.test(host)
    || /(^|\.)novelas360\.cyou$/i.test(host);
}

/**
 * Hosts that still resolve in DNS but accept no connections, so a request to one
 * can only ever end in a timeout. Fembed closed in 2022 and GoUnlimited before
 * it; both names now point at parked addresses that answer nothing. Measured over
 * three consecutive trials each, every request burned the full deadline
 * (6001-6006ms against a 6000ms budget) before failing — spent inside a scrape
 * that has about ten seconds in total, and spent on a host that cannot answer.
 *
 * This is deliberately a list of hosts that answer *nothing*, not hosts that
 * answer badly. A 403 or a 503 already costs one fast round trip and returns at
 * the `res.ok` check in resolvePlayerStream, so there is nothing to save there,
 * and a host that merely blocks some requests must keep its chance to serve the
 * rest: hqq.tv answered 200, 403 and 200 across three consecutive trials, and
 * listing it here would throw away the two that worked.
 */
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
  return /(^|\.)(?:streamtape|streamadblockplus|stape|tapewithadblock|streamta)\.(?:com|net|to|xyz|cc|site)$/i
    .test(getHostname(value));
}

/**
 * Streamtape hides the playback URL from a plain page scan by splitting it in two:
 * a `#robotlink` div holds the first half, and a script appends the tail of a
 * second string, dropping its first characters. Neither half is a usable URL on
 * its own, which is why the generic extractor comes back empty on every
 * Streamtape page the sources hand over.
 *
 * The result is a `/get_video` endpoint that redirects to the media file, so it is
 * returned as-is and the redirect is followed where it is played.
 */
function extractStreamtapeStream(html, baseUrl) {
  if (!html) return null;

  const assignment = html.match(
    /getElementById\(\s*['"]robotlink['"]\s*\)\s*\.innerHTML\s*=\s*['"]([^'"]*)['"]\s*\+\s*\(\s*['"]([^'"]*)['"]\s*\)\s*\.substring\(\s*(\d+)\s*\)/i
  );
  if (!assignment) return null;

  const [, head, tail, offset] = assignment;
  const combined = `${head}${tail.substring(Number(offset))}`;
  if (!combined.includes('get_video')) return null;

  // The head is written as `//host/get_video?...` or as a bare `/get_video?...`,
  // so the origin has to come from the page it was found on.
  const absolute = combined.startsWith('//')
    ? `https:${combined}`
    : normalizeUrl(combined, baseUrl);

  return absolute && isHttpUrl(absolute) ? absolute : null;
}

const VIDGUARD_HOST_PATTERN = /(^|\.)(?:vidguard\.to|vid-guard\.com|listeamed\.net|bembed\.net|v6embed\.xyz|vgembed\.com|vgfplay\.com|embedv\.net|fslinks\.org|818ing\.com|moviesm4u\.com)$/i;

function isVidguardHost(value) {
  return VIDGUARD_HOST_PATTERN.test(getHostname(value));
}

function isMediafireHost(value) {
  return /(^|\.)mediafire\.com$/i.test(getHostname(value));
}

// The Pelisplus single-page player, which is rebranded across a rotating set of
// domains. This used to be three hardcoded substrings, which missed
// pelisplus.rpmstream.live — a host the sources hand over regularly and whose
// stream the decryptor below resolves without any change at all. Recognised by
// the `pelisplus` subdomain plus the player domains that do not carry it.
const PELISPLUS_HOST_PATTERN = /(^|\.)(?:pelisplus[a-z0-9-]*\.[a-z0-9.-]+|4meplayer\.pro|upns\.pro|strp2p\.com|rpmstream\.live)$/i;

/**
 * True for a Pelisplus player URL. The stream id lives in the fragment, and
 * without one there is nothing to ask the API for.
 */
function isPelisplusHost(value) {
  if (!PELISPLUS_HOST_PATTERN.test(getHostname(value))) return false;

  try {
    return new URL(value).hash.length > 1;
  } catch {
    return false;
  }
}

/**
 * vudeo.co serves `/embed-<id>.html` as a fingerprint stub: it assigns the real
 * player URL to a variable and navigates with `location.replace(variable + suffix)`,
 * which the literal-argument redirect scan cannot see. The suffix is the
 * fingerprint result, and `fp=-7` is the value the stub itself falls back to when
 * fingerprinting times out, so it is accepted.
 */
function extractAssignedRedirect(html, baseUrl) {
  const linkMatch = html.match(/\b(?:var|let|const)\s+redirect_link\s*=\s*['"]([^'"]+)['"]/i);
  if (!linkMatch) return null;

  const fallbackMatch = html.match(/redirect\(\s*['"]([^'"]+)['"]\s*\)/);
  return normalizeUrl(`${linkMatch[1]}${fallbackMatch?.[1] || 'fp=-7'}`, baseUrl);
}

/**
 * Hosts that only serve a player on their /e/ path — a /v/, /f/ or /d/ link is a
 * landing or download page with no config in it, so following one as-is always
 * comes back empty.
 */
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

// Lockers that need an account, a captcha or a wait timer. Anything else is worth
// one attempt: the resolvers below cover most of them, and the generic extractor
// covers a good share of the rest.
const FILE_LOCKER_SERVERS = [
  '1fichier', 'fichier', 'mega', 'uptobox', 'drive',
  'gofile', 'wetransfer', 'terabox', 'pixeldrain', 'zippyshare'
];

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
  // Gated behind a challenge no server-side resolver can answer — Filemoon by
  // captcha (see resolveFilemoon), VOE by a DDoS-Guard JS check that answers 403
  // to every request, Dood by the Cloudflare managed challenge playmogo.com now
  // serves every embed page behind (see resolveDood). Measured over 33 attempts in
  // July 2026, voe.sx resolved none of them, so ranking it mid-table only displaced
  // hosts that do resolve. Dood was ranked third best here and had the same effect:
  // every page listing it spent a fetch and a resolve timeout on a challenge page
  // ahead of servers that hand over a stream.
  // A VOE *mirror* is still recognised by payload further down, which is a
  // separate path and unaffected by this.
  if (s.includes('filemoon') || s.includes('voe') || s.includes('dood') || s.includes('playmogo')) return 6;
  return 3;
}

/**
 * Xupalace ("GoTV"-style) multi-server widget: pages list several embed
 * servers via `onclick="go_to_playerVast('URL', lang, idx)"` handlers
 * instead of exposing them as real <iframe> tags, so the generic iframe
 * regex never sees them.
 */
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

    const imgName = ($(el).find('img').attr('src') || '')
      .split('/').pop()
      .replace(/\.[a-z0-9]+$/i, '')
      .toLowerCase();
    const label = ($(el).find('span').first().text() || imgName || '').trim().toLowerCase();

    results.push({ url, server: label });
  });

  return results;
}

async function resolveXupalaceServers(html, baseUrl, userAgent, options) {
  const { depth, visited, signal } = options;
  const servers = extractXupalaceServers(html, baseUrl)
    .filter((entry) => !isFileLockerServer(entry.server))
    .sort((a, b) => scoreXupalaceServer(a.server) - scoreXupalaceServer(b.server));

  return firstResultInOrder(servers, EMBED_RESOLVE_CONCURRENCY, async (entry) => {
    try {
      return await resolvePlayerStream(entry.url, userAgent, baseUrl, { depth: depth + 1, visited, signal });
    } catch (e) {
      console.warn(`Unpacker: Xupalace server ${entry.server || entry.url} failed: ${e.message}`);
      return null;
    }
  });
}

function normalizeNetuEmbedUrl(url, referer) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/f\/([^/?#]+)/i);
    if (!match) return url;

    const embedUrl = new URL(`/e/${match[1]}`, parsed.origin);
    embedUrl.searchParams.set('http_referer', referer || 'https://tioplus.app/');
    return embedUrl.toString();
  } catch {
    return url;
  }
}

// hglink.to ("HLSWish", a StreamWish rebrand) is a front door: its own page is a
// ~70KB bespoke-obfuscated loader with no static redirect target — no
// location.href, no assigned variable, nothing the existing redirect regexes can
// see, because the navigation happens inside that obfuscated script rather than
// in the page's markup. Actually running that script to observe where it goes
// is not worth the risk it'd bring (arbitrary third-party JS executing with this
// process's privileges) for what turns out to be an unnecessary step anyway:
// hglink.to's own /e/<id> path always exists, unfetched, on vibuxer.com under
// the identical id — confirmed live by fetching hglink.to's target through an
// actual browser (getting routed to a *different* mirror, audinifer.com, that
// happened to serve the identical branded page) and separately fetching
// vibuxer.com directly for the same id (no visit to hglink.to at all), which
// served the same content. So the front door can be skipped by substituting the
// hostname before ever requesting it, landing on a page this file's own generic
// extractDirectStream already decodes (a Dean Edwards packed script) without any
// hglink.to-specific extraction logic at all.
const WISH_FRONT_DOOR_HOSTS = { 'hglink.to': 'vibuxer.com' };

function normalizeWishFrontDoorUrl(url) {
  const host = getHostname(url).replace(/^www\./, '');
  const mirror = WISH_FRONT_DOOR_HOSTS[host];
  if (!mirror) return url;

  try {
    const parsed = new URL(url);
    parsed.hostname = mirror;
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Rewrites a wrapper URL to the path its host actually serves a player on, before
 * anything is fetched.
 */
function normalizeEmbedUrl(url, referer) {
  if (isNetuFamilyHost(url)) return normalizeNetuEmbedUrl(url, referer);
  if (isEmbedPathHost(url)) return toEmbedPathUrl(url);
  const wishMirrorUrl = normalizeWishFrontDoorUrl(url);
  if (wishMirrorUrl !== url) return wishMirrorUrl;
  return url;
}

function extractNetuDirectStream(html, baseUrl) {
  const directUrl = extractDirectStream(html, baseUrl);
  if (!directUrl) return null;

  const lower = directUrl.toLowerCase();
  if (lower.startsWith('data:') || lower.includes('/hls-vod-s03/flv/api/files/videos/2018/08/01/')) {
    return null;
  }

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
    const firstDecoded = Buffer.from(value, 'base64').toString('binary');
    let shifted = '';
    for (let index = 0; index < firstDecoded.length; index += 1) {
      shifted += String.fromCharCode(firstDecoded.charCodeAt(index) - 3);
    }

    const reversed = shifted.split('').reverse().join('');
    const json = Buffer.from(reversed, 'base64').toString('utf8');
    return JSON.parse(json);
  } catch (error) {
    // Speculative decodes run against pages that are usually not VOE at all, so a
    // failure there is the expected outcome and not worth a log line.
    if (!options.quiet) {
      console.warn(`Unpacker: VOE payload decode failed: ${error.message}`);
    }
    return null;
  }
}

/**
 * Collects every string on the page that could be a VOE payload. Mirrors carry it
 * in an `application/json` script tag; some builds assign it to a plain variable
 * instead, so both shapes are gathered and left for the decoder to judge.
 */
function collectVoeEncodedPayloads(html) {
  const payloads = [];
  let match;

  const scriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  while (payloads.length < MAX_VOE_PAYLOADS && (match = scriptRegex.exec(html)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      const encoded = Array.isArray(parsed)
        ? parsed.find((item) => typeof item === 'string' && item.length > 0)
        : null;
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

/**
 * Some builds hand back the stream URL base64-encoded rather than in the clear.
 */
function normalizeVoeCandidate(value) {
  if (typeof value !== 'string' || !value) return null;
  if (/^https?:\/\//i.test(value)) return value;

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {
    // Not base64; nothing usable here.
  }

  return null;
}

/**
 * VOE mirrors (matthewhotelscience.com at last check; the domain rotates) can
 * serve an Altcha "confirm you're human" page instead of the player: a form
 * carrying a CSRF token and an <altcha-widget> pointing at a challenge URL, which
 * must be solved and POSTed back before the real page is served. This is not a
 * detection scheme distinguishing bots from humans — it's a fixed, published
 * client-side algorithm (github.com/altcha-org/altcha) that anyone, including a
 * script, can run; solving it is not bypassing a protection, it's using the page
 * the way its own widget does.
 */
function extractAltchaGate(html) {
  if (!html || !html.includes('altcha-widget')) return null;

  const tokenMatch = html.match(/name=["']_token["']\s+value=["']([^"']+)["']/);
  const challengeMatch = html.match(/<altcha-widget[^>]+challenge=["']([^"']+)["']/);
  if (!tokenMatch || !challengeMatch) return null;

  return { csrfToken: tokenMatch[1], challengeUrl: challengeMatch[1] };
}

/**
 * Altcha's PBKDF2 challenge: find a counter such that PBKDF2(nonce || counter,
 * salt, cost, keyLength) starts with keyPrefix. counter is appended to the nonce
 * as a big-endian uint32, per the algorithm's default counter mode — this
 * addon only ever needs to solve what the widget's own default configuration
 * produces, not the full space of options the library supports.
 */
function solveAltchaChallenge(parameters) {
  const { nonce, salt, cost, keyLength = 32, keyPrefix, algorithm } = parameters || {};
  if (!nonce || !salt || !cost || !keyPrefix) return null;
  if (keyPrefix.length > MAX_ALTCHA_KEY_PREFIX_HEX_LENGTH) {
    console.warn(`Unpacker: Refusing Altcha challenge with ${keyPrefix.length}-hex-char prefix (max ${MAX_ALTCHA_KEY_PREFIX_HEX_LENGTH}).`);
    return null;
  }

  const digest = algorithm === 'PBKDF2/SHA-512' ? 'sha512' : algorithm === 'PBKDF2/SHA-384' ? 'sha384' : 'sha256';
  const nonceBuf = Buffer.from(nonce, 'hex');
  const saltBuf = Buffer.from(salt, 'hex');
  const keyPrefixBuf = Buffer.from(keyPrefix, 'hex');
  const password = Buffer.alloc(nonceBuf.length + 4);
  nonceBuf.copy(password, 0);

  const deadline = Date.now() + MAX_ALTCHA_POW_MS;
  const start = Date.now();
  for (let counter = 0; ; counter += 1) {
    if (Date.now() > deadline) {
      console.warn(`Unpacker: Altcha proof-of-work exceeded ${MAX_ALTCHA_POW_MS}ms after ${counter} guesses; giving up.`);
      return null;
    }
    password.writeUInt32BE(counter >>> 0, nonceBuf.length);
    const derived = crypto.pbkdf2Sync(password, saltBuf, cost, keyLength, digest);
    if (derived.subarray(0, keyPrefixBuf.length).equals(keyPrefixBuf)) {
      return { counter, derivedKey: derived.toString('hex'), time: Date.now() - start };
    }
  }
}

/**
 * Every Set-Cookie the server sent gets folded into one Cookie header for the
 * next request in the sequence, later values winning over earlier ones — the
 * session cookie backing the CSRF token issued alongside the gate page has to
 * still be present when the solved challenge is POSTed back, and the challenge
 * fetch in between may itself rotate cookies.
 */
function mergeSetCookies(existingCookieHeader, res) {
  const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  if (setCookies.length === 0) return existingCookieHeader;

  const jar = new Map();
  for (const pair of (existingCookieHeader || '').split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) jar.set(name, rest.join('='));
  }
  for (const setCookie of setCookies) {
    const [name, ...rest] = setCookie.split(';')[0].trim().split('=');
    if (name) jar.set(name, rest.join('='));
  }

  return Array.from(jar.entries()).map(([name, value]) => `${name}=${value}`).join('; ');
}

/**
 * Solves the gate found by extractAltchaGate and POSTs the result back to the
 * same URL, returning the response as fetchTextWithTimeout would so the caller
 * can fall through to its normal extraction on the now-unlocked page. `access`
 * mirrors the hidden field the page itself carries at value "0"; `altcha` is the
 * hidden field name the widget's web component uses by default.
 */
async function resolveAltchaGate(url, gateRes, gate, userAgent, referer, signal) {
  let cookies = mergeSetCookies('', gateRes);

  const challengeRes = await fetchTextWithTimeout(gate.challengeUrl, {
    headers: { 'User-Agent': userAgent, 'Cookie': cookies, 'Referer': url },
    signal
  }, PLAYER_FETCH_TIMEOUT_MS);
  cookies = mergeSetCookies(cookies, challengeRes.res);
  if (!challengeRes.res.ok) return null;

  let challenge;
  try {
    challenge = JSON.parse(challengeRes.text);
  } catch {
    return null;
  }

  const solution = solveAltchaChallenge(challenge.parameters);
  if (!solution) return null;

  const payload = Buffer.from(JSON.stringify({
    challenge: { parameters: challenge.parameters, signature: challenge.signature },
    solution
  })).toString('base64');

  const body = new URLSearchParams({ _token: gate.csrfToken, access: '0', altcha: payload });
  const solvedRes = await fetchTextWithTimeout(url, {
    method: 'POST',
    headers: {
      'User-Agent': userAgent,
      'Cookie': cookies,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': url
    },
    body: body.toString(),
    signal
  }, PLAYER_FETCH_TIMEOUT_MS);
  if (!solvedRes.res.ok) return null;

  return solvedRes;
}

/**
 * The decode is self-validating — it only yields JSON with a source field for a
 * real VOE payload — so this can be run speculatively against a page whose host is
 * an unrecognised mirror, which in practice is most of them.
 */
function extractVoeDirectStream(html, baseUrl, options = {}) {
  if (!html) return null;

  for (const encoded of collectVoeEncodedPayloads(html)) {
    const data = decodeVoePayload(encoded, options);
    if (!data) continue;

    const fallback = Array.isArray(data.fallback) ? data.fallback.map((item) => item?.file) : [];
    const candidates = [
      data.source,
      data.file,
      data.hls,
      ...fallback,
      data.direct_access_allowed ? data.direct_access_url : null
    ].map(normalizeVoeCandidate).filter(Boolean);

    const direct = candidates.find((candidate) => /\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(candidate));
    if (direct) return normalizeUrl(direct, baseUrl);
  }

  return null;
}

/**
 * VidGuard (listeamed.net and its sibling domains) publishes the stream URL with an
 * obfuscated `sig` query parameter; the CDN answers 403 until it is decoded. The
 * transform is fixed: hex pairs XORed with 2, base64-decoded, the trailing five
 * bytes dropped, reversed, adjacent characters swapped, then five more characters
 * dropped.
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

    const bytes = Buffer.from(deobfuscated, 'base64');
    if (bytes.length <= 10) return streamUrl;

    const characters = Array.from(bytes.subarray(0, bytes.length - 5))
      .reverse()
      .map((byte) => String.fromCharCode(byte));
    for (let index = 0; index + 1 < characters.length; index += 2) {
      const swap = characters[index];
      characters[index] = characters[index + 1];
      characters[index + 1] = swap;
    }

    parsed.searchParams.set('sig', characters.join('').slice(0, -5));
    return parsed.toString();
  } catch (error) {
    console.warn(`Unpacker: VidGuard signature decode failed: ${error.message}`);
    return streamUrl;
  }
}

function extractVidguardStream(html, baseUrl) {
  for (const source of [html, ...iterUnpackedScripts(html)]) {
    if (!source) continue;

    const normalized = source.replace(/\\\//g, '/');
    const configMatch = normalized.match(/["'](?:stream|hls|file)["']\s*:\s*["']([^"']+)["']/i)
      || normalized.match(/(https?:\/\/[^\s'"`<>]+[?&]sig=[^\s'"`<>]+)/i);
    const candidate = normalizeUrl(configMatch?.[1], baseUrl);
    if (candidate) return decodeVidguardSignature(candidate);
  }

  return null;
}

/**
 * MediaFire serves a landing page, not the file. Cinecalidad's download options are
 * mostly MediaFire, and handing the landing page URL on as a stream meant every one
 * of them failed the playability check.
 */
function extractMediafireDirectUrl(html, baseUrl) {
  if (!html) return null;

  const $ = cheerio.load(html);
  const button = $('#downloadButton').first();

  const href = normalizeUrl(button.attr('href'), baseUrl);
  if (href && !/(^|\.)mediafire\.com\/file\//i.test(href) && isHttpUrl(href)) {
    return href;
  }

  const scrambled = button.attr('data-scrambled-url');
  if (scrambled) {
    try {
      const decoded = Buffer.from(scrambled, 'base64').toString('utf8');
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
      while ((fallbackMatch = fallbackRegex.exec(html)) !== null) {
        loopMatches.push(fallbackMatch);
      }
    }

    for (const candidateMatch of loopMatches) {
      const arrayName = fileVarName ? candidateMatch[1] : candidateMatch[2];
      const subtractValue = parseInt(fileVarName ? candidateMatch[2] : candidateMatch[3], 10);
      const arrayPattern = new RegExp(`var\\s+${arrayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*(\\[[\\s\\S]*?\\]);`);
      const arrayMatch = html.match(arrayPattern);
      if (!arrayMatch) continue;

      const encodedParts = JSON.parse(arrayMatch[1]);
      const streamUrl = encodedParts.map((part) => {
        const digits = Buffer.from(part, 'base64').toString('utf8').replace(/\D/g, '');
        return String.fromCharCode(parseInt(digits, 10) - subtractValue);
      }).join('');

      if (!/\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(streamUrl)) continue;

      const sessionMatch = html.match(/\bsesz\s*=\s*["']([^"']+)["']/);
      const directUrl = normalizeUrl(streamUrl, baseUrl);
      if (!directUrl || !sessionMatch) return directUrl;

      const parsed = new URL(directUrl);
      if (!parsed.searchParams.has('s')) {
        parsed.searchParams.set('s', sessionMatch[1]);
      }
      return parsed.toString();
    }
  } catch (error) {
    console.warn(`Unpacker: Nupload decode failed: ${error.message}`);
  }

  return null;
}

/**
 * embed69 names a server for every link it returns. This used to be a nine-name
 * allowlist, which silently discarded every link on a host that had since gained a
 * resolver — and every host the generic extractor would have handled. Anything that
 * is not an unresolvable locker now gets an attempt, bounded by MAX_EMBED69_ATTEMPTS.
 */
function isSupportedEmbedServer(server) {
  return !isFileLockerServer(server);
}

const crypto = require('crypto');

/**
 * Pelisplus AES decryptor.
 * Servers like pelisplus.upns.pro, pelisplusto.4meplayer.pro, pelisplus.strp2p.com
 * all encrypt their /api/v1/video?id=<hash> API responses with a static AES-128-CBC key.
 * The key is derived from the S() function in their JS bundle (always uses firstChar='t').
 * The IV is derived from the _() function (always the same on HTTPS).
 */
function _buildPelisplusKeyAndIV() {
  function m(...args) { return String.fromCharCode(...args); }
  function p(str, n) { return str.charCodeAt(n) || 0; }
  
  // S() with firstChar='t' (static)
  const v = '#t';
  const P = '10'; const O = 110; const G = 1;
  let N = '';
  const B = '\u1d5f'.charCodeAt(0).toString().split(''); // '7519'
  for (let ye = 0; ye < B.length; ye++) N += m(parseInt(P + B[ye]));
  N += m(p(v, 1));
  N += N.substring(1, 3);
  N += m(O, O - 1, O + 7);
  const oe = '3579'.split('');
  N += m(oe[3] + oe[2], oe[1] + oe[2]);
  const val1 = oe[0] * G + G + oe[3];
  N += m(val1, val1);
  const val2 = oe[3] * P + oe[3] * G;
  oe.reverse();
  const val3 = parseInt(oe.join('').substring(0, 2));
  N += m(val2, val3);
  const key = Buffer.from(N, 'utf8').slice(0, 16);
  
  // _() — always the same on https://
  let B2 = '';
  for (let Ie = 1; Ie < 10; Ie++) B2 += m(Ie + 48);
  B2 += m(48, 111, 0, 117, 121, 116, 114);
  const iv = Buffer.from(B2, 'utf8').slice(0, 16);
  
  return { key, iv };
}

const { key: PELISPLUS_KEY, iv: PELISPLUS_IV } = _buildPelisplusKeyAndIV();

/**
 * Resolves a pelisplus embed URL (upns.pro, 4meplayer.pro, strp2p.com) to a direct m3u8.
 */
async function resolvePelisplus(embedUrl, userAgent, referer, signal) {
  try {
    const urlObj = new URL(embedUrl);
    const hash = urlObj.hash.replace('#', '');
    const host = urlObj.hostname;
    if (!hash) return null;
    
    const apiUrl = `https://${host}/api/v1/video?id=${hash}`;
    const { res, text: hexData } = await fetchTextWithTimeout(apiUrl, {
      headers: { 'User-Agent': userAgent, 'Referer': referer || embedUrl, 'Origin': `https://${host}` },
      signal
    }, PELISPLUS_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    
    const buf = Buffer.from(hexData.trim(), 'hex');
    
    const decipher = crypto.createDecipheriv('aes-128-cbc', PELISPLUS_KEY, PELISPLUS_IV);
    decipher.setAutoPadding(true);
    const decrypted = decipher.update(buf, undefined, 'utf8') + decipher.final('utf8');
    
    // Strip all control/non-printable characters that get embedded in the JSON
    const cleaned = decrypted.replace(/[^\x20-\x7E\x0A\x0D]/g, '');
    let data = null;
    try { data = JSON.parse(cleaned); } catch { /* try regex fallback below */ }
    
    // Regex fallback: extract source URL directly from the (possibly corrupted) JSON string
    let src = data && data.source ? data.source : null;
    if (!src) {
      const sourceMatch = cleaned.match(/"source"\s*:\s*"([^"]+)"/);
      if (sourceMatch) src = sourceMatch[1];
    }
    
    if (src) {
      src = src.split('\\/').join('/');
      if (src.startsWith('ttps://')) src = 'h' + src;
      if (!src.startsWith('http')) return null;
      console.log(`Unpacker: Pelisplus resolved ${host} => ${src.substring(0, 80)}...`);
      return src;
    }
    return null;
  } catch (e) {
    console.error('resolvePelisplus error:', e.message);
    return null;
  }
}

/**
 * Strips PKCS#7 padding from a decrypted string, tolerating a trailing byte that
 * is not padding at all. A pad of 0 would make slice(0, -0) return the whole
 * string emptied, and a decrypted block whose last byte happens to exceed the
 * block size would otherwise cut real content off the end.
 */
function stripPkcs7Padding(decrypted) {
  const pad = decrypted.charCodeAt(decrypted.length - 1);
  if (!Number.isInteger(pad) || pad < 1 || pad > 16 || pad > decrypted.length) {
    return decrypted;
  }
  return decrypted.slice(0, -pad);
}

function decryptEmbed69(html) {
  const powChallengeMatch = html.match(/const POW_CHALLENGE = '([^']+)';/);
  const powDifficultyMatch = html.match(/const POW_DIFFICULTY = (\d+);/);
  const powSaltMatch = html.match(/const POW_SALT = '([^']+)';/);
  const dataLinkMatch = html.match(/let dataLink = (\[.*?\]);/);
  
  if (!powChallengeMatch || !powDifficultyMatch || !powSaltMatch || !dataLinkMatch) {
      return null;
  }
  
  const challenge = powChallengeMatch[1];
  const difficulty = parseInt(powDifficultyMatch[1]);
  const salt = powSaltMatch[1];
  let dataLink = [];
  try {
      dataLink = JSON.parse(dataLinkMatch[1]);
  } catch(e) {
      return null;
  }
  
  if (difficulty > MAX_POW_DIFFICULTY) {
      console.warn(`Unpacker: Refusing embed69 proof-of-work at difficulty ${difficulty} (max ${MAX_POW_DIFFICULTY}).`);
      return null;
  }

  const prefix = '0'.repeat(difficulty);
  const powDeadline = Date.now() + MAX_POW_MS;
  let nonce = 0;
  let aesKey = null;
  while (true) {
      const hash = crypto.createHash('sha256').update(challenge + nonce).digest('hex');
      if (hash.startsWith(prefix)) {
          aesKey = crypto.createHash('sha256').update(challenge + nonce + salt).digest();
          break;
      }
      nonce++;
      // Checked in blocks so the clock read costs nothing next to ~1k hashes.
      if ((nonce & 0x3ff) === 0 && Date.now() > powDeadline) {
          console.warn(`Unpacker: embed69 proof-of-work (difficulty ${difficulty}) exceeded ${MAX_POW_MS}ms after ${nonce} nonces; giving up.`);
          return null;
      }
  }

  const decryptedLinks = [];
  for (const file of dataLink) {
      if (file.sortedEmbeds) {
          for (const embed of file.sortedEmbeds) {
              if (embed.link && embed.type === 'video') {
                  try {
                      const raw = Buffer.from(embed.link, 'base64');
                      const iv = raw.slice(0, 16);
                      const ciphertext = raw.slice(16);
                      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
                      decipher.setAutoPadding(false);
                      const decrypted = stripPkcs7Padding(
                        decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
                      );
                      decryptedLinks.push({ server: embed.servername, url: decrypted, kind: 'video' });
                  } catch (e) {
                      // ignore
                  }
              }
          }
      }

      if (file.downloadEmbeds) {
          for (const embed of file.downloadEmbeds) {
              if (embed.link) {
                  try {
                      const raw = Buffer.from(embed.link, 'base64');
                      const iv = raw.slice(0, 16);
                      const ciphertext = raw.slice(16);
                      const decipher = crypto.createDecipheriv('aes-256-cbc', aesKey, iv);
                      decipher.setAutoPadding(false);
                      const decrypted = stripPkcs7Padding(
                        decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8')
                      );
                      decryptedLinks.push({ server: embed.servername, url: decrypted, kind: 'download' });
                  } catch (e) {
                      // ignore
                  }
              }
          }
      }
  }
  return decryptedLinks;
}

/**
 * Dood's `/pass_md5/` handshake, run against whichever page the embed landed on.
 *
 * `pageUrl` is the URL the body was actually served from, which after the playmogo
 * rebrand is never the URL we asked for: a relative /pass_md5/ resolved against the
 * link we started from pointed at a host that only redirects.
 *
 * Checked against live links in July 2026 (real dood embeds taken off a Cuevana3i
 * page): every mirror 301s to playmogo.com, which answers 403 with a Cloudflare
 * managed challenge — `cf-mitigated: challenge`, the "Just a moment..." interstitial
 * — and no pass_md5 in the body, so this returns null before spending a request.
 * The other Cloudflare-fronted sources this addon scrapes answered 200 from the same
 * address at the same time, so that is playmogo's policy for embed pages rather than
 * a reputation problem at one address. The handshake is kept rather than deleted
 * because it is a page-shape check that costs nothing when the shape is absent, and
 * it is what will pick the host back up if the challenge is ever lifted. What this
 * finding does change is the ranking: see scoreXupalaceServer.
 */
async function resolveDood(html, url, userAgent, signal, pageUrl = url) {
  if (!isDoodHost(url) && !isDoodHost(pageUrl)) return null;

  const passMatch = html.match(/(["'])(\/pass_md5\/[^"'<>]+)\1/i)
    || html.match(/(["'])(https?:\/\/[^"'<>]+\/pass_md5\/[^"'<>]+)\1/i);
  const passUrl = normalizeUrl(passMatch?.[2], pageUrl);
  if (!passUrl) return null;

  try {
    const { res, text } = await fetchTextWithTimeout(passUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': pageUrl,
        'X-Requested-With': 'XMLHttpRequest'
      },
      signal
    }, DOOD_DIRECT_TIMEOUT_MS);
    if (!res.ok) return null;

    const direct = text.trim().replace(/\\\//g, '/');
    if (/^https?:\/\/.+\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(direct)) {
      return direct;
    }

    return null;
  } catch {
    return null;
  }
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function getFilemoonKeyParts(payload) {
  const keyParts = Array.isArray(payload?.key_parts) ? payload.key_parts : [];
  const version = String(payload?.version || '').trim();
  const versionNumber = Number(version);

  if (
    Number.isInteger(versionNumber)
    && versionNumber >= 1
    && versionNumber <= 20
    && versionNumber <= keyParts.length
    && (31 - versionNumber) <= keyParts.length
  ) {
    return [keyParts[versionNumber - 1], keyParts[30 - versionNumber]].filter(Boolean);
  }

  return keyParts;
}

function decryptFilemoonPayload(payload) {
  const keyParts = getFilemoonKeyParts(payload).filter((part) => typeof part === 'string' && part.length > 0);
  if (!keyParts.length || !payload?.iv || !payload?.payload) return null;

  const key = Buffer.concat(keyParts.map(base64UrlDecode));
  const iv = base64UrlDecode(payload.iv);
  const encrypted = base64UrlDecode(payload.payload);
  const tagLength = 16;
  if (![16, 24, 32].includes(key.length) || encrypted.length <= tagLength) return null;

  const ciphertext = encrypted.subarray(0, encrypted.length - tagLength);
  const authTag = encrypted.subarray(encrypted.length - tagLength);
  const decipher = crypto.createDecipheriv(`aes-${key.length * 8}-gcm`, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

function extractFilemoonCode(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/(?:e|d|file|download)\/([^/?#]+)/i);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function buildFilemoonApiUrl(url, code, path) {
  return new URL(`/api/videos/${encodeURIComponent(code)}/${path}`, url).toString();
}

function buildFilemoonHeaders(url, userAgent, referer) {
  return {
    'User-Agent': userAgent,
    'Referer': url,
    'Origin': new URL(url).origin,
    'Accept': 'application/json',
    'X-Embed-Origin': referer ? getHostname(referer) : '',
    'X-Embed-Referer': referer || url,
    'X-Embed-Parent': referer || url
  };
}

/**
 * The player posts a device attestation alongside the playback request. Its
 * contents are only used for abuse scoring — the request is refused outright
 * without one — so a per-request identifier is enough to get a verdict back.
 */
function buildFilemoonFingerprint() {
  return {
    token: crypto.randomBytes(16).toString('hex'),
    viewer_id: crypto.randomUUID(),
    device_id: crypto.randomUUID(),
    confidence: 0
  };
}

/**
 * Filemoon's embed is a single-page app — the stream is never in the HTML, so the
 * generic extractor has nothing to work with and the JSON API below is the only
 * route to it.
 *
 * The request shape is taken from the current player bundle
 * (`/assets/videoPagesBundle-*.js`): the URL is built same-origin as
 * `/api/videos/<code>/embed/playback`, and playback is a POST carrying a
 * `fingerprint` object. A GET — which is what this used to send — is answered
 * `405 method not allowed`, as is a POST without the fingerprint.
 *
 * Getting a stream back also needs `captcha_required` to be false for the file.
 * When it is true the server answers `428 captcha_required` unless an
 * `X-Captcha-Token` from a solved reCAPTCHA is attached, which cannot be produced
 * server-side. Every file sampled in July 2026 was gated this way, so the settings
 * probe short-circuits those rather than spending a second round-trip to be
 * refused. If that policy ever relaxes, the playback path below is ready for it.
 */
async function resolveFilemoon(url, userAgent, referer, signal) {
  if (!isFilemoonHost(url)) return null;

  const code = extractFilemoonCode(url);
  if (!code) return null;

  const headers = buildFilemoonHeaders(url, userAgent, referer);

  try {
    const { res, text } = await fetchTextWithTimeout(
      buildFilemoonApiUrl(url, code, 'embed/settings'),
      { headers, signal },
      FILEMOON_API_TIMEOUT_MS
    );
    if (!res.ok) return null;

    if (JSON.parse(text)?.captcha_required) {
      console.log(`Unpacker: Filemoon ${code} requires a captcha; skipping.`);
      return null;
    }
  } catch (error) {
    console.warn(`Unpacker: Filemoon settings probe failed for ${url}: ${error.message}`);
    return null;
  }

  try {
    const { res, text } = await fetchTextWithTimeout(
      buildFilemoonApiUrl(url, code, 'embed/playback'),
      {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ fingerprint: buildFilemoonFingerprint() }),
        signal
      },
      FILEMOON_API_TIMEOUT_MS
    );
    if (!res.ok) return null;

    const data = JSON.parse(text);
    const decrypted = decryptFilemoonPayload(data.playback || data);
    const sources = Array.isArray(decrypted?.sources) ? decrypted.sources : [];
    const direct = sources
      .map((source) => source?.url)
      .find((sourceUrl) => /\.(m3u8|mp4|mkv)(?:$|[?#])/i.test(sourceUrl || ''));
    if (direct) return normalizeUrl(direct, url);
  } catch (error) {
    console.warn(`Unpacker: Filemoon API resolve failed for ${url}: ${error.message}`);
  }

  return null;
}

function addVoePermanentToken(url) {
  const token = process.env.VOE_PERMANENT_TOKEN;
  if (!token || !isVoeHost(url)) return null;

  try {
    const parsed = new URL(url);
    if (!parsed.searchParams.has('permanentToken')) {
      parsed.searchParams.set('permanentToken', token);
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/**
 * Advanced recursive player resolver.
 * Handles known external players (like embed69, vidhide, pelisplus, emturbovid etc)
 * to extract the final direct .m3u8/.mp4
 */
async function resolvePlayerStream(url, userAgent, referer, options = {}) {
    const depth = options.depth || 0;
    const visited = options.visited || new Set();
    const signal = options.signal;
    const normalizedInputUrl = normalizeUrl(url, referer);
    if (!normalizedInputUrl || depth > MAX_RESOLVE_DEPTH || visited.has(normalizedInputUrl)) {
        return null;
    }
    visited.add(normalizedInputUrl);
    url = normalizeEmbedUrl(normalizedInputUrl, referer);
    if (visited.has(url) && url !== normalizedInputUrl) {
        return null;
    }
    visited.add(url);

    if (isDefunctHost(url)) {
        console.log(`Unpacker: Skipping ${getHostname(url)}, which accepts no connections`);
        return null;
    }

    try {
        // Pelisplus SPA players (upns, 4meplayer, strp2p, rpmstream)
        if (isPelisplusHost(url)) {
            const m3u8 = await resolvePelisplus(url, userAgent, referer, signal);
            if (m3u8) return m3u8;
        }

        if (isFilemoonHost(url)) {
            const directUrl = await resolveFilemoon(url, userAgent, referer, signal);
            return directUrl;
        }

        const { res, text: rawHtml } = await fetchTextWithTimeout(url, {
            headers: { 'User-Agent': userAgent, 'Referer': referer },
            signal
        }, PLAYER_FETCH_TIMEOUT_MS);
        if (!res.ok) return null;

        let html = rawHtml;
        const altchaGate = extractAltchaGate(html);
        if (altchaGate) {
            const solved = await resolveAltchaGate(url, res, altchaGate, userAgent, referer, signal);
            if (!solved) return null;
            html = solved.text;
        }

        if (isXupalaceHost(url) || html.includes('go_to_playerVast')) {
            const xupalaceDirectUrl = await resolveXupalaceServers(html, url, userAgent, { depth, visited, signal });
            if (xupalaceDirectUrl) return xupalaceDirectUrl;
        }

        if (isVoeHost(url) && html.includes('generate-token') && !url.includes('permanentToken=')) {
            const tokenUrl = addVoePermanentToken(url);
            if (tokenUrl && tokenUrl !== url) {
                const tokenDirectUrl = await resolvePlayerStream(tokenUrl, userAgent, referer, { depth: depth + 1, visited, signal });
                if (tokenDirectUrl) return tokenDirectUrl;
            }
        }

        if (isVoeHost(url)) {
            const voeDirectUrl = extractVoeDirectStream(html, url);
            if (voeDirectUrl) return voeDirectUrl;
        }

        if (isNetuFamilyHost(url)) {
            const netuDirectUrl = extractNetuDirectStream(html, url);
            if (netuDirectUrl) return netuDirectUrl;

            const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
            const iframeUrl = normalizeUrl(iframeMatch?.[1], url);
            if (iframeUrl && iframeUrl !== url && isNetuFamilyHost(iframeUrl)) {
                return await resolvePlayerStream(iframeUrl, userAgent, url, { depth: depth + 1, visited, signal });
            }

            return null;
        }

        if (isVidguardHost(url)) {
            const vidguardDirectUrl = extractVidguardStream(html, url);
            if (vidguardDirectUrl) return vidguardDirectUrl;
        }

        if (isMediafireHost(url)) {
            const mediafireDirectUrl = extractMediafireDirectUrl(html, url);
            if (mediafireDirectUrl) return mediafireDirectUrl;
        }

        if (isNuploadHost(url)) {
            const nuploadDirectUrl = extractNuploadDirectStream(html, url);
            if (nuploadDirectUrl) return nuploadDirectUrl;
        }

        if (isStreamtapeHost(url)) {
            const streamtapeDirectUrl = extractStreamtapeStream(html, url);
            if (streamtapeDirectUrl) return streamtapeDirectUrl;
        }

        // emturbovid / turbovidhls: extract m3u8 from data-hash attribute or urlPlay variable
        if (url.includes('emturbovid') || url.includes('turbovidhls') || url.includes('turboviplay')) {
            const dataHash = html.match(/data-hash=["']([^"']+\.m3u8[^"']*)/);
            if (dataHash) return normalizeUrl(dataHash[1], url);
            const urlPlay = html.match(/var\s+urlPlay\s*=\s*["']([^"']+\.m3u8[^"']*)/);
            if (urlPlay) return normalizeUrl(urlPlay[1], url);
        }

        const doodDirectUrl = await resolveDood(html, url, userAgent, signal, res.url || url);
        if (doodDirectUrl) return doodDirectUrl;

        // Check if it's embed69, including mirrored /vidurl pages that serve Embed69 HTML.
        if (url.includes('embed69') || (html.includes('POW_CHALLENGE') && html.includes('dataLink'))) {
            const embed69Links = decryptEmbed69(html);
            if (embed69Links && embed69Links.length > 0) {
                // Try resolving the first valid video embed (e.g. vidhide)
                const rankedEmbeds = embed69Links.sort((a, b) => {
                    const kindScore = (value) => value.kind === 'video' ? 0 : 1;
                    const serverScore = (value) => {
                        const server = (value.server || '').toLowerCase();
                        if (server === 'vidhide' || server === 'streamwish' || server === 'hlswish') return 0;
                        if (server === 'rapidvideo') return 1;
                        if (server === 'vidguard' || server === 'listeamed') return 5;
                        if (server === 'luluvdo' || server === 'vudeo' || server === 'streamhide') return 6;
                        if (server === 'netu' || server === 'waaw' || server === 'hqq') return 7;
                        // Filemoon gates playback behind a captcha, VOE behind a
                        // DDoS-Guard JS check, and Dood behind the Cloudflare managed
                        // challenge playmogo.com serves every embed page behind; none
                        // can be answered server-side (see resolveFilemoon,
                        // resolveDood and scoreXupalaceServer). Ranked above, each
                        // burned one of MAX_EMBED69_ATTEMPTS on every page that
                        // listed it — Dood at 3 was ahead of four hosts that resolve.
                        if (
                          server === 'filemoon'
                          || server === 'voe'
                          || server === 'dood'
                          || server === 'doodstream'
                          || server === 'doodstreaming'
                          || server === 'playmogo'
                        ) return 8;
                        return 2;
                    };
                    return kindScore(a) - kindScore(b) || serverScore(a) - serverScore(b);
                });

                // The attempt cap is applied by selecting the candidates up front
                // rather than by counting as we go: with overlapping resolutions
                // there is no single running total to compare against, and the cap
                // has always meant "try at most this many", which this preserves.
                const attemptedEmbeds = rankedEmbeds
                    .filter((embed) => isSupportedEmbedServer(embed.server))
                    .slice(0, MAX_EMBED69_ATTEMPTS);

                const directUrl = await firstResultInOrder(attemptedEmbeds, EMBED_RESOLVE_CONCURRENCY, async (embed) => (
                    resolvePlayerStream(embed.url, userAgent, url, { depth: depth + 1, visited, signal })
                ));
                if (directUrl) return directUrl;
            }
        }
        
        // VOE's mirror domains rotate faster than any list of them can be kept
        // current, so a page that was not recognised by host still gets one
        // speculative decode. It costs nothing on a non-VOE page: the payload only
        // yields JSON with a source field if it really is one.
        if (!isVoeHost(url)) {
            const voeMirrorUrl = extractVoeDirectStream(html, url, { quiet: true });
            if (voeMirrorUrl) {
                console.log(`Unpacker: Recognised ${getHostname(url)} as a VOE mirror by payload`);
                return voeMirrorUrl;
            }
        }

        // Check for JS redirect (e.g. VOE initial page). The match is not necessarily
        // the page's real navigation — adblock detectors and back-button handlers
        // assign location.href too — so a redirect that leads nowhere must fall
        // through to this page's own extraction rather than end the resolve.
        const jsRedirectMatch = html.match(/(?:(?:window|self)\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|(?:(?:window|self)\.)?location\.(?:replace|assign)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        const redirectUrl = normalizeUrl(jsRedirectMatch?.[1] || jsRedirectMatch?.[2], url);
        if (redirectUrl && redirectUrl !== url && isHttpUrl(redirectUrl)) {
            console.log(`Unpacker: Following JS redirect to ${redirectUrl}`);
            const redirectDirectUrl = await resolvePlayerStream(redirectUrl, userAgent, referer, { depth: depth + 1, visited, signal });
            if (redirectDirectUrl) return redirectDirectUrl;
        }

        // Redirects built by concatenating a variable, which the literal scan above
        // cannot match (vudeo's fingerprint stub, for one).
        const assignedRedirectUrl = extractAssignedRedirect(html, url);
        if (assignedRedirectUrl && assignedRedirectUrl !== url && isHttpUrl(assignedRedirectUrl)) {
            console.log(`Unpacker: Following assigned redirect to ${assignedRedirectUrl}`);
            const assignedDirectUrl = await resolvePlayerStream(assignedRedirectUrl, userAgent, referer, { depth: depth + 1, visited, signal });
            if (assignedDirectUrl) return assignedDirectUrl;
        }

        const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
        const iframeUrl = normalizeUrl(iframeMatch?.[1], url);
        if (iframeUrl && iframeUrl !== url && isHttpUrl(iframeUrl)) {
            const directUrl = await resolvePlayerStream(iframeUrl, userAgent, url, { depth: depth + 1, visited, signal });
            if (directUrl) return directUrl;
        }

        // Standard dean-edwards / direct extraction
        const directUrl = extractDirectStream(html, url);
        if (directUrl) return normalizeUrl(directUrl, url);

        return null;
    } catch (e) {
        console.warn(`Unpacker: Player wrapper skipped (${getHostname(url) || url}): ${e.message}`);
        return null;
    }
}

/**
 * Resolves a download-host landing page to the file behind it. Sources that list
 * download mirrors alongside their players hand back a page URL, which is not
 * playable and fails validation as HTML; this turns it into the real target where
 * the host allows it, and returns the input unchanged where it does not.
 */
async function resolveDownloadUrl(url, userAgent, referer, options = {}) {
  if (!isMediafireHost(url)) return url;

  try {
    const { res, text: html } = await fetchTextWithTimeout(url, {
      headers: { 'User-Agent': userAgent, 'Referer': referer || url },
      signal: options.signal
    }, PLAYER_FETCH_TIMEOUT_MS);
    if (!res.ok) return url;

    const directUrl = extractMediafireDirectUrl(html, url);
    if (directUrl) {
      console.log(`Unpacker: MediaFire resolved ${url} => ${directUrl.substring(0, 80)}...`);
      return directUrl;
    }
  } catch (error) {
    console.warn(`Unpacker: MediaFire resolve failed for ${url}: ${error.message}`);
  }

  return url;
}

module.exports = {
  __test: {
    cleanEscapedStreamUrl,
    decodeVidguardSignature,
    isDefunctHost,
    isDoodHost,
    decryptFilemoonPayload,
    extractAssignedRedirect,
    extractMediafireDirectUrl,
    extractStreamtapeStream,
    extractVidguardStream,
    extractVoeDirectStream,
    extractAltchaGate,
    solveAltchaChallenge,
    mergeSetCookies,
    isPelisplusHost,
    isStreamtapeHost,
    isSupportedEmbedServer,
    scoreXupalaceServer,
    iterUnpackedScripts,
    normalizeEmbedUrl,
    stripPkcs7Padding
  },
  decryptEmbed69,
  extractDirectStream,
  extractXupalaceServers,
  resolveDownloadUrl,
  resolvePelisplus,
  resolvePlayerStream,
  unpack
};

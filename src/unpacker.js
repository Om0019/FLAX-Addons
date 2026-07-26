/**
 * Dean Edwards Unpacker Utility
 */
const cheerio = require('cheerio');
const { decodeHtmlEntities, fetchTextWithTimeout, fetchWithTimeout, normalizeUrl } = require('./http');

const PLAYER_FETCH_TIMEOUT_MS = 5000;
const PELISPLUS_FETCH_TIMEOUT_MS = 4500;
const MAX_RESOLVE_DEPTH = 5;
const DOOD_DIRECT_TIMEOUT_MS = 1800;
const FILEMOON_API_TIMEOUT_MS = 3500;
// embed69 states its own proof-of-work difficulty, and the search costs 16^difficulty
// hashes. Node is single-threaded, so an unbounded search stalls every other in-flight
// request: difficulty 6 measures ~58s of blocked event loop, difficulty 7 ~15 minutes.
// Bound it in wall-clock time so the damage is capped regardless of CPU speed, and
// reject difficulties that are hopeless up front. Difficulty 5 (~1.3s expected) still
// completes ~90% of the time; anything slower is not worth the shared event loop.
const MAX_POW_DIFFICULTY = 6;
const MAX_POW_MS = 3000;

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
 * Parses HTML, finds any packed scripts, unpacks them, and looks for .m3u8/.mp4 stream URLs.
 * Also scans the HTML directly for any un-packed stream URLs as a fallback.
 */
function extractDirectStream(html, baseUrl) {
  if (!html) return null;

  const normalizedHtml = decodeHtmlEntities(html).replace(/\\\//g, '/');

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
  ].map((link) => normalizeUrl(link, baseUrl)).filter(Boolean).filter(link => {
    const l = link.toLowerCase();
    return !l.includes('google-analytics')
      && !l.includes('analytics.js')
      && !l.includes('tagmanager')
      && !l.includes('test-videos.co.uk')
      && !l.includes('big_buck_bunny');
  });

  if (validDirect.length > 0) {
    return [...new Set(validDirect)][0];
  }

  // 2. Scan and unpack packed scripts (e.g. vidhide, hlswish, vimeos)
  const packerRegex = /eval\s*\(\s*function\s*\(\s*p\s*,\s*a\s*,\s*c\s*,\s*k\s*,\s*e\s*,\s*d\s*\)[\s\S]*?\}\s*\(\s*(['"])([\s\S]*?)\1\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(['"])([\s\S]*?)\5\.split\(['"]\|['"]\)/gi;
  
  let match;
  while ((match = packerRegex.exec(normalizedHtml)) !== null) {
    try {
      let p = match[2].trim();
      const a = parseInt(match[3]);
      const c = parseInt(match[4]);
      let kStr = match[6].trim();
      const k = kStr.split('|');
      
      const unpacked = unpack(p, a, c, k, {}, {});
      const streamMatches = unpacked.match(directRegex) || [];
      const validStreams = streamMatches.map((link) => normalizeUrl(link, baseUrl)).filter(Boolean).filter(link => {
        const l = link.toLowerCase();
        return !l.includes('analytics')
          && !l.includes('ads')
          && !l.includes('test-videos.co.uk')
          && !l.includes('big_buck_bunny');
      });

      if (validStreams.length > 0) {
        return [...new Set(validStreams)][0];
      }
    } catch (err) {
      console.error('Unpacker: Failed to decode script block:', err.message);
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

function isDoodHost(value) {
  return /(^|\.)dood\.(?:li|to|stream|watch|so|pm|ws)$/i.test(getHostname(value));
}

function isFilemoonHost(value) {
  return /(^|\.)filemoon\.(?:sx|to|in|nl|wt|eu|art)$/i.test(getHostname(value));
}

function isVoeHost(value) {
  const host = getHostname(value);
  return /(^|\.)voe\.sx$/i.test(host)
    || host.includes('pamelachangemission.com');
}

function isWaawHost(value) {
  const host = getHostname(value);
  return /(^|\.)waaw\.to$/i.test(host);
}

function isNuploadHost(value) {
  const host = getHostname(value);
  return /(^|\.)n(?:u)?upload\.(?:top|me)$/i.test(host);
}

function isXupalaceHost(value) {
  return /(^|\.)xupalace\.org$/i.test(getHostname(value));
}

const XUPALACE_LOCKER_SERVERS = new Set([
  '1fichier', 'fichier', 'mega', 'mediafire', 'uptobox', 'drive',
  'gofile', 'wetransfer', 'terabox', 'pixeldrain', 'zippyshare'
]);

function scoreXupalaceServer(server) {
  const s = (server || '').toLowerCase();
  if (s.includes('streamwish') || s.includes('hlswish') || s.includes('vidhide')) return 0;
  if (s.includes('filemoon')) return 1;
  if (s.includes('dood')) return 2;
  if (s.includes('voe')) return 4;
  if (s.includes('waaw') || s.includes('netu')) return 5;
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
    .filter((entry) => !XUPALACE_LOCKER_SERVERS.has(entry.server))
    .sort((a, b) => scoreXupalaceServer(a.server) - scoreXupalaceServer(b.server));

  for (const entry of servers) {
    try {
      const directUrl = await resolvePlayerStream(entry.url, userAgent, baseUrl, { depth: depth + 1, visited, signal });
      if (directUrl) return directUrl;
    } catch (e) {
      console.warn(`Unpacker: Xupalace server ${entry.server || entry.url} failed: ${e.message}`);
    }
  }

  return null;
}

function normalizeWaawEmbedUrl(url, referer) {
  if (!isWaawHost(url)) return url;

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

function extractWaawDirectStream(html, baseUrl) {
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

function decodeVoePayload(encoded) {
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
    console.warn(`Unpacker: VOE payload decode failed: ${error.message}`);
    return null;
  }
}

function extractVoeDirectStream(html, baseUrl) {
  if (!html) return null;

  const scriptRegex = /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(html)) !== null) {
    try {
      const payload = JSON.parse(match[1].trim());
      const encoded = Array.isArray(payload) && typeof payload[0] === 'string' ? payload[0] : null;
      if (!encoded) continue;

      const data = decodeVoePayload(encoded);
      if (!data) continue;

      const fallback = Array.isArray(data.fallback) ? data.fallback.map((item) => item?.file) : [];
      const candidates = [
        data.source,
        ...fallback,
        data.direct_access_allowed ? data.direct_access_url : null
      ].filter(Boolean);

      const direct = candidates.find((candidate) => /\.(?:m3u8|mp4|mkv)(?:$|[?#])/i.test(candidate));
      if (direct) return normalizeUrl(direct, baseUrl);
    } catch {
      // Ignore unrelated JSON script tags.
    }
  }

  return null;
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

function isSupportedEmbedServer(server) {
  return [
    'vidhide',
    'streamwish',
    'hlswish',
    'rapidvideo',
    'filemoon',
    'dood',
    'doodstream',
    'doodstreaming',
    'voe'
  ].includes((server || '').toLowerCase());
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
    const res = await fetchWithTimeout(apiUrl, {
      headers: { 'User-Agent': userAgent, 'Referer': referer || embedUrl, 'Origin': `https://${host}` },
      signal
    }, PELISPLUS_FETCH_TIMEOUT_MS);
    if (!res.ok) return null;
    
    const hexData = await res.text();
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
                      let decrypted = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
                      const pad = decrypted.charCodeAt(decrypted.length - 1);
                      decrypted = decrypted.slice(0, -pad);
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
                      let decrypted = decipher.update(ciphertext, undefined, 'utf8') + decipher.final('utf8');
                      const pad = decrypted.charCodeAt(decrypted.length - 1);
                      decrypted = decrypted.slice(0, -pad);
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

async function resolveDood(html, url, userAgent, signal) {
  if (!isDoodHost(url)) return null;

  const passMatch = html.match(/(["'])(\/pass_md5\/[^"'<>]+)\1/i)
    || html.match(/(["'])(https?:\/\/[^"'<>]+\/pass_md5\/[^"'<>]+)\1/i);
  const passUrl = normalizeUrl(passMatch?.[2], url);
  if (!passUrl) return null;

  try {
    const res = await fetchWithTimeout(passUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': url,
        'X-Requested-With': 'XMLHttpRequest'
      },
      signal
    }, DOOD_DIRECT_TIMEOUT_MS);
    if (!res.ok) return null;

    const direct = (await res.text()).trim().replace(/\\\//g, '/');
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

async function resolveFilemoon(url, userAgent, referer, signal) {
  if (!isFilemoonHost(url)) return null;

  const code = extractFilemoonCode(url);
  if (!code) return null;

  const apiPaths = [
    `/api/videos/${encodeURIComponent(code)}/embed/playback`,
    `/api/videos/${encodeURIComponent(code)}/playback`
  ];

  for (const path of apiPaths) {
    try {
      const apiUrl = new URL(path, url).toString();
      const { res, text } = await fetchTextWithTimeout(apiUrl, {
        headers: {
          'User-Agent': userAgent,
          'Referer': url,
          'Origin': new URL(url).origin,
          'Accept': 'application/json',
          'X-Embed-Origin': referer ? getHostname(referer) : '',
          'X-Embed-Referer': referer || url,
          'X-Embed-Parent': referer || url
        },
        signal
      }, FILEMOON_API_TIMEOUT_MS);
      if (!res.ok) continue;

      const data = JSON.parse(text);
      const playback = data.playback || data;
      const decrypted = decryptFilemoonPayload(playback);
      const sources = Array.isArray(decrypted?.sources) ? decrypted.sources : [];
      const direct = sources
        .map((source) => source?.url)
        .find((sourceUrl) => /\.(m3u8|mp4|mkv)(?:$|[?#])/i.test(sourceUrl || ''));
      if (direct) return normalizeUrl(direct, url);
    } catch (error) {
      console.warn(`Unpacker: Filemoon API resolve failed for ${url}: ${error.message}`);
    }
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
    url = normalizeWaawEmbedUrl(normalizedInputUrl, referer);
    if (visited.has(url) && url !== normalizedInputUrl) {
        return null;
    }
    visited.add(url);

    try {
        // Pelisplus SPA players (upns, 4meplayer, strp2p)
        if (url.includes('pelisplus.upns.pro') || url.includes('4meplayer.pro') || url.includes('strp2p.com')) {
            const m3u8 = await resolvePelisplus(url, userAgent, referer, signal);
            if (m3u8) return m3u8;
        }

        if (isFilemoonHost(url)) {
            const directUrl = await resolveFilemoon(url, userAgent, referer, signal);
            if (directUrl) return directUrl;
        }

        const { res, text: html } = await fetchTextWithTimeout(url, {
            headers: { 'User-Agent': userAgent, 'Referer': referer },
            signal
        }, PLAYER_FETCH_TIMEOUT_MS);
        if (!res.ok) return null;

        if (isXupalaceHost(url) || html.includes('go_to_playerVast')) {
            const xupalaceDirectUrl = await resolveXupalaceServers(html, url, userAgent, { depth, visited, signal });
            if (xupalaceDirectUrl) return xupalaceDirectUrl;
        }

        if (isVoeHost(url) && html.includes('generate-token') && !url.includes('permanentToken=')) {
            const tokenUrl = addVoePermanentToken(url);
            if (tokenUrl && tokenUrl !== url) {
                return await resolvePlayerStream(tokenUrl, userAgent, referer, { depth: depth + 1, visited, signal });
            }
        }

        if (isVoeHost(url)) {
            const voeDirectUrl = extractVoeDirectStream(html, url);
            if (voeDirectUrl) return voeDirectUrl;
        }

        if (isWaawHost(url)) {
            const waawDirectUrl = extractWaawDirectStream(html, url);
            if (waawDirectUrl) return waawDirectUrl;

            const iframeMatch = html.match(/<iframe[^>]+src=["']([^"']+)["']/i);
            const iframeUrl = normalizeUrl(iframeMatch?.[1], url);
            if (iframeUrl && iframeUrl !== url && isWaawHost(iframeUrl)) {
                return await resolvePlayerStream(iframeUrl, userAgent, url, { depth: depth + 1, visited, signal });
            }

            return null;
        }

        if (isNuploadHost(url)) {
            const nuploadDirectUrl = extractNuploadDirectStream(html, url);
            if (nuploadDirectUrl) return nuploadDirectUrl;
        }
        
        // emturbovid / turbovidhls: extract m3u8 from data-hash attribute or urlPlay variable
        if (url.includes('emturbovid') || url.includes('turbovidhls') || url.includes('turboviplay')) {
            const dataHash = html.match(/data-hash=["']([^"']+\.m3u8[^"']*)/);
            if (dataHash) return normalizeUrl(dataHash[1], url);
            const urlPlay = html.match(/var\s+urlPlay\s*=\s*["']([^"']+\.m3u8[^"']*)/);
            if (urlPlay) return normalizeUrl(urlPlay[1], url);
        }

        const doodDirectUrl = await resolveDood(html, url, userAgent, signal);
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
                        if (server === 'filemoon') return 2;
                        if (server === 'dood' || server === 'doodstream' || server === 'doodstreaming') return 3;
                        if (server === 'voe') return 5;
                        return 2;
                    };
                    return kindScore(a) - kindScore(b) || serverScore(a) - serverScore(b);
                });

                for (const embed of rankedEmbeds) {
                    if (isSupportedEmbedServer(embed.server)) {
                        const directUrl = await resolvePlayerStream(embed.url, userAgent, url, { depth: depth + 1, visited, signal });
                        if (directUrl) return directUrl;
                    }
                }
            }
        }
        
        // Check for JS redirect (e.g. VOE initial page)
        const jsRedirectMatch = html.match(/(?:(?:window|self)\.)?location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|(?:(?:window|self)\.)?location\.(?:replace|assign)\s*\(\s*['"]([^'"]+)['"]\s*\)/);
        const redirectUrl = normalizeUrl(jsRedirectMatch?.[1] || jsRedirectMatch?.[2], url);
        if (redirectUrl && redirectUrl !== url && isHttpUrl(redirectUrl)) {
            console.log(`Unpacker: Following JS redirect to ${redirectUrl}`);
            return await resolvePlayerStream(redirectUrl, userAgent, referer, { depth: depth + 1, visited, signal });
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

module.exports = {
  decryptEmbed69,
  extractDirectStream,
  extractXupalaceServers,
  resolvePelisplus,
  resolvePlayerStream,
  unpack
};

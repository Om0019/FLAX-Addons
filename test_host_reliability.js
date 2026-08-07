const { resolvePlayerStream } = require('./src/unpacker');
const { getStreams } = require('./src/scrapers');
const { fetchTextWithTimeout, fetchWithTimeout, normalizeUrl } = require('./src/http');
const cheerio = require('cheerio');

const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DISCOVERY_TIMEOUT_MS = 7000;

const wrapperFixtures = [
  ['filemoon', 'https://filemoon.sx/e/jit3ysg37ojx'],
  ['hlswish', 'https://hlswish.com/e/7mpdbzuy04uy'],
  ['embed69', 'https://embed69.org/f/tt1270797'],
  ['vidhide', 'https://vidhideplus.com/v/jwbzc2sk6vi4'],
  ['pelisplus-upns', 'https://pelisplus.upns.pro/#pkaw9'],
  ['voe', 'https://voe.sx/e/iwh9zzst5ezc'],
  ['waaw', 'https://waaw.to/f/PsX7c4rIU7wF'],
  ['streamlare', 'https://streamlare.com/e/XAQ9qzx1bgLl4mME']
];

const streamCases = [
  { type: 'movie', id: 'tt1631867', label: 'Al filo del manana' },
  { type: 'movie', id: 'tmdb:movie:1061474', label: 'Superman (2025)' },
  { type: 'movie', id: 'tmdb:movie:299534', label: 'Avengers: Endgame' },
  { type: 'movie', id: 'tmdb:movie:533535', label: 'Deadpool & Wolverine' },
  { type: 'movie', id: 'tmdb:movie:550', label: 'Fight Club' },
  { type: 'series', id: 'tmdb:series:100088', label: 'The Last of Us S1E1', season: 1, episode: 1 },
  { type: 'series', id: 'tmdb:series:1396', label: 'Breaking Bad S2E1', season: 2, episode: 1 },
  { type: 'series', id: 'tmdb:series:94997', label: 'House of the Dragon S1E1', season: 1, episode: 1 }
];

const discoveryPages = {
  tioplus: [
    ['Al filo del manana', 'https://tioplus.app/pelicula/al-filo-del-manana'],
    ['Superman (2025)', 'https://tioplus.app/pelicula/superman-2025'],
    ['Fight Club', 'https://tioplus.app/pelicula/el-club-de-la-lucha'],
    ['The Last of Us S1E1', 'https://tioplus.app/serie/the-last-of-us/season/1/episode/1'],
    ['House of the Dragon S1E1', 'https://tioplus.app/serie/la-casa-del-dragon/season/1/episode/1']
  ],
  cinecalidad: [
    ['Al filo del manana', 'https://www.cinecalidad.am/ver-pelicula/al-filo-del-manana/'],
    ['Superman (2025)', 'https://www.cinecalidad.am/ver-pelicula/superman-2/'],
    ['Avengers: Endgame', 'https://www.cinecalidad.am/ver-pelicula/avengers-endgame/'],
    ['Deadpool & Wolverine', 'https://www.cinecalidad.am/ver-pelicula/deadpool-wolverine/'],
    ['Fight Club', 'https://www.cinecalidad.am/ver-pelicula/el-club-de-la-pelea/']
  ],
  cuevana3i: [
    ['Al filo del manana', 'https://cuevana3i.you/pelicula/al-filo-del-manana'],
    ['Superman (2025)', 'https://cuevana3i.you/pelicula/superman'],
    ['Fight Club', 'https://cuevana3i.you/pelicula/el-club-de-la-pelea'],
    ['The Last of Us S1E1', 'https://cuevana3i.you/serie/the-last-of-us/episodio-1x1']
  ],
  sololatino: [
    ['Al filo del manana', 'https://sololatino.net/pelicula/al-filo-del-manana'],
    ['Superman (2025)', 'https://sololatino.net/pelicula/superman'],
    ['Avengers: Endgame', 'https://sololatino.net/pelicula/avengers-endgame'],
    ['Deadpool & Wolverine', 'https://sololatino.net/pelicula/deadpool-wolverine'],
    ['House of the Dragon S1E1', 'https://sololatino.net/serie/la-casa-del-dragon/temporada-1/episodio-1']
  ]
};

function kindOf(url) {
  if (!url) return 'none';
  if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
  if (/\.(?:mp4|mkv|bin)(?:$|[?#])/i.test(url)) return 'file';
  return 'other';
}

function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return 'invalid-url';
  }
}

function hostFamily(host) {
  if (host.includes('mediafire.com')) return 'mediafire';
  if (host.includes('fireload.com')) return 'fireload';
  if (host.includes('vimeos')) return 'vimeos';
  if (host.includes('goodstream')) return 'goodstream';
  if (host.includes('turboviplay.com') || host.includes('turbovidhls') || host.includes('emturbovid')) return 'turboviplay';
  if (host.includes('premilkyway.com')) return 'hlswish/premilkyway';
  if (host.includes('acek-cdn.com')) return 'acek-cdn';
  if (host.includes('dramiyos-cdn.com')) return 'dramiyos-cdn';
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'pelisplus-ip';
  if (host.includes('cdn-tnmr.org')) return 'cdn-tnmr';
  return host;
}

function wrapperFamily(url) {
  const host = hostOf(url);
  if (url.includes('pelisplus.upns.pro')) return 'pelisplus-upns';
  if (url.includes('4meplayer.pro')) return 'pelisplus-4meplayer';
  if (url.includes('strp2p.com')) return 'pelisplus-p2p';
  if (host.includes('filemoon')) return 'filemoon';
  if (host.includes('hlswish') || host.includes('streamwish')) return 'hlswish/streamwish';
  if (host.includes('vidhide')) return 'vidhide';
  if (host.includes('embed69')) return 'embed69';
  if (host.includes('voe') || host.includes('pamelachangemission.com')) return 'voe';
  if (host.includes('waaw')) return 'waaw';
  if (host.includes('dood')) return 'dood';
  if (host.includes('turboviplay') || host.includes('turbovidhls') || host.includes('emturbovid')) return 'turboviplay';
  if (host.includes('vimeos')) return 'vimeos';
  if (host.includes('goodstream')) return 'goodstream';
  if (host.includes('mediafire.com')) return 'mediafire';
  if (host.includes('fireload.com')) return 'fireload';
  if (host.includes('player.pelisserieshoy.com')) return 'pelisserieshoy-player';
  return host || 'unknown';
}

function b64ToUtf8(value) {
  try {
    return Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return '';
  }
}

function utf8ToB64(value) {
  return Buffer.from(value, 'utf8').toString('base64');
}

async function resolveTioPlusTokenUrl(decodedUrl) {
  if (!decodedUrl) return null;

  if (
    decodedUrl.includes('pelisplus.upns.pro')
    || decodedUrl.includes('4meplayer.pro')
    || decodedUrl.includes('strp2p.com')
    || decodedUrl.includes('emturbovid')
    || decodedUrl.includes('turbovidhls')
    || decodedUrl.includes('turboviplay')
  ) {
    return decodedUrl;
  }

  try {
    const innerPath = utf8ToB64(utf8ToB64(decodedUrl));
    const playerUrl = `https://tioplus.app/player/${innerPath}`;
    const { res, text } = await fetchTextWithTimeout(playerUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://tioplus.app/'
      }
    }, DISCOVERY_TIMEOUT_MS);
    if (!res.ok) return decodedUrl;

    const redirectMatch = text.match(/window\.location\.href\s*=\s*['"]([^'"]+)['"]/);
    return redirectMatch?.[1] || decodedUrl;
  } catch {
    return decodedUrl;
  }
}

async function resolvePelisSeriesHoy(streamUrl) {
  try {
    const { res, text } = await fetchTextWithTimeout(streamUrl, {
      headers: {
        'User-Agent': userAgent,
        'Referer': 'https://sololatino.net/'
      }
    }, DISCOVERY_TIMEOUT_MS);
    if (!res.ok) return null;

    const tokenMatch = text.match(/const\s+_t\s*=\s*['"]([^'"]+)['"]/);
    if (!tokenMatch) return null;
    const token = tokenMatch[1];

    await fetchWithTimeout('https://player.pelisserieshoy.com/s.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
        'Referer': streamUrl,
        'Origin': 'https://player.pelisserieshoy.com'
      },
      body: new URLSearchParams({ a: 'click', tok: token })
    }, DISCOVERY_TIMEOUT_MS);

    const listRes = await fetchWithTimeout('https://player.pelisserieshoy.com/s.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
        'Referer': streamUrl,
        'Origin': 'https://player.pelisserieshoy.com'
      },
      body: new URLSearchParams({ a: '1', tok: token })
    }, DISCOVERY_TIMEOUT_MS);
    if (!listRes.ok) return null;

    const listJson = await listRes.json();
    const firstServer = listJson?.s?.[0];
    if (!firstServer) return null;

    const playRes = await fetchWithTimeout('https://player.pelisserieshoy.com/s.php', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': userAgent,
        'Referer': streamUrl,
        'Origin': 'https://player.pelisserieshoy.com'
      },
      body: new URLSearchParams({ a: '2', v: firstServer[1], tok: token })
    }, DISCOVERY_TIMEOUT_MS);
    if (!playRes.ok) return null;

    const playJson = await playRes.json();
    if (!playJson?.u) return null;

    const pathUrl = 'https://player.pelisserieshoy.com' + playJson.u;
    const redirectCheck = await fetchWithTimeout(pathUrl, {
      method: 'GET',
      headers: {
        'User-Agent': userAgent,
        'Referer': streamUrl
      },
      redirect: 'manual'
    }, DISCOVERY_TIMEOUT_MS);

    let directUrl = [301, 302, 303, 307, 308].includes(redirectCheck.status)
      ? redirectCheck.headers.get('location')
      : pathUrl;
    if (directUrl && directUrl.includes('.bin')) {
      directUrl += '#.mp4';
    }

    return directUrl;
  } catch {
    return null;
  }
}

function decodeCuevanaWrapperUrl(wrapperUrl) {
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
      if (!baseUrl) return null;

      const key = ((typeof process !== "undefined" && process.env ? process.env.CUEVANA_UUID_KEY : undefined));
      const decoded = Buffer.from(token.slice(1), 'base64').toString('binary');
      let decrypted = '';
      for (let i = 0; i < decoded.length; i += 1) {
        decrypted += String.fromCharCode(decoded.charCodeAt(i) ^ key.charCodeAt(i % key.length));
      }

      return decrypted ? baseUrl + decrypted : null;
    }

    const v = parsed.searchParams.get('v');
    if (v) {
      const decoded = Buffer.from(v, 'base64').toString('utf8').trim();
      return decoded.startsWith('http') ? decoded : null;
    }
  } catch {
    return null;
  }

  return null;
}

function pushDiscovery(discoveries, item) {
  const url = normalizeUrl(item.url, item.referer);
  if (!url) return;
  discoveries.push({
    ...item,
    url,
    wrapper: item.wrapper || wrapperFamily(url)
  });
}

async function discoverTioPlus() {
  const discoveries = [];

  for (const [title, pageUrl] of discoveryPages.tioplus) {
    try {
      const { res, text } = await fetchTextWithTimeout(pageUrl, {
        headers: { 'User-Agent': userAgent }
      }, DISCOVERY_TIMEOUT_MS);
      if (!res.ok) continue;

      const $ = cheerio.load(text);
      const tokens = [];
      const mainToken = $('#player-tr').attr('data-tr');
      if (mainToken) tokens.push(['Opcion 1', mainToken]);
      $('li[data-server]').each((i, el) => {
        const token = $(el).attr('data-server');
        const label = $(el).text().trim() || `Opcion ${i + 2}`;
        if (token && !tokens.some((entry) => entry[1] === token)) {
          tokens.push([label, token]);
        }
      });

      for (const [label, token] of tokens) {
        const decodedUrl = b64ToUtf8(token);
        if (!decodedUrl || decodedUrl.includes('strp2p.com') || /p2p|torrent/i.test(label)) continue;
        const resolvedUrl = await resolveTioPlusTokenUrl(decodedUrl);
        if (!resolvedUrl) continue;
        pushDiscovery(discoveries, {
          source: 'TioPlus',
          title,
          label,
          url: resolvedUrl,
          referer: pageUrl
        });
      }
    } catch (error) {
      console.warn(`Discovery: TioPlus failed for ${title}: ${error.message}`);
    }
  }

  return discoveries;
}

async function discoverCinecalidad() {
  const discoveries = [];

  for (const [title, pageUrl] of discoveryPages.cinecalidad) {
    try {
      const { res, text } = await fetchTextWithTimeout(pageUrl, {
        headers: { 'User-Agent': userAgent }
      }, DISCOVERY_TIMEOUT_MS);
      if (!res.ok) continue;

      const $ = cheerio.load(text);
      $('#playeroptionsul li').each((i, el) => {
        const url = $(el).attr('data-option');
        const label = $(el).text().trim() || `Opcion ${i + 1}`;
        if (!url || /trailer|youtube/i.test(label + ' ' + url)) return;
        pushDiscovery(discoveries, {
          source: 'Cinecalidad',
          title,
          label,
          url,
          referer: pageUrl
        });
      });
    } catch (error) {
      console.warn(`Discovery: Cinecalidad failed for ${title}: ${error.message}`);
    }
  }

  return discoveries;
}

async function discoverCuevana3i() {
  const discoveries = [];

  for (const [title, pageUrl] of discoveryPages.cuevana3i) {
    try {
      const { res, text } = await fetchTextWithTimeout(pageUrl, {
        headers: { 'User-Agent': userAgent }
      }, DISCOVERY_TIMEOUT_MS);
      if (!res.ok) continue;

      const wrapperUrls = [...new Set(text.match(/https:\/\/tungtungsahur\.cuevana3i\.you\/\?(?:token|v)=[^"'`\s<>]+/g) || [])];
      for (const wrapperUrl of wrapperUrls) {
        const decodedUrl = decodeCuevanaWrapperUrl(wrapperUrl);
        if (!decodedUrl) continue;
        pushDiscovery(discoveries, {
          source: 'Cuevana3i',
          title,
          label: 'Decoded wrapper',
          url: decodedUrl,
          referer: pageUrl
        });
      }
    } catch (error) {
      console.warn(`Discovery: Cuevana3i failed for ${title}: ${error.message}`);
    }
  }

  return discoveries;
}

async function discoverSoloLatino() {
  const discoveries = [];

  let xsrfCookieVal = '';
  let sessionCookieVal = '';
  let decodedXSRF = '';
  let cookieString = '';

  try {
    const csrfRes = await fetchWithTimeout('https://sololatino.net/sanctum/csrf-cookie', {
      headers: {
        'User-Agent': userAgent,
        'Accept': 'application/json'
      }
    }, DISCOVERY_TIMEOUT_MS);
    const setCookies = csrfRes.headers.getSetCookie();
    for (const cookie of setCookies) {
      if (cookie.startsWith('XSRF-TOKEN=')) {
        xsrfCookieVal = cookie.split(';')[0].substring('XSRF-TOKEN='.length);
      } else if (cookie.startsWith('sololatinonet-session=')) {
        sessionCookieVal = cookie.split(';')[0].substring('sololatinonet-session='.length);
      }
    }

    decodedXSRF = decodeURIComponent(xsrfCookieVal);
    cookieString = `XSRF-TOKEN=${xsrfCookieVal}; sololatinonet-session=${sessionCookieVal}`;
  } catch (error) {
    console.warn(`Discovery: SoloLatino CSRF failed: ${error.message}`);
    return discoveries;
  }

  if (!decodedXSRF) return discoveries;

  for (const [title, pageUrl] of discoveryPages.sololatino) {
    try {
      const { res, text } = await fetchTextWithTimeout(pageUrl, {
        headers: { 'User-Agent': userAgent }
      }, DISCOVERY_TIMEOUT_MS);
      if (!res.ok) continue;

      const $ = cheerio.load(text);
      const tokens = [];
      $('.server-btn').each((i, el) => {
        const token = $(el).attr('data-player-token');
        const label = $(el).text().trim() || `Servidor ${i + 1}`;
        if (token) tokens.push([label, token]);
      });

      for (const [label, token] of tokens) {
        try {
          const apiRes = await fetchWithTimeout('https://sololatino.net/api/player-url', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
              'X-XSRF-TOKEN': decodedXSRF,
              'User-Agent': userAgent,
              'Cookie': cookieString,
              'Referer': pageUrl,
              'Origin': 'https://sololatino.net'
            },
            body: JSON.stringify({ t: token })
          }, DISCOVERY_TIMEOUT_MS);

          if (!apiRes.ok) continue;
          const payload = await apiRes.json();
          if (!payload?.url) continue;
          pushDiscovery(discoveries, {
            source: 'SoloLatino',
            title,
            label,
            url: payload.url,
            referer: pageUrl,
            apiType: payload.type
          });
        } catch (error) {
          console.warn(`Discovery: SoloLatino token failed for ${title} ${label}: ${error.message}`);
        }
      }
    } catch (error) {
      console.warn(`Discovery: SoloLatino failed for ${title}: ${error.message}`);
    }
  }

  return discoveries;
}

async function discoverLiveWrappers() {
  const discovered = [
    ...(await discoverTioPlus()),
    ...(await discoverCinecalidad()),
    ...(await discoverCuevana3i()),
    ...(await discoverSoloLatino())
  ];

  const seen = new Set();
  return discovered.filter((item) => {
    const key = `${item.source}:${item.url}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function auditDiscoveredWrapper(item) {
  const started = Date.now();
  const directInput = /\.(?:m3u8|mp4|mkv|bin)(?:$|[?#])/i.test(item.url)
    || wrapperFamily(item.url) === 'mediafire'
    || wrapperFamily(item.url) === 'fireload';
  let direct = null;

  if (directInput) {
    direct = item.url;
  } else if (wrapperFamily(item.url) === 'pelisserieshoy-player') {
    direct = await resolvePelisSeriesHoy(item.url);
  } else {
    direct = await resolvePlayerStream(item.url, userAgent, item.referer || 'https://tioplus.app/');
  }

  return {
    source: item.source,
    title: item.title,
    label: item.label,
    wrapper: item.wrapper,
    url: item.url,
    ok: Boolean(direct),
    ms: Date.now() - started,
    kind: kindOf(direct),
    host: direct ? hostOf(direct) : null,
    family: direct ? hostFamily(hostOf(direct)) : null,
    direct
  };
}

async function auditWrapper([name, url]) {
  const started = Date.now();
  const direct = await resolvePlayerStream(url, userAgent, 'https://tioplus.app/');
  return {
    name,
    fixture: url,
    ok: Boolean(direct),
    ms: Date.now() - started,
    kind: kindOf(direct),
    host: direct ? hostOf(direct) : null,
    family: direct ? hostFamily(hostOf(direct)) : null,
    direct
  };
}

function addStat(map, key, patch = {}) {
  if (!map.has(key)) {
    map.set(key, {
      key,
      count: 0,
      sources: new Set(),
      titles: new Set(),
      kinds: new Set(),
      examples: []
    });
  }

  const stat = map.get(key);
  stat.count += 1;
  if (patch.source) stat.sources.add(patch.source);
  if (patch.title) stat.titles.add(patch.title);
  if (patch.kind) stat.kinds.add(patch.kind);
  if (patch.example && stat.examples.length < 3) stat.examples.push(patch.example);
}

async function auditStreams() {
  const byFamily = new Map();
  const bySource = new Map();
  const caseResults = [];

  for (const item of streamCases) {
    const started = Date.now();
    const streams = await getStreams(item.type, item.id, item.season, item.episode);
    const ms = Date.now() - started;
    caseResults.push({ ...item, ms, count: streams.length });

    for (const stream of streams) {
      const host = hostOf(stream.url);
      const family = hostFamily(host);
      const kind = kindOf(stream.url);
      addStat(byFamily, family, {
        source: stream.name,
        title: item.label,
        kind,
        example: `${stream.name} ${stream.title} -> ${host}`
      });
      addStat(bySource, stream.name, {
        title: item.label,
        kind,
        example: `${stream.title} -> ${family}`
      });
    }
  }

  return { caseResults, byFamily, bySource };
}

function printableStats(map) {
  return [...map.values()]
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .map((stat, index) => ({
      rank: index + 1,
      name: stat.key,
      count: stat.count,
      sources: [...stat.sources].sort(),
      titles: [...stat.titles].sort(),
      kinds: [...stat.kinds].sort(),
      examples: stat.examples
    }));
}

async function run() {
  console.log('=== Fresh discovered wrapper/player URLs ===');
  const discovered = await discoverLiveWrappers();
  console.log(JSON.stringify({
    discovered: discovered.length,
    byWrapper: discovered.reduce((acc, item) => {
      acc[item.wrapper] = (acc[item.wrapper] || 0) + 1;
      return acc;
    }, {})
  }));

  const discoveredResults = [];
  for (const item of discovered) {
    const result = await auditDiscoveredWrapper(item);
    discoveredResults.push(result);
    console.log(JSON.stringify(result));
  }

  console.log('=== Ranked discovered wrappers ===');
  const discoveredStats = new Map();
  for (const result of discoveredResults) {
    if (!discoveredStats.has(result.wrapper)) {
      discoveredStats.set(result.wrapper, {
        wrapper: result.wrapper,
        tested: 0,
        playable: 0,
        totalMs: 0,
        families: new Set(),
        sources: new Set(),
        titles: new Set(),
        examples: []
      });
    }

    const stat = discoveredStats.get(result.wrapper);
    stat.tested += 1;
    stat.playable += result.ok ? 1 : 0;
    stat.totalMs += result.ms;
    if (result.family) stat.families.add(result.family);
    stat.sources.add(result.source);
    stat.titles.add(result.title);
    if (stat.examples.length < 3) {
      stat.examples.push(`${result.ok ? 'OK' : 'NO_STREAM'} ${result.source} ${result.label} -> ${result.host || hostOf(result.url)}`);
    }
  }

  const rankedDiscovered = [...discoveredStats.values()]
    .sort((a, b) => (b.playable / b.tested) - (a.playable / a.tested) || b.playable - a.playable || a.totalMs - b.totalMs)
    .map((stat, index) => ({
      rank: index + 1,
      wrapper: stat.wrapper,
      playable: stat.playable,
      tested: stat.tested,
      successRate: Number((stat.playable / stat.tested).toFixed(2)),
      avgMs: Math.round(stat.totalMs / stat.tested),
      families: [...stat.families].sort(),
      sources: [...stat.sources].sort(),
      titles: [...stat.titles].sort(),
      examples: stat.examples
    }));
  for (const stat of rankedDiscovered) {
    console.log(JSON.stringify(stat));
  }

  console.log('=== Stale/static wrapper fixtures ===');
  const wrapperResults = [];
  for (const fixture of wrapperFixtures) {
    const result = await auditWrapper(fixture);
    wrapperResults.push(result);
    console.log(JSON.stringify(result));
  }

  console.log('=== End-to-end stream cases ===');
  const { caseResults, byFamily, bySource } = await auditStreams();
  for (const result of caseResults) {
    console.log(JSON.stringify(result));
  }

  console.log('=== Ranked host families ===');
  for (const stat of printableStats(byFamily)) {
    console.log(JSON.stringify(stat));
  }

  console.log('=== Ranked sources ===');
  for (const stat of printableStats(bySource)) {
    console.log(JSON.stringify(stat));
  }

  console.log('=== Wrapper fixture summary ===');
  const rankedWrappers = wrapperResults
    .sort((a, b) => Number(b.ok) - Number(a.ok) || a.ms - b.ms)
    .map((result, index) => ({ rank: index + 1, ...result }));
  for (const result of rankedWrappers) {
    console.log(JSON.stringify(result));
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

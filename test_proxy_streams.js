const assert = require('assert');
const app = require('./src/server');

const {
  getUpstreamUserAgent,
  shouldProxyStream,
  isLikelyHlsManifestUrl,
  proxiedStreamUrl,
  rewriteHlsManifest
} = app.__test;

const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function fakeReq(baseUrl, referer = '', ua) {
  const parsed = new URL(baseUrl);
  return {
    protocol: parsed.protocol.replace(':', ''),
    query: { referer, ...(ua ? { ua } : {}) },
    get(name) {
      if (name.toLowerCase() === 'host') return parsed.host;
      if (name.toLowerCase() === 'user-agent') return 'Stremio/4.4.168';
      return undefined;
    },
    headers: {}
  };
}

/**
 * These CDNs answer 403 to anything that is not a browser. Validation probes with
 * the resolving User-Agent, so forwarding the player's instead meant a stream
 * passed validation and then 403'd the moment it was played.
 */
function testUpstreamUserAgent() {
  assert.strictEqual(
    getUpstreamUserAgent(fakeReq('https://addon.example')),
    DEFAULT_USER_AGENT,
    'with no pinned UA the proxy uses the browser default, never the client header'
  );

  assert.strictEqual(
    getUpstreamUserAgent(fakeReq('https://addon.example', '', 'Scraper UA')),
    'Scraper UA',
    'the UA the stream was resolved with is what goes upstream'
  );

  const pinned = proxiedStreamUrl(
    'https://addon.example',
    'https://video.example/master.m3u8',
    'https://embed.example/player',
    'Scraper UA'
  );
  assert.strictEqual(new URL(pinned).searchParams.get('ua'), 'Scraper UA', 'the resolving UA travels with the link');

  const defaulted = proxiedStreamUrl(
    'https://addon.example',
    'https://video.example/master.m3u8',
    '',
    DEFAULT_USER_AGENT
  );
  assert.strictEqual(new URL(defaulted).searchParams.get('ua'), null, 'the default UA is not spelled out in every URL');
}

function testProxyDecisions() {
  assert.strictEqual(shouldProxyStream({
    title: 'Headered HLS',
    url: 'https://ordinary-host.example/master.m3u8',
    behaviorHints: {
      proxyHeaders: {
        request: {
          Referer: 'https://embed.example/player',
          'User-Agent': 'Scraper UA'
        }
      }
    }
  }), true, 'streams with proxyHeaders should be proxied');

  assert.strictEqual(shouldProxyStream({
    title: 'Ace HLS',
    url: 'https://abc.acek-cdn.com/hls/master.m3u8'
  }), true, 'known header-sensitive CDN streams should be proxied');

  assert.strictEqual(shouldProxyStream({
    title: 'Premium',
    url: 'https://download.media.example/video.mp4'
  }), true, 'premium streams should be proxied');

  assert.strictEqual(shouldProxyStream({
    title: 'Plain Direct',
    url: 'https://plain.example/video.mp4'
  }), false, 'plain streams without headers or sensitive hosts should stay direct');
}

function testProxyUrl() {
  assert.strictEqual(isLikelyHlsManifestUrl('https://video.example/master.m3u8?token=abc'), true);
  assert.strictEqual(isLikelyHlsManifestUrl('https://video.example/segment001.ts'), false);
  // Playlists are buffered whole so they can be rewritten. Matching the query
  // string too would route a whole movie down that path and hold it in memory.
  assert.strictEqual(
    isLikelyHlsManifestUrl('https://video.example/movie.mp4?fallback=master.m3u8'),
    false,
    'an m3u8 in the query string does not make an MP4 a playlist'
  );

  const url = proxiedStreamUrl(
    'https://addon.example',
    'https://video.example/master.m3u8?token=a b',
    'https://embed.example/player'
  );

  const parsed = new URL(url);
  assert.strictEqual(parsed.origin, 'https://addon.example');
  assert.strictEqual(parsed.pathname, '/proxy/stream.m3u8');
  assert.strictEqual(parsed.searchParams.get('url'), 'https://video.example/master.m3u8?token=a b');
  assert.strictEqual(parsed.searchParams.get('referer'), 'https://embed.example/player');

  assert.strictEqual(
    new URL(proxiedStreamUrl('https://addon.example', 'https://video.example/segment001.ts', '')).pathname,
    '/proxy/segment.ts',
    'transport stream segments keep a .ts proxy extension'
  );
  assert.strictEqual(
    new URL(proxiedStreamUrl('https://addon.example', 'https://video.example/key.key', '')).pathname,
    '/proxy/key.key',
    'HLS key URLs keep a .key proxy extension'
  );
  assert.strictEqual(
    new URL(proxiedStreamUrl('https://addon.example', 'https://video.example/movie.bin', '')).pathname,
    '/proxy/stream.mp4',
    'bin direct video URLs are presented as mp4 to players'
  );
}

function testHlsRewrite() {
  const manifest = [
    '#EXTM3U',
    '#EXT-X-KEY:METHOD=AES-128,URI="keys/main.key"',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720',
    'variant/index.m3u8',
    '#EXTINF:6.000,',
    'https://cdn.example/video/segment001.ts',
    '#EXT-X-DATERANGE:ID="ad",X-ASSET-URI="not-a-playlist"',
    ''
  ].join('\n');

  const rewritten = rewriteHlsManifest(
    manifest,
    'https://origin.example/path/master.m3u8',
    fakeReq('https://addon.example', 'https://embed.example/player')
  );

  assert(rewritten.includes('https://addon.example/proxy/stream.m3u8?url='), 'rewritten manifest contains proxied HLS playlist URLs');
  assert(rewritten.includes('https://addon.example/proxy/segment.ts?url='), 'rewritten manifest contains proxied segment URLs with media extension');
  assert(rewritten.includes('https://addon.example/proxy/key.key?url='), 'rewritten manifest contains proxied key URLs with key extension');
  assert(rewritten.includes(encodeURIComponent('https://origin.example/path/variant/index.m3u8')), 'relative variant playlist is rewritten');
  assert(rewritten.includes(encodeURIComponent('https://origin.example/path/keys/main.key')), 'relative key URI is rewritten');
  assert(rewritten.includes(encodeURIComponent('https://origin.example/path/init.mp4')), 'relative init map URI is rewritten');
  assert(rewritten.includes(encodeURIComponent('https://cdn.example/video/segment001.ts')), 'absolute segment URL is rewritten');
  assert(rewritten.includes('referer=https%3A%2F%2Fembed.example%2Fplayer'), 'referer is preserved on child proxy URLs');
}

/** Variants and segments must inherit the UA, or only the master would load. */
function testHlsRewriteCarriesUserAgent() {
  const rewritten = rewriteHlsManifest(
    ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=1280000', 'variant/index.m3u8', '#EXTINF:6.000,', 'segment001.ts', ''].join('\n'),
    'https://origin.example/path/master.m3u8',
    fakeReq('https://addon.example', 'https://embed.example/player', 'Scraper UA')
  );

  const uaLinks = rewritten.split('\n').filter((line) => line.includes('/proxy/'));
  assert.strictEqual(uaLinks.length, 2, 'both the variant and the segment are proxied');
  for (const link of uaLinks) {
    assert.strictEqual(
      new URL(link).searchParams.get('ua'),
      'Scraper UA',
      'child requests keep the User-Agent the stream was resolved with'
    );
  }
}

testProxyDecisions();
testProxyUrl();
testUpstreamUserAgent();
testHlsRewrite();
testHlsRewriteCarriesUserAgent();

console.log('Proxy stream tests passed');

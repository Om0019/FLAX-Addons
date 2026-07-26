// Proxy fixtures run origins on loopback, which the SSRF guard blocks by design.
process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';

const assert = require('assert');
const http = require('http');
const cheerio = require('cheerio');
const app = require('./src/server');
const { __test: unpackerInternals } = require('./src/unpacker');
const { __test: orchestratorInternals } = require('./src/scrapers');
const { createTtlCache } = require('./src/ttl-cache');
const { __test: cuevanaInternals } = require('./src/scrapers/cuevana3i');

const { stripPkcs7Padding } = unpackerInternals;
const { sanitizeStream } = orchestratorInternals;
const { findOptionLabel } = cuevanaInternals;

function testCacheEviction() {
  const cache = createTtlCache({ maxEntries: 3 });

  cache.set('a', 'value-a', 60000);
  assert.strictEqual(cache.get('a'), 'value-a', 'fresh entry is returned');

  // Expiry is observed on read, not only on sweep.
  cache.set('short', 'value-short', 1);
  const expired = new Promise((resolve) => setTimeout(resolve, 15));

  // Unbounded keyspace: without a cap the map grows for the life of the process.
  const capped = createTtlCache({ maxEntries: 20 });
  for (let i = 0; i < 50; i += 1) {
    capped.set(`key-${i}`, i, 60000);
  }
  assert.strictEqual(capped.size, 20, 'size is capped');
  assert.strictEqual(capped.get('key-49'), 49, 'newest survives');
  assert.strictEqual(capped.get('key-0'), undefined, 'oldest is evicted first');

  // Re-writing a key refreshes its position, so it is not evicted as if stale.
  const recency = createTtlCache({ maxEntries: 3 });
  recency.set('x', 1, 60000);
  recency.set('y', 2, 60000);
  recency.set('z', 3, 60000);
  recency.set('x', 10, 60000);
  recency.set('w', 4, 60000);
  assert.strictEqual(recency.get('x'), 10, 're-written key survives eviction');
  assert.strictEqual(recency.get('y'), undefined, 'least recently written is evicted');

  return expired.then(() => {
    assert.strictEqual(cache.get('short'), undefined, 'expired entry is not returned');
  });
}

// TMDB metadata barely changes, and every uncached stream request paid for two or
// three round-trips before any scraping began.
async function testTmdbResponsesAreCached() {
  const tmdb = require('./src/tmdb');
  const realFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      id: 1399, name: 'Test Show', original_name: 'Test Show',
      first_air_date: '2011-04-17', external_ids: { imdb_id: 'tt0944947' },
      genres: [], credits: { crew: [], cast: [] }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  try {
    tmdb.__test.responseCache.clear();

    const first = await tmdb.getMetaDetails('series', '1399', { includeEpisodes: false });
    assert.strictEqual(calls, 1, 'first lookup hits the network');
    assert.strictEqual(first.name, 'Test Show');

    const second = await tmdb.getMetaDetails('series', '1399', { includeEpisodes: false });
    assert.strictEqual(calls, 1, 'repeat lookup is served from cache');
    assert.deepStrictEqual(second, first, 'cached result matches');

    // A different id must not collide with the cached one.
    await tmdb.getMetaDetails('series', '1400', { includeEpisodes: false });
    assert.strictEqual(calls, 2, 'a different key still hits the network');
  } finally {
    global.fetch = realFetch;
    tmdb.__test.responseCache.clear();
  }
}

// A failing lookup must not be pinned in the cache for hours.
async function testTmdbFailuresAreNotCached() {
  const tmdb = require('./src/tmdb');
  const realFetch = global.fetch;
  let calls = 0;

  global.fetch = async () => {
    calls += 1;
    if (calls === 1) return new Response('nope', { status: 500 });
    return new Response(JSON.stringify({ id: 7, title: 'Recovered', release_date: '2024-01-01' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  };

  try {
    tmdb.__test.responseCache.clear();

    const failed = await tmdb.getMetaDetails('movie', '7', { includeEpisodes: false });
    assert.strictEqual(failed, null, 'a failed lookup returns null');

    const recovered = await tmdb.getMetaDetails('movie', '7', { includeEpisodes: false });
    assert.strictEqual(calls, 2, 'the failure was retried rather than cached');
    assert.strictEqual(recovered.name, 'Recovered');
  } finally {
    global.fetch = realFetch;
    tmdb.__test.responseCache.clear();
  }
}

function testPkcs7PaddingStrip() {
  // Real PKCS#7: the pad byte value equals the number of pad bytes.
  assert.strictEqual(stripPkcs7Padding('payload\x03\x03\x03'), 'payload', 'valid padding removed');
  assert.strictEqual(stripPkcs7Padding('payload\x01'), 'payload', 'single pad byte removed');
  assert.strictEqual(stripPkcs7Padding('x' + '\x10'.repeat(16)), 'x', 'full block of padding removed');

  // A pad byte of 0 would make slice(0, -0) return an empty string, silently
  // turning a decrypted URL into ''.
  assert.strictEqual(stripPkcs7Padding('payload\x00'), 'payload\x00', 'zero pad leaves content intact');

  // A trailing byte past the block size is content, not padding.
  assert.strictEqual(
    stripPkcs7Padding('https://cdn.example/a.m3u8'),
    'https://cdn.example/a.m3u8',
    'non-padding tail preserved'
  );
  assert.strictEqual(stripPkcs7Padding('ab\xff'), 'ab\xff', 'out-of-range pad preserved');

  // Claimed padding longer than the string must not over-trim.
  assert.strictEqual(stripPkcs7Padding('a\x05'), 'a\x05', 'pad longer than content preserved');
}

function testOptionLabelLookup() {
  // Wrapper URLs carry quotes and brackets; building a selector from one used to
  // throw and abort the whole scrape.
  const hostile = 'https://x.example/?token="]:has(';
  const doc = cheerio.load(`
    <div data-url="https://a.example/?v=1">Opcion A</div>
    <div data-url='${hostile}'>Opcion Hostile</div>
  `);

  assert.strictEqual(findOptionLabel(doc, 'https://a.example/?v=1'), 'Opcion A', 'ordinary lookup works');
  assert.doesNotThrow(() => findOptionLabel(doc, hostile), 'a URL with selector metacharacters must not throw');
  assert.strictEqual(findOptionLabel(doc, hostile), 'Opcion Hostile', 'and still matches by value');
  assert.strictEqual(findOptionLabel(doc, 'https://absent.example/'), '', 'missing entry yields empty label');
}

function testSanitizeStreamFiltering() {
  assert.strictEqual(sanitizeStream({ url: 'ftp://example.com/a.mp4' }), null, 'non-http protocol dropped');
  assert.strictEqual(sanitizeStream({ url: 'not a url' }), null, 'unparseable url dropped');
  assert.ok(sanitizeStream({ url: 'https://cdn.example/a.m3u8' }), 'ordinary stream kept');

  // The private-address filter reads the escape hatch at call time, so drop the
  // opt-in this file sets for its proxy fixtures while checking the real default.
  delete process.env.ALLOW_PRIVATE_PROXY_TARGETS;
  try {
    assert.strictEqual(
      sanitizeStream({ url: 'http://169.254.169.254/latest/meta-data/' }),
      null,
      'stream naming the metadata endpoint is dropped'
    );
    assert.strictEqual(sanitizeStream({ url: 'http://192.168.1.5/movie.mp4' }), null, 'private LAN stream dropped');
    assert.ok(
      sanitizeStream({ url: 'https://93.184.216.34/a.m3u8' }),
      'public IP-literal stream kept, since sources legitimately use them'
    );
  } finally {
    process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';
  }
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

function proxyGet(port, targetUrl) {
  const path = `/proxy/stream?url=${encodeURIComponent(targetUrl)}&referer=`;
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'],
        body: Buffer.concat(chunks).toString()
      }));
    });
  });
}

// Forcing 200 for anything playlist-shaped turned upstream failures into
// valid-looking manifests with the error page rewritten into them, so a player
// saw a broken playlist instead of a clean error.
async function testUpstreamErrorsAreNotDressedAsManifests() {
  const origin = await startServer((req, res) => {
    if (req.url.startsWith('/missing')) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      return res.end('<html>Not found</html>');
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXTINF:6.0,\nseg1.ts\n');
  });
  const proxy = await startServer(app);

  try {
    const port = proxy.address().port;
    const originUrl = `http://127.0.0.1:${origin.address().port}`;

    const missing = await proxyGet(port, `${originUrl}/missing.m3u8`);
    assert.strictEqual(missing.status, 404, 'upstream 404 on a .m3u8 URL keeps its status');
    assert.ok(!missing.body.includes('/proxy/'), 'an error page is not rewritten as a playlist');

    // The success path must still be rewritten as before.
    const good = await proxyGet(port, `${originUrl}/stream.m3u8`);
    assert.strictEqual(good.status, 200);
    assert.ok(good.contentType.includes('mpegurl'), 'playlist content-type preserved');
    assert.ok(good.body.includes('/proxy/segment.ts?url='), 'segments still rewritten');
  } finally {
    origin.close();
    proxy.close();
  }
}

async function main() {
  await testCacheEviction();
  await testTmdbResponsesAreCached();
  await testTmdbFailuresAreNotCached();
  testPkcs7PaddingStrip();
  testOptionLabelLookup();
  testSanitizeStreamFiltering();
  await testUpstreamErrorsAreNotDressedAsManifests();
  console.log('Cache and edge-case tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

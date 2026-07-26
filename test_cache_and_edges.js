// Proxy fixtures run origins on loopback, which the SSRF guard blocks by design.
process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';

const assert = require('assert');
const http = require('http');
const cheerio = require('cheerio');
const app = require('./src/server');
const { __test: unpackerInternals } = require('./src/unpacker');
const { __test: orchestratorInternals } = require('./src/scrapers');
const { __test: cuevanaInternals } = require('./src/scrapers/cuevana3i');

const { stripPkcs7Padding } = unpackerInternals;
const { pruneExpiring, sanitizeStream } = orchestratorInternals;
const { findOptionLabel } = cuevanaInternals;

function testCacheEviction() {
  const now = Date.now();
  const map = new Map();
  const isExpired = (entry) => entry.expiresAt <= now;

  map.set('fresh', { expiresAt: now + 60000 });
  map.set('stale', { expiresAt: now - 1 });
  map.set('alsoStale', { expiresAt: now - 5000 });

  pruneExpiring(map, 100, isExpired);
  assert.deepStrictEqual([...map.keys()], ['fresh'], 'expired entries are dropped');

  // Unbounded keyspace: without a cap the map grows for the life of the process.
  const big = new Map();
  for (let i = 0; i < 50; i += 1) {
    big.set(`key-${i}`, { expiresAt: now + 60000 });
  }
  pruneExpiring(big, 20, isExpired);
  assert.strictEqual(big.size, 20, 'size is capped');
  assert.ok(big.has('key-49'), 'newest survives');
  assert.ok(!big.has('key-0'), 'oldest is evicted first');
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
  testCacheEviction();
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

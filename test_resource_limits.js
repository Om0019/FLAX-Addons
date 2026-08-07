// These fixtures necessarily run their origins on loopback, which the SSRF guard
// blocks by design, so they opt in explicitly. test_ssrf_guard.js covers the
// blocking behaviour itself and asserts this flag is off there.
(typeof process !== "undefined" && process.env ? process.env.ALLOW_PRIVATE_PROXY_TARGETS : undefined) = '1';

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const app = require('./src/server');
const { unpack, decryptEmbed69, extractDirectStream } = require('./src/unpacker');

// These cover the paths where a remote page controls how much work this process
// does. The addon is single-threaded, so an unbounded loop or an unthrottled copy
// does not just slow one request down, it stalls every concurrent one.

function testUnpackClampsRemoteCounter() {
  const k = 'https|cdn|example|com|hls|master|m3u8|file'.split('|');

  const startedAt = Date.now();
  unpack('x', 62, 500000000, k, {}, {});
  const elapsed = Date.now() - startedAt;
  assert(elapsed < 500, `unpack must clamp an oversized c to the dictionary length (took ${elapsed}ms)`);

  // Clamping must not change what a well-formed packed script decodes to.
  assert.strictEqual(
    unpack('{7:"0://1.2.3/4/5.6"}', 62, k.length, k, {}, {}),
    '{file:"https://cdn.example.com/hls/master.m3u8"}',
    'substitutions still applied for a well-formed packed script'
  );

  const html = `<script>eval(function(p,a,c,k,e,d){}('{7:"0://1.2.3/4/5.6"}',62,${k.length},'${k.join('|')}'.split('|')))</script>`;
  assert.strictEqual(
    extractDirectStream(html, 'https://player.example/e/abc'),
    'https://cdn.example.com/hls/master.m3u8',
    'packed scripts still resolve end to end'
  );
}

function buildPowHtml(difficulty) {
  return [
    `const POW_CHALLENGE = 'challenge-${difficulty}';`,
    `const POW_DIFFICULTY = ${difficulty};`,
    "const POW_SALT = 'salt';",
    'let dataLink = [];'
  ].join('\n');
}

function testProofOfWorkIsBounded() {
  // Difficulty 7 costs ~16x difficulty 6 (minutes of blocked event loop). It must
  // be refused outright rather than attempted.
  const startedAt = Date.now();
  assert.strictEqual(decryptEmbed69(buildPowHtml(9)), null, 'absurd difficulty is refused');
  assert(Date.now() - startedAt < 100, 'refusal is immediate, not after a search');

  // An accepted difficulty still gets a wall-clock ceiling.
  const hardStartedAt = Date.now();
  decryptEmbed69(buildPowHtml(6));
  const hardElapsed = Date.now() - hardStartedAt;
  assert(hardElapsed < 6000, `proof-of-work must be time-bounded (blocked ${hardElapsed}ms)`);

  // Cheap difficulties must still solve, or we would break every embed69 source.
  const links = decryptEmbed69(buildPowHtml(2));
  assert(Array.isArray(links), 'solvable proof-of-work still returns decrypted links');
}

function startOrigin(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, () => resolve(server));
  });
}

function startProxy() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, () => resolve(server));
  });
}

function proxyPath(targetUrl) {
  return `/proxy/stream?url=${encodeURIComponent(targetUrl)}&referer=`;
}

async function testProxyDeliversCompleteBody() {
  const payload = crypto.randomBytes(8 * 1024 * 1024);
  const expected = crypto.createHash('sha256').update(payload).digest('hex');

  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': payload.length });
    res.end(payload);
  });
  const proxy = await startProxy();

  try {
    const target = `http://127.0.0.1:${origin.address().port}/movie.mp4`;
    const body = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port: proxy.address().port, path: proxyPath(target) }, (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      });
    });

    assert.strictEqual(body.length, payload.length, 'proxied body is complete');
    assert.strictEqual(
      crypto.createHash('sha256').update(body).digest('hex'),
      expected,
      'proxied body is byte-identical to the origin'
    );
  } finally {
    origin.close();
    proxy.close();
  }
}

async function testProxyStopsReadingAfterClientDisconnect() {
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  let bytesServed = 0;

  const origin = await startOrigin((req, res) => {
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    const timer = setInterval(() => {
      bytesServed += chunk.length;
      res.write(chunk);
    }, 10);
    res.on('close', () => clearInterval(timer));
  });
  const proxy = await startProxy();

  try {
    const target = `http://127.0.0.1:${origin.address().port}/movie.mp4`;
    const servedAtDisconnect = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port: proxy.address().port, path: proxyPath(target) }, (res) => {
        res.on('data', () => {});
        setTimeout(() => {
          const served = bytesServed;
          req.destroy();
          resolve(served);
        }, 800);
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 1500));

    // Without backpressure-aware piping the origin keeps streaming a whole movie
    // into a client that has already gone away.
    const leaked = bytesServed - servedAtDisconnect;
    assert(
      leaked < 4 * 1024 * 1024,
      `proxy must stop pulling from the origin once the client disconnects (leaked ${(leaked / 1e6).toFixed(1)}MB)`
    );
  } finally {
    origin.close();
    proxy.close();
  }
}

async function main() {
  testUnpackClampsRemoteCounter();
  testProofOfWorkIsBounded();
  await testProxyDeliversCompleteBody();
  await testProxyStopsReadingAfterClientDisconnect();
  console.log('Resource limit tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

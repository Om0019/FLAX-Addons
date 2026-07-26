const assert = require('assert');
const http = require('http');
const app = require('./src/server');
const { assertPublicUrl, hasBlockedIpLiteralHost, isBlockedAddress } = require('./src/net-guard');

// /proxy fetches a caller-supplied URL and returns the body. Without a destination
// filter that is a server-side request forgery primitive against loopback, the LAN
// and the cloud metadata endpoint.

// Guard tests are meaningless if the escape hatch is on, so fail loudly instead.
assert.notStrictEqual(
  process.env.ALLOW_PRIVATE_PROXY_TARGETS, '1',
  'these tests must run with ALLOW_PRIVATE_PROXY_TARGETS unset'
);

function testBlockedRanges() {
  const blocked = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.0.0.1', '172.16.5.4', '172.31.255.255',
    '192.168.1.1', '169.254.169.254', '100.64.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254'
  ];
  for (const address of blocked) {
    assert.strictEqual(isBlockedAddress(address), true, `${address} must be blocked`);
  }

  // Public addresses, including the bare-IPv4 hosts some sources legitimately use
  // for streams, must keep working — the orchestrator ranks that family best.
  const allowed = ['8.8.8.8', '1.1.1.1', '172.15.0.1', '172.32.0.1', '93.184.216.34', '2606:4700::1111'];
  for (const address of allowed) {
    assert.strictEqual(isBlockedAddress(address), false, `${address} must be allowed`);
  }
}

async function testAssertPublicUrl() {
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /Blocked address/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1:8080/admin'), /Blocked address/);
  await assert.rejects(() => assertPublicUrl('http://localhost/'), /Blocked hostname/);
  await assert.rejects(() => assertPublicUrl('http://[::1]/'), /Blocked address/);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /Unsupported protocol/);
  await assert.rejects(() => assertPublicUrl('http://consul.internal/v1/kv'), /Blocked hostname/);

  assert.strictEqual(hasBlockedIpLiteralHost('http://169.254.169.254/'), true);
  assert.strictEqual(hasBlockedIpLiteralHost('https://93.184.216.34/master.m3u8'), false);
  assert.strictEqual(hasBlockedIpLiteralHost('https://cdn.example.com/master.m3u8'), false);
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
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
  });
}

async function testProxyRejectsInternalTargets() {
  const proxy = await startServer(app);
  try {
    const port = proxy.address().port;

    const metadata = await proxyGet(port, 'http://169.254.169.254/latest/meta-data/iam/security-credentials/');
    assert.strictEqual(metadata.status, 400, 'cloud metadata endpoint must be refused');

    const loopback = await proxyGet(port, 'http://127.0.0.1:22/');
    assert.strictEqual(loopback.status, 400, 'loopback must be refused');

    const lan = await proxyGet(port, 'http://192.168.0.1/');
    assert.strictEqual(lan.status, 400, 'private LAN must be refused');
  } finally {
    proxy.close();
  }
}

// The guard is worth little if it only inspects the first URL: a permitted host can
// answer 302 and point anywhere it likes. Exercised through the same helper the
// route uses, with a validator that allows the entry point and rejects the hop, so
// the per-hop check is what is actually under test.
async function testProxyValidatesRedirectHops() {
  const { fetchFollowingRedirects } = app.__test;

  let internalWasContacted = false;
  const internal = await startServer((req, res) => {
    internalWasContacted = true;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('SECRET-CREDENTIALS');
  });

  const internalUrl = `http://127.0.0.1:${internal.address().port}/creds`;
  const redirector = await startServer((req, res) => {
    res.writeHead(302, { Location: internalUrl });
    res.end();
  });
  const entryUrl = `http://127.0.0.1:${redirector.address().port}/start`;

  try {
    const seen = [];
    const validate = async (url) => {
      seen.push(url);
      // Entry point passes; anything it redirects to is judged on its merits.
      if (url !== entryUrl) await assertPublicUrl(url);
    };

    await assert.rejects(
      () => fetchFollowingRedirects(entryUrl, { headers: {}, buffer: false, timeoutMs: 5000, validate }),
      /Blocked address/,
      'the redirect destination must be validated, not just the entry point'
    );

    assert.deepStrictEqual(seen, [entryUrl, internalUrl], 'every hop is passed to the validator');
    assert.strictEqual(internalWasContacted, false, 'internal service must never be contacted');
  } finally {
    internal.close();
    redirector.close();
  }
}

// A redirect loop must terminate rather than spin.
async function testRedirectCapTerminates() {
  const { fetchFollowingRedirects } = app.__test;

  let hops = 0;
  const looper = await startServer((req, res) => {
    hops += 1;
    res.writeHead(302, { Location: '/again' });
    res.end();
  });

  try {
    await assert.rejects(
      () => fetchFollowingRedirects(`http://127.0.0.1:${looper.address().port}/`, {
        headers: {}, buffer: false, timeoutMs: 5000, validate: async () => {}
      }),
      /Exceeded 5 redirects/,
      'an endless redirect chain must be capped'
    );
    assert.ok(hops <= 7, `chain stopped after ${hops} requests`);
  } finally {
    looper.close();
  }
}

// Guarding must not break the ordinary path. Verified end to end through the real
// route by opting in to private targets, which is the only way to express a
// reachable origin in a test, then restoring the default.
async function testProxyStillServesAllowedTargets() {
  await assert.doesNotReject(() => assertPublicUrl('https://93.184.216.34/master.m3u8'));
  await assert.doesNotReject(() => assertPublicUrl('https://[2606:4700::1111]/master.m3u8'));

  const origin = await startServer((req, res) => {
    if (req.url === '/redir') {
      res.writeHead(302, { Location: '/final.mp4' });
      return res.end();
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    res.end('VIDEO-BYTES');
  });
  const proxy = await startServer(app);

  process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';
  try {
    const port = proxy.address().port;
    const originUrl = `http://127.0.0.1:${origin.address().port}`;

    const direct = await proxyGet(port, `${originUrl}/final.mp4`);
    assert.strictEqual(direct.status, 200, 'permitted target is served');
    assert.strictEqual(direct.body, 'VIDEO-BYTES', 'body passes through intact');

    // Manual redirect following must still actually follow them.
    const redirected = await proxyGet(port, `${originUrl}/redir`);
    assert.strictEqual(redirected.status, 200, 'redirect is followed to completion');
    assert.strictEqual(redirected.body, 'VIDEO-BYTES', 'redirected body passes through intact');
  } finally {
    delete process.env.ALLOW_PRIVATE_PROXY_TARGETS;
    origin.close();
    proxy.close();
  }

  // And the default must be restored once the opt-in is gone.
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/'), /Blocked address/);
}

async function main() {
  testBlockedRanges();
  await testAssertPublicUrl();
  await testProxyRejectsInternalTargets();
  await testProxyValidatesRedirectHops();
  await testRedirectCapTerminates();
  await testProxyStillServesAllowedTargets();
  console.log('SSRF guard tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

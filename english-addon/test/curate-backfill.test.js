// Curation picks its candidates before anything is probed, so a provider's
// best-looking link dying used to remove that provider from the response
// entirely, even when the same provider had a second, lower-resolution link
// that was never given a chance.
//
// curateStreams collapses each provider to its single best entry, so a dead
// top pick isn't simply gone - it's excluded from the next round's input,
// and curateStreams recomputes each provider's best from what's left. That
// re-run is what promotes a provider's own next-best link rather than
// requiring a separate refill mechanism to reimplement the same rules twice.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { curateStreams } = require('../src/curate');
const { selectPlayableStreams } = require('../src/stream-probe');

let server;
let origin;

test.before(async () => {
  server = http.createServer((req, res) => {
    if (req.url.startsWith('/dead')) {
      res.writeHead(404, { 'Content-Type': 'video/mp4' });
      return res.end();
    }
    res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 0-1/2' });
    res.end('ok');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => new Promise((resolve) => server.close(resolve)));

const entry = (providerId, resolution, path) => ({
  providerId,
  providerName: providerId,
  resolution,
  raw: { url: `${origin}${path}` }
});

const curate = (available) => curateStreams(available);

test('a dead top pick is replaced by a different provider, not left empty', async () => {
  const entries = [
    entry('hdhub4u', '1080p', '/dead1'),
    entry('uhdmovies', '1080p', '/dead2'),
    entry('castle', '1080p', '/good1'),
    entry('streamflix', '1080p', '/good2')
  ];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  assert.deepEqual(playable.map((item) => item.providerId), ['castle', 'streamflix']);
});

test('a provider whose top pick dies is refilled from its own next-best resolution', async () => {
  // hdhub4u offers both a 1080p and a 720p link for the same title.
  // curateStreams keeps only the 1080p one initially - the 720p entry isn't
  // even a candidate until the 1080p one is proven dead and excluded from
  // the pool curateStreams re-runs over.
  const entries = [
    entry('hdhub4u', '1080p', '/dead1'),
    entry('hdhub4u', '720p', '/good1')
  ];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  assert.deepEqual(playable.map((item) => ({ providerId: item.providerId, resolution: item.resolution })),
    [{ providerId: 'hdhub4u', resolution: '720p' }]);
});

test('a provider never contributes two entries at once, even mid-refill', async () => {
  const entries = [
    entry('hdhub4u', '1080p', '/dead1'),
    entry('hdhub4u', '1080p', '/good1'), // same provider, same tier - a tiebreak, not two slots
    entry('castle', '1080p', '/good2')
  ];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  const providers = playable.map((item) => item.providerId);

  assert.equal(new Set(providers).size, providers.length, 'no provider appears twice');
  assert.equal(playable.length, 2);
});

test('healthy picks cost no extra probes and are returned unchanged', async () => {
  const entries = [entry('hdhub4u', '1080p', '/good1'), entry('castle', '1080p', '/good2')];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  assert.deepEqual(playable.map((item) => item.providerId), ['hdhub4u', 'castle']);
});

test('everything dead returns nothing rather than looping', async () => {
  const entries = [entry('hdhub4u', '1080p', '/dead1'), entry('castle', '1080p', '/dead2')];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  assert.deepEqual(playable, []);
});

test('a spent budget returns the curated picks unverified rather than probing', async () => {
  const entries = [entry('hdhub4u', '1080p', '/dead1'), entry('castle', '1080p', '/good1')];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() - 1 });

  // Nothing was probed, so nothing is disproved: the curated pair stands.
  assert.deepEqual(playable.map((item) => item.providerId), ['hdhub4u', 'castle']);
});

test('each link is probed at most once across rounds', async () => {
  const probed = [];
  const countingServer = http.createServer((req, res) => {
    probed.push(req.url);
    if (req.url.startsWith('/dead')) {
      res.writeHead(404, { 'Content-Type': 'video/mp4' });
      return res.end();
    }
    res.writeHead(206, { 'Content-Type': 'video/mp4' });
    res.end('ok');
  });
  await new Promise((resolve) => countingServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${countingServer.address().port}`;

  try {
    const at = (providerId, resolution, path) => ({
      providerId,
      providerName: providerId,
      resolution,
      raw: { url: `${base}${path}` }
    });
    const entries = [
      at('hdhub4u', '1080p', '/dead1'),
      at('uhdmovies', '1080p', '/good1'),
      at('castle', '1080p', '/good2')
    ];

    await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });

    // /good1 survives round one and is re-selected in round two; its verdict is
    // remembered rather than re-fetched.
    assert.equal(probed.length, new Set(probed).size, 'no URL was probed twice');
  } finally {
    await new Promise((resolve) => countingServer.close(resolve));
  }
});

// AIOStreams' links are debrid resolve endpoints, not files: they take longer
// to answer than any probe deadline we can afford, and a timed-out probe is
// kept anyway. Probing them spent the whole budget to learn nothing, and the
// budget it spent was the one the other providers' links needed.
test('aiostreams is never fetched and is kept regardless', async () => {
  const probed = [];
  const countingServer = http.createServer((req, res) => {
    probed.push(req.url);
    res.writeHead(404, { 'Content-Type': 'text/html' });
    res.end('<html>gone</html>');
  });
  await new Promise((resolve) => countingServer.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${countingServer.address().port}`;

  try {
    const at = (providerId, path) => ({
      providerId,
      providerName: providerId,
      resolution: '1080p',
      raw: { url: `${base}${path}` }
    });
    const entries = [at('aiostreams', '/resolve'), at('castle', '/dead')];

    const playable = await selectPlayableStreams(entries, curate, {
      deadlineAt: Date.now() + 8000,
      shouldProbe: (item) => item.providerId !== 'aiostreams'
    });

    assert.deepEqual(probed, ['/dead'], 'only the probeable link was fetched');
    // Castle's link answered like a dead one and went; AIOStreams' stands even
    // though the same server would have failed it.
    assert.deepEqual(playable.map((item) => item.providerId), ['aiostreams']);
  } finally {
    await new Promise((resolve) => countingServer.close(resolve));
  }
});

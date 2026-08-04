// Curation picks its candidates before anything is probed, so a tier whose picks
// are all dead used to disappear from the response even when a lower-ranked
// provider had a working link that curation had set aside.
//
// The first attempt at fixing that refilled from a flat list of runners-up, and
// broke curation's own rules doing it: the reserve is ordered across tiers, so a
// dead 2160p pair drew its replacements from the 1080p leftovers and returned
// four 1080p streams against a per-tier limit of two. Re-curating over the
// survivors is what keeps those rules true of the final response.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { curateStreams, resolutionTier } = require('../src/curate');
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

const countByTier = (selection) => selection.reduce((counts, item) => {
  const tier = resolutionTier(item.resolution);
  counts[tier] = (counts[tier] || 0) + 1;
  return counts;
}, {});

test('a tier whose every pick is dead is refilled from its own tier', async () => {
  const entries = [
    entry('hdhub4u', '1080p', '/dead1'),
    entry('uhdmovies', '1080p', '/dead2'),
    entry('castle', '1080p', '/good1'),
    entry('netmirror', '1080p', '/good2')
  ];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  assert.deepEqual(playable.map((item) => item.providerId), ['castle', 'netmirror']);
});

test('refilling never exceeds two per tier, even when a whole tier dies', async () => {
  const entries = [
    // Both 2160p picks are dead and there is no 2160p replacement…
    entry('hdhub4u', '2160p', '/dead1'),
    entry('uhdmovies', '2160p', '/dead2'),
    // …while 1080p has more healthy candidates than it is allowed to use.
    entry('hdhub4u', '1080p', '/good1'),
    entry('uhdmovies', '1080p', '/good2'),
    entry('castle', '1080p', '/good3'),
    entry('netmirror', '1080p', '/good4'),
    entry('vidsrc', '1080p', '/good5')
  ];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });

  // The regression this guards: a flat reserve returned four 1080p streams here.
  assert.deepEqual(countByTier(playable), { '1080p': 2 });
});

test('refilling keeps one provider per tier', async () => {
  const entries = [
    entry('hdhub4u', '1080p', '/dead1'),
    // Same provider, second link in the same tier — must not take the free slot.
    entry('hdhub4u', '1080p', '/good1'),
    entry('castle', '1080p', '/good2'),
    entry('netmirror', '1080p', '/good3')
  ];

  const playable = await selectPlayableStreams(entries, curate, { deadlineAt: Date.now() + 8000 });
  const providers = playable.map((item) => item.providerId);

  assert.equal(new Set(providers).size, providers.length, 'no provider appears twice in a tier');
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

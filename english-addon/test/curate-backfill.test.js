// Curation picks its candidates before anything is probed, so a tier whose picks
// are both dead used to disappear from the response even when a lower-ranked
// provider had a working link that curation had set aside.

const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');
const { curateStreams, curationRunnersUp } = require('../src/curate');
const { filterPlayableStreamsWithBackfill } = require('../src/stream-probe');

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

test('runners-up are everything curation passed over, in its own preference order', () => {
  const entries = [
    entry('hdhub4u', '1080p', '/a'),
    entry('uhdmovies', '1080p', '/b'),
    entry('castle', '1080p', '/c'),
    entry('netmirror', '1080p', '/d'),
    entry('vidsrc', '2160p', '/e')
  ];

  const curated = curateStreams(entries);
  assert.deepEqual(curated.map((item) => item.providerId), ['vidsrc', 'hdhub4u', 'uhdmovies']);

  // Higher tier first, then provider rank — the same ordering curation applies.
  assert.deepEqual(
    curationRunnersUp(entries, curated).map((item) => item.providerId),
    ['castle', 'netmirror']
  );
});

test('a tier whose every pick is dead is refilled rather than left empty', async () => {
  const curated = [entry('a', '1080p', '/dead1'), entry('b', '1080p', '/dead2')];
  const reserve = [entry('c', '1080p', '/good1'), entry('d', '1080p', '/good2')];

  const playable = await filterPlayableStreamsWithBackfill(curated, reserve, {
    target: curated.length,
    deadlineAt: Date.now() + 8000
  });

  assert.deepEqual(playable.map((item) => item.providerId), ['c', 'd']);
});

test('healthy picks cost no extra probes', async () => {
  const curated = [entry('a', '1080p', '/good')];
  const reserve = [entry('b', '1080p', '/good2')];

  const playable = await filterPlayableStreamsWithBackfill(curated, reserve, {
    target: curated.length,
    deadlineAt: Date.now() + 8000
  });

  assert.deepEqual(playable.map((item) => item.providerId), ['a']);
});

test('an exhausted reserve returns what survived rather than hanging', async () => {
  const curated = [entry('a', '1080p', '/dead1'), entry('b', '1080p', '/dead2')];

  const playable = await filterPlayableStreamsWithBackfill(curated, [], {
    target: curated.length,
    deadlineAt: Date.now() + 8000
  });

  assert.deepEqual(playable, []);
});

test('a spent budget stops the refill loop', async () => {
  const curated = [entry('a', '1080p', '/dead1')];
  const reserve = [entry('b', '1080p', '/good1')];

  const playable = await filterPlayableStreamsWithBackfill(curated, reserve, {
    target: curated.length,
    deadlineAt: Date.now() - 1
  });

  assert.deepEqual(playable, []);
});

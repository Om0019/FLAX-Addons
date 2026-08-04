// Three ways a stream could reach the viewer misdescribed or unusable, each
// caught in a live run against the real providers.

const assert = require('node:assert/strict');
const test = require('node:test');
const { dedupeByUrl, normalizeUrl, normalizeStream } = require('../src/response');

const entry = (providerId, resolution, url) => ({
  providerId,
  providerName: providerId,
  resolution,
  raw: { url }
});

// Castle returns one URL — a path under /720/ — three times, labelled 1080P,
// 720P and 480P. Keeping the first occurrence kept the highest claim, so a
// 720p stream took the 1080p slot and Castle never filled 720p at all.
test('one link offered at several resolutions keeps the lowest claim', () => {
  const url = 'https://cdn.example/hls/1/720/index.m3u8';
  const deduped = dedupeByUrl([
    entry('castle', '1080P', url),
    entry('castle', '720P', url),
    entry('castle', '480P', url)
  ]);

  assert.equal(deduped.length, 1);
  assert.equal(deduped[0].resolution, '480P');
});

test('the same link from two providers keeps the first, and its claim', () => {
  const url = 'https://cdn.example/file.mkv';
  const deduped = dedupeByUrl([entry('hdhub4u', '1080p', url), entry('castle', '480p', url)]);

  assert.deepEqual(deduped.map((item) => [item.providerId, item.resolution]), [['hdhub4u', '1080p']]);
});

test('distinct links are all kept', () => {
  const deduped = dedupeByUrl([
    entry('hdhub4u', '1080p', 'https://cdn.example/a.mkv'),
    entry('hdhub4u', '1080p', 'https://cdn.example/b.mkv')
  ]);
  assert.equal(deduped.length, 2);
});

test('entries with no URL are dropped', () => {
  assert.deepEqual(dedupeByUrl([entry('castle', '1080p', undefined)]), []);
});

// 4KHDHub's Direct-R2 links carry the release filename unencoded.
test('a URL with literal spaces is encoded, and escapes are left alone', () => {
  assert.equal(
    normalizeUrl('https://x.workers.dev/id/Breaking Bad S01E01 1080p.mkv'),
    'https://x.workers.dev/id/Breaking%20Bad%20S01E01%201080p.mkv'
  );
  // Signature-bearing paths must survive untouched: no double-encoding.
  const signed = 'https://x.r2.dev/hub/abc?X-Amz-Credential=ce38%2F20260804%2Fauto&sig=a%2Bb';
  assert.equal(normalizeUrl(signed), signed);
});

test('something unparseable is passed through rather than mangled', () => {
  assert.equal(normalizeUrl('not a url'), 'not a url');
});

test('a provider bingeGroup survives into the response', () => {
  const stream = normalizeStream(
    { url: 'https://cdn.example/a.mkv', quality: '1080p', behaviorHints: { bingeGroup: '4khdhub-FSL' } },
    '4KHDHub'
  );

  assert.equal(stream.behaviorHints.bingeGroup, '4khdhub-FSL');
  assert.equal(stream.behaviorHints.notWebReady, true);
});

test('required request headers are forwarded as proxyHeaders', () => {
  const stream = normalizeStream(
    { url: 'https://cdn.example/a.m3u8', headers: { Referer: 'https://required.example/' } },
    'Castle'
  );

  assert.deepEqual(stream.behaviorHints.proxyHeaders, { request: { Referer: 'https://required.example/' } });
  assert.equal(stream.behaviorHints.bingeGroup, undefined);
});

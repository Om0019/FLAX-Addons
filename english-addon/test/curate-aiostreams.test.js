const assert = require('node:assert/strict');
const test = require('node:test');
const { curateAiostreams } = require('../src/curate');

const entry = (resolution, url) => ({ providerId: 'aiostreams', providerName: 'AIOStreams', resolution, url });

test('caps AIOStreams to one 2160p, one 1080p, and one lower-or-unlabeled stream', () => {
  const entries = [
    entry('2160p', 'a'),
    entry('2160p', 'b'),
    entry('1080p', 'c'),
    entry('1080p', 'd'),
    entry('720p', 'e'),
    entry('480p', 'f'),
    entry(null, 'g')
  ];

  const selected = curateAiostreams(entries);

  assert.equal(selected.length, 3);
  assert.deepEqual(selected.map((item) => item.url), ['a', 'c', 'e']);
});

test('a missing tier is simply absent, not backfilled from another tier', () => {
  const entries = [entry('1080p', 'a'), entry(null, 'b')];

  const selected = curateAiostreams(entries);

  assert.deepEqual(selected.map((item) => item.url), ['a', 'b']);
});

test('720p and unlabeled share the same lower tier and only one of them survives', () => {
  const entries = [entry(null, 'a'), entry('720p', 'b')];

  const selected = curateAiostreams(entries);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, 'a');
});

test('4k is treated as the 2160p tier', () => {
  const entries = [entry('4k', 'a'), entry('2160p', 'b')];

  const selected = curateAiostreams(entries);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].url, 'a');
});

test('empty input yields no streams', () => {
  assert.deepEqual(curateAiostreams([]), []);
});

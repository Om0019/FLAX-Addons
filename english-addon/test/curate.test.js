const assert = require('node:assert/strict');
const test = require('node:test');
const { curateStreams, resolutionTier } = require('../src/curate');

const entry = (providerId, resolution) => ({ providerId, providerName: providerId, resolution });

test('a provider offering several resolutions contributes only its best one', () => {
  // Regression: hdhub4u having a 2160p, a 1080p, and a 720p link for the
  // same title used to be able to fill three of the five slots by itself.
  const entries = [
    entry('hdhub4u', '2160p'),
    entry('hdhub4u', '1080p'),
    entry('hdhub4u', '720p')
  ];

  const selected = curateStreams(entries);

  assert.equal(selected.length, 1);
  assert.equal(selected[0].resolution, '2160p');
});

test('reliability outranks resolution: a shaky provider\'s higher claim does not jump a reliable one', () => {
  const entries = [
    entry('videasy', '2160p'), // higher resolution, but ranked well below hdhub4u/castle
    entry('hdhub4u', '720p'),
    entry('castle', '720p')
  ];

  const selected = curateStreams(entries);

  assert.deepEqual(selected.map((item) => item.providerId), ['hdhub4u', 'castle', 'videasy']);
});

test('resolution only breaks ties between providers of otherwise-equal rank', () => {
  const entries = [
    entry('unranked-a', '720p'),
    entry('unranked-b', '2160p')
  ];

  const selected = curateStreams(entries);

  assert.deepEqual(selected.map((item) => item.providerId), ['unranked-b', 'unranked-a']);
});

test('at most 5 streams survive, most reliable provider first', () => {
  const entries = [
    entry('hdhub4u', '2160p'),
    entry('uhdmovies', '2160p'),
    entry('4khdhubnew', '1080p'),
    entry('castle', '1080p'),
    entry('streamflix', '720p'),
    entry('videasy', '720p'),
    entry('peachify', 'HD'),
    entry('allwish', 'HD')
  ];

  const selected = curateStreams(entries);

  assert.equal(selected.length, 5);
  assert.deepEqual(
    selected.map((item) => item.providerId),
    ['hdhub4u', 'uhdmovies', '4khdhubnew', 'castle', 'streamflix']
  );
});

test('an unlabeled resolution still competes for a slot on its own merits', () => {
  // A provider's stream can be a full adaptive HLS ladder with no single
  // resolution to report - "unlabeled" is not the same as "worse", so it is
  // not excluded outright, only outranked by entries that do claim a tier.
  const entries = [entry('hdhub4u', '1080p'), entry('castle', null)];

  const selected = curateStreams(entries);

  assert.deepEqual(selected.map((item) => item.providerId), ['hdhub4u', 'castle']);
});

test('resolutionTier treats an unlabeled resolution the same as a below-720p one', () => {
  assert.equal(resolutionTier(null), resolutionTier('480p'));
  assert.equal(resolutionTier(undefined), 'fallback');
  assert.equal(resolutionTier('Auto'), 'fallback');
});

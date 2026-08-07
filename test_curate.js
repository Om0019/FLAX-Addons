// curateStreams (src/curate.js): caps a request's stream list two ways -
// non-AIOStreams streams to 3 (one per scraper, most reliable first), and
// AIOStreams streams to 3 (one per quality tier: 2160p, 1080p, other) -
// mirroring english-addon/src/curate.js's own two caps.

const assert = require('assert');
const { curateStreams, SCRAPER_PRIORITY, MAX_NON_AIOSTREAMS, AIOSTREAMS_TIERS } = require('./src/curate');

const stream = (sourceLabel, url, quality) => ({ __sourceLabel: sourceLabel, url, name: sourceLabel, quality });
const aioStream = (url, height) => stream('AIOStreams', url, height ? { height } : null);

function testCapsToThreeMostReliableScrapers() {
  const selected = [
    stream('Cuevana3i', 'a'),
    stream('SoloLatino', 'b'),
    stream('TioPlus', 'c'),
    stream('PelisPedia', 'd'),
    stream('Embed69', 'e')
  ];

  const curated = curateStreams(selected);

  assert.strictEqual(curated.length, MAX_NON_AIOSTREAMS);
  assert.deepStrictEqual(curated.map((s) => s.__sourceLabel), ['SoloLatino', 'TioPlus', 'PelisPedia']);
}

function testOnlyOneStreamPerScraper() {
  const selected = [
    stream('SoloLatino', 'a'),
    stream('SoloLatino', 'b'),
    stream('TioPlus', 'c')
  ];

  const curated = curateStreams(selected);

  assert.strictEqual(curated.length, 2);
  assert.strictEqual(curated[0].url, 'a', 'a scraper contributes its first surviving stream, not a later one');
}

function testOriginalOrderIsPreserved() {
  // The incoming list is already sorted (confirmed-playable first, ranked by
  // host) by the time this runs - curation must only decide what survives,
  // not re-sort by scraper priority.
  const selected = [
    stream('Cinecalidad', 'best-host'),
    stream('SoloLatino', 'second-best-host')
  ];

  const curated = curateStreams(selected);

  assert.deepStrictEqual(curated.map((s) => s.url), ['best-host', 'second-best-host']);
}

function testUnknownScraperStillCompetesForASlot() {
  const selected = [stream('SomeNewScraper', 'a'), stream('SoloLatino', 'b')];

  const curated = curateStreams(selected);

  assert.strictEqual(curated.length, 2, 'a scraper missing from SCRAPER_PRIORITY is not excluded outright');
}

function testFewerThanThreeScrapersReturnsAllOfThem() {
  const selected = [stream('SoloLatino', 'a'), stream('TioPlus', 'b')];

  const curated = curateStreams(selected);

  assert.strictEqual(curated.length, 2);
}

function testEmptyListReturnsEmpty() {
  assert.deepStrictEqual(curateStreams([]), []);
}

function testScraperPriorityCoversEveryNonAiostreamsSource() {
  const knownScrapers = [
    'SoloLatino', 'Cinecalidad', 'TioPlus', 'Cuevana3i', 'LaMovie',
    'PelisPedia', 'TLNovelas', 'Novelas360', 'Ennovelas', 'Embed69'
  ];
  for (const scraper of knownScrapers) {
    assert.ok(SCRAPER_PRIORITY.includes(scraper), `${scraper} is missing from SCRAPER_PRIORITY`);
  }
}

function testAiostreamsCapsToOnePerQualityTier() {
  const selected = [
    aioStream('a', 2160),
    aioStream('b', 2160),
    aioStream('c', 1080),
    aioStream('d', 1080),
    aioStream('e', 720),
    aioStream('f', null)
  ];

  const curated = curateStreams(selected);

  assert.strictEqual(curated.length, AIOSTREAMS_TIERS.length);
  assert.deepStrictEqual(curated.map((s) => s.url), ['a', 'c', 'e']);
}

function testAiostreams720AndUnlabeledShareTheSameLowerTier() {
  const selected = [aioStream('a', null), aioStream('b', 720)];

  const curated = curateStreams(selected);

  assert.strictEqual(curated.length, 1);
  assert.strictEqual(curated[0].url, 'a');
}

function testAiostreamsAndNonAiostreamsCapsApplyIndependently() {
  const selected = [
    aioStream('a', 2160),
    aioStream('b', 1080),
    aioStream('c', 720),
    stream('SoloLatino', 'd'),
    stream('TioPlus', 'e'),
    stream('PelisPedia', 'f'),
    stream('Embed69', 'g')
  ];

  const curated = curateStreams(selected);

  const aioUrls = curated.filter((s) => s.__sourceLabel === 'AIOStreams').map((s) => s.url);
  const nonAioUrls = curated.filter((s) => s.__sourceLabel !== 'AIOStreams').map((s) => s.url);
  assert.deepStrictEqual(aioUrls, ['a', 'b', 'c']);
  assert.deepStrictEqual(nonAioUrls, ['d', 'e', 'f']);
}

function run() {
  testCapsToThreeMostReliableScrapers();
  testOnlyOneStreamPerScraper();
  testOriginalOrderIsPreserved();
  testUnknownScraperStillCompetesForASlot();
  testFewerThanThreeScrapersReturnsAllOfThem();
  testEmptyListReturnsEmpty();
  testScraperPriorityCoversEveryNonAiostreamsSource();
  testAiostreamsCapsToOnePerQualityTier();
  testAiostreams720AndUnlabeledShareTheSameLowerTier();
  testAiostreamsAndNonAiostreamsCapsApplyIndependently();

  console.log('All curate tests passed.');
}

run();

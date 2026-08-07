// curateNonAiostreams (src/curate.js): caps the non-AIOStreams portion of a
// request to 3 streams, one per scraper, most reliable scrapers first, while
// leaving AIOStreams entries untouched and uncapped.

const assert = require('assert');
const { curateNonAiostreams, SCRAPER_PRIORITY, MAX_NON_AIOSTREAMS } = require('./src/curate');

const stream = (sourceLabel, url) => ({ __sourceLabel: sourceLabel, url, name: sourceLabel });

function testCapsToThreeMostReliableScrapers() {
  const selected = [
    stream('Cuevana3i', 'a'),
    stream('SoloLatino', 'b'),
    stream('TioPlus', 'c'),
    stream('PelisPedia', 'd'),
    stream('Embed69', 'e')
  ];

  const curated = curateNonAiostreams(selected);

  assert.strictEqual(curated.length, MAX_NON_AIOSTREAMS);
  assert.deepStrictEqual(curated.map((s) => s.__sourceLabel), ['SoloLatino', 'TioPlus', 'PelisPedia']);
}

function testAioStreamsIsUncappedAndUnaffectedByCap() {
  const selected = [
    stream('AIOStreams', 'a'),
    stream('AIOStreams', 'b'),
    stream('AIOStreams', 'c'),
    stream('SoloLatino', 'd'),
    stream('TioPlus', 'e'),
    stream('PelisPedia', 'f'),
    stream('Embed69', 'g')
  ];

  const curated = curateNonAiostreams(selected);

  const aioCount = curated.filter((s) => s.__sourceLabel === 'AIOStreams').length;
  const nonAioCount = curated.length - aioCount;
  assert.strictEqual(aioCount, 3, 'every AIOStreams entry survives the cap');
  assert.strictEqual(nonAioCount, MAX_NON_AIOSTREAMS);
}

function testOnlyOneStreamPerScraper() {
  const selected = [
    stream('SoloLatino', 'a'),
    stream('SoloLatino', 'b'),
    stream('TioPlus', 'c')
  ];

  const curated = curateNonAiostreams(selected);

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

  const curated = curateNonAiostreams(selected);

  assert.deepStrictEqual(curated.map((s) => s.url), ['best-host', 'second-best-host']);
}

function testUnknownScraperStillCompetesForASlot() {
  const selected = [stream('SomeNewScraper', 'a'), stream('SoloLatino', 'b')];

  const curated = curateNonAiostreams(selected);

  assert.strictEqual(curated.length, 2, 'a scraper missing from SCRAPER_PRIORITY is not excluded outright');
}

function testFewerThanThreeScrapersReturnsAllOfThem() {
  const selected = [stream('SoloLatino', 'a'), stream('TioPlus', 'b')];

  const curated = curateNonAiostreams(selected);

  assert.strictEqual(curated.length, 2);
}

function testEmptyListReturnsEmpty() {
  assert.deepStrictEqual(curateNonAiostreams([]), []);
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

function run() {
  testCapsToThreeMostReliableScrapers();
  testAioStreamsIsUncappedAndUnaffectedByCap();
  testOnlyOneStreamPerScraper();
  testOriginalOrderIsPreserved();
  testUnknownScraperStillCompetesForASlot();
  testFewerThanThreeScrapersReturnsAllOfThem();
  testEmptyListReturnsEmpty();
  testScraperPriorityCoversEveryNonAiostreamsSource();

  console.log('All curate tests passed.');
}

run();

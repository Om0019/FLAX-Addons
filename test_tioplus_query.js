const assert = require('assert');
const { __test } = require('./src/scrapers/tioplus');

const { toSearchQuery } = __test;

// TioPlus takes the search term as a URL path segment. Two characters break it
// whatever the encoding: a plain apostrophe returns HTTP 500 (%27 fails too) and a
// slash returns 404 (%2F too). Both were silent — the search attempt was spent and
// nothing came back, so any title carrying one lost that lookup entirely.

function testApostropheIsRemoved() {
  assert.strictEqual(toSearchQuery("Grey's Anatomy"), 'Greys Anatomy');
  assert.strictEqual(toSearchQuery("Schindler's List"), 'Schindlers List');
  assert.strictEqual(toSearchQuery("Ocean's Eleven"), 'Oceans Eleven');
}

function testSlashBecomesSpace() {
  assert.strictEqual(toSearchQuery('Face/Off'), 'Face Off');
  // Collapsing avoids the double space a bare replacement would leave.
  assert.strictEqual(toSearchQuery('A / B'), 'A B');
}

// Only the two characters that actually break the endpoint are touched. A curly
// apostrophe is accepted by the server, and mangling accents or punctuation that
// works would cost matches rather than win them.
function testEverythingElseIsLeftAlone() {
  assert.strictEqual(toSearchQuery('Grey’s Anatomy'), 'Grey’s Anatomy', 'curly apostrophe is fine');
  assert.strictEqual(toSearchQuery('Anatomía de Grey'), 'Anatomía de Grey', 'accents preserved');
  assert.strictEqual(toSearchQuery('Spider-Man: No Way Home'), 'Spider-Man: No Way Home');
  assert.strictEqual(toSearchQuery('Tom & Jerry'), 'Tom & Jerry');
  assert.strictEqual(toSearchQuery('Mamma Mia!'), 'Mamma Mia!');
  assert.strictEqual(toSearchQuery('Mr. Robot'), 'Mr. Robot');
}

function testHandlesMissingInput() {
  assert.strictEqual(toSearchQuery(''), '');
  assert.strictEqual(toSearchQuery(null), '');
  assert.strictEqual(toSearchQuery(undefined), '');
  assert.strictEqual(toSearchQuery('  padded  '), 'padded');
}

// Most of the tokens on a page are wrappers that answer with a timeout, so the
// three-result target is rarely reached and the wait deadline has to be what ends
// the collection. It used to enable the fast return without lowering the target,
// which meant it ended nothing: a token that resolved at 2.5s was handed back at
// 7.5s, after the orchestrator had already returned without this source.
async function testWaitDeadlineReleasesWhatHasResolved() {
  const { mapWithConcurrencyUntilEnough } = require('./src/scrapers/tioplus').__test;

  const items = ['fast', 'slow-a', 'slow-b', 'slow-c'];
  const startedAt = Date.now();
  const results = await mapWithConcurrencyUntilEnough(items, 4, async (item) => {
    if (item === 'fast') return { url: `https://cdn.example/${item}.m3u8` };
    // Stands in for a wrapper host that only answers when its timeout fires.
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return null;
  }, { minResults: 3, minWaitMs: 300, timeoutMs: 6500 });
  const elapsed = Date.now() - startedAt;

  assert.strictEqual(results.length, 1, 'the resolved token is returned');
  assert.ok(
    elapsed < 1500,
    `collection must end on the wait deadline, not the collection timeout (took ${elapsed}ms)`
  );
}

// The deadline lowers the target, it does not abandon it: with nothing resolved
// there is nothing to hand back, so the collection has to keep waiting.
async function testWaitDeadlineDoesNotReleaseAnEmptyResult() {
  const { mapWithConcurrencyUntilEnough } = require('./src/scrapers/tioplus').__test;

  const startedAt = Date.now();
  const results = await mapWithConcurrencyUntilEnough(['a', 'b'], 2, async () => {
    await new Promise((resolve) => setTimeout(resolve, 800));
    return null;
  }, { minResults: 3, minWaitMs: 200, timeoutMs: 6500 });

  assert.deepStrictEqual(results, [], 'nothing resolved, nothing returned');
  assert.ok(
    Date.now() - startedAt >= 700,
    'an empty result must not be released early by the deadline'
  );
}

async function main() {
  testApostropheIsRemoved();
  testSlashBecomesSpace();
  testEverythingElseIsLeftAlone();
  testHandlesMissingInput();
  await testWaitDeadlineReleasesWhatHasResolved();
  await testWaitDeadlineDoesNotReleaseAnEmptyResult();
  console.log('TioPlus query tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

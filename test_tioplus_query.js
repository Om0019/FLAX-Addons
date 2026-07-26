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

testApostropheIsRemoved();
testSlashBecomesSpace();
testEverythingElseIsLeftAlone();
testHandlesMissingInput();

console.log('TioPlus query tests passed');

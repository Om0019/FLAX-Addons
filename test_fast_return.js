const assert = require('assert');
const path = require('path');

// The fast-return path used to be unreachable: its enabling flag only flipped when
// a 3500ms timer fired, so however quickly sources answered, no request could
// finish sooner. Collection time was pinned at 3501ms in measurement after
// measurement. These tests drive the orchestrator with stub scrapers so the
// timing is deterministic and no network is involved.

const ORCHESTRATOR = path.join(__dirname, 'src', 'scrapers', 'index.js');

// Read the real thresholds so the stubs stay meaningful if they are retuned.
const orchestratorSource = require('fs').readFileSync(ORCHESTRATOR, 'utf8');
const constant = (name) => {
  const match = orchestratorSource.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} should be defined`);
  return parseInt(match[1], 10);
};
const MIN_STREAMS = constant('FAST_SOURCE_MIN_STREAMS');
const MIN_SOURCES = constant('FAST_SOURCE_MIN_SOURCES');
// Split the required streams across the required number of fast sources, plus one
// spare so the gate is comfortably satisfied rather than exactly met.
const PER_SOURCE = Math.ceil(MIN_STREAMS / MIN_SOURCES) + 1;

function stubScraper(delayMs, streamCount, label) {
  return {
    scrape: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      return Array.from({ length: streamCount }, (_, i) => ({
        name: label,
        title: `${label} ${i + 1}`,
        url: `https://cdn-${label.toLowerCase()}.example/${i}/master.m3u8`
      }));
    }
  };
}

/**
 * Loads a fresh orchestrator with the six source modules replaced by stubs, so
 * completion timing is under the test's control. TMDB and stream validation are
 * stubbed out too — this is measuring the collection gate, nothing else.
 */
function loadOrchestratorWith(stubs) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('src', 'scrapers')) || key.includes(path.join('src', 'tmdb'))) {
      delete require.cache[key];
    }
  }

  const names = {
    './sololatino': 'SoloLatino',
    './cinecalidad': 'Cinecalidad',
    './tioplus': 'TioPlus',
    './cuevana3i': 'Cuevana3i',
    './lamovie': 'LaMovie',
    './pelispedia': 'PelisPedia'
  };

  const Module = require('module');
  const originalLoad = Module._load;

  Module._load = function patched(request, parent, isMain) {
    if (parent && parent.filename === ORCHESTRATOR) {
      if (names[request]) return stubs[names[request]] || stubScraper(50, 0, names[request]);
      if (request === '../tmdb') {
        return {
          getMetaDetails: async () => ({
            name: 'Test Title', originalTitle: 'Test Title', releaseInfo: '2024', imdb_id: 'tt1'
          }),
          findByImdbId: async () => null,
          getAlternativeTitles: async () => []
        };
      }
    }
    return originalLoad.apply(this, arguments);
  };

  try {
    delete require.cache[ORCHESTRATOR];
    return require(ORCHESTRATOR);
  } finally {
    Module._load = originalLoad;
  }
}

// Two quick sources between them satisfy the gate, so the request must not sit
// waiting for the relaxation deadline.
async function testTwoFastSourcesReturnEarly() {
  const orchestrator = loadOrchestratorWith({
    LaMovie: stubScraper(150, PER_SOURCE, 'LaMovie'),
    Cuevana3i: stubScraper(200, PER_SOURCE, 'Cuevana3i'),
    SoloLatino: stubScraper(9000, PER_SOURCE, 'SoloLatino'),
    TioPlus: stubScraper(9000, PER_SOURCE, 'TioPlus'),
    Cinecalidad: stubScraper(9000, PER_SOURCE, 'Cinecalidad'),
    PelisPedia: stubScraper(9000, PER_SOURCE, 'PelisPedia')
  });

  const startedAt = Date.now();
  const streams = await orchestrator.getStreams('movie', 'tmdb:movie:1', null, null);
  const elapsed = Date.now() - startedAt;

  assert.ok(streams.length > 0, 'streams are returned');
  assert.ok(
    elapsed < 2500,
    `two fast sources must not wait for the 3500ms relaxation deadline (took ${elapsed}ms)`
  );
}

// A single fast source is deliberately not enough: waiting for a second is what
// stops the early exit from always handing back the quickest source alone. Once
// the relaxation deadline passes, one source will do.
async function testSingleSourceWaitsForRelaxation() {
  const orchestrator = loadOrchestratorWith({
    LaMovie: stubScraper(150, MIN_STREAMS, 'LaMovie'),
    Cuevana3i: stubScraper(9000, 0, 'Cuevana3i'),
    SoloLatino: stubScraper(9000, 0, 'SoloLatino'),
    TioPlus: stubScraper(9000, 0, 'TioPlus'),
    Cinecalidad: stubScraper(9000, 0, 'Cinecalidad'),
    PelisPedia: stubScraper(9000, 0, 'PelisPedia')
  });

  const startedAt = Date.now();
  const streams = await orchestrator.getStreams('movie', 'tmdb:movie:2', null, null);
  const elapsed = Date.now() - startedAt;

  assert.ok(streams.length > 0, 'the single source still yields streams');
  assert.ok(
    elapsed >= 3400,
    `one source alone should wait for the relaxation deadline (returned in ${elapsed}ms)`
  );
  assert.ok(elapsed < 6000, `but must not wait for the full collection timeout (took ${elapsed}ms)`);
}

// A probe that can outlast the phase it runs in guarantees that phase times out.
function testValidationProbeFitsInsideItsBudget() {
  const probe = constant('STREAM_VALIDATION_TIMEOUT_MS');
  const fast = constant('STREAM_VALIDATION_FAST_TIMEOUT_MS');
  const total = constant('STREAM_VALIDATION_TOTAL_TIMEOUT_MS');

  assert.ok(probe < total, `per-probe timeout (${probe}ms) must be under the phase budget (${total}ms)`);
  assert.ok(fast <= total, `fast budget (${fast}ms) should not exceed the total budget (${total}ms)`);
}

async function main() {
  await testTwoFastSourcesReturnEarly();
  await testSingleSourceWaitsForRelaxation();
  testValidationProbeFitsInsideItsBudget();
  console.log('Fast-return tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

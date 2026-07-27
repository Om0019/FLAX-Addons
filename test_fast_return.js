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

// Sources typically answer with one or two streams each, so the full five-stream
// target is only ever met by waiting for a fourth source — exactly what the
// relaxation deadline exists to stop doing. Past the deadline a thinner set is
// accepted, but only once the probes have shown those streams actually play.
async function testConfirmedThinSourcesReturnAtRelaxationDeadline() {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('#EXTM3U\n#EXTINF:6.0,\nseg.ts\n', {
    status: 200,
    headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
  });

  try {
    // Three sources, one stream each: under the full target, and all playable.
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper(150, 1, 'LaMovie'),
      Cuevana3i: stubScraper(250, 1, 'Cuevana3i'),
      PelisPedia: stubScraper(350, 1, 'PelisPedia'),
      SoloLatino: stubScraper(9000, 2, 'SoloLatino'),
      TioPlus: stubScraper(9000, 2, 'TioPlus'),
      Cinecalidad: stubScraper(9000, 2, 'Cinecalidad')
    });

    const startedAt = Date.now();
    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:3', null, null);
    const elapsed = Date.now() - startedAt;

    assert.ok(streams.length > 0, 'the thin sources still yield streams');
    assert.ok(
      elapsed < 6000,
      `confirmed thin sources must return on the relaxation deadline (took ${elapsed}ms)`
    );
  } finally {
    global.fetch = realFetch;
  }
}

// The counterpart, and the reason the gate counts confirmed streams rather than
// raw ones. Sources that hand back dead URLs must not trip the early return: doing
// so cancels the sources still in flight and hands the user whatever survives
// validation, which was measured in production as one stream out of three.
async function testUnplayableThinSourcesDoNotTripTheDeadline() {
  const realFetch = global.fetch;
  global.fetch = async () => new Response('not a playlist', { status: 404 });

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper(150, 1, 'LaMovie'),
      Cuevana3i: stubScraper(250, 1, 'Cuevana3i'),
      PelisPedia: stubScraper(350, 1, 'PelisPedia'),
      // Enough to satisfy the full target, but only if it is waited for.
      SoloLatino: stubScraper(4200, MIN_STREAMS, 'SoloLatino'),
      TioPlus: stubScraper(9000, 0, 'TioPlus'),
      Cinecalidad: stubScraper(9000, 0, 'Cinecalidad')
    });

    const startedAt = Date.now();
    await orchestrator.getStreams('movie', 'tmdb:movie:4', null, null);
    const elapsed = Date.now() - startedAt;

    assert.ok(
      elapsed >= 4200,
      `three dead streams must not trigger the early return at the deadline (returned in ${elapsed}ms)`
    );
  } finally {
    global.fetch = realFetch;
  }
}

// A probe that can outlast the phase it runs in guarantees that phase times out.
function testValidationProbeFitsInsideItsBudget() {
  const probe = constant('STREAM_VALIDATION_TIMEOUT_MS');
  const fast = constant('STREAM_VALIDATION_FAST_TIMEOUT_MS');
  const total = constant('STREAM_VALIDATION_TOTAL_TIMEOUT_MS');

  assert.ok(probe < total, `per-probe timeout (${probe}ms) must be under the phase budget (${total}ms)`);
  assert.ok(fast <= total, `fast budget (${fast}ms) should not exceed the total budget (${total}ms)`);
}

// Probes begin as each source reports rather than after all of them, so a URL can
// be asked about twice — once eagerly, once by the final selection. It must only
// be fetched once, or overlapping would just double the network work.
async function testValidatorProbesEachUrlOnce() {
  const { createStreamValidator } = require('./src/scrapers').__test;

  const realFetch = global.fetch;
  const fetched = [];
  global.fetch = async (url) => {
    fetched.push(String(url));
    return new Response('#EXTM3U\n#EXTINF:6.0,\nseg.ts\n', {
      status: 200,
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' }
    });
  };

  try {
    const validator = createStreamValidator(new AbortController().signal);
    const stream = { name: 'S', title: 't', url: 'https://cdn.example/a/master.m3u8' };
    const other = { name: 'S', title: 't', url: 'https://cdn.example/b/master.m3u8' };

    const [first, second, third] = await Promise.all([
      validator.validate(stream),
      validator.validate(stream),
      validator.validate(other)
    ]);

    assert.strictEqual(first, second, 'repeat probe returns the same result');
    // A probe reports playability and whatever it could tell about quality, so the
    // verdict is a record rather than a bare boolean.
    assert.strictEqual(typeof third.playable, 'boolean', 'a distinct url is probed on its own');
    assert.strictEqual(validator.started, 2, 'two distinct urls means two probes');

    const forStream = fetched.filter((u) => u === stream.url);
    assert.strictEqual(forStream.length, 1, `a url must be fetched once, saw ${forStream.length}`);

    // Asking again after settling must still not refetch.
    await validator.validate(stream);
    assert.strictEqual(fetched.filter((u) => u === stream.url).length, 1, 'settled result is reused');
  } finally {
    global.fetch = realFetch;
  }
}

async function main() {
  await testValidatorProbesEachUrlOnce();
  await testTwoFastSourcesReturnEarly();
  await testSingleSourceWaitsForRelaxation();
  await testConfirmedThinSourcesReturnAtRelaxationDeadline();
  await testUnplayableThinSourcesDoNotTripTheDeadline();
  testValidationProbeFitsInsideItsBudget();
  console.log('Fast-return tests passed');
}

main().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

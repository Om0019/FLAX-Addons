const assert = require('assert');
const path = require('path');

// These tests cover the three places where independent work used to be queued up
// behind other work rather than run alongside it. They are all about *when*
// requests are issued, so every one of them stubs the clock-facing edge — global
// fetch, or the scraper modules themselves — and asserts on issue times. No
// network is involved.

const { raceTitleSearches } = require('./src/scrapers/common');
const ORCHESTRATOR = path.join(__dirname, 'src', 'scrapers', 'index.js');

const orchestratorSource = require('fs').readFileSync(ORCHESTRATOR, 'utf8');
const constant = (name) => {
  const match = orchestratorSource.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} should be defined`);
  return parseInt(match[1], 10);
};

// Two searches issued this far apart are concurrent by any reasonable reading;
// sequential ones are separated by a whole stubbed round trip (see STUB_LATENCY_MS).
const CONCURRENT_WINDOW_MS = 100;
const STUB_LATENCY_MS = 400;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- raceTitleSearches ------------------------------------------------------

// The point of racing is latency, not a change of preference: whichever answers
// first, the earliest title in the list still owns the result.
async function testPriorityOrderWinsOverArrivalOrder() {
  const match = await raceTitleSearches(['primary', 'secondary'], async (title) => {
    if (title === 'secondary') return { from: 'secondary' };
    await delay(50);
    return { from: 'primary' };
  });

  assert.deepStrictEqual(match, { from: 'primary' }, 'the earlier title wins even when it answers later');
}

async function testFallsBackToLaterTitle() {
  const match = await raceTitleSearches(['primary', 'secondary'], async (title) => (
    title === 'secondary' ? { from: 'secondary' } : null
  ));

  assert.deepStrictEqual(match, { from: 'secondary' }, 'a later title is used when the earlier one misses');
  assert.strictEqual(await raceTitleSearches(['a', 'b'], async () => null), null, 'no match yields null');
}

async function testSearchesRunConcurrently() {
  const issuedAt = [];
  await raceTitleSearches(['primary', 'secondary'], async (title) => {
    issuedAt.push({ title, at: Date.now() });
    await delay(STUB_LATENCY_MS);
    return null;
  });

  assert.strictEqual(issuedAt.length, 2, 'both titles are searched');
  const spread = Math.abs(issuedAt[1].at - issuedAt[0].at);
  assert.ok(
    spread < CONCURRENT_WINDOW_MS,
    `both searches should be issued together (${spread}ms apart, stub latency ${STUB_LATENCY_MS}ms)`
  );
}

// A failure on a title that the sequential version would never have requested must
// not become a new way for the scrape to fail.
async function testFailureOnUnconsultedTitleIsAbsorbed() {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);

  try {
    const match = await raceTitleSearches(['primary', 'secondary'], async (title) => {
      if (title === 'secondary') throw new Error('secondary search exploded');
      return { from: 'primary' };
    });

    assert.deepStrictEqual(match, { from: 'primary' }, 'the matching title still wins');
    // Let any stray rejection reach the handler before checking.
    await delay(50);
    assert.deepStrictEqual(unhandled, [], 'the unconsulted failure must not surface as an unhandled rejection');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
}

// ...but a failure the sequential version *would* have hit still propagates.
async function testFailureOnConsultedTitlePropagates() {
  await assert.rejects(
    raceTitleSearches(['primary', 'secondary'], async (title) => {
      if (title === 'secondary') throw new Error('secondary search exploded');
      return null;
    }),
    /secondary search exploded/,
    'an error surfaces once every higher-priority title has missed'
  );

  await assert.rejects(
    raceTitleSearches(['primary', 'secondary'], async (title) => {
      if (title === 'primary') throw new Error('primary search exploded');
      return { from: 'secondary' };
    }),
    /primary search exploded/,
    'the highest-priority failure wins over a lower-priority match'
  );
}

// --- Scrapers: overlapping the two title searches ---------------------------

const NO_MATCH_HTML = '<html><head><title>Nada</title></head><body><p>Sin resultados</p></body></html>';

/**
 * Installs a fetch stub that records every request with the time it was issued and
 * answers after STUB_LATENCY_MS, so sequential work is plainly separable from
 * concurrent work.
 */
function stubFetch(handler) {
  const realFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options = {}) => {
    const target = String(url);
    requests.push({ url: target, at: Date.now() });
    await delay(STUB_LATENCY_MS);
    return handler(target, options);
  };

  return {
    requests,
    restore() { global.fetch = realFetch; }
  };
}

function withQuietLogs(run) {
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};

  return Promise.resolve().then(run).finally(() => {
    console.log = original.log;
    console.warn = original.warn;
    console.error = original.error;
  });
}

// Each of the three search-based sources should ask for both names at once. A
// Spanish-titled release whose site entry is filed under the original name used to
// pay a full search round trip before that name was tried at all.
async function testScrapersSearchBothTitlesConcurrently() {
  const cases = [
    { name: 'SoloLatino', module: './src/scrapers/sololatino', searchUrl: /sololatino\.net\/buscar/ },
    { name: 'TioPlus', module: './src/scrapers/tioplus', searchUrl: /tioplus\.app\// },
    { name: 'Cinecalidad', module: './src/scrapers/cinecalidad', searchUrl: /cinecalidad\.am\/\?s=/ }
  ];

  for (const testCase of cases) {
    const stub = stubFetch(() => new Response(NO_MATCH_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html' }
    }));

    try {
      const scraper = require(testCase.module);
      await withQuietLogs(() => scraper.scrape(
        'Título En Español',
        'Original English Title',
        2024,
        'movie',
        null,
        null,
        { extraTitles: [] }
      ));

      const searches = stub.requests.filter((request) => testCase.searchUrl.test(request.url));
      assert.ok(searches.length >= 2, `${testCase.name} searches both titles (saw ${searches.length})`);

      const spread = searches[1].at - searches[0].at;
      assert.ok(
        spread < CONCURRENT_WINDOW_MS,
        `${testCase.name} should issue both title searches together (${spread}ms apart, stub latency ${STUB_LATENCY_MS}ms)`
      );
    } finally {
      stub.restore();
    }
  }
}

// --- SoloLatino: handshake and page load in parallel ------------------------

const MATCH_HTML = `<html><head><title>Test 2024</title><meta name="csrf-token" content="tok"></head>
<body><a href="https://sololatino.net/pelicula/test-2024" title="Test 2024">Test 2024</a></body></html>`;

// The Sanctum handshake and the content page share no data, so the page load has no
// reason to queue behind the handshake.
async function testSololatinoHandshakeOverlapsPageLoad() {
  const stub = stubFetch((target) => {
    if (target.includes('/sanctum/csrf-cookie')) {
      return new Response('{}', {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Set-Cookie': 'XSRF-TOKEN=xyz; Path=/' }
      });
    }
    return new Response(MATCH_HTML, { status: 200, headers: { 'Content-Type': 'text/html' } });
  });

  try {
    const sololatino = require('./src/scrapers/sololatino');
    await withQuietLogs(() => sololatino.scrape('Test', 'Test', 2024, 'movie', null, null, { extraTitles: [] }));

    const handshake = stub.requests.find((request) => request.url.includes('/sanctum/csrf-cookie'));
    const page = stub.requests.find((request) => request.url.includes('/pelicula/test-2024'));

    assert.ok(handshake, 'the Sanctum handshake is made');
    assert.ok(page, 'the content page is fetched');

    const spread = Math.abs(page.at - handshake.at);
    assert.ok(
      spread < CONCURRENT_WINDOW_MS,
      `handshake and page load should overlap (${spread}ms apart, stub latency ${STUB_LATENCY_MS}ms)`
    );
  } finally {
    stub.restore();
  }
}

// --- Orchestrator: alternative titles must not gate the scrapers -------------

const ALTERNATIVE_TITLES_MAX_WAIT_MS = constant('ALTERNATIVE_TITLES_MAX_WAIT_MS');

/**
 * Loads a fresh orchestrator whose sources record when they were invoked, with a
 * TMDB stub whose translations lookup never answers.
 */
function loadOrchestratorWithStalledTitles(startedAt) {
  for (const key of Object.keys(require.cache)) {
    if (key.includes(path.join('src', 'scrapers')) || key.includes(path.join('src', 'tmdb'))) {
      delete require.cache[key];
    }
  }

  const sourceNames = ['./sololatino', './cinecalidad', './tioplus', './cuevana3i', './lamovie', './pelispedia'];
  const Module = require('module');
  const originalLoad = Module._load;

  Module._load = function patched(request, parent) {
    if (parent && parent.filename === ORCHESTRATOR) {
      if (sourceNames.includes(request)) {
        return {
          scrape: async () => {
            startedAt.push(Date.now());
            return [{ name: 'Stub', title: 'Stub', url: 'https://cdn-stub.example/master.m3u8' }];
          }
        };
      }
      if (request === '../tmdb') {
        return {
          getMetaDetails: async () => ({
            name: 'Test Title', originalTitle: 'Test Title', releaseInfo: '2024', imdb_id: 'tt1'
          }),
          findByImdbId: async () => null,
          // Never settles: the failure mode this bounds is a TMDB call that hangs
          // until its own 5s deadline while nothing else is allowed to start.
          getAlternativeTitles: () => new Promise(() => {})
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

async function testStalledAlternativeTitlesDoNotBlockScrapers() {
  const scraperStarts = [];
  const orchestrator = loadOrchestratorWithStalledTitles(scraperStarts);

  const startedAt = Date.now();
  // Without the bound, the stalled lookup is awaited outright and this never
  // returns. Racing a deadline turns that regression into a failed assertion
  // rather than a test run that hangs.
  const HANG_GUARD_MS = ALTERNATIVE_TITLES_MAX_WAIT_MS + 20000;
  const streams = await withQuietLogs(() => Promise.race([
    orchestrator.getStreams('movie', 'tmdb:movie:900', null, null),
    delay(HANG_GUARD_MS).then(() => null)
  ]));

  assert.ok(
    streams !== null,
    `the request must not stall on the alternative-titles lookup (still waiting after ${HANG_GUARD_MS}ms)`
  );
  assert.ok(scraperStarts.length > 0, 'the scrapers are invoked');
  const firstScraperDelay = Math.min(...scraperStarts) - startedAt;

  assert.ok(scraperStarts.length > 0, 'the scrapers still run');
  assert.ok(streams.length > 0, 'streams are still returned without the alternative titles');
  assert.ok(
    firstScraperDelay < ALTERNATIVE_TITLES_MAX_WAIT_MS + 500,
    `scrapers must start within the ${ALTERNATIVE_TITLES_MAX_WAIT_MS}ms title budget (waited ${firstScraperDelay}ms)`
  );
  assert.ok(
    firstScraperDelay >= ALTERNATIVE_TITLES_MAX_WAIT_MS - 100,
    `the wait should be the configured budget, not zero (waited ${firstScraperDelay}ms)`
  );
}

(async () => {
  const tests = [
    testPriorityOrderWinsOverArrivalOrder,
    testFallsBackToLaterTitle,
    testSearchesRunConcurrently,
    testFailureOnUnconsultedTitleIsAbsorbed,
    testFailureOnConsultedTitlePropagates,
    testScrapersSearchBothTitlesConcurrently,
    testSololatinoHandshakeOverlapsPageLoad,
    testStalledAlternativeTitlesDoNotBlockScrapers
  ];

  for (const test of tests) {
    await test();
    console.log(`ok - ${test.name}`);
  }

  console.log('Search latency tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

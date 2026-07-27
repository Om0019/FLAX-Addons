const assert = require('assert');
const http = require('http');

// Covers the work that repeats — per proxy hop, per candidate mirror, per cache
// write, per landing-page request — where the cost is paid over and over rather
// than once per lookup.

assert.notStrictEqual(
  process.env.ALLOW_PRIVATE_PROXY_TARGETS, '1',
  'these tests must run with ALLOW_PRIVATE_PROXY_TARGETS unset'
);

const dns = require('node:dns').promises;
const netGuard = require('./src/net-guard');
const { assertPublicUrl } = netGuard;
const { createTtlCache } = require('./src/ttl-cache');
const { firstResultInOrder } = require('./src/concurrency');

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Replaces dns.lookup for the duration of `run`, counting calls. net-guard holds
 * the promises API object rather than the function, so patching the property is
 * enough.
 */
async function withStubbedDns(answers, run) {
  const realLookup = dns.lookup;
  const lookups = [];

  dns.lookup = async (host) => {
    lookups.push(host);
    await delay(10);
    const addresses = answers[host];
    if (!addresses) {
      const error = new Error(`getaddrinfo ENOTFOUND ${host}`);
      error.code = 'ENOTFOUND';
      throw error;
    }
    return addresses;
  };

  netGuard.__test.dnsCache.clear();
  netGuard.__test.inFlightLookups.clear();

  try {
    return await run(lookups);
  } finally {
    dns.lookup = realLookup;
    netGuard.__test.dnsCache.clear();
    netGuard.__test.inFlightLookups.clear();
  }
}

const PUBLIC_ANSWER = { 'cdn.example.com': [{ address: '93.184.216.34', family: 4 }] };

// Playback asks the guard once per HLS segment. Resolving every time put a
// getaddrinfo on the libuv threadpool for each one.
async function testRepeatedHopsResolveOnce() {
  await withStubbedDns(PUBLIC_ANSWER, async (lookups) => {
    for (let i = 0; i < 5; i += 1) {
      await assertPublicUrl(`https://cdn.example.com/segment-${i}.ts`);
    }

    assert.strictEqual(lookups.length, 1, `five hops to one host should resolve once (resolved ${lookups.length}x)`);
  });
}

// A burst of segment requests on a cold cache must not each start their own lookup.
async function testConcurrentHopsShareOneLookup() {
  await withStubbedDns(PUBLIC_ANSWER, async (lookups) => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => assertPublicUrl(`https://cdn.example.com/burst-${i}.ts`))
    );

    assert.strictEqual(lookups.length, 1, `a concurrent burst should share one lookup (resolved ${lookups.length}x)`);
  });
}

// The cache holds addresses, never verdicts: the block-list still runs per request.
async function testCachedAddressesAreStillJudged() {
  await withStubbedDns({ 'rebind.example.com': [{ address: '93.184.216.34', family: 4 }] }, async () => {
    await assert.doesNotReject(() => assertPublicUrl('https://rebind.example.com/a.ts'));

    // Same host, now cached — but poisoned to a link-local address, standing in for
    // a resolution that should never be trusted.
    netGuard.__test.dnsCache.clear();
    netGuard.__test.dnsCache.set('rebind.example.com', [{ address: '169.254.169.254', family: 4 }], 30000);

    await assert.rejects(
      () => assertPublicUrl('https://rebind.example.com/b.ts'),
      /Blocked address/,
      'a cached resolution must still be run through the block list'
    );
  });
}

// The escape hatch for anyone who wants the pre-cache behaviour back.
async function testCacheCanBeDisabled() {
  process.env.PROXY_DNS_CACHE_TTL_MS = '0';
  try {
    await withStubbedDns(PUBLIC_ANSWER, async (lookups) => {
      await assertPublicUrl('https://cdn.example.com/one.ts');
      await assertPublicUrl('https://cdn.example.com/two.ts');

      assert.strictEqual(lookups.length, 2, 'TTL 0 must resolve every hop');
    });
  } finally {
    delete process.env.PROXY_DNS_CACHE_TTL_MS;
  }
}

// A failed resolution must not be pinned: it is cheap to retry and hosts recover.
async function testFailuresAreNotCached() {
  await withStubbedDns({}, async (lookups) => {
    await assert.rejects(() => assertPublicUrl('https://gone.example.com/a.ts'), /Could not resolve host/);
    await assert.rejects(() => assertPublicUrl('https://gone.example.com/b.ts'), /Could not resolve host/);

    assert.strictEqual(lookups.length, 2, 'a failed lookup is retried, not cached');
  });
}

// --- firstResultInOrder -----------------------------------------------------

// Candidates are ranked before they are tried, so the ranking has to decide the
// winner — not whichever host happens to answer first.
async function testMirrorPriorityBeatsArrivalOrder() {
  const result = await firstResultInOrder(['best', 'worst'], 3, async (item) => {
    if (item === 'worst') return 'worst-url';
    await delay(60);
    return 'best-url';
  });

  assert.strictEqual(result, 'best-url', 'the higher-ranked mirror wins even when it answers later');
}

async function testFallsThroughFailedMirrors() {
  const attempted = [];
  const result = await firstResultInOrder(['a', 'b', 'c'], 3, async (item) => {
    attempted.push(item);
    if (item === 'c') return 'c-url';
    if (item === 'b') throw new Error('mirror exploded');
    return null;
  });

  assert.strictEqual(result, 'c-url', 'a failing mirror does not end the chain');
  assert.strictEqual(await firstResultInOrder(['a'], 3, async () => null), null, 'all-failed yields null');
}

async function testConcurrencyIsBounded() {
  let inFlight = 0;
  let peak = 0;
  const concurrency = 3;

  await firstResultInOrder(Array.from({ length: 9 }, (_, i) => i), concurrency, async () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await delay(30);
    inFlight -= 1;
    return null;
  });

  assert.ok(peak <= concurrency, `at most ${concurrency} mirrors in flight (peaked at ${peak})`);
  assert.ok(peak > 1, `mirrors should actually overlap (peaked at ${peak})`);
}

// Overlapping must not mean resolving mirrors nobody will look at.
async function testStopsStartingMirrorsOnceOneSucceeds() {
  const started = [];
  const items = Array.from({ length: 12 }, (_, i) => i);

  const result = await firstResultInOrder(items, 2, async (item) => {
    started.push(item);
    await delay(20);
    return item === 0 ? 'first-url' : null;
  });

  assert.strictEqual(result, 'first-url');
  assert.ok(
    started.length < items.length,
    `remaining mirrors must not all be started (started ${started.length} of ${items.length})`
  );
}

// --- TTL cache --------------------------------------------------------------

function testCacheStillBoundsAndExpires() {
  const cache = createTtlCache({ maxEntries: 10 });

  for (let i = 0; i < 100; i += 1) {
    cache.set(`key-${i}`, i, 60000);
  }
  assert.ok(cache.size <= 10, `entry cap is enforced on write (size ${cache.size})`);

  // An expired entry is gone on read even when no sweep has run.
  cache.set('short', 'value', 1);
  assert.strictEqual(cache.get('short'), 'value');
  return delay(20).then(() => {
    assert.strictEqual(cache.get('short'), undefined, 'expired entries are dropped lazily on read');

    // An explicit prune sweeps immediately regardless of when the last sweep ran.
    const sweepable = createTtlCache({ maxEntries: 1000 });
    sweepable.set('gone', 1, 1);
    sweepable.set('kept', 2, 60000);
    return delay(20).then(() => {
      sweepable.prune();
      assert.strictEqual(sweepable.size, 1, 'prune() removes expired entries on demand');
      assert.strictEqual(sweepable.get('kept'), 2, 'and leaves live ones');
    });
  });
}

// --- Landing page -----------------------------------------------------------

function get(port, path, headers = {}) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks).toString()));
    });
  });
}

// The page is cached per origin, so the cache key has to actually carry the origin
// — a page served to one host must never be handed to another.
async function testLandingPageIsPerOrigin() {
  const app = require('./src/server');
  const server = await new Promise((resolve) => {
    const created = http.createServer(app);
    created.listen(0, () => resolve(created));
  });

  try {
    const port = server.address().port;
    const first = await get(port, '/', { Host: 'one.example' });
    const repeat = await get(port, '/', { Host: 'one.example' });
    const other = await get(port, '/', { Host: 'two.example' });

    assert.ok(first.includes('http://one.example/manifest.json'), 'the page names the requesting origin');
    assert.strictEqual(repeat, first, 'a repeat request for the same origin is byte-identical');
    assert.ok(other.includes('http://two.example/manifest.json'), 'a different host gets its own page');
    assert.ok(!other.includes('one.example'), 'and never the previous origin');
  } finally {
    server.close();
  }
}

(async () => {
  const tests = [
    testRepeatedHopsResolveOnce,
    testConcurrentHopsShareOneLookup,
    testCachedAddressesAreStillJudged,
    testCacheCanBeDisabled,
    testFailuresAreNotCached,
    testMirrorPriorityBeatsArrivalOrder,
    testFallsThroughFailedMirrors,
    testConcurrencyIsBounded,
    testStopsStartingMirrorsOnceOneSucceeds,
    testCacheStillBoundsAndExpires,
    testLandingPageIsPerOrigin
  ];

  for (const test of tests) {
    await test();
    console.log(`ok - ${test.name}`);
  }

  console.log('Hot path tests passed');
})().then(() => process.exit(0)).catch((error) => {
  console.error(error);
  process.exit(1);
});

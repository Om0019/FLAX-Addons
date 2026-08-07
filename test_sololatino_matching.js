const assert = require('assert');
const sololatino = require('./src/scrapers/sololatino');

const {
  scoreCandidate,
  extractPageIdentityText,
  pageHasRequestedYear,
  buildFallbackUrls
} = sololatino.__test;

assert.strictEqual(
  scoreCandidate({
    url: 'https://sololatino.net/pelicula/supergirl',
    title: 'Pelicula Supergirl 1984'
  }, 'Supergirl', 'Supergirl', 2026),
  0,
  'SoloLatino must reject explicit wrong-year movie search results'
);

assert(pageHasRequestedYear('<h1>Supergirl 2026</h1>', 2026), 'page with target year is accepted');
assert.strictEqual(
  pageHasRequestedYear('<title>Ver Supergirl (1984) Online</title><script>const year = 2026;</script>', 2026),
  false,
  'fallback page with wrong identity year is rejected even if chrome/script contains the requested year'
);
assert.strictEqual(
  extractPageIdentityText('<title>Ver Supergirl (1984) Online</title><h1>Supergirl</h1>').includes('1984'),
  true,
  'identity extraction includes title metadata'
);

assert.deepStrictEqual(
  buildFallbackUrls('movie', 'Supergirl', 'Supergirl: Woman of Tomorrow').map((item) => item.url),
  [
    'https://sololatino.net/pelicula/supergirl',
    'https://sololatino.net/pelicula/supergirl-woman-of-tomorrow'
  ],
  'fallback URLs include title and original title candidates'
);

// A 403 is about the caller, not the title. It used to read as "no results", so
// the scraper went on to guess URLs on the same origin and probe each one — four
// requests and about five seconds of the orchestrator's budget to be told the same
// thing four times, on every request, for as long as the block lasted.
async function testRefusalStopsAfterTheFirstRequest() {
  const { refusalCache, REFUSAL_KEY } = sololatino.__test;
  const realFetch = global.fetch;
  const requested = [];

  refusalCache.clear();
  global.fetch = async (url) => {
    requested.push(String(url));
    return new Response('<html>Forbidden</html>', { status: 403 });
  };

  try {
    const streams = await sololatino.scrape('El Padrino', 'The Godfather', 1972, 'movie', null, null, {});
    assert.deepStrictEqual(streams, [], 'a refused host yields no streams');
    assert.ok(
      requested.every((url) => url.includes('/buscar')),
      `a refused search must not go on to probe fallback URLs, saw ${JSON.stringify(requested)}`
    );

    // The refusal is remembered, so the next lookup costs nothing at all.
    const before = requested.length;
    const second = await sololatino.scrape('Otra Pelicula', 'Another Movie', 2001, 'movie', null, null, {});
    assert.deepStrictEqual(second, [], 'the remembered refusal short-circuits the source');
    assert.strictEqual(requested.length, before, 'a remembered refusal makes no requests at all');
    assert.strictEqual(refusalCache.get(REFUSAL_KEY), 403, 'the refusing status is what gets remembered');
  } finally {
    global.fetch = realFetch;
    refusalCache.clear();
  }
}

// A 404 is a real answer about a real title, so it must not disable the source.
async function testNotFoundIsNotTreatedAsRefusal() {
  const { refusalCache, REFUSAL_KEY } = sololatino.__test;
  const realFetch = global.fetch;

  refusalCache.clear();
  global.fetch = async () => new Response('<html>Nothing here</html>', { status: 404 });

  try {
    await sololatino.scrape('Nonexistent Film', 'Nonexistent Film', 2050, 'movie', null, null, {});
    assert.strictEqual(
      refusalCache.get(REFUSAL_KEY),
      undefined,
      'a 404 says the title is missing, not that the host is refusing us'
    );
  } finally {
    global.fetch = realFetch;
    refusalCache.clear();
  }
}

// Cloudflare scores requests on how complete their headers look, so the shape the
// User-Agent claims to be has to be the shape the request actually has.
function testSearchSendsBrowserShapedHeaders() {
  const headers = sololatino.__test.browserHeaders('UA/1.0');
  for (const header of ['Accept', 'Accept-Language', 'Sec-Fetch-Mode', 'User-Agent']) {
    assert.ok(headers[header], `browser-shaped requests carry ${header}`);
  }
}

async function main() {
  testSearchSendsBrowserShapedHeaders();
  await testRefusalStopsAfterTheFirstRequest();
  await testNotFoundIsNotTreatedAsRefusal();
  console.log('SoloLatino matching tests passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

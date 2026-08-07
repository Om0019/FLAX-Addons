// Selection tests: which of the collected streams actually reach the viewer.
//
// MIN_CONFIRMED_STREAMS ends validation early so the response stays fast. It used
// to end the result set too — probes still in flight were aborted and their streams
// discarded, so a lookup that found more working links than the threshold handed
// back exactly the threshold. These drive the orchestrator with stub sources and
// real local origins so the verdicts are deterministic.

(typeof process !== "undefined" && process.env ? process.env.ALLOW_PRIVATE_PROXY_TARGETS : undefined) = '1';

const assert = require('assert');
const http = require('http');
const path = require('path');

const ORCHESTRATOR = path.join(__dirname, 'src', 'scrapers', 'index.js');

const orchestratorSource = require('fs').readFileSync(ORCHESTRATOR, 'utf8');
const constant = (name) => {
  const match = orchestratorSource.match(new RegExp(`const ${name} = (\\d+);`));
  assert.ok(match, `${name} should be defined`);
  return parseInt(match[1], 10);
};
const MIN_CONFIRMED_STREAMS = constant('MIN_CONFIRMED_STREAMS');
// The longest a probe can wait, whichever phase started it: a "slow" path below has
// to outlast even that to count as one the probe never hears back from.
const LONGEST_PROBE_MS = Math.max(
  constant('STREAM_VALIDATION_EAGER_TIMEOUT_MS'),
  constant('STREAM_VALIDATION_TOTAL_TIMEOUT_MS')
);

/**
 * An origin serving three kinds of path:
 *   /good/<n>  immediately valid HLS
 *   /slow/<n>  valid HLS, but not until after the probe deadline
 *   /bad/<n>   404, a definitive "not playable"
 */
function startOrigin() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bad/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('gone');
      return;
    }

    const send = () => {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunk.m3u8\n');
    };

    if (req.url.startsWith('/slow/')) {
      setTimeout(send, LONGEST_PROBE_MS * 3).unref();
      return;
    }

    send();
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function stubScraper(label, urls) {
  return {
    scrape: async () => urls.map((url, index) => ({
      name: label,
      title: `${label} ${index + 1}`,
      url
    }))
  };
}

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

  Module._load = function patched(request, parent) {
    if (parent && parent.filename === ORCHESTRATOR) {
      if (names[request]) return stubs[names[request]] || stubScraper(names[request], []);
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

// Enough good streams to trip the early exit, plus one that is still being probed
// when it fires. The slow one has not failed anything — it must survive.
//
// Exercised directly against validatePlayableStreams rather than through the full
// getStreams orchestrator: curateNonAiostreams (src/curate.js, tested separately
// in test_curate.js) caps a request's non-AIOStreams streams to 3 total, one per
// scraper - going through getStreams here would mean this test's 4 sources
// (3 good + 1 slow) could never all survive regardless of whether validation
// itself preserved the unproven one, which is not what this test is about.
async function testUnprovenStreamsSurviveTheEarlyExit() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;
  const goodUrls = Array.from({ length: MIN_CONFIRMED_STREAMS }, (_, i) => `${origin}/good/${i}/master.m3u8`);
  const slowUrl = `${origin}/slow/0/master.m3u8`;

  try {
    const { __test } = require(ORCHESTRATOR);
    const rawStreams = [...goodUrls, slowUrl].map((url, i) => ({ name: 'Test', title: `Test ${i}`, url }));
    const controller = new AbortController();
    const validator = __test.createStreamValidator(controller.signal, () => {});

    const selected = await __test.validatePlayableStreams(
      rawStreams.map(__test.sanitizeStream).filter(Boolean),
      validator,
      controller,
      8000
    );
    const urls = selected.map((stream) => stream.url);

    for (const url of goodUrls) {
      assert.ok(urls.includes(url), `confirmed stream ${url} is returned`);
    }
    assert.ok(
      urls.includes(slowUrl),
      'a stream whose probe was still running is kept rather than discarded'
    );
    assert.strictEqual(
      urls.length,
      goodUrls.length + 1,
      'every collected stream that was not disproven is offered'
    );
    // Kept, but behind the proven ones. A final sort on host score alone used to
    // float unproven streams back to the top, which is where viewers click first.
    assert.strictEqual(
      urls[urls.length - 1],
      slowUrl,
      'an unproven stream is offered after every confirmed one'
    );
  } finally {
    server.close();
  }
}

// The other half of the contract: a stream that genuinely failed its probe stays
// out, so keeping the unproven ones does not mean keeping the dead ones.
async function testFailedStreamsAreStillDropped() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;
  const goodUrl = `${origin}/good/0/master.m3u8`;
  const badUrls = [`${origin}/bad/0/master.m3u8`, `${origin}/bad/1/master.m3u8`];

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [goodUrl]),
      Cuevana3i: stubScraper('Cuevana3i', badUrls)
    });

    const urls = (await orchestrator.getStreams('movie', 'tmdb:movie:2', null, null))
      .map((stream) => stream.url);

    assert.ok(urls.includes(goodUrl), 'the playable stream is returned');
    for (const url of badUrls) {
      assert.ok(!urls.includes(url), `a stream that failed validation (${url}) is dropped`);
    }
  } finally {
    server.close();
  }
}

// When every probe fails, the candidates are handed back anyway: validation has
// false negatives, and an empty list is the worse answer.
async function testAllFailedFallsBackToCandidates() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;
  const badUrls = [`${origin}/bad/0/master.m3u8`, `${origin}/bad/1/master.m3u8`];

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', badUrls)
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:3', null, null);
    // Both candidates are from the same scraper, so curateNonAiostreams
    // (src/curate.js) keeps only one of them - the wipeout fallback still
    // has to go through the same per-scraper cap as everything else.
    assert.strictEqual(streams.length, 1, 'a candidate survives a total validation wipeout');
  } finally {
    server.close();
  }
}

// A playlist is not always announced by its path. Several hosts serve one from an
// extensionless URL and say so only in the content type; judging by extension
// alone recorded those as unplayable.
async function testExtensionlessManifestIsPlayable() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;
  const bareUrl = `${origin}/good/0`;
  const badUrl = `${origin}/bad/0/master.m3u8`;

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [bareUrl]),
      Cuevana3i: stubScraper('Cuevana3i', [badUrl])
    });

    // The dead stream is the discriminator. If the manifest is judged playable it
    // is confirmed and the 404 is dropped, leaving one. If it is not, nothing
    // validates, the total-failure fallback returns both, and this fails.
    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:4', null, null);
    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [bareUrl],
      'a manifest identified only by its content type is confirmed playable'
    );
  } finally {
    server.close();
  }
}

// The same routing bug in the other direction: a `.m3u8` in a query string is not
// a playlist, and must not send an MP4 down the playlist path to be judged on a
// #EXTM3U it will never contain.
async function testM3u8InQueryStringIsNotTreatedAsManifest() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/bad/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('gone');
      return;
    }
    res.writeHead(200, { 'content-type': 'video/mp4' });
    res.end('\x00\x00\x00\x18ftypmp42');
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = `${origin}/video.mp4?fallback=old.m3u8`;
    const badUrl = `${origin}/bad/0.mp4`;

    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [url]),
      Cuevana3i: stubScraper('Cuevana3i', [badUrl])
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:5', null, null);
    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [url],
      'the mp4 is confirmed as video rather than failed for a missing #EXTM3U'
    );
  } finally {
    server.close();
  }
}

/**
 * A master playlist that loads is not yet a stream that plays. turboviplay serves
 * masters happily while the variant hosts they name are gone, so the stream ranked
 * near the top of the list and then played nothing.
 */
async function testMasterPlaylistWithDeadVariantIsRejected() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dead-variant/')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('gone');
      return;
    }
    if (req.url.startsWith('/live-variant/')) {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:6.000,\nsegment001.ts\n');
      return;
    }

    const variant = req.url.includes('dead') ? '/dead-variant/index.m3u8' : '/live-variant/index.m3u8';
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=1280x720\n${variant}\n`);
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const deadMaster = `${origin}/dead/master.m3u8`;
    const liveMaster = `${origin}/live/master.m3u8`;

    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [deadMaster]),
      Cuevana3i: stubScraper('Cuevana3i', [liveMaster])
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:6', null, null);
    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [liveMaster],
      'the master whose variant 404s is dropped; the one whose variant loads is kept'
    );
  } finally {
    server.close();
  }
}

/**
 * The deeper probe must not invent failures: a variant that is merely slow leaves
 * the stream unproven rather than rejected, which is what keeps it in the list.
 */
async function testSlowVariantDoesNotRejectTheMaster() {
  const stalled = [];
  const server = http.createServer((req, res) => {
    // Never answered: the variant probe has to give up on its own deadline.
    if (req.url.startsWith('/slow-variant/')) {
      stalled.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n/slow-variant/index.m3u8\n');
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const master = `${origin}/master.m3u8`;

    const orchestrator = loadOrchestratorWith({ LaMovie: stubScraper('LaMovie', [master]) });
    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:7', null, null);

    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [master],
      'a variant that times out is inconclusive, so the master survives'
    );
  } finally {
    stalled.forEach((res) => res.destroy());
    server.close();
  }
}

/**
 * turboviplay answers for files it no longer has with `#EXTM3U\n#EXT-X-VERSION:6`
 * and nothing else. It is a well-formed, empty playlist: it names no variants and
 * no segments, so there is nothing to play, but treating the #EXTM3U header alone
 * as proof of life confirmed it and put it at the top of the list.
 */
/**
 * A gateway error on the variant is about the variant: the master just loaded over
 * the same route. Treating 5xx as inconclusive let exactly the streams this probe
 * exists to catch survive it.
 */
async function testVariantGatewayErrorRejectsTheMaster() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/dead-variant/')) {
      res.writeHead(503, { 'content-type': 'text/plain' });
      res.end('upstream connect error');
      return;
    }
    if (req.url.startsWith('/rate-limited-variant/')) {
      res.writeHead(429, { 'content-type': 'text/plain' });
      res.end('slow down');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    const variant = req.url.includes('gateway') ? '/dead-variant/i.m3u8' : '/rate-limited-variant/i.m3u8';
    res.end(`#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\n${variant}\n`);
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const gatewayUrl = `${origin}/gateway/master.m3u8`;
    const rateLimitedUrl = `${origin}/ratelimited/master.m3u8`;

    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [gatewayUrl]),
      Cuevana3i: stubScraper('Cuevana3i', [rateLimitedUrl])
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:10', null, null);
    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [rateLimitedUrl],
      'a 503 variant rejects its master; a 429 one is transient and survives'
    );
  } finally {
    server.close();
  }
}

async function testEmptyPlaylistIsRejected() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    if (req.url.startsWith('/empty/')) {
      res.end('#EXTM3U\n#EXT-X-VERSION:6\n');
      return;
    }
    res.end('#EXTM3U\n#EXTINF:6.000,\nsegment001.ts\n');
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const emptyUrl = `${origin}/empty/master.m3u8`;
    const realUrl = `${origin}/real/master.m3u8`;

    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [emptyUrl]),
      Cuevana3i: stubScraper('Cuevana3i', [realUrl])
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:8', null, null);
    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [realUrl],
      'a playlist naming neither variants nor segments is dropped'
    );
  } finally {
    server.close();
  }
}

/**
 * The emptiness check must only fire on a body we read to the end. Probes read a
 * fixed window, and a playlist can legitimately open with a long run of
 * #EXT-X-MEDIA renditions before its first #EXT-X-STREAM-INF.
 */
async function testLongHeaderPlaylistIsNotJudgedEmpty() {
  const renditions = Array.from({ length: 40 }, (_, i) => (
    `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="Track ${i}",LANGUAGE="es-${i}",URI="audio/${i}/index.m3u8"`
  )).join('\n');
  const playlist = `#EXTM3U\n${renditions}\n#EXT-X-STREAM-INF:BANDWIDTH=1280000\nvariant/index.m3u8\n`;
  assert.ok(playlist.length > 2048, 'fixture must overflow the probe window to be meaningful');

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(playlist);
  });
  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const url = `${origin}/master.m3u8`;

    const orchestrator = loadOrchestratorWith({ LaMovie: stubScraper('LaMovie', [url]) });
    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:9', null, null);

    assert.deepStrictEqual(
      streams.map((stream) => stream.url),
      [url],
      'a playlist whose entries fall outside the probe window is not called empty'
    );
  } finally {
    server.close();
  }
}

async function run() {
  const tests = [
    ['Unproven streams survive the early exit', testUnprovenStreamsSurviveTheEarlyExit],
    ['Failed streams are still dropped', testFailedStreamsAreStillDropped],
    ['Total validation failure falls back to candidates', testAllFailedFallsBackToCandidates],
    ['Extensionless manifest is playable', testExtensionlessManifestIsPlayable],
    ['m3u8 in a query string is not a manifest', testM3u8InQueryStringIsNotTreatedAsManifest],
    ['Master playlist with a dead variant is rejected', testMasterPlaylistWithDeadVariantIsRejected],
    ['Slow variant does not reject the master', testSlowVariantDoesNotRejectTheMaster],
    ['Variant gateway error rejects the master', testVariantGatewayErrorRejectsTheMaster],
    ['Empty playlist is rejected', testEmptyPlaylistIsRejected],
    ['Long-header playlist is not judged empty', testLongHeaderPlaylistIsNotJudgedEmpty]
  ];

  for (const [label, test] of tests) {
    await test();
    console.log(`ok - ${label}`);
  }

  console.log('\nStream selection tests passed');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

// Selection tests: which of the collected streams actually reach the viewer.
//
// MIN_CONFIRMED_STREAMS ends validation early so the response stays fast. It used
// to end the result set too — probes still in flight were aborted and their streams
// discarded, so a lookup that found more working links than the threshold handed
// back exactly the threshold. These drive the orchestrator with stub sources and
// real local origins so the verdicts are deterministic.

process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';

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
const STREAM_VALIDATION_TIMEOUT_MS = constant('STREAM_VALIDATION_TIMEOUT_MS');

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
      setTimeout(send, STREAM_VALIDATION_TIMEOUT_MS * 3).unref();
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
async function testUnprovenStreamsSurviveTheEarlyExit() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;
  const goodUrls = Array.from({ length: MIN_CONFIRMED_STREAMS }, (_, i) => `${origin}/good/${i}/master.m3u8`);
  const slowUrl = `${origin}/slow/0/master.m3u8`;

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', goodUrls),
      Cuevana3i: stubScraper('Cuevana3i', [slowUrl])
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:1', null, null);
    const urls = streams.map((stream) => stream.url);

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
    assert.strictEqual(streams.length, badUrls.length, 'candidates survive a total validation wipeout');
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

async function run() {
  const tests = [
    ['Unproven streams survive the early exit', testUnprovenStreamsSurviveTheEarlyExit],
    ['Failed streams are still dropped', testFailedStreamsAreStillDropped],
    ['Total validation failure falls back to candidates', testAllFailedFallsBackToCandidates],
    ['Extensionless manifest is playable', testExtensionlessManifestIsPlayable],
    ['m3u8 in a query string is not a manifest', testM3u8InQueryStringIsNotTreatedAsManifest]
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

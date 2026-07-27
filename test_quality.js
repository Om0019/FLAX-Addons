// Quality tests: what the addon says a stream is worth, and where it got that from.
//
// The manifest half is the part that has to be right — it is the only reading that
// is measured rather than claimed, and it is taken from the body the validation
// probe already fetched, so a parser that silently returns nothing costs the whole
// feature with no other symptom. The rest guard the claims against reading a
// resolution out of a cache key.

process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';

const assert = require('assert');
const http = require('http');
const path = require('path');

const quality = require('./src/quality');
const {
  bestQuality,
  claimedQuality,
  formatQuality,
  qualityFromLabel,
  qualityFromManifest,
  qualityFromUrl,
  qualityRank,
  withQualityLabel
} = quality;

const ORCHESTRATOR = path.join(__dirname, 'src', 'scrapers', 'index.js');

function masterPlaylist(variants, { trailingNewline = true } = {}) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:4'];

  variants.forEach((variant, index) => {
    const attributes = [`BANDWIDTH=${variant.bandwidth}`];
    if (variant.codecs) attributes.push(`CODECS="${variant.codecs}"`);
    if (variant.resolution) attributes.push(`RESOLUTION=${variant.resolution}`);
    lines.push(`#EXT-X-STREAM-INF:${attributes.join(',')}`);
    lines.push(`v${index}/index.m3u8`);
  });

  return lines.join('\n') + (trailingNewline ? '\n' : '');
}

// The whole point of hooking into the probe: RESOLUTION is the host describing its
// own renditions, and the top of the ladder is what the stream is worth.
function testMasterPlaylistResolution() {
  const body = masterPlaylist([
    { bandwidth: 1280000, resolution: '854x480', codecs: 'avc1.4d401f,mp4a.40.2' },
    { bandwidth: 5000000, resolution: '1920x1080', codecs: 'avc1.640028,mp4a.40.2' }
  ]);

  const result = qualityFromManifest(body);
  assert.strictEqual(result.height, 1080, 'the best rendition is the one reported');
  assert.strictEqual(result.source, 'manifest', 'a declared resolution counts as measured');
  assert.strictEqual(formatQuality(result), '1080p');
}

// CODECS carries commas inside its quotes, so anything that splits the attribute
// list on commas loses RESOLUTION on exactly the variants that have codecs listed.
function testCodecsCommasDoNotHideResolution() {
  const body = masterPlaylist([
    { bandwidth: 5000000, codecs: 'avc1.640028,mp4a.40.2', resolution: '1920x1080' }
  ]);

  assert.strictEqual(qualityFromManifest(body).height, 1080, 'quoted commas do not hide RESOLUTION');
}

// AVERAGE-BANDWIDTH ends in BANDWIDTH. Matching it as one would read the average as
// the peak and estimate a rung too low.
function testAverageBandwidthIsNotReadAsBandwidth() {
  const body = '#EXTM3U\n#EXT-X-STREAM-INF:AVERAGE-BANDWIDTH=400000,BANDWIDTH=5000000\nv.m3u8\n';
  const result = qualityFromManifest(body);

  assert.strictEqual(result.source, 'bandwidth', 'no RESOLUTION means the bitrate is all there is');
  assert.strictEqual(result.height, 1080, 'the peak bitrate is what gets bucketed');
}

// A ladder with no RESOLUTION anywhere still says something, but only roughly, and
// the label has to admit it.
function testBandwidthEstimateIsMarkedAsOne() {
  const body = masterPlaylist([{ bandwidth: 2200000 }]);
  const result = qualityFromManifest(body);

  assert.strictEqual(result.height, 720);
  assert.strictEqual(result.estimated, true);
  assert.strictEqual(formatQuality(result), '~720p', 'an estimate is not printed as a measurement');
}

// BANDWIDTH=1 is not 240p video, it is a placeholder. Bucketing it would label
// every stream carrying one.
function testImplausibleBandwidthIsNoReading() {
  assert.strictEqual(
    qualityFromManifest('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nchunk.m3u8\n'),
    null,
    'a bitrate too low for video is not a resolution'
  );
}

// The probe reads a byte range, so the body can stop anywhere. A half-read line
// reports RESOLUTION=1920x10, and a body that was cut off may hide better variants
// below — both have to be visible in the answer.
function testTruncatedManifestIsAFloorNotAFigure() {
  const full = masterPlaylist([
    { bandwidth: 1280000, resolution: '854x480' },
    { bandwidth: 5000000, resolution: '1920x1080' }
  ]);
  const cutMidLine = `${full.slice(0, full.indexOf('RESOLUTION=1920x1080') + 'RESOLUTION=1920x10'.length)}`;

  const partial = qualityFromManifest(cutMidLine, { complete: false });
  assert.strictEqual(partial.height, 480, 'a line that was cut off is not read at all');
  assert.strictEqual(formatQuality(partial), '≥480p', 'a truncated ladder is reported as a floor');

  const complete = qualityFromManifest(full, { complete: true });
  assert.strictEqual(formatQuality(complete), '1080p', 'a whole ladder is reported exactly');
}

// Nothing to find here: a media playlist lists segments, and segments carry no
// dimensions. The answer is "unknown", never a guess.
function testMediaPlaylistYieldsNothing() {
  assert.strictEqual(qualityFromManifest('#EXTM3U\n#EXTINF:10,\nseg0.ts\n'), null);
  assert.strictEqual(qualityFromManifest('#EXTM3U\n'), null);
  assert.strictEqual(qualityFromManifest(''), null);
}

function testUrlClaims() {
  const cases = [
    ['https://host.example/hls/1080/index.m3u8', '1080p'],
    ['https://host.example/movie_720p.mp4', '720p'],
    ['https://host.example/play?res=480', '480p'],
    ['https://host.example/1920x1080/movie.mp4', '1080p'],
    ['https://host.example/4k/movie.m3u8', '2160p'],
    // Boundaries, not substrings: these must all come back unknown.
    ['https://host.example/v/a1080b/master.m3u8', null],
    ['https://host.example/movie.mp4?e=1753894720', null],
    ['https://host.example/good/1/master.m3u8', null]
  ];

  for (const [url, expected] of cases) {
    assert.strictEqual(formatQuality(qualityFromUrl(url)) || null, expected, `${url} reads as ${expected}`);
  }
}

function testLabelClaims() {
  assert.strictEqual(formatQuality(qualityFromLabel('🇲🇽 Latino 1080p')), '1080p');
  // A tier word keeps the site's own wording: "HD" ranks like 720p but was never
  // measured, and printing "720p" would claim it was.
  assert.strictEqual(formatQuality(qualityFromLabel('🇲🇽 HD')), 'HD');
  assert.strictEqual(qualityFromLabel('🇲🇽 HD').height, 720, 'a tier word still has a rank');
  assert.strictEqual(formatQuality(qualityFromLabel('🇲🇽 FULL HD')), 'FHD');
  assert.strictEqual(formatQuality(qualityFromLabel('⬇ CAM')), 'CAM');
  // Server names are not quality claims.
  for (const label of ['🇲🇽 Opcion 1', 'CineHDPlus mirror', '🇲🇽 Latino', 'Servidor 2']) {
    assert.strictEqual(qualityFromLabel(label), null, `${label} claims nothing`);
  }
}

// An explicit resolution outranks a tier word on the same label, because 1080p says
// more than HD and pages carry both.
function testExplicitResolutionBeatsTierWord() {
  assert.strictEqual(formatQuality(qualityFromLabel('HD 1080p Latino')), '1080p');
}

function testMeasurementBeatsClaim() {
  const claimed = qualityFromUrl('https://host.example/1080/index.m3u8');
  const measured = qualityFromManifest(masterPlaylist([{ bandwidth: 2500000, resolution: '1280x720' }]));

  assert.strictEqual(bestQuality(claimed, measured).source, 'manifest', 'the probe wins');
  assert.strictEqual(bestQuality(measured, claimed).source, 'manifest', 'in either order');
  assert.strictEqual(bestQuality(null, claimed), claimed, 'a claim beats nothing');
  assert.strictEqual(bestQuality(null, null), null);
}

function testRanking() {
  const measured1080 = qualityFromManifest(masterPlaylist([{ bandwidth: 5000000, resolution: '1920x1080' }]));
  const claimed1080 = qualityFromUrl('https://host.example/1080/index.m3u8');
  const measured720 = qualityFromManifest(masterPlaylist([{ bandwidth: 2500000, resolution: '1280x720' }]));

  assert.ok(qualityRank(measured1080) > qualityRank(measured720), 'taller ranks higher');
  assert.ok(qualityRank(measured1080) > qualityRank(claimed1080), 'at equal height, evidence breaks the tie');
  assert.ok(qualityRank(claimed1080) > qualityRank(measured720), 'height dominates evidence');
  assert.ok(qualityRank(null) === 0, 'unknown is neutral');
  assert.ok(qualityRank(qualityFromLabel('CAM')) < qualityRank(null), 'a cam sinks below unknown');
}

function testTitleLabelling() {
  const measured = qualityFromManifest(masterPlaylist([{ bandwidth: 5000000, resolution: '1920x1080' }]));

  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 Opcion 1', quality: measured }).title,
    '🇲🇽 Opcion 1 • 1080p',
    'the label is appended to the source and server name, not instead of them'
  );

  // Running twice must not read as "1080p • 1080p".
  const once = withQualityLabel({ title: '🇲🇽 Opcion 1', quality: measured });
  assert.strictEqual(withQualityLabel(once).title, once.title, 'labelling is idempotent');

  // LaMovie hands over its own quality claim. When the ladder actually tops out
  // lower, the measurement replaces the claim rather than sitting next to it.
  const measured720 = qualityFromManifest(masterPlaylist([{ bandwidth: 2500000, resolution: '1280x720' }]));
  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 Latino 1080p', quality: measured720 }).title,
    '🇲🇽 Latino • 720p',
    'a measurement supersedes the claim already in the title'
  );

  // A claim that only restates what the title already says changes nothing.
  const claim = qualityFromLabel('🇲🇽 Latino 1080p');
  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 Latino 1080p', quality: claim }).title,
    '🇲🇽 Latino 1080p',
    'a claim does not rewrite the title it came from'
  );

  const unknown = { title: '🇲🇽 Opcion 1' };
  assert.strictEqual(withQualityLabel(unknown), unknown, 'an unknown quality leaves the stream alone');
}

function testClaimedQualityPrefersTheUrl() {
  const stream = {
    url: 'https://host.example/hls/1080/index.m3u8',
    title: '🇲🇽 HD',
    name: 'SoloLatino'
  };

  const result = claimedQuality(stream);
  assert.strictEqual(result.source, 'url', 'the path beats the page label');
  assert.strictEqual(result.height, 1080);
}

/**
 * An origin that serves a real HLS ladder, so the orchestrator's probe reads a
 * manifest rather than a fixture:
 *   /ladder/…   master with RESOLUTION up to 1080p
 *   /bitrate/…  master with BANDWIDTH only
 *   /media/…    media playlist — playable, quality unknown
 */
function startOrigin() {
  const server = http.createServer((req, res) => {
    const body = req.url.startsWith('/ladder/')
      ? masterPlaylist([
        { bandwidth: 1280000, resolution: '854x480', codecs: 'avc1.4d401f,mp4a.40.2' },
        { bandwidth: 5000000, resolution: '1920x1080', codecs: 'avc1.640028,mp4a.40.2' }
      ])
      : req.url.startsWith('/bitrate/')
        ? masterPlaylist([{ bandwidth: 2200000 }])
        : '#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nseg0.ts\n';

    res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
    res.end(body);
  });

  return new Promise((resolve) => {
    server.listen(0, () => resolve({ server, port: server.address().port }));
  });
}

function stubScraper(label, urls) {
  return {
    scrape: async () => urls.map((url, index) => ({
      name: label,
      title: `🇲🇽 ${label} ${index + 1}`,
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

// End to end: the probe that decides whether a stream plays also reports what it
// is, and that reaches the title Stremio shows.
async function testOrchestratorLabelsProbedStreams() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [`${origin}/ladder/0/master.m3u8`]),
      Cuevana3i: stubScraper('Cuevana3i', [`${origin}/bitrate/0/master.m3u8`]),
      TioPlus: stubScraper('TioPlus', [`${origin}/media/0/index.m3u8`])
    });

    const streams = await orchestrator.getStreams('movie', 'tmdb:movie:quality-1', null, null);
    const byUrl = new Map(streams.map((stream) => [stream.url, stream]));

    const ladder = byUrl.get(`${origin}/ladder/0/master.m3u8`);
    assert.ok(ladder, 'the ladder stream is offered');
    assert.strictEqual(ladder.quality.source, 'manifest', 'the probe measured it');
    assert.ok(ladder.title.endsWith('• 1080p'), `ladder title carries the measurement: ${ladder.title}`);

    const bitrate = byUrl.get(`${origin}/bitrate/0/master.m3u8`);
    assert.ok(bitrate.title.endsWith('• ~720p'), `bitrate title is marked an estimate: ${bitrate.title}`);

    const media = byUrl.get(`${origin}/media/0/index.m3u8`);
    assert.strictEqual(media.quality, undefined, 'a media playlist yields no reading');
    assert.strictEqual(media.title, '🇲🇽 TioPlus 1', 'and no label is invented for it');
  } finally {
    server.close();
  }
}

// A probe that learns nothing must not erase what the URL already said, or a
// single-rendition playlist ends up less informative than an unprobed stream.
async function testProbeWithNoReadingKeepsTheUrlClaim() {
  const { server, port } = await startOrigin();
  const origin = `http://127.0.0.1:${port}`;

  try {
    const orchestrator = loadOrchestratorWith({
      LaMovie: stubScraper('LaMovie', [`${origin}/media/0/1080p/index.m3u8`])
    });

    const [stream] = await orchestrator.getStreams('movie', 'tmdb:movie:quality-2', null, null);
    assert.strictEqual(stream.quality.height, 1080);
    assert.ok(stream.title.endsWith('• 1080p'), `an unmeasured claim is still shown: ${stream.title}`);
  } finally {
    server.close();
  }
}

// Quality orders streams a host score has tied — and only those. Ranking on it
// first would put a claim written into a URL ahead of a stream from a host with a
// better record, which is the wrong way round.
function testQualityOnlyBreaksTies() {
  const { sortStreams } = require('./src/scrapers').__test;

  const low = { url: 'https://acek-cdn.com/480/a.m3u8', quality: qualityFromUrl('https://acek-cdn.com/480/a.m3u8') };
  const high = { url: 'https://acek-cdn.com/1080/b.m3u8', quality: qualityFromUrl('https://acek-cdn.com/1080/b.m3u8') };
  const sorted = sortStreams([low, high]);
  assert.strictEqual(sorted[0].url, high.url, 'the better rendition leads within one host');

  // cdn-tnmr scores worst of the named hosts; a 1080p claim must not lift it above
  // a well-scored host offering 480p.
  const wellScored = { url: 'https://acek-cdn.com/480/a.m3u8', quality: qualityFromUrl('https://acek-cdn.com/480/a.m3u8') };
  const poorlyScored = { url: 'https://cdn-tnmr.org/1080/b.m3u8', quality: qualityFromUrl('https://cdn-tnmr.org/1080/b.m3u8') };
  assert.strictEqual(
    sortStreams([poorlyScored, wellScored])[0].url,
    wellScored.url,
    'host score still decides across hosts'
  );
}

async function run() {
  testMasterPlaylistResolution();
  testCodecsCommasDoNotHideResolution();
  testAverageBandwidthIsNotReadAsBandwidth();
  testBandwidthEstimateIsMarkedAsOne();
  testImplausibleBandwidthIsNoReading();
  testTruncatedManifestIsAFloorNotAFigure();
  testMediaPlaylistYieldsNothing();
  testUrlClaims();
  testLabelClaims();
  testExplicitResolutionBeatsTierWord();
  testMeasurementBeatsClaim();
  testRanking();
  testTitleLabelling();
  testClaimedQualityPrefersTheUrl();
  testQualityOnlyBreaksTies();
  await testOrchestratorLabelsProbedStreams();
  await testProbeWithNoReadingKeepsTheUrlClaim();

  console.log('All quality tests passed.');
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});

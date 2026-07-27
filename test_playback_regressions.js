/**
 * Regressions found while re-testing playback, sources, extractors and the proxy.
 *
 * Each block below reproduces a failure that reached a viewer: a stream that was
 * offered and would not play, a label that contradicted itself, a live host that
 * was thrown away, or a manifest whose rewritten URLs were not URLs at all.
 */
const assert = require('assert');
const http = require('http');

process.env.ALLOW_PRIVATE_PROXY_TARGETS = '1';

const app = require('./src/server');
const unpacker = require('./src/unpacker');
const scrapers = require('./src/scrapers');
const { withQualityLabel, qualityFromManifest, qualityFromLabel, formatQuality } = require('./src/quality');

const { rewriteHlsManifest, getPublicBaseUrl } = app.__test;
const { createStreamValidator, hostHealth, firstVariantUrl } = scrapers.__test;

const PROBE_RANGE_BYTES = 2048;

function fakeReq(host, { forwardedProto, referer = '', ua } = {}) {
  return {
    protocol: 'http',
    query: { referer, ...(ua ? { ua } : {}) },
    get(name) {
      if (name.toLowerCase() === 'host') return host;
      return undefined;
    },
    headers: forwardedProto ? { 'x-forwarded-proto': forwardedProto } : {}
  };
}

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString()
      }));
    }).on('error', reject);
  });
}

/**
 * X-Forwarded-Proto is a list, not a value: every proxy in the chain appends to
 * it, so a deployment behind two of them (a CDN in front of the platform's own
 * ingress, which is the normal shape) sends "https, http". Pasting the whole
 * header in front of :// produced a base URL of "https, http://host", so every
 * URI in a rewritten HLS manifest came back as an unparseable string and nothing
 * proxied would play at all.
 */
function testForwardedProtoListIsNotPastedIntoTheBaseUrl() {
  assert.strictEqual(
    getPublicBaseUrl(fakeReq('addon.example', { forwardedProto: 'https, http' })),
    'https://addon.example',
    'only the first hop of the X-Forwarded-Proto list names the scheme'
  );

  assert.strictEqual(
    getPublicBaseUrl(fakeReq('addon.example', { forwardedProto: 'https' })),
    'https://addon.example',
    'a single-value header still works'
  );

  // A header nobody sensible sent must not become part of the URL either.
  assert.strictEqual(
    getPublicBaseUrl(fakeReq('addon.example', { forwardedProto: 'javascript:alert(1)' })),
    'http://addon.example',
    'an unrecognised scheme falls back to the connection protocol'
  );

  const rewritten = rewriteHlsManifest(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000\nvariant/index.m3u8\n',
    'https://origin.example/path/master.m3u8',
    fakeReq('addon.example', { forwardedProto: 'https, http', referer: 'https://embed.example/player' })
  );

  for (const line of rewritten.split('\n')) {
    if (!line.includes('/proxy/')) continue;
    assert.doesNotThrow(
      () => new URL(line.trim()),
      `every rewritten manifest line must be a parseable URL, got ${JSON.stringify(line)}`
    );
  }
}

/**
 * The master is fetched with one Referer and its children were handed a
 * different one. Header-sensitive CDNs are the only reason a stream is proxied
 * at all, so a segment arriving with a Referer the master never used is exactly
 * the 403 this proxy exists to avoid — the playlist loads and playback stalls on
 * the first segment.
 */
async function testChildRequestsInheritTheRefererTheMasterUsed() {
  const seenReferers = [];
  const origin = await startServer((req, res) => {
    seenReferers.push({ path: req.url.split('?')[0], referer: req.headers.referer });
    if (req.url.startsWith('/master.m3u8')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:4,\nseg1.ts\n');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end('segment-bytes');
  });
  const proxy = await startServer(app);

  try {
    const originPort = origin.address().port;
    const proxyPort = proxy.address().port;
    const target = `http://127.0.0.1:${originPort}/master.m3u8`;

    // No referer on the link: the route falls back to a default, and the
    // children have to be given that same default.
    const manifest = await get(proxyPort, `/proxy/stream.m3u8?url=${encodeURIComponent(target)}&referer=`);
    assert.strictEqual(manifest.status, 200);

    const childUrl = manifest.body.split('\n').find((line) => line.includes('/proxy/'));
    assert(childUrl, 'the playlist was rewritten');

    const childPath = new URL(childUrl.trim()).pathname + new URL(childUrl.trim()).search;
    await get(proxyPort, childPath);

    const masterReferer = seenReferers.find((entry) => entry.path === '/master.m3u8')?.referer;
    const segmentReferer = seenReferers.find((entry) => entry.path === '/seg1.ts')?.referer;

    assert.strictEqual(
      segmentReferer,
      masterReferer,
      'a segment must be requested with the Referer that got the playlist through'
    );
  } finally {
    origin.close();
    proxy.close();
  }
}

/**
 * A measurement replaces a claim only when the claim was written as digits. The
 * sources spell the same claim in words at least as often — LaMovie labels its
 * options "Latino Full HD" — and those survived, so a 720p ladder was offered to
 * viewers as "Latino Full HD • 720p": the source's claim and the measurement
 * that disproves it, side by side, which is the exact reading this replacement
 * exists to prevent.
 */
function testMeasuredQualityReplacesWordedClaimsToo() {
  const measured = qualityFromManifest(
    '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,RESOLUTION=1280x720\nv.m3u8\n'
  );
  assert.strictEqual(measured.height, 720);

  const cases = [
    ['🇲🇽 Latino Full HD', '🇲🇽 Latino • 720p'],
    ['🇲🇽 Latino FHD', '🇲🇽 Latino • 720p'],
    ['🇲🇽 Servidor HD', '🇲🇽 Servidor • 720p'],
    ['🇲🇽 Opcion SD', '🇲🇽 Opcion • 720p'],
    ['🇲🇽 Latino 1080p', '🇲🇽 Latino • 720p'],
    ['🇲🇽 Latino 4K Opcion 1', '🇲🇽 Latino Opcion 1 • 720p']
  ];

  for (const [title, expected] of cases) {
    assert.strictEqual(
      withQualityLabel({ title, quality: measured }).title,
      expected,
      `a measurement must not be printed next to the claim it contradicts (${title})`
    );
  }

  // A claim never overwrites another claim; there is nothing to prefer about it.
  // It is not restated beside one either — the claim is read straight back out of
  // the title, so appending it turned "Latino Full HD" into "Latino Full HD • FHD".
  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 Latino Full HD', quality: qualityFromLabel('Full HD') }).title,
    '🇲🇽 Latino Full HD',
    'an unmeasured reading leaves the source label alone'
  );
  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 Latino 1080p', quality: qualityFromLabel('Latino 1080p') }).title,
    '🇲🇽 Latino 1080p',
    'and does not restate a resolution already written in the title'
  );

  // With nothing in the title to go on, a claim is still worth printing.
  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 Servidor 2', quality: qualityFromLabel('Full HD') }).title,
    '🇲🇽 Servidor 2 • FHD',
    'a claim from the URL or the server name still reaches the viewer'
  );

  // "HD" inside a server name is not a quality claim and must survive.
  assert.strictEqual(
    withQualityLabel({ title: '🇲🇽 CineHDPlus', quality: measured }).title,
    '🇲🇽 CineHDPlus • 720p',
    'a tier word has to stand alone to count as a claim'
  );
}

/**
 * A master whose header runs past the probe window is read only as far as the
 * range asked for, so the first variant URI can fall outside it. Having no
 * variant to follow was treated as "the variants are unreachable" — a live
 * stream was dropped, and its host recorded as a hard failure, two of which mark
 * the whole CDN dead for three minutes and take every other stream on it down.
 * A truncated read is inconclusive everywhere else in this file, and it has to
 * be here too.
 */
async function testTruncatedMasterIsNotJudgedUnreachable() {
  const streamInf = '#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO="aud"\n';
  let header = '#EXTM3U\n#EXT-X-VERSION:6\n';
  let index = 0;
  while (Buffer.byteLength(header) + streamInf.length < PROBE_RANGE_BYTES) {
    header += `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="l${index}",NAME="Audio ${index} Latino",URI="audio/t${index}.m3u8"\n`;
    index += 1;
  }
  // Land the window boundary in the gap between a variant's attributes and the
  // URI line that follows it.
  const probeWindow = header.slice(0, PROBE_RANGE_BYTES - streamInf.length) + streamInf;
  assert.strictEqual(Buffer.byteLength(probeWindow), PROBE_RANGE_BYTES);
  assert.strictEqual(
    firstVariantUrl(probeWindow, 'https://cdn.example/master.m3u8'),
    null,
    'the window really does end before any variant URI'
  );

  const origin = await startServer((req, res) => {
    if (req.url.startsWith('/master.m3u8')) {
      res.writeHead(206, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(probeWindow);
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n');
  });

  try {
    const port = origin.address().port;
    hostHealth.clear();

    const validator = createStreamValidator(new AbortController().signal);
    const verdict = await validator.validate({
      url: `http://127.0.0.1:${port}/master.m3u8`,
      title: 'Servidor 1'
    });

    assert.strictEqual(
      verdict.playable,
      true,
      'a master read only as far as its header must not be dropped for it'
    );
    const health = hostHealth.get('127.0.0.1');
    assert.notStrictEqual(
      health?.events?.[0]?.outcome,
      'hard-fail',
      'and the host must not be charged a hard failure for a short read'
    );
  } finally {
    hostHealth.clear();
    origin.close();
  }
}

/**
 * The complementary case still has to fail: a master that was read whole and
 * names no variant is naming nothing playable.
 */
async function testCompleteMasterWithNoVariantIsStillRejected() {
  const body = '#EXTM3U\n#EXT-X-VERSION:6\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080\n';
  const origin = await startServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    res.end(body);
  });

  try {
    const port = origin.address().port;
    hostHealth.clear();

    const validator = createStreamValidator(new AbortController().signal);
    const verdict = await validator.validate({
      url: `http://127.0.0.1:${port}/master.m3u8`,
      title: 'Servidor 1'
    });

    assert.strictEqual(
      verdict.playable,
      false,
      'a complete master that names no variant is not a stream'
    );
  } finally {
    hostHealth.clear();
    origin.close();
  }
}

/**
 * DoodStream rebranded to playmogo.com. Every mirror — dood.li, d000d.com,
 * ds2play.com and the rest — answers 301 to playmogo.com/e/<code>, so recognising
 * only the old dood.* names left a source handing over any of the others
 * unrouted. Checked against the live hosts in July 2026.
 */
function testDoodHostRecognitionCoversTheRebrand() {
  const { isDoodHost } = unpacker.__test;

  for (const url of [
    'https://dood.li/e/abc', 'https://dood.to/e/abc', 'https://dood.stream/e/abc',
    'https://dood.re/e/abc', 'https://dood.yt/e/abc',
    'https://d000d.com/e/abc', 'https://d0000d.com/e/abc', 'https://d0o0d.com/e/abc',
    'https://dooood.com/e/abc', 'https://all3do.com/e/abc', 'https://doply.net/e/abc',
    'https://vide0.net/e/abc', 'https://ds2play.com/e/abc', 'https://ds2video.com/e/abc',
    'https://doodstream.com/e/abc', 'https://doodstream.co/e/abc',
    'https://playmogo.com/e/abc'
  ]) {
    assert.strictEqual(isDoodHost(url), true, `${url} is a Dood mirror`);
  }

  // The pattern must not widen into unrelated hosts.
  for (const url of [
    'https://sololatino.net/e/abc', 'https://filemoon.sx/e/abc',
    'https://notdood.example.com/e/abc', 'https://playmogo.com.evil.example/e/abc',
    'https://mydood.org/e/abc'
  ]) {
    assert.strictEqual(isDoodHost(url), false, `${url} is not a Dood mirror`);
  }
}

/**
 * Dood is now gated the same way Filemoon and VOE are, so it belongs where they
 * are: last. Ranked third best it cost every page that listed it a fetch and a
 * resolve timeout against a Cloudflare challenge page, ahead of servers that hand
 * over a stream — and on embed69 it also burned one of MAX_EMBED69_ATTEMPTS.
 */
function testChallengeGatedHostsRankBehindResolvableOnes() {
  const servers = [
    { url: 'https://x/1', server: 'dood' },
    { url: 'https://x/2', server: 'filemoon' },
    { url: 'https://x/3', server: 'vidguard' },
    { url: 'https://x/4', server: 'streamwish' },
    { url: 'https://x/5', server: 'luluvdo' }
  ];

  const html = servers
    .map((entry) => `<div onclick="go_to_playerVast('${entry.url}', 1, 0)"><span>${entry.server}</span></div>`)
    .join('');

  const ordered = unpacker.extractXupalaceServers(html, 'https://xupalace.org/page');
  assert.strictEqual(ordered.length, servers.length, 'every server on the page is picked up');

  // extractXupalaceServers preserves page order; the ranking is what resolve
  // applies, so assert on the comparator's own verdict.
  const rank = (name) => ordered.findIndex((entry) => entry.server === name);
  assert(rank('dood') >= 0, 'dood is still offered, not dropped');

  const { scoreXupalaceServer } = unpacker.__test;
  assert(
    scoreXupalaceServer('dood') > scoreXupalaceServer('vidguard'),
    'dood is attempted after hosts that resolve'
  );
  assert.strictEqual(
    scoreXupalaceServer('dood'),
    scoreXupalaceServer('filemoon'),
    'dood sits with the other challenge-gated hosts'
  );
  assert.strictEqual(
    scoreXupalaceServer('playmogo'),
    scoreXupalaceServer('filemoon'),
    'and so does the name it rebranded to'
  );
}

/**
 * RESOLUTION names the encoded frame, and encoders reach a ladder rung from either
 * side. These are the shapes the live sources are actually serving, taken off real
 * masters in July 2026: 1920x1040 and 1920x968 keep the rung's width and crop the
 * height, 1432x720 and 1280x674 keep the height and widen the frame. Reading the
 * height alone printed "1040p", "968p" and "674p" — labels naming no rung a viewer
 * or a player recognises — and gave a 1080p-class encode a sort key well below the
 * rung it belongs to.
 */
function testResolutionMapsToTheRungAPlayerWouldName() {
  const manifest = (resolution) => (
    `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=${resolution}\nv.m3u8\n`
  );
  const rung = (resolution) => formatQuality(qualityFromManifest(manifest(resolution)));

  // Observed live.
  assert.strictEqual(rung('1920x1040'), '1080p', 'width-kept scope encode is 1080p');
  assert.strictEqual(rung('1920x968'), '1080p', 'so is a taller matte');
  assert.strictEqual(rung('1280x674'), '720p', 'height-kept scope encode is 720p');
  assert.strictEqual(rung('1432x720'), '720p', 'a widened 720p frame is still 720p');

  // Common scope masterings.
  assert.strictEqual(rung('1920x800'), '1080p', '2.40:1 at full 1080p width is 1080p');
  assert.strictEqual(rung('1920x816'), '1080p');
  assert.strictEqual(rung('1280x536'), '720p');
  assert.strictEqual(rung('3840x1608'), '2160p');

  // Exact rungs must come through untouched.
  for (const [resolution, expected] of [
    ['1920x1080', '1080p'], ['1280x720', '720p'], ['854x480', '480p'],
    ['640x360', '360p'], ['2560x1440', '1440p'], ['3840x2160', '2160p'],
    ['1600x900', '900p'], ['426x240', '240p']
  ]) {
    assert.strictEqual(rung(resolution), expected, `${resolution} is exactly ${expected}`);
  }

  // Taller than 16:9: the width understates these, so the frame's area decides.
  assert.strictEqual(rung('1440x1080'), '1080p', '4:3 HD is 1080p');
  assert.strictEqual(rung('640x480'), '480p', '4:3 SD is 480p');
  assert.strictEqual(rung('1024x768'), '720p', 'XGA is 720p-class, not 576p');

  // And the ranking that follows from it.
  const rank = (resolution) => require('./src/quality').qualityRank(qualityFromManifest(manifest(resolution)));
  assert(
    rank('1920x800') > rank('1280x720'),
    'a 1080p scope encode must outrank a 720p one'
  );
  assert.strictEqual(
    rank('1280x674'), rank('1280x720'),
    'and a letterboxed 720p ranks with the rung it belongs to'
  );
}

/**
 * A probe that ran out of time has not judged the stream — but its verdict was
 * reported the same way a refusal is, and the caller drops whatever comes back
 * false. Measured against the live sources, three of four streams discarded this
 * way were serving a playable manifest moments later on the same tokens. They
 * belong after the confirmed streams, not in the bin.
 */
async function testTimedOutProbesLeaveTheStreamUnproven() {
  const { __test } = scrapers;
  const slow = await startServer((req, res) => {
    if (req.url.startsWith('/slow')) {
      // Headers, then silence: the shape that trips a body deadline.
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.write('#EXTM3U\n');
      return;
    }
    res.writeHead(404).end();
  });

  try {
    const port = slow.address().port;
    hostHealth.clear();

    const validator = __test.createStreamValidator(new AbortController().signal);
    const verdict = await validator.validate({ url: `http://127.0.0.1:${port}/slow.m3u8`, title: 'slow' });

    assert.strictEqual(verdict.playable, false, 'a stalled probe does not confirm the stream');
    assert.strictEqual(
      verdict.conclusive,
      false,
      'but it must not claim to have judged it either'
    );

    // A refusal, by contrast, is a real finding and stays conclusive.
    const refused = await validator.validate({ url: `http://127.0.0.1:${port}/gone.m3u8`, title: 'gone' });
    assert.strictEqual(refused.playable, false);
    assert.strictEqual(refused.conclusive, true, 'a 404 is a verdict');
  } finally {
    hostHealth.clear();
    slow.close();
  }
}

/**
 * And the selection has to act on that distinction: an unverified stream is still
 * offered, ranked behind everything that was confirmed.
 */
async function testUnverifiedStreamsAreStillOffered() {
  const { __test } = scrapers;
  const origin = await startServer((req, res) => {
    if (req.url.startsWith('/good')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n');
      return;
    }
    if (req.url.startsWith('/stalls')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.write('#EXTM3U\n');
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/html' }).end('<html>gone</html>');
  });

  try {
    const port = origin.address().port;
    hostHealth.clear();

    const streams = [
      { name: 'A', title: 'good', url: `http://127.0.0.1:${port}/good.m3u8` },
      { name: 'B', title: 'stalls', url: `http://127.0.0.1:${port}/stalls.m3u8` },
      { name: 'C', title: 'refused', url: `http://127.0.0.1:${port}/refused.m3u8` }
    ];

    const controller = new AbortController();
    const validator = __test.createStreamValidator(controller.signal);
    const selected = await __test.validatePlayableStreams(streams, validator, controller);
    const urls = selected.map((stream) => stream.url);

    assert(urls.includes(`http://127.0.0.1:${port}/good.m3u8`), 'the confirmed stream is offered');
    assert(
      urls.includes(`http://127.0.0.1:${port}/stalls.m3u8`),
      'the stream that could not be verified is offered too'
    );
    assert(
      !urls.includes(`http://127.0.0.1:${port}/refused.m3u8`),
      'the stream that was actually refused is dropped'
    );
    assert.strictEqual(urls[0], `http://127.0.0.1:${port}/good.m3u8`, 'confirmed comes first');
  } finally {
    hostHealth.clear();
    origin.close();
  }
}

/**
 * These sources sit behind Cloudflare almost without exception, and when an origin
 * is down the edge answers 520-526 rather than 502. Counting only the standard
 * bad-gateway family meant a host serving 522 to every request never accumulated
 * the failures that take it out of rotation, so every lookup kept paying for it.
 */
async function testCloudflareOriginErrorsCountAsGatewayFailures() {
  const { __test } = scrapers;
  const origin = await startServer((req, res) => {
    res.writeHead(522, { 'Content-Type': 'text/html' });
    res.end('<html>origin down</html>');
  });

  try {
    const port = origin.address().port;
    __test.hostHealth.clear();

    const validator = __test.createStreamValidator(new AbortController().signal);
    // Three gateway failures is what marks a host dead.
    for (const n of [1, 2, 3]) {
      await validator.validate({ url: `http://127.0.0.1:${port}/s${n}.m3u8`, title: `s${n}` });
    }

    const health = __test.hostHealth.get('127.0.0.1');
    assert(health, 'the host accumulated health events');
    assert.deepStrictEqual(
      health.events.map((event) => event.outcome),
      ['gateway-fail', 'gateway-fail', 'gateway-fail'],
      'a Cloudflare origin error is a gateway failure'
    );
    assert(health.deadUntil > Date.now(), 'and three of them take the host out of rotation');
  } finally {
    __test.hostHealth.clear();
    origin.close();
  }
}

/**
 * A CDN host that has stopped resolving and an address this proxy refuses to reach
 * are different failures, and they were reported identically: 400 "Blocked url".
 * Playing a stream whose variant host had died told the player its own request was
 * malformed. Seen live on a variant chain whose master loaded fine.
 *
 * Classification only — this file runs with the private-target escape hatch on, so
 * the HTTP status each one produces is asserted in test_ssrf_guard.js, where the
 * guard is live.
 */
async function testDeadHostAndRefusedAddressAreDifferentFailures() {
  const { assertPublicUrl, BlockedAddressError, UnresolvableHostError } = require('./src/net-guard');
  const previous = process.env.ALLOW_PRIVATE_PROXY_TARGETS;
  delete process.env.ALLOW_PRIVATE_PROXY_TARGETS;

  try {
    await assert.rejects(
      () => assertPublicUrl('https://no-such-host-9z8y7x6w5v.invalid/master.m3u8'),
      (error) => {
        assert(error instanceof UnresolvableHostError, 'a host that does not resolve is unresolvable');
        assert(error instanceof BlockedAddressError, 'and still stops the request like any refusal');
        return true;
      }
    );

    await assert.rejects(
      () => assertPublicUrl('http://169.254.169.254/latest/meta-data/'),
      (error) => {
        assert(error instanceof BlockedAddressError, 'the metadata endpoint is still refused');
        assert(
          !(error instanceof UnresolvableHostError),
          'and refusing it must not be confused with it being missing'
        );
        return true;
      }
    );
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PRIVATE_PROXY_TARGETS;
    else process.env.ALLOW_PRIVATE_PROXY_TARGETS = previous;
  }
}

/**
 * A certificate the runtime will not accept is a verdict, not a shortfall of
 * budget. It matters here because these streams reach a viewer through this
 * addon's proxy: what Node refuses to fetch is exactly what cannot be played.
 *
 * Live, pelisplus serves every stream from a bare IPv4 address whose certificate
 * does not cover it — six sampled, four addresses, two netblocks, all
 * ERR_TLS_CERT_ALTNAME_INVALID. Treating that as inconclusive would keep a stream
 * that can never play.
 */
function testCertificateFailuresAreVerdicts() {
  const { isDefiniteFetchFailure } = scrapers.__test;
  const withCode = (code) => Object.assign(new Error('fetch failed'), { cause: { code } });

  for (const code of [
    'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'ERR_SSL_WRONG_VERSION_NUMBER', 'ENOTFOUND', 'ECONNREFUSED', 'EHOSTUNREACH', 'ERR_INVALID_URL'
  ]) {
    assert.strictEqual(isDefiniteFetchFailure(withCode(code)), true, `${code} is a verdict`);
  }

  // Anything that only says "we ran out of road" is not.
  for (const code of ['ETIMEDOUT', 'ECONNRESET', 'EPIPE', 'UND_ERR_HEADERS_TIMEOUT', '']) {
    assert.strictEqual(isDefiniteFetchFailure(withCode(code)), false, `${code || '(none)'} is not a verdict`);
  }
  assert.strictEqual(isDefiniteFetchFailure(new Error('boom')), false, 'an error with no code says nothing');
}

/**
 * The same thing end to end, against a server presenting a certificate for a
 * different name — the shape pelisplus serves.
 */
async function testBadCertificateStreamIsDropped() {
  const { execFileSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const nodePath = require('node:path');
  const https = require('node:https');

  const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'latino-cert-'));
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=not-this-host.example',
      '-keyout', nodePath.join(dir, 'key.pem'), '-out', nodePath.join(dir, 'cert.pem')
    ], { stdio: 'ignore' });

    const server = https.createServer({
      key: fs.readFileSync(nodePath.join(dir, 'key.pem')),
      cert: fs.readFileSync(nodePath.join(dir, 'cert.pem'))
    }, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXTINF:4,\nseg.ts\n');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    try {
      const { hostHealth: health, createStreamValidator: make } = scrapers.__test;
      health.clear();
      // The playlist behind it is perfectly good; only the certificate is wrong.
      const url = `https://127.0.0.1:${server.address().port}/master.m3u8`;
      const verdict = await make(new AbortController().signal).validate({ url, title: 'bad cert' });

      assert.strictEqual(verdict.playable, false, 'a certificate the runtime rejects is not playable');
      assert.strictEqual(verdict.conclusive, true, 'and that is a verdict, not a shortfall of budget');
      health.clear();
    } finally {
      server.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * And the ranking that follows: a host that cannot present a usable certificate
 * must not be offered ahead of hosts that play. Bare-IPv4 hosts were scored best
 * of all, so the stream at the top of the list was the one that could not play.
 */
function testBareIpHostsDoNotRankFirst() {
  const { sortStreams } = scrapers.__test;
  const ordered = sortStreams([
    { name: 'ip', title: 'pelisplus', url: 'https://45.156.158.200/v4/abc/master.m3u8' },
    { name: 'cdn', title: 'goodstream', url: 'https://hls2.goodstream.one/x/master.m3u8' },
    { name: 'other', title: 'vimeos', url: 'https://s8.vimeos.net/x/master.m3u8' }
  ]);

  assert.notStrictEqual(ordered[0].name, 'ip', 'a bare-IP host no longer leads the list');
  assert.strictEqual(ordered[ordered.length - 1].name, 'ip', 'it goes last');
}

(async () => {
  testForwardedProtoListIsNotPastedIntoTheBaseUrl();
  console.log('ok - X-Forwarded-Proto lists do not corrupt rewritten manifest URLs');

  await testChildRequestsInheritTheRefererTheMasterUsed();
  console.log('ok - segments inherit the Referer the playlist was fetched with');

  testMeasuredQualityReplacesWordedClaimsToo();
  console.log('ok - a measurement replaces worded quality claims, not just digits');

  await testTruncatedMasterIsNotJudgedUnreachable();
  console.log('ok - a truncated master is inconclusive, not unreachable');

  await testCompleteMasterWithNoVariantIsStillRejected();
  console.log('ok - a complete master naming no variant is still rejected');

  testDoodHostRecognitionCoversTheRebrand();
  console.log('ok - Dood host recognition covers the playmogo rebrand');

  testChallengeGatedHostsRankBehindResolvableOnes();
  console.log('ok - challenge-gated hosts rank behind ones that resolve');

  testResolutionMapsToTheRungAPlayerWouldName();
  console.log('ok - RESOLUTION maps to the rung a player would name');

  await testTimedOutProbesLeaveTheStreamUnproven();
  console.log('ok - a timed-out probe reports that it judged nothing');

  await testUnverifiedStreamsAreStillOffered();
  console.log('ok - unverified streams are offered behind the confirmed ones');

  await testCloudflareOriginErrorsCountAsGatewayFailures();
  console.log('ok - Cloudflare origin errors count as gateway failures');

  await testDeadHostAndRefusedAddressAreDifferentFailures();
  console.log('ok - a dead host and a refused address are different failures');

  testCertificateFailuresAreVerdicts();
  console.log('ok - certificate failures are verdicts, not budget shortfalls');

  await testBadCertificateStreamIsDropped();
  console.log('ok - a stream behind a bad certificate is dropped');

  testBareIpHostsDoNotRankFirst();
  console.log('ok - bare-IP hosts no longer lead the stream list');

  console.log('\nPlayback regression tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

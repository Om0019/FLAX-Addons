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
const { withQualityLabel, qualityFromManifest, qualityFromLabel } = require('./src/quality');

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

  console.log('\nPlayback regression tests passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

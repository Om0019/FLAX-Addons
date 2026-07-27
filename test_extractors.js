// Host-extractor coverage. Every case here is offline: the payload formats are
// reproduced by inverting each decoder, so a change that breaks one of them fails
// in CI rather than silently returning zero streams from a live source.

const assert = require('assert');
const http = require('http');
const { extractDirectStream, resolvePlayerStream, resolveDownloadUrl, __test } = require('./src/unpacker');

const {
  decodeVidguardSignature,
  extractMediafireDirectUrl,
  extractVidguardStream,
  extractVoeDirectStream,
  isSupportedEmbedServer,
  iterUnpackedScripts,
  normalizeEmbedUrl
} = __test;

const userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

function rot13(value) {
  return String(value).replace(/[a-zA-Z]/g, (char) => {
    const base = char <= 'Z' ? 65 : 97;
    return String.fromCharCode(((char.charCodeAt(0) - base + 13) % 26) + base);
  });
}

/** Inverse of decodeVoePayload, so the fixture is generated rather than pasted. */
function encodeVoePayload(data) {
  const inner = Buffer.from(JSON.stringify(data), 'utf8').toString('base64');
  const reversed = inner.split('').reverse().join('');
  let shifted = '';
  for (const char of reversed) {
    shifted += String.fromCharCode(char.charCodeAt(0) + 3);
  }
  return rot13(Buffer.from(shifted, 'binary').toString('base64'));
}

/** Inverse of decodeVidguardSignature. */
function encodeVidguardSignature(sig) {
  const characters = `${sig}ABCDE`.split('');
  for (let index = 0; index + 1 < characters.length; index += 2) {
    const swap = characters[index];
    characters[index] = characters[index + 1];
    characters[index + 1] = swap;
  }

  const payload = Buffer.concat([
    Buffer.from(characters.reverse().join(''), 'binary'),
    Buffer.from('ZZZZZ', 'binary')
  ]).toString('base64');

  let hex = '';
  for (const char of payload) {
    hex += (char.charCodeAt(0) ^ 2).toString(16).padStart(2, '0');
  }
  return hex;
}

function buildVoeMirrorPage(data, { asVariable = false } = {}) {
  // Markers are stripped during decode, so scattering them through the payload is
  // exactly what a real mirror does.
  const encoded = encodeVoePayload(data).replace(/^(.{20})/, '$1@$').replace(/(.{40})/, '$1^^');
  const body = asVariable
    ? `<script>var MKGMa = "${encoded}";</script>`
    : `<script type="application/json">["${encoded}"]</script>`;

  return `<html><head><title>Player</title></head><body>${body}</body></html>`;
}

function testVoePayloadDecodes() {
  const source = 'https://delivery.example.net/engine/hls2/01/00042/master.m3u8?t=abc&s=1';
  const html = buildVoeMirrorPage({ source, direct_access_allowed: false, fallback: [] });

  assert.strictEqual(
    extractVoeDirectStream(html, 'https://unknown-mirror.example/e/abc'),
    source,
    'VOE payload decodes to its source URL'
  );

  // The same payload carried in a plain variable instead of a JSON script tag.
  assert.strictEqual(
    extractVoeDirectStream(buildVoeMirrorPage({ source }, { asVariable: true }), 'https://unknown-mirror.example/e/abc'),
    source,
    'VOE payload in a plain variable is found too'
  );

  // Base64-wrapped stream URLs, and the fallback list, are both accepted.
  const fallbackFile = 'https://delivery.example.net/fallback/index.m3u8';
  assert.strictEqual(
    extractVoeDirectStream(
      buildVoeMirrorPage({ source: null, fallback: [{ file: Buffer.from(fallbackFile).toString('base64') }] }),
      'https://unknown-mirror.example/e/abc'
    ),
    fallbackFile,
    'base64-encoded fallback entries are decoded'
  );
}

function testVoeDecodeRejectsUnrelatedPages() {
  const pages = [
    '<html><script type="application/json">["not-a-voe-payload"]</script></html>',
    '<html><script type="application/json">{"@context":"https://schema.org","name":"A Movie"}</script></html>',
    `<html><script>var config = "${'x'.repeat(200)}";</script></html>`,
    '<html><body>nothing here</body></html>'
  ];

  for (const html of pages) {
    assert.strictEqual(
      extractVoeDirectStream(html, 'https://example.com/e/abc', { quiet: true }),
      null,
      'a non-VOE page must not be mistaken for one'
    );
  }
}

// The reason VOE produced nothing in practice: voe.sx only serves a redirect stub,
// and the mirror it lands on has a domain no allowlist can keep up with.
async function testVoeMirrorIsRecognisedByPayload() {
  const source = 'https://delivery.example.net/engine/hls2/02/00099/master.m3u8?t=xyz';
  let mirrorRequests = 0;

  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/stub')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(`<html><script>window.location.href = 'http://127.0.0.1:${server.address().port}/e/mirrored';</script></html>`);
      return;
    }

    mirrorRequests += 1;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(buildVoeMirrorPage({ source, direct_access_allowed: false }));
  });

  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const stubUrl = `http://127.0.0.1:${server.address().port}/stub`;
    const resolved = await resolvePlayerStream(stubUrl, userAgent, 'https://cinecalidad.am/');

    assert.strictEqual(resolved, source, 'a VOE mirror on an unrecognised domain still resolves');
    assert.strictEqual(mirrorRequests, 1, 'the redirect is followed exactly once');
  } finally {
    server.close();
  }
}

function testVidguardSignatureRoundTrips() {
  const realSig = 'aGVsbG8tdmlkZ3VhcmQtc2ln';
  const obfuscated = encodeVidguardSignature(realSig);
  const streamUrl = `https://cdn.example.net/stream/master.m3u8?sig=${obfuscated}&t=1700000000`;

  const decoded = new URL(decodeVidguardSignature(streamUrl));
  assert.strictEqual(decoded.searchParams.get('sig'), realSig, 'the sig parameter is deobfuscated');
  assert.strictEqual(decoded.searchParams.get('t'), '1700000000', 'other query parameters survive');

  // A URL with no sig, or a sig that is not hex, must pass through untouched rather
  // than being mangled into something unplayable.
  for (const url of ['https://cdn.example.net/a.m3u8', 'https://cdn.example.net/a.m3u8?sig=not-hex']) {
    assert.strictEqual(decodeVidguardSignature(url), url, 'a URL without a decodable sig is left alone');
  }
}

function testVidguardStreamExtraction() {
  const realSig = 'dmlkZ3VhcmQtc3RyZWFt';
  const streamUrl = `https://cdn.example.net/hls/master.m3u8?sig=${encodeVidguardSignature(realSig)}&expiry=99`;

  // VidGuard hides the config inside a packed script, which is why the packer pass
  // had to become reusable.
  const dictionary = ['window', 'svg', 'stream', streamUrl.replace(/\//g, '\\/')];
  const packed = `<script>eval(function(p,a,c,k,e,d){}('0.1={"2":"3"}',62,${dictionary.length},'${dictionary.join('|')}'.split('|')))</script>`;

  const resolved = extractVidguardStream(packed, 'https://listeamed.net/e/abc');
  assert(resolved, 'a packed VidGuard config yields a stream');
  assert.strictEqual(new URL(resolved).searchParams.get('sig'), realSig, 'the extracted stream has a decoded sig');

  const plain = `<html><script>window.svg = {"stream":"${streamUrl}"};</script></html>`;
  assert.strictEqual(
    new URL(extractVidguardStream(plain, 'https://listeamed.net/e/abc')).searchParams.get('sig'),
    realSig,
    'an unpacked VidGuard config works too'
  );
}

function testMediafireDirectExtraction() {
  const direct = 'https://download2390.mediafire.com/abc123/file/Movie.2024.1080p.mkv';
  const landing = 'https://www.mediafire.com/file/abc123/Movie.mkv/file';

  assert.strictEqual(
    extractMediafireDirectUrl(`<html><a id="downloadButton" href="${direct}">Download</a></html>`, landing),
    direct,
    'the download button href is used'
  );

  const scrambled = Buffer.from(direct).toString('base64');
  assert.strictEqual(
    extractMediafireDirectUrl(
      `<html><a id="downloadButton" href="#" data-scrambled-url="${scrambled}">Download</a></html>`,
      landing
    ),
    direct,
    'a scrambled download URL is decoded'
  );

  assert.strictEqual(
    extractMediafireDirectUrl(`<html><script>var x = "${direct}";</script></html>`, landing),
    direct,
    'the page is scanned when no button is present'
  );

  // A landing page that only links back to itself yields nothing, so the caller
  // keeps the original URL rather than a bogus "direct" link.
  assert.strictEqual(
    extractMediafireDirectUrl(`<html><a id="downloadButton" href="${landing}">Download</a></html>`, landing),
    null,
    'a self-referential landing page is not treated as a direct file'
  );
}

async function testDownloadUrlResolutionIsNonDestructive() {
  const nonMediafire = 'https://fireload.com/f/abcdef/Movie.mkv';
  assert.strictEqual(
    await resolveDownloadUrl(nonMediafire, userAgent, 'https://www.cinecalidad.am/'),
    nonMediafire,
    'an unhandled download host is returned unchanged'
  );
}

function testEmbedPathNormalization() {
  const cases = [
    ['https://listeamed.net/v/abc123', 'https://listeamed.net/e/abc123'],
    ['https://ahvsh.com/v/abc123', 'https://ahvsh.com/e/abc123'],
    ['https://luluvdo.com/d/abc123', 'https://luluvdo.com/e/abc123'],
    ['https://vudeo.io/f/abc123', 'https://vudeo.io/e/abc123'],
    // Hosts that already serve a player on /v/ must not be rewritten.
    ['https://vidhideplus.com/v/jwbzc2sk6vi4', 'https://vidhideplus.com/v/jwbzc2sk6vi4'],
    ['https://filemoon.sx/e/jit3ysg37ojx', 'https://filemoon.sx/e/jit3ysg37ojx'],
    ['https://hlswish.com/e/7mpdbzuy04uy', 'https://hlswish.com/e/7mpdbzuy04uy']
  ];

  for (const [input, expected] of cases) {
    assert.strictEqual(normalizeEmbedUrl(input, 'https://tioplus.app/'), expected, `normalizes ${input}`);
  }

  // The netu family keeps the referer parameter the player checks for.
  for (const host of ['waaw.to', 'netu.tv', 'hqq.tv']) {
    const normalized = new URL(normalizeEmbedUrl(`https://${host}/f/abc123`, 'https://tioplus.app/'));
    assert.strictEqual(normalized.pathname, '/e/abc123', `${host} is rewritten to its embed path`);
    assert.strictEqual(normalized.searchParams.get('http_referer'), 'https://tioplus.app/', `${host} keeps http_referer`);
  }
}

function testEmbedServerGate() {
  // Servers with a resolver, or that the generic extractor handles, must not be
  // dropped before they are ever tried.
  for (const server of ['voe', 'vidguard', 'listeamed', 'luluvdo', 'streamhide', 'vudeo', 'netu', 'vidhide', 'filemoon', '']) {
    assert(isSupportedEmbedServer(server), `${server || '(unnamed)'} is attempted`);
  }

  for (const server of ['1fichier', 'mega', 'uptobox', 'gofile', 'terabox', 'pixeldrain']) {
    assert(!isSupportedEmbedServer(server), `${server} is skipped as an unresolvable locker`);
  }
}

function testUnpackedScriptIteration() {
  const dictionary = ['file', 'https', 'cdn', 'example', 'net', 'master', 'm3u8'];
  const packed = `<script>eval(function(p,a,c,k,e,d){}('{0:"1://2.3.4/5.6"}',62,${dictionary.length},'${dictionary.join('|')}'.split('|')))</script>`;

  const [unpacked, ...rest] = [...iterUnpackedScripts(`${packed}`)];
  assert.strictEqual(unpacked, '{file:"https://cdn.example.net/master.m3u8"}', 'a packed block is decoded');
  assert.strictEqual(rest.length, 0, 'only real packed blocks are yielded');
  assert.deepStrictEqual([...iterUnpackedScripts('<html>no scripts</html>')], [], 'a page with no packed script yields nothing');
}

/** Builds a Dean Edwards packed script carrying `url` as its player config. */
function packStreamConfig(url) {
  const dictionary = ['file', ...url.replace(/^https:\/\//, '').split(/[/.]/)];
  const body = `{0:"https://${url.replace(/^https:\/\//, '').replace(/[^/.]+/g, (word) => dictionary.indexOf(word))}"}`;
  return `<script>eval(function(p,a,c,k,e,d){}('${body}',62,${dictionary.length},'${dictionary.join('|')}'.split('|')))</script>`;
}

// A bare includes('ads') check also fires on "uploads" and "downloads" — the two
// most common path segments real stream URLs sit under — so it discarded the
// stream it was meant to protect. Ad hosts and ad path segments still go.
function testPackedStreamAdFilter() {
  const kept = [
    'https://cdn.example.net/uploads/master.m3u8',
    'https://cdn.example.net/downloads/movie.mp4',
    'https://cdn.example.net/hls2/master.m3u8'
  ];

  for (const url of kept) {
    assert.strictEqual(
      extractDirectStream(packStreamConfig(url), 'https://host.example/e/abc'),
      url,
      `a packed stream under ${new URL(url).pathname} survives the ad filter`
    );
  }

  for (const url of ['https://ads.example.net/preroll.mp4', 'https://cdn.example.net/ads/preroll.mp4']) {
    assert.strictEqual(
      extractDirectStream(packStreamConfig(url), 'https://host.example/e/abc'),
      null,
      `a genuine ad asset (${url}) is still rejected`
    );
  }

  // The unpacked path has to agree with the packed one; they used to apply
  // different filters to the same URL.
  assert.strictEqual(
    extractDirectStream('<script>file:"https://ads.example.net/preroll.mp4"</script>', 'https://host.example/e/abc'),
    null,
    'the unpacked path rejects ad assets too'
  );
}

// An adblock detector or back-button handler assigns location.href on pages that
// are not redirect stubs at all. Following it is right; ending the resolve when it
// leads nowhere threw away a page whose stream was sitting right there.
async function testDeadJsRedirectFallsThrough() {
  const source = 'https://cdn.example.net/hls/master.m3u8';

  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    if (req.url.startsWith('/blocked')) {
      res.end('<html><body>nothing here</body></html>');
      return;
    }
    res.end(`<html><script>if (window.adblockDetected) { window.location.href = "/blocked"; }</script>
      <script>jwplayer("p").setup({file:"${source}"});</script></html>`);
  });

  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const resolved = await resolvePlayerStream(
      `http://127.0.0.1:${server.address().port}/player`,
      userAgent,
      'https://tioplus.app/'
    );
    assert.strictEqual(resolved, source, 'a redirect that leads nowhere still leaves the page extractable');
  } finally {
    server.close();
  }
}

async function run() {
  const tests = [
    ['VOE payload decodes', testVoePayloadDecodes],
    ['VOE decode rejects unrelated pages', testVoeDecodeRejectsUnrelatedPages],
    ['VOE mirror recognised by payload', testVoeMirrorIsRecognisedByPayload],
    ['VidGuard signature round-trips', testVidguardSignatureRoundTrips],
    ['VidGuard stream extraction', testVidguardStreamExtraction],
    ['MediaFire direct extraction', testMediafireDirectExtraction],
    ['Download resolution is non-destructive', testDownloadUrlResolutionIsNonDestructive],
    ['Embed path normalization', testEmbedPathNormalization],
    ['embed69 server gate', testEmbedServerGate],
    ['Packed script iteration', testUnpackedScriptIteration],
    ['Packed stream ad filter', testPackedStreamAdFilter],
    ['Dead JS redirect falls through', testDeadJsRedirectFallsThrough]
  ];

  for (const [label, test] of tests) {
    await test();
    console.log(`ok - ${label}`);
  }

  console.log(`\n${tests.length} extractor tests passed`);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

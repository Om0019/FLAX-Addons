// Host-extractor coverage. Every case here is offline: the payload formats are
// reproduced by inverting each decoder, so a change that breaks one of them fails
// in CI rather than silently returning zero streams from a live source.

const assert = require('assert');
const crypto = require('crypto');
const http = require('http');
const { extractDirectStream, resolvePlayerStream, resolveDownloadUrl, __test } = require('./src/unpacker');

const {
  cleanEscapedStreamUrl,
  decodeVidguardSignature,
  decryptFilemoonPayload,
  extractAssignedRedirect,
  extractMediafireDirectUrl,
  extractStreamtapeStream,
  extractVidguardStream,
  extractVoeDirectStream,
  extractAltchaGate,
  solveAltchaChallenge,
  isDefunctHost,
  isPelisplusHost,
  isStreamtapeHost,
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

/**
 * A fixed challenge whose PBKDF2 derivation at counter=0, cost=1 happens to start
 * with the chosen 1-byte prefix — precomputed offline so the test never has to
 * brute-force, and stays instant regardless of the machine running it.
 */
const ALTCHA_FIXTURE_CHALLENGE = {
  parameters: {
    algorithm: 'PBKDF2/SHA-256',
    cost: 1,
    keyLength: 32,
    keyPrefix: 'a4',
    nonce: '00112233445566778899aabbccddeeff0011223',
    salt: 'abcdef0123456789'
  },
  signature: 'test-signature'
};

function buildAltchaGatePage(challengeUrl, csrfToken) {
  return `<!DOCTYPE html><html><head><meta name="csrf-token" content="${csrfToken}"></head>` +
    `<body><form method="POST" class="access-form">` +
    `<input type="hidden" name="_token" value="${csrfToken}">` +
    `<input type="hidden" name="access" value="0">` +
    `<altcha-widget challenge="${challengeUrl}" hidefooter display="standard"></altcha-widget>` +
    `</form></body></html>`;
}

function testAltchaGateIsDetected() {
  const gatePage = buildAltchaGatePage('https://example.com/challenge/abc', 'tok-123');
  assert.deepStrictEqual(
    extractAltchaGate(gatePage),
    { csrfToken: 'tok-123', challengeUrl: 'https://example.com/challenge/abc' },
    'a gate page yields its CSRF token and challenge URL'
  );

  assert.strictEqual(
    extractAltchaGate('<html><body>a normal player page</body></html>'),
    null,
    'a page without an altcha-widget is not mistaken for a gate'
  );
}

function testAltchaChallengeSolves() {
  const solution = solveAltchaChallenge(ALTCHA_FIXTURE_CHALLENGE.parameters);
  assert.ok(solution, 'the fixture challenge is solved');
  assert.strictEqual(solution.counter, 0, 'the precomputed fixture solves at counter 0');

  const badPrefix = { ...ALTCHA_FIXTURE_CHALLENGE.parameters, keyPrefix: '0000' };
  assert.strictEqual(
    solveAltchaChallenge(badPrefix),
    null,
    'a longer-than-supported prefix is refused up front rather than searched'
  );
}

// This is the actual failure mode this addon hit in practice: a VOE mirror
// (matthewhotelscience.com at last check) serves an Altcha "confirm you're
// human" gate instead of the player, and every VOE-backed stream came back
// empty until the challenge was solved and POSTed back.
async function testAltchaGateIsSolvedAndUnblocksVoeMirror() {
  const source = 'https://delivery.example.net/engine/hls2/03/00071/master.m3u8?t=post-gate';
  let postedBody = null;

  const server = http.createServer((req, res) => {
    const port = server.address().port;

    if (req.url.startsWith('/challenge')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(ALTCHA_FIXTURE_CHALLENGE));
      return;
    }

    if (req.method === 'POST' && req.url.startsWith('/e/gated')) {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        postedBody = new URLSearchParams(raw);
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(buildVoeMirrorPage({ source, direct_access_allowed: false }));
      });
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(buildAltchaGatePage(`http://127.0.0.1:${port}/challenge`, 'csrf-abc'));
  });

  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const gatedUrl = `http://127.0.0.1:${server.address().port}/e/gated`;
    const resolved = await resolvePlayerStream(gatedUrl, userAgent, 'https://sololatino.net/');

    assert.strictEqual(resolved, source, 'the page behind the gate resolves once the challenge is solved');
    assert.ok(postedBody, 'the solved challenge was POSTed back');
    assert.strictEqual(postedBody.get('_token'), 'csrf-abc', 'the CSRF token from the gate page is carried through');

    const submittedPayload = JSON.parse(Buffer.from(postedBody.get('altcha'), 'base64').toString('utf8'));
    assert.strictEqual(submittedPayload.solution.counter, 0, 'the solved counter is submitted');
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

  assert.strictEqual(
    extractDirectStream(
      '<script>/* player.src({src:"https://cdn.example.net/stale/master.m3u8"}); */</script>',
      'https://host.example/e/abc'
    ),
    null,
    'commented-out player configs are ignored'
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

function base64Url(buffer) {
  return buffer.toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/**
 * Builds a Filemoon playback payload the way its API does: AES-GCM over the JSON,
 * with the key split across `key_parts` and `version` naming which two entries to
 * reassemble it from.
 */
function buildFilemoonPayload(data, { version, partCount = 30 } = {}) {
  const parts = Array.from({ length: partCount }, () => crypto.randomBytes(16));
  const index = Number(version);
  const key = Buffer.concat([parts[index - 1], parts[30 - index]]);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);

  return {
    version: String(version),
    key_parts: parts.map(base64Url),
    iv: base64Url(iv),
    payload: base64Url(Buffer.concat([encrypted, cipher.getAuthTag()]))
  };
}

// The two key parts are picked by `version`, and picking the wrong pair yields a
// key that fails authentication rather than anything diagnosable. The indices
// mirror Filemoon's player bundle, which maps version n to the 1-based pair
// [n, 31 - n]; this pins that mapping so a rewrite cannot quietly shift it.
function testFilemoonPayloadDecryption() {
  const sources = [{ url: 'https://cdn.example.net/hls/master.m3u8', quality: '1080p' }];

  for (const version of [1, 3, 15, 20]) {
    assert.deepStrictEqual(
      decryptFilemoonPayload(buildFilemoonPayload({ sources }, { version })),
      { sources },
      `version ${version} selects the right key parts`
    );
  }

  // A version outside the table means the whole key_parts list is the key, which
  // is only a valid AES key length by accident — it must fail, not throw.
  const payload = buildFilemoonPayload({ sources }, { version: 3 });
  assert.strictEqual(
    decryptFilemoonPayload({ ...payload, version: '99' }),
    null,
    'an unknown version does not produce a bogus key'
  );

  assert.strictEqual(decryptFilemoonPayload({ key_parts: [] }), null, 'an empty payload is rejected');
}

async function testByseCaptchaGateIsRecognised() {
  const realFetch = global.fetch;
  const requests = [];

  global.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    assert.strictEqual(
      String(url),
      'https://bysejikuar.com/api/videos/56w42pouykk2/embed/settings',
      'Byse embeds should use the Filemoon-style settings API before fetching HTML'
    );
    assert.strictEqual(options.headers?.['X-Embed-Origin'], 'ww2.tlnovelas.net');

    return new Response(JSON.stringify({ captcha_required: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };

  try {
    const resolved = await resolvePlayerStream(
      'https://bysejikuar.com/e/56w42pouykk2',
      userAgent,
      'https://ww2.tlnovelas.net/ver/lo-que-la-vida-me-robo-capitulo-1/'
    );

    assert.strictEqual(resolved, null, 'captcha-gated Byse files are skipped server-side');
    assert.strictEqual(requests.length, 1, 'captcha-gated files stop after the settings probe');
  } finally {
    global.fetch = realFetch;
  }
}

/**
 * Novelas360 serves netu's player from its own domain. The only plain-text .m3u8 on
 * that page is netu's placeholder clip, which the generic path would have handed
 * over as the episode.
 */
async function testNetuClonePlaceholderIsNotServed() {
  const realFetch = global.fetch;
  const placeholder = 'https://4fw4gd.cfglobalcdn.com/secip/1/abc/1606597200/hls-vod-s03/flv/api/files/videos/2018/08/01/153311550983uua.mp4.m3u8';

  global.fetch = async () => new Response(
    `<html><body><script>olplayer.src({src: '${placeholder}', type: 'application/x-mpegURL'});</script></body></html>`,
    { status: 200, headers: { 'content-type': 'text/html' } }
  );

  try {
    const resolved = await resolvePlayerStream(
      'https://novelas360.cyou/player/embed_player.php?vid=V2xQVlR2Tk9qQjNkN0lRb3AyK0xQUT09',
      userAgent,
      'https://novelas360.com/video/lo-que-la-vida-me-robo-capitulo-1/'
    );

    assert.strictEqual(resolved, null, "netu's placeholder clip is never offered as a stream");
  } finally {
    global.fetch = realFetch;
  }
}

/** Builds an embed69 page whose dataLink carries the given servers, encrypted the
 *  way the site does: AES-256-CBC under a key derived from a solved proof-of-work. */
function buildEmbed69Page(servers) {
  const challenge = 'challenge';
  const salt = 'salt';
  const difficulty = 2;

  let nonce = 0;
  let key;
  for (;;) {
    if (crypto.createHash('sha256').update(challenge + nonce).digest('hex').startsWith('0'.repeat(difficulty))) {
      key = crypto.createHash('sha256').update(challenge + nonce + salt).digest();
      break;
    }
    nonce += 1;
  }

  const encrypt = (plain) => {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
  };

  const dataLink = [{
    sortedEmbeds: servers.map(({ server, url }) => ({ servername: server, type: 'video', link: encrypt(url) }))
  }];

  return `<script>const POW_CHALLENGE = '${challenge}';
const POW_DIFFICULTY = ${difficulty};
const POW_SALT = '${salt}';
let dataLink = ${JSON.stringify(dataLink)};</script>`;
}

// embed69 lists more servers than MAX_EMBED69_ATTEMPTS allows, so the ranking
// decides which ones are ever tried. Filemoon used to rank second despite being
// unresolvable server-side, spending an attempt on every page that offered it.
async function testEmbed69RanksFilemoonLast() {
  const requested = [];

  const server = http.createServer((req, res) => {
    requested.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body>no stream here</body></html>');
  });

  await new Promise((resolve) => server.listen(0, resolve));

  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const html = buildEmbed69Page([
      { server: 'filemoon', url: `${origin}/filemoon` },
      { server: 'voe', url: `${origin}/voe` },
      { server: 'vidhide', url: `${origin}/vidhide` }
    ]);

    const page = http.createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    });
    await new Promise((resolve) => page.listen(0, resolve));

    try {
      await resolvePlayerStream(`http://127.0.0.1:${page.address().port}/embed69`, userAgent, 'https://sololatino.net/');
    } finally {
      page.close();
    }

    assert.strictEqual(
      requested[0],
      '/vidhide',
      'the server that can actually resolve is attempted first'
    );
    assert.deepStrictEqual(
      [...requested].slice(1).sort(),
      ['/filemoon', '/voe'],
      'both challenge-gated hosts are attempted only once the resolvable ones are exhausted'
    );
  } finally {
    server.close();
  }
}

/**
 * Streamtape splits the playback URL across a div and a script that appends the
 * tail of a second string. Neither half is a URL, which is why a plain page scan
 * never found one.
 */
function testStreamtapeExtraction() {
  const head = '//streamtape.com/get_video?id=abc123&expires=1799999999&ip=Nzc';
  const tail = 'XYZ&token=deadbeefcafe';
  const html = `
    <div id="robotlink" style="display:none;">${head}</div>
    <script>document.getElementById('robotlink').innerHTML = '${head}' + ('${tail}').substring(3);</script>
  `;

  assert.strictEqual(
    extractStreamtapeStream(html, 'https://streamtape.com/e/abc123'),
    `https:${head}&token=deadbeefcafe`,
    'the two halves are joined with the leading characters of the tail dropped'
  );

  assert.strictEqual(
    extractStreamtapeStream('<div id="robotlink"></div>', 'https://streamtape.com/e/abc123'),
    null,
    'a page without the split assignment yields nothing rather than a broken URL'
  );

  assert.strictEqual(isStreamtapeHost('https://streamtape.com/e/abc'), true);
  assert.strictEqual(isStreamtapeHost('https://tapewithadblock.org/e/abc'), false, 'unrelated hosts are not claimed');
}

/**
 * vudeo's fingerprint stub navigates with `location.replace(variable + suffix)`,
 * which carries no literal URL for the redirect scan to match.
 */
function testAssignedRedirectExtraction() {
  const html = `
    <script>
    var redirect_link = 'http://vudeo.co/embed-a6fxzqiiyuj3.html?tr_uuid=20260727-1739&';
    const rdrTimeout = setTimeout(() => redirect('fp=-7'), 300);
    </script>
  `;

  assert.strictEqual(
    extractAssignedRedirect(html, 'https://vudeo.co/embed-a6fxzqiiyuj3.html'),
    'http://vudeo.co/embed-a6fxzqiiyuj3.html?tr_uuid=20260727-1739&fp=-7',
    'the assigned base and the fallback suffix are joined'
  );

  assert.strictEqual(
    extractAssignedRedirect('<script>var other = "https://example.test/";</script>', 'https://vudeo.co/'),
    null,
    'an unrelated assignment is not treated as a redirect'
  );
}

/** pelisplus.rpmstream.live resolved with the existing decryptor but was never routed to it. */
function testPelisplusHostRecognition() {
  assert.strictEqual(isPelisplusHost('https://pelisplus.rpmstream.live/#ogfd1'), true);
  assert.strictEqual(isPelisplusHost('https://pelisplus.upns.pro/#abc'), true);
  assert.strictEqual(isPelisplusHost('https://pelisplusto.4meplayer.pro/#abc'), true);
  assert.strictEqual(
    isPelisplusHost('https://pelisplus.rpmstream.live/'),
    false,
    'without a fragment there is no video id to ask the API for'
  );
  assert.strictEqual(isPelisplusHost('https://goodstream.one/embed-abc.html'), false);
}

/**
 * The skip covers hosts that answer nothing at all, so it must not spread to the
 * ones that merely answer badly some of the time — hqq.tv served 200, 403 and 200
 * across three consecutive trials, and a host like that has to keep its turn.
 */
async function testDefunctHostSkip() {
  assert.strictEqual(isDefunctHost('https://fembed.com/v/abc'), true);
  assert.strictEqual(isDefunctHost('https://www.fembed.com/v/abc'), true);
  assert.strictEqual(isDefunctHost('https://gounlimited.to/e/abc'), true);

  for (const live of [
    'https://hqq.tv/e/abc',
    'https://waaw.to/e/abc',
    'https://novelas360.cyou/e/abc',
    'https://gamovideo.com/e/abc'
  ]) {
    assert.strictEqual(isDefunctHost(live), false, `${live} still answers and must be tried`);
  }

  // A defunct name appearing inside another host is a different host.
  assert.strictEqual(isDefunctHost('https://fembed.com.example.net/v/abc'), false);
  assert.strictEqual(isDefunctHost('https://notfembed.com/v/abc'), false);

  // Resolving one returns without reaching the network at all, which is what
  // keeps the timeout off the scrape's budget. An attempted fetch here would
  // hang for the full deadline rather than come back null.
  const started = Date.now();
  const resolved = await resolvePlayerStream('https://fembed.com/v/abc', userAgent, 'https://example.com/');
  assert.strictEqual(resolved, null);
  assert.ok(Date.now() - started < 1000, 'defunct host must be skipped without a request');
}

/**
 * ok.ru's player config is JSON-escaped twice, so its manifest URL reaches the
 * generic extractor with every `&` written as `\\u0026` and a stray trailing
 * backslash. Served that way the host answers 400 with a one-byte body; repaired,
 * the same URL returns a real playlist. Measured against a live ok.ru embed, which
 * is roughly a fifth of the player links the Ennovelas source hands over.
 */
function testEscapedStreamUrlRepair() {
  const escaped = 'https://vd238.okcdn.ru/video.m3u8?cmd=videoPlayerCdn\\\\u0026expires=1785560124152\\\\u0026sig=ss0c6pi83lQ\\';
  assert.strictEqual(
    cleanEscapedStreamUrl(escaped),
    'https://vd238.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&expires=1785560124152&sig=ss0c6pi83lQ'
  );

  // Singly-escaped payloads and the other separators JSON hides the same way.
  assert.strictEqual(
    cleanEscapedStreamUrl('https://h.example/a.m3u8?x=1\\u0026y=2\\u003d3'),
    'https://h.example/a.m3u8?x=1&y=2=3'
  );

  // A URL that never carried an escape is returned untouched, so this cannot
  // rewrite the hosts that were already working.
  const plain = 'https://vd468.okcdn.ru/expires/1785560107895/ondemand/hls4_450645.m3u8/';
  assert.strictEqual(cleanEscapedStreamUrl(plain), plain);
  assert.strictEqual(
    cleanEscapedStreamUrl('https://h.example/v.mp4?a=1&b=2'),
    'https://h.example/v.mp4?a=1&b=2'
  );

  // And the repair reaches the extractor, not just the helper.
  assert.strictEqual(
    extractDirectStream(
      '<script>var p = "{\\"hlsManifestUrl\\":\\"https://vd238.okcdn.ru/video.m3u8?cmd=videoPlayerCdn\\\\u0026sig=abc\\"}";</script>',
      'https://www.ok.ru/videoembed/1'
    ),
    'https://vd238.okcdn.ru/video.m3u8?cmd=videoPlayerCdn&sig=abc'
  );
}

async function run() {
  const tests = [
    ['Escaped stream URL repair', testEscapedStreamUrlRepair],
    ['VOE payload decodes', testVoePayloadDecodes],
    ['VOE decode rejects unrelated pages', testVoeDecodeRejectsUnrelatedPages],
    ['VOE mirror recognised by payload', testVoeMirrorIsRecognisedByPayload],
    ['Altcha gate is detected', testAltchaGateIsDetected],
    ['Altcha challenge solves', testAltchaChallengeSolves],
    ['Altcha gate is solved and unblocks VOE mirror', testAltchaGateIsSolvedAndUnblocksVoeMirror],
    ['VidGuard signature round-trips', testVidguardSignatureRoundTrips],
    ['VidGuard stream extraction', testVidguardStreamExtraction],
    ['MediaFire direct extraction', testMediafireDirectExtraction],
    ['Download resolution is non-destructive', testDownloadUrlResolutionIsNonDestructive],
    ['Embed path normalization', testEmbedPathNormalization],
    ['embed69 server gate', testEmbedServerGate],
    ['Packed script iteration', testUnpackedScriptIteration],
    ['Packed stream ad filter', testPackedStreamAdFilter],
    ['Dead JS redirect falls through', testDeadJsRedirectFallsThrough],
    ['Filemoon payload decryption', testFilemoonPayloadDecryption],
    ['Byse captcha gate is recognised', testByseCaptchaGateIsRecognised],
    ['netu clone placeholder is not served', testNetuClonePlaceholderIsNotServed],
    ['embed69 ranks challenge-gated hosts last', testEmbed69RanksFilemoonLast],
    ['Streamtape split URL extraction', testStreamtapeExtraction],
    ['Assigned-variable redirect extraction', testAssignedRedirectExtraction],
    ['Pelisplus host recognition', testPelisplusHostRecognition],
    ['Defunct hosts are skipped before any request', testDefunctHostSkip]
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

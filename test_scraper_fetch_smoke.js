// Exercises every migrated fetch call site in the scrapers against a stubbed
// global fetch, so a destructuring or contract slip in src/http.js consumers
// surfaces as a failure instead of a silently empty stream list. No network.
// Drive every migrated call site with a stubbed fetch. A destructuring mistake in
// the migration surfaces here as a TypeError rather than a silent empty result.
const realFetch = global.fetch;
let calls = 0;

const HTML = `<html><head><title>Test 2024</title><meta name="csrf-token" content="tok"></head>
<body><a href="/pelicula/test-2024" title="Test 2024">Test 2024</a>
<a href="/serie/test-2024">Test 2024</a>
<a href="/ver-pelicula/test-2024">Test 2024</a>
<div class="server-btn" data-player-token="abc">Latino</div>
<ul id="playeroptionsul"><li data-option="https://player.example/e/x">Servidor 1</li></ul>
<div id="player-tr" data-tr="aHR0cHM6Ly9wbGF5ZXIuZXhhbXBsZS9lL3g="></div>
<iframe src="https://player.example/e/x"></iframe>
<a href="?download=1">Mediafire</a></body></html>`;

const JSONBODY = JSON.stringify({
  url: 'https://cdn.example/master.m3u8', type: 'iframe',
  s: [['Server', 'v1']], u: '/direct/file.mp4',
  data: { posts: [{ _id: '1', title: 'Test', slug: 'test', type: 'movies', release_date: '2024-01-01', episode_number: 1 }],
          embeds: [{ url: 'https://player.example/e/x', lang: 'Latino', quality: '1080p' }] }
});

global.fetch = async (url, opts = {}) => {
  calls++;
  const u = String(url);
  const isJson = /api|\.json|s\.php|search\?/.test(u) && !/\.m3u8/.test(u);
  return new Response(isJson ? JSONBODY : HTML, {
    status: 200,
    headers: {
      'Content-Type': isJson ? 'application/json' : 'text/html',
      'Set-Cookie': 'XSRF-TOKEN=xyz; Path=/'
    }
  });
};

const scrapers = {
  sololatino: require('./src/scrapers/sololatino'),
  tioplus: require('./src/scrapers/tioplus'),
  cinecalidad: require('./src/scrapers/cinecalidad'),
  cuevana3i: require('./src/scrapers/cuevana3i'),
  lamovie: require('./src/scrapers/lamovie'),
  pelispedia: require('./src/scrapers/pelispedia'),
  ennovelas: require('./src/scrapers/ennovelas')
};

// Silence scraper chatter so only failures show.
const origLog = console.log, origWarn = console.warn, origErr = console.error;
const errors = [];
console.log = () => {}; console.warn = () => {};
console.error = (...a) => { errors.push(a.join(' ')); };

(async () => {
  let failures = 0;
  for (const [name, mod] of Object.entries(scrapers)) {
    for (const type of ['movie', 'series']) {
      const before = calls;
      try {
        const out = await mod.scrape('Test', 'Test', 2024, type, 1, 1, { extraTitles: [] });
        if (!Array.isArray(out)) { origLog(`FAIL ${name}/${type}: returned ${typeof out}`); failures++; }
      } catch (e) {
        origLog(`THREW ${name}/${type}: ${e.name}: ${e.message}`);
        failures++;
      }
      if (calls === before) { origLog(`WARN ${name}/${type}: made no fetch calls`); }
    }
  }
  const typeErrors = errors.filter(e => /TypeError|is not a function|Cannot read|undefined/.test(e));
  console.log = origLog; console.warn = origWarn; console.error = origErr;
  origLog(`total fetch calls: ${calls}`);
  origLog(`destructuring/type errors in scraper logs: ${typeErrors.length}`);
  typeErrors.slice(0, 8).forEach(e => origLog('  ! ' + e));
  origLog(failures === 0 && typeErrors.length === 0 ? 'MIGRATION SMOKE: PASS' : 'MIGRATION SMOKE: FAIL');
  process.exit(failures === 0 && typeErrors.length === 0 ? 0 : 1);
})();

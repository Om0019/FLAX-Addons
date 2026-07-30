const assert = require('assert');
const tlnovelas = require('./src/scrapers/tlnovelas');

const {
  expandPlayerEntry,
  extractPlayerUrls,
  extractSearchResults,
  buildSearchTitles,
  episodeNumberFromText,
  findEpisodeUrl,
  isNovelaPage,
  playerLabel,
  scoreCandidate,
  seasonNumberFromTitle,
  slugifyTitle
} = tlnovelas.__test;

const BASE = 'https://ww2.tlnovelas.net';

assert.strictEqual(slugifyTitle('El Señor De Los Cielos 10'), 'el-senor-de-los-cielos-10');
assert.deepStrictEqual(
  buildSearchTitles('El señor de los cielos', 'The Lord of the Skies', 10),
  [
    'El señor de los cielos 10',
    'El señor de los cielos',
    'The Lord of the Skies 10',
    'The Lord of the Skies'
  ],
  'seasoned novelas are searched by their TLNovelas title first'
);
assert.deepStrictEqual(
  buildSearchTitles('El Señor De Los Cielos 10', 'El Señor De Los Cielos', 10).slice(0, 2),
  ['El Señor De Los Cielos 10', 'El Señor De Los Cielos'],
  'already-numbered TLNovelas titles are not doubled'
);

const searchHtml = `
  <div class="vk-poster">
    <a href="${BASE}/novela/el-senor-de-los-cielos-10/" title="Ver capitulos de El Señor De Los Cielos 10">
      <div class="vk-info"><p>El Señor De Los Cielos 10</p></div>
    </a>
  </div>
  <a href="${BASE}/novela/el-senor-de-los-cielos/" title="Ver capitulos de El Señor De Los Cielos">Wrong</a>
`;

const results = extractSearchResults(searchHtml);
assert.strictEqual(results.length, 2, 'search parser collects novela links');
assert.ok(
  scoreCandidate(results[0], 'El Señor De Los Cielos 10', 'El Señor De Los Cielos 10') >
  scoreCandidate(results[1], 'El Señor De Los Cielos 10', 'El Señor De Los Cielos 10'),
  'exact numbered novela title beats the older base title'
);

const seriesHtml = `
  <a class="list-link" href="${BASE}/ver/el-senor-de-los-cielos-10-capitulo-18/" title="Ver El Señor De Los Cielos 10 Capítulo 18 online">Capitulo 18</a>
  <a class="list-link" href="${BASE}/ver/el-senor-de-los-cielos-10-capitulo-17/" title="Ver El Señor De Los Cielos 10 Capítulo 17 online">Capitulo 17</a>
`;
assert.strictEqual(
  findEpisodeUrl(seriesHtml, `${BASE}/novela/el-senor-de-los-cielos-10/`, 17),
  `${BASE}/ver/el-senor-de-los-cielos-10-capitulo-17/`,
  'episode finder selects the requested capitulo'
);

const episodeHtml = `
  <iframe src="https://example.com/e/from-iframe"></iframe>
  <script>
    $(function(){var e=[];e[0]='https://filemoon.to/e/abc',e[1]='https://voe.sx/e/xyz';});
  </script>
`;
assert.deepStrictEqual(
  extractPlayerUrls(episodeHtml, `${BASE}/ver/example-capitulo-1/`),
  [
    'https://example.com/e/from-iframe',
    'https://filemoon.to/e/abc',
    'https://voe.sx/e/xyz'
  ],
  'player extractor reads iframes and TLNovelas script arrays'
);

// The site files each season as its own novela, so a page without the season number
// is season 1 — serving its capítulo under a season-10 request is the wrong episode,
// however well the words match.
const seasonResults = [
  { url: `${BASE}/novela/el-senor-de-los-cielos/`, title: 'El señor de los cielos' },
  { url: `${BASE}/novela/el-senor-de-los-cielos-10/`, title: 'El Señor De Los Cielos 10' },
  { url: `${BASE}/novela/el-senor-de-los-cielos-8/`, title: 'El Señor De Los Cielos 8' }
];

assert.strictEqual(
  scoreCandidate(seasonResults[0], 'El señor de los cielos', 'El señor de los cielos', [], 10),
  0,
  'the unnumbered novela is not offered for a later season'
);
assert.ok(
  scoreCandidate(seasonResults[1], 'El señor de los cielos', 'El señor de los cielos', [], 10) > 0,
  'the season-10 novela still matches a search made under the plain title'
);
assert.strictEqual(
  scoreCandidate(seasonResults[2], 'El señor de los cielos', 'El señor de los cielos', [], 10),
  0,
  'a different season scores nothing'
);
assert.strictEqual(
  scoreCandidate(seasonResults[1], 'El señor de los cielos', 'El señor de los cielos', [], 1),
  0,
  'a numbered novela is not offered for season 1'
);
assert.ok(
  scoreCandidate(seasonResults[1], 'El Señor De Los Cielos 10', 'El Señor De Los Cielos', [], 1) > 0,
  'a season named by the title itself is honoured when the request says season 1'
);

assert.strictEqual(seasonNumberFromTitle('Rosario Tijeras 5'), 5);
assert.strictEqual(seasonNumberFromTitle('Rubi 2020'), null, 'a year is part of the name, not a season');
assert.strictEqual(seasonNumberFromTitle('La gata'), null);

// The older layout stores a bare id plus the server digit its v_ideo() helper maps
// to a host; read literally it resolved against the episode page and 404'd.
assert.strictEqual(expandPlayerEntry('bLLNfskCqRvm|1'), 'https://hqq.to/e/bLLNfskCqRvm');
assert.strictEqual(expandPlayerEntry('OwVg9ntGyXkJ|2'), 'https://dood.yt/e/OwVg9ntGyXkJ');
assert.strictEqual(expandPlayerEntry('U58IVO4sXqge|3'), 'https://player.ojearanime.com/e/U58IVO4sXqge');
assert.strictEqual(expandPlayerEntry('kYDDc12qz9bi|4'), 'https://player.vernovelastv.net/e/kYDDc12qz9bi');
assert.strictEqual(
  expandPlayerEntry('https://hqq.tv/e/0ZufKlK2RSmM'),
  'https://hqq.tv/e/0ZufKlK2RSmM',
  'entries that are already URLs are left alone'
);
assert.strictEqual(
  expandPlayerEntry('abc|9'),
  'abc|9',
  'an unmapped server digit is left for the URL parser to reject'
);

assert.deepStrictEqual(
  extractPlayerUrls(
    `<script>$(function(){var e=[];e[0]='bLLNfskCqRvm|1',e[1]='http://gamovideo.com/embed-rzirp12eh7i1.html';});</script>`,
    `${BASE}/ver/me-robaste-el-corazon-capitulo-142/`
  ),
  ['https://hqq.to/e/bLLNfskCqRvm', 'http://gamovideo.com/embed-rzirp12eh7i1.html'],
  'shorthand entries become real embed URLs'
);

const adPage = `
  <script src="https://jsc.adskeeper.com/t/l/tlnovelas.net.973671.js" async></script>
  <script>var cfg = {url: 'https://ads.example.com/track/pixel', file: 'https://tracker.example.net/beacon'};</script>
  <script>$(function(){var e=[];e[0]='https://luluvdo.com/e/d8s1amdy60sb';});</script>
  <a href="${BASE}/novela/duena-de-mi/">Ver capitulos</a>
`;
const adPageUrls = extractPlayerUrls(adPage, `${BASE}/ver/duena-de-mi-capitulo-3/`);
assert.strictEqual(adPageUrls[0], 'https://luluvdo.com/e/d8s1amdy60sb', 'real players come first');
assert.ok(
  !adPageUrls.some((url) => url.includes('tlnovelas.net') || url.endsWith('.js')),
  'the site\'s own pages and script tags are not fetched as players'
);

// Some layouts number the episode only in the href.
assert.strictEqual(episodeNumberFromText('/ver/el-senor-de-los-cielos-10-capitulo-17/'), 17);
assert.strictEqual(episodeNumberFromText('Capítulo 17'), 17);
assert.strictEqual(
  findEpisodeUrl(
    `<a href="${BASE}/ver/la-gata-capitulo-9/"></a><a href="${BASE}/ver/la-gata-capitulo-8/"></a>`,
    `${BASE}/novela/la-gata/`,
    8
  ),
  `${BASE}/ver/la-gata-capitulo-8/`,
  'an episode link with no text is matched on its href'
);

// The site answers 200 with a shell page for novelas it does not have.
assert.strictEqual(isNovelaPage('<html><body>No encontrado</body></html>'), false);
assert.strictEqual(isNovelaPage(`<a href="${BASE}/ver/la-gata-capitulo-1/">Capitulo 1</a>`), true);

assert.strictEqual(playerLabel('https://iplayerhls.com/e/abc'), 'Iplayerhls');
assert.strictEqual(playerLabel('https://player.vernovelastv.net/e/abc'), 'Vernovelastv');

console.log('TLNovelas tests passed');

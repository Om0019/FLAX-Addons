const assert = require('assert');
const tlnovelas = require('./src/scrapers/tlnovelas');

const {
  extractPlayerUrls,
  extractSearchResults,
  buildSearchTitles,
  findEpisodeUrl,
  scoreCandidate,
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

console.log('TLNovelas tests passed');

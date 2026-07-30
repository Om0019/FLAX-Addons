const assert = require('assert');
const novelas360 = require('./src/scrapers/novelas360');

const {
  buildSearchTitles,
  episodeNumberFromText,
  extractEpisodeResults,
  extractPlayerUrls,
  scoreEpisodeCandidate,
  slugifyTitle,
  titleWithoutEpisode
} = novelas360.__test;

assert.deepStrictEqual(
  buildSearchTitles('El señor de los cielos', 'El Señor de los Cielos', 10, []),
  ['El señor de los cielos 10', 'El señor de los cielos'],
  'seasoned novelas are searched by their season title first'
);

assert.strictEqual(slugifyTitle('Mañana es para siempre'), 'manana-es-para-siempre');
assert.strictEqual(episodeNumberFromText('Lo Que La Vida Me Robo Capitulo 196 -FINAL'), 196);
assert.strictEqual(titleWithoutEpisode('Lo Que La Vida Me Robo Capitulo 196 -FINAL'), 'Lo Que La Vida Me Robo');

const searchHtml = `
  <article class="post">
    <a href="https://novelas360.com/video/lo-que-la-vida-me-robo-capitulo-2-1/">
      <img alt="Lo Que La Vida Me Robo">
    </a>
    <h3>Lo Que La Vida Me Robo Capitulo 2</h3>
  </article>
  <article class="post">
    <a href="https://novelas360.com/video/otra-novela-capitulo-2-1/"></a>
    <h3>Otra Novela Capitulo 2</h3>
  </article>
`;

const results = extractEpisodeResults(searchHtml);
assert.strictEqual(results.length, 2);
assert.strictEqual(results[0].title, 'Lo Que La Vida Me Robo Capitulo 2');
assert(
  scoreEpisodeCandidate(results[0], 'Lo que la vida me robo', 'Lo que la vida me robó') > 0,
  'matching title and slug receive a positive score'
);
assert(scoreEpisodeCandidate(results[0], 'Lo que la vida me robo', 'Lo que la vida me robó') > scoreEpisodeCandidate(results[1], 'Lo que la vida me robo', 'Lo que la vida me robó'));

const playerHtml = `
  <iframe src="https://novelas360.cyou/player/embed_player.php?vid=abc&autoplay=no"></iframe>
  <script>var file = 'https://cdn.example.test/video/master.m3u8';</script>
`;

assert.deepStrictEqual(
  extractPlayerUrls(playerHtml, 'https://novelas360.com/video/lo-que-la-vida-me-robo-capitulo-1-1/'),
  [
    'https://novelas360.cyou/player/embed_player.php?vid=abc&autoplay=no',
    'https://cdn.example.test/video/master.m3u8'
  ],
  'player extractor reads iframe and script URLs'
);

console.log('Novelas360 tests passed');

const assert = require('assert');
const novelas360 = require('./src/scrapers/novelas360');

const {
  buildSearchTitles,
  episodeNumberFromText,
  episodeUrlCandidates,
  extractEpisodeResults,
  extractPlayerUrls,
  isPlayableCandidate,
  playerLabel,
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

// Only some novelas carry the duplicate-slug "-1" suffix; probing for it alone
// missed every novela filed under the plain URL and fell through to the slow search.
assert.deepStrictEqual(
  episodeUrlCandidates('carrusel', 20),
  [
    'https://novelas360.com/video/carrusel-capitulo-20/',
    'https://novelas360.com/video/carrusel-capitulo-20-1/'
  ],
  'the canonical episode URL is tried before the duplicate-slug variant'
);

// The wrapper appears in two shapes, and newer posts use the one a host-and-query
// check rejected — those episodes extracted their player and then discarded it.
assert.strictEqual(
  isPlayableCandidate('https://novelas360.cyou/e/eHJmTjZSK2V3NDk1NVppOVROSk1rUT09'),
  true,
  'the plain /e/ embed form is playable'
);
assert.strictEqual(
  isPlayableCandidate('https://novelas360.example/player/embed_player.php?vid=abc'),
  true,
  'the embed is recognised by its path, not by the domain it is served from'
);
assert.strictEqual(isPlayableCandidate('https://novelas360.com/wp-content/theme.js'), false);
assert.strictEqual(
  isPlayableCandidate('https://www.youtube.com/watch?v=5TfgESJVonw'),
  false,
  'the trailer and social embeds every post carries are not players'
);

assert.strictEqual(playerLabel('https://novelas360.cyou/player/embed_player.php?vid=abc'), 'Novelas360');

console.log('Novelas360 tests passed');

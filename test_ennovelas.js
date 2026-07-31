const assert = require('assert');
const ennovelas = require('./src/scrapers/ennovelas');

const {
  buildSearchTitles,
  episodeNumberFromText,
  episodeUrlCandidates,
  extractEpisodeResults,
  extractPlayerUrls,
  extractPostWrapperUrls,
  isPlayableCandidate,
  playerLabel,
  scoreEpisodeCandidate,
  slugifyTitle,
  titleWithoutEpisode
} = ennovelas.__test;

const wrapperPayload = Buffer.from(JSON.stringify({
  vk: 'https://vk.com/video_ext.php?oid=848029978&id=456257718',
  uqload: 'https://uqload.net/embed-wnysn1qdhrcd.html'
})).toString('base64');

assert.strictEqual(slugifyTitle('Yo soy Betty, la fea'), 'yo-soy-betty-la-fea');
assert.deepStrictEqual(
  buildSearchTitles('El Señor De Los Cielos', 'El senor de los cielos', 10, ['Lord of the Skies']),
  ['El Señor De Los Cielos 10', 'El Señor De Los Cielos', 'Lord of the Skies 10', 'Lord of the Skies']
);
assert.strictEqual(episodeNumberFromText('Yo soy Betty, la fea Capitulo 335 Final'), 335);
assert.strictEqual(episodeNumberFromText('Ep 12'), 12);
assert.strictEqual(titleWithoutEpisode('Yo soy Betty, la fea Capitulo 1'), 'Yo soy Betty, la fea');
assert.deepStrictEqual(episodeUrlCandidates('yo-soy-betty-la-fea', 1), [
  'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1/',
  'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1-final/',
  'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-episodio-1/'
]);

assert.deepStrictEqual(extractPostWrapperUrls(`https://manaw.top/novel.php?post=${wrapperPayload}`), [
  'https://vk.com/video_ext.php?oid=848029978&id=456257718',
  'https://uqload.net/embed-wnysn1qdhrcd.html'
]);

const html = `
  <article><a href="https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1/" title="Yo soy Betty, la fea Capitulo 1">Ep 1</a></article>
  <a href="https://manaw.top/novel.php?post=${wrapperPayload}">Ver Capitulo</a>
  <meta name="twitter:player" content="https://l.ennovelas-tv.com/emb/?vid=64027">
`;

assert.deepStrictEqual(extractEpisodeResults(html), [
  { url: 'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1/', title: 'Yo soy Betty, la fea Capitulo 1' }
]);

assert.deepStrictEqual(extractPlayerUrls(html, 'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1/'), [
  'https://vk.com/video_ext.php?oid=848029978&id=456257718',
  'https://uqload.net/embed-wnysn1qdhrcd.html'
]);

assert.strictEqual(isPlayableCandidate('https://vk.com/video_ext.php?oid=1&id=2'), true);
assert.strictEqual(isPlayableCandidate('https://uqload.net/embed-abc.html'), true);
assert.strictEqual(isPlayableCandidate('https://l.ennovelas-tv.com/emb/?vid=64027'), false);
assert.strictEqual(playerLabel('https://uqload.net/embed-abc.html'), 'Uqload');
assert.ok(scoreEpisodeCandidate({
  url: 'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1/',
  title: 'Yo soy Betty, la fea Capitulo 1'
}, 'Yo soy Betty, la fea', '', []) > 0);

console.log('Ennovelas tests passed');

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
  normalizePlayerUrl,
  playerLabel,
  scoreEpisodeCandidate,
  seasonFromText,
  seasonSlugStems,
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
// The site's sitemap has no -episodio- episodes at all, so that candidate is gone
// and the budget it used goes to the season shapes below.
assert.deepStrictEqual(episodeUrlCandidates('yo-soy-betty-la-fea', 1), [
  'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1/',
  'https://l.ennovelas-tv.com/yo-soy-betty-la-fea-capitulo-1-final/'
]);

// Both spellings the site uses for a season.
assert.deepStrictEqual(seasonSlugStems('senora-acero', 4), [
  'senora-acero-4-temporada',
  'senora-acero-temporada-4'
]);
// Season 1 is numbered in the slug too, and search cannot reach it on a long
// running show, so it gets stems as well — the caller orders them behind the
// plain slug.
assert.deepStrictEqual(seasonSlugStems('40-y-20', 1), [
  '40-y-20-1-temporada',
  '40-y-20-temporada-1'
]);
assert.deepStrictEqual(seasonSlugStems('yo-soy-betty-la-fea', null), []);
assert.deepStrictEqual(seasonSlugStems('yo-soy-betty-la-fea', 0), []);
assert.deepStrictEqual(seasonSlugStems('', 4), []);

assert.strictEqual(seasonFromText('40 y 20 Temporada 7 Capitulo 12 Final'), 7);
assert.strictEqual(seasonFromText('senora-acero-5-temporada-capitulo-69'), 5);
assert.strictEqual(seasonFromText('Yo soy Betty, la fea Capitulo 1'), null);

// A result from another season is the wrong episode, not a weaker match.
const fortyTwentyS7 = {
  url: 'https://l.ennovelas-tv.com/40-y-20-temporada-7-capitulo-12-final/',
  title: '40 y 20 Temporada 7 Capitulo 12 Final'
};
const fortyTwentyS1 = {
  url: 'https://l.ennovelas-tv.com/40-y-20-temporada-1-capitulo-12/',
  title: '40 y 20 Temporada 1 Capitulo 12'
};
assert.ok(scoreEpisodeCandidate(fortyTwentyS7, '40 y 20', '', [], 7) > 0);
assert.strictEqual(scoreEpisodeCandidate(fortyTwentyS1, '40 y 20', '', [], 7), -1);
// With no season asked for, neither is disqualified.
assert.ok(scoreEpisodeCandidate(fortyTwentyS1, '40 y 20', '', [], null) > 0);

// The doubled embed prefix the wrapper payloads carry is a 404 on every uqload
// mirror; the single-prefix form serves the stream.
assert.strictEqual(
  normalizePlayerUrl('https://uqload.co/embed-embed-bpfry83xace0.html'),
  'https://uqload.co/embed-bpfry83xace0.html'
);
assert.strictEqual(
  normalizePlayerUrl('https://uqload.co/embed-bpfry83xace0.html'),
  'https://uqload.co/embed-bpfry83xace0.html'
);
// VK watch pages carry no player config; only the embed endpoint does.
assert.strictEqual(
  normalizePlayerUrl('https://vk.com/video786886391_456242431'),
  'https://vk.com/video_ext.php?oid=786886391&id=456242431'
);
assert.strictEqual(
  normalizePlayerUrl('https://vk.com/video_ext.php?oid=848029978&id=456257718'),
  'https://vk.com/video_ext.php?oid=848029978&id=456257718'
);

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

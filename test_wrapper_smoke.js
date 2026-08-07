const { getStreams } = require('./src/scrapers');

const cases = [
  { type: 'movie', id: 'tmdb:movie:299534', label: 'Avengers: Endgame' },
  { type: 'movie', id: 'tmdb:movie:1061474', label: 'Superman (2025)' },
  { type: 'movie', id: 'tmdb:movie:533535', label: 'Deadpool & Wolverine' },
  { type: 'movie', id: 'tmdb:movie:550', label: 'Fight Club' },
  { type: 'series', id: 'tmdb:series:100088', label: 'The Last of Us S1E1', season: 1, episode: 1 },
  { type: 'series', id: 'tmdb:series:1396', label: 'Breaking Bad S2E1', season: 2, episode: 1 },
  { type: 'series', id: 'tmdb:series:94997', label: 'House of the Dragon S1E1', season: 1, episode: 1 }
];

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

function mediaKind(url) {
  if (/\.m3u8(?:$|[?#])/i.test(url)) return 'hls';
  if (/\.(?:mp4|mkv|bin)(?:$|[?#])/i.test(url)) return 'file';
  return 'other';
}

async function run() {
  for (const item of cases) {
    console.log(`\n=== ${item.label} (${item.type}) ===`);
    const streams = await getStreams(item.type, item.id, item.season, item.episode);
    console.log(`streams=${streams.length}`);

    for (const [index, stream] of streams.entries()) {
      console.log([
        `${index + 1}.`,
        stream.name,
        JSON.stringify(stream.title),
        mediaKind(stream.url),
        hostOf(stream.url)
      ].join(' '));
      console.log(`   ${stream.url}`);
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

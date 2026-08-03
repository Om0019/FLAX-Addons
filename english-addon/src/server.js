const express = require('express');
const cors = require('cors');
const { findByImdbId } = require('./tmdb');
const { PROVIDERS, fetchAllStreams } = require('./providers');
const { extractContainer, extractResolution, formatStreamName, formatStreamDescription } = require('./stream-template');
const { curateStreams } = require('./curate');

const app = express();
app.use(cors());

const MANIFEST = {
  id: 'org.stremio.english-addon',
  version: '1.0.0',
  name: 'English',
  description: `English-language movies and TV, aggregated from: ${PROVIDERS.map((p) => p.name).join(', ')}`,
  resources: ['stream'],
  types: ['movie', 'series'],
  idPrefixes: ['tt'],
  catalogs: []
};

app.get('/manifest.json', (req, res) => {
  res.json(MANIFEST);
});

function normalizeStream(raw, providerName) {
  const behaviorHints = { notWebReady: true };
  if (raw.headers && Object.keys(raw.headers).length > 0) {
    behaviorHints.proxyHeaders = { request: raw.headers };
  }

  return {
    name: formatStreamName(MANIFEST.name, raw.__cached === true),
    title: formatStreamDescription({
      indexer: providerName,
      container: extractContainer(raw.url),
      resolution: extractResolution(raw)
    }),
    url: raw.url,
    behaviorHints
  };
}

app.get('/stream/:type/:id.json', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id;

  if (type !== 'movie' && type !== 'series') {
    return res.status(400).json({ err: 'Unsupported type' });
  }

  const [imdbId, seasonStr, episodeStr] = id.split(':');
  if (!/^tt\d+$/.test(imdbId)) {
    return res.status(400).json({ err: 'Unsupported id format' });
  }

  const season = type === 'series' ? Number(seasonStr) : null;
  const episode = type === 'series' ? Number(episodeStr) : null;
  if (type === 'series' && (!Number.isInteger(season) || !Number.isInteger(episode))) {
    return res.status(400).json({ err: 'Missing season/episode' });
  }

  try {
    const tmdb = await findByImdbId(imdbId, type);
    if (!tmdb) {
      console.log(`English addon: no TMDB match for ${imdbId}`);
      return res.json({ streams: [] });
    }

    const mediaType = type === 'series' ? 'tv' : 'movie';
    const results = await fetchAllStreams(tmdb.id, mediaType, season, episode);

    const entries = results.flatMap(({ providerId, providerName, streams: providerStreams }) =>
      providerStreams.map((raw) => ({ providerId, providerName, raw, resolution: extractResolution(raw) }))
    );
    const curated = curateStreams(entries);
    const streams = curated.map(({ raw, providerName }) => normalizeStream(raw, providerName));

    console.log(`English addon: ${imdbId} (${type}) -> ${streams.length} stream(s) (${entries.length} before curation) from ${results.filter((r) => r.streams.length > 0).length}/${results.length} providers`);
    res.json({ streams });
  } catch (error) {
    console.error(`English addon: stream lookup failed for ${id}:`, error.message);
    res.status(500).json({ err: 'Internal error' });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', manifest: '/manifest.json' });
});

module.exports = app;

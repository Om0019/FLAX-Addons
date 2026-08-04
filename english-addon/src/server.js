const express = require('express');
const cors = require('cors');
const { findByImdbId } = require('./tmdb');
const { PROVIDERS, fetchAllStreams, diagnoseTorrentio } = require('./providers');
const { extractContainer, extractResolution, formatStreamName, formatStreamDescription } = require('./stream-template');
const { curateStreams, resolutionTier } = require('./curate');

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

function parseStreamRequest(type, id) {
  if (type !== 'movie' && type !== 'series') {
    return { error: 'Unsupported type' };
  }

  const [imdbId, seasonStr, episodeStr] = id.split(':');
  if (!/^tt\d+$/.test(imdbId)) {
    return { error: 'Unsupported id format' };
  }

  const season = type === 'series' ? Number(seasonStr) : null;
  const episode = type === 'series' ? Number(episodeStr) : null;
  if (type === 'series' && (!Number.isInteger(season) || !Number.isInteger(episode))) {
    return { error: 'Missing season/episode' };
  }

  return { imdbId, season, episode };
}

// This route is deliberately not advertised in the manifest. It returns only
// aggregate diagnostics: never source URLs, hashes, or debrid credentials.
app.get('/diagnostics/torrentio/:type/:id.json', async (req, res) => {
  const parsed = parseStreamRequest(req.params.type, req.params.id);
  if (parsed.error) return res.status(400).json({ err: parsed.error });

  try {
    const tmdb = await findByImdbId(parsed.imdbId, req.params.type);
    if (!tmdb) return res.status(404).json({ err: 'TMDB match not found' });

    const mediaType = req.params.type === 'series' ? 'tv' : 'movie';
    const torrentio = await diagnoseTorrentio(parsed.imdbId, mediaType, parsed.season, parsed.episode);
    return res.json({
      imdbId: parsed.imdbId,
      tmdbId: tmdb.id,
      mediaType,
      season: parsed.season,
      episode: parsed.episode,
      torrentio
    });
  } catch (error) {
    console.error(`English addon: Torrentio diagnostics failed for ${req.params.id}:`, error.message);
    return res.status(500).json({ err: 'Internal error' });
  }
});

function normalizeStream(raw, providerName) {
  const behaviorHints = { notWebReady: true };
  if (raw.headers && Object.keys(raw.headers).length > 0) {
    behaviorHints.proxyHeaders = { request: raw.headers };
  }

  return {
    name: formatStreamName(providerName, raw.__cached === true),
    title: formatStreamDescription({
      language: 'English',
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

  const parsed = parseStreamRequest(type, id);
  if (parsed.error) return res.status(400).json({ err: parsed.error });
  const { imdbId, season, episode } = parsed;

  try {
    const tmdb = await findByImdbId(imdbId, type);
    if (!tmdb) {
      console.log(`English addon: no TMDB match for ${imdbId}`);
      return res.json({ streams: [] });
    }

    const mediaType = type === 'series' ? 'tv' : 'movie';
    const results = await fetchAllStreams(tmdb.id, imdbId, mediaType, season, episode);

    const entries = results.flatMap(({ providerId, providerName, streams: providerStreams }) =>
      providerStreams.map((raw) => ({ providerId, providerName, raw, resolution: extractResolution(raw) }))
    );
    // Torrentio is an additional cached-debrid option, not one of the two
    // regular provider slots per resolution. Keep its first 4K and 1080p
    // result, then curate all other providers independently at two distinct
    // indexers per tier.
    const torrentioEntries = entries.filter((entry) => entry.providerId === 'torrentio');
    const torrentioCurated = ['2160p', '1080p'].flatMap((tier) => {
      const stream = torrentioEntries.find((entry) => resolutionTier(entry.resolution) === tier);
      return stream ? [stream] : [];
    });
    const curated = [
      ...torrentioCurated,
      ...curateStreams(entries.filter((entry) => entry.providerId !== 'torrentio'))
    ];
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

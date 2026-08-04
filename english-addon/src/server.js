const express = require('express');
const cors = require('cors');
const { findByImdbId } = require('./tmdb');
const { PROVIDERS, fetchAllStreams, diagnoseTorrentio } = require('./providers');
const { extractContainer, extractResolution, formatStreamName, formatStreamDescription } = require('./stream-template');
const { curateStreams, curationRunnersUp, resolutionTier } = require('./curate');
const { STREAM_PROBE_TIMEOUT_MS, filterPlayableStreamsWithBackfill } = require('./stream-probe');

const app = express();
app.use(cors());

// Ceiling on one stream lookup, measured from the moment the request arrives.
// Every deadline below it was independent, so the worst case was their sum:
// TMDB, then Torrentio's own fetch, then the TorBox cache check, then the
// probes — around 19s, past the point where a Stremio client has given up and
// the whole response is wasted. The probe phase draws on what is left of this
// rather than starting a fresh clock.
const REQUEST_BUDGET_MS = 12000;
// Below this there is no point starting another probe: it would abort on arrival
// and, because a timed-out probe is kept rather than dropped, teach us nothing.
const MIN_PROBE_BUDGET_MS = 400;

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

/**
 * Two providers reaching the same CDN link is ordinary — several of these
 * resolve through shared hosts — and without this the same link was offered
 * twice, taking two of the viewer's slots to say one thing. First occurrence
 * wins, so the higher-ranked provider keeps the attribution.
 */
function dedupeByUrl(entries) {
  const seen = new Set();
  return entries.filter((entry) => {
    const url = entry.raw?.url;
    if (!url || seen.has(url)) return false;
    seen.add(url);
    return true;
  });
}

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
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS;

  try {
    const tmdb = await findByImdbId(imdbId, type);
    if (!tmdb) {
      console.log(`English addon: no TMDB match for ${imdbId}`);
      return res.json({ streams: [] });
    }

    const mediaType = type === 'series' ? 'tv' : 'movie';
    const results = await fetchAllStreams(tmdb.id, imdbId, mediaType, season, episode);

    const entries = dedupeByUrl(results.flatMap(({ providerId, providerName, streams: providerStreams }) =>
      providerStreams.map((raw) => ({ providerId, providerName, raw, resolution: extractResolution(raw) }))
    ));
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
    // Do not expose a link simply because its provider returned it. A bounded
    // byte-range probe verifies the final, curated links (including their
    // required request headers) before Stremio sees them — and refills from what
    // curation set aside when a pick turns out to be dead, so a tier whose two
    // candidates both fail does not vanish from the response.
    const reserve = curationRunnersUp(entries, curated);
    const probeBudgetMs = deadlineAt - Date.now();
    const playable = probeBudgetMs >= MIN_PROBE_BUDGET_MS
      ? await filterPlayableStreamsWithBackfill(curated, reserve, {
        target: curated.length,
        deadlineAt,
        timeoutMs: Math.min(STREAM_PROBE_TIMEOUT_MS, probeBudgetMs)
      })
      : curated;

    if (probeBudgetMs < MIN_PROBE_BUDGET_MS) {
      console.warn(`English addon: ${imdbId} used its ${REQUEST_BUDGET_MS}ms budget before probing; returning curated streams unverified.`);
    }

    const streams = playable.map(({ raw, providerName }) => normalizeStream(raw, providerName));

    console.log(`English addon: ${imdbId} (${type}) -> ${streams.length} playable stream(s) (${entries.length} before curation) from ${results.filter((r) => r.streams.length > 0).length}/${results.length} providers`);
    res.json({ streams });
  } catch (error) {
    // An empty list, not a 500. Stremio renders a failed stream request as an
    // error in the UI; no results is the honest and far less disruptive answer,
    // and it is what the Latino addon on the same deployment already does.
    console.error(`English addon: stream lookup failed for ${id}:`, error.message);
    res.json({ streams: [] });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'ok', manifest: '/manifest.json' });
});

module.exports = app;

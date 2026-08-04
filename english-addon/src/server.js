const express = require('express');
const cors = require('cors');
const { findByImdbId } = require('./tmdb');
const { PROVIDERS, fetchAllStreams, fetchTorrentioCachedStreams, diagnoseTorrentio } = require('./providers');
const { extractResolution } = require('./stream-template');
const { curateStreams, curateTorrentioStreams } = require('./curate');
const { dedupeByUrl, isProbeable, normalizeStream } = require('./response');
const { STREAM_PROBE_TIMEOUT_MS, selectPlayableStreams } = require('./stream-probe');

const app = express();
app.use(cors());

// Ceiling on one stream lookup, measured from the moment the request arrives.
// Torrentio (fetch + TorBox cache check) now runs from the very start,
// parallel with TMDB and the other providers, rather than serialized after
// TMDB resolves - so it draws on this same clock rather than adding its own
// on top. The probe phase draws on what's left of this rather than starting
// a fresh clock either.
const REQUEST_BUDGET_MS = 12000;
// Below this there is no point starting another probe: it would abort on arrival
// and, because a timed-out probe is kept rather than dropped, teach us nothing.
const MIN_PROBE_BUDGET_MS = 400;
// Held back from the provider phase so the probes always get a turn. Probing is
// what keeps dead links out of the response, and it was the first thing to be
// squeezed out whenever the providers ran long — exactly when a response is
// most likely to contain something broken.
const PROBE_RESERVE_MS = 2500;

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

app.get('/stream/:type/:id.json', async (req, res) => {
  const { type } = req.params;
  const id = req.params.id;

  const parsed = parseStreamRequest(type, id);
  if (parsed.error) return res.status(400).json({ err: parsed.error });
  const { imdbId, season, episode } = parsed;
  const deadlineAt = Date.now() + REQUEST_BUDGET_MS;
  const mediaType = type === 'series' ? 'tv' : 'movie';

  // Torrentio is keyed on the IMDb id alone, unlike every other provider here,
  // which needs the TMDB id below. Starting it now, rather than after the TMDB
  // lookup resolves, hands it the full request budget instead of whatever was
  // left over — TMDB's own timeout is up to 3s, and that used to be dead time
  // on Torrentio's clock before it had even sent a request. Never rejects, so
  // there is nothing to catch here; a TMDB miss below simply leaves this
  // promise unawaited, which is harmless since it settles on its own.
  const torrentioPromise = fetchTorrentioCachedStreams(imdbId, mediaType, season, episode, {
    timeoutMs: deadlineAt - Date.now() - PROBE_RESERVE_MS
  });

  try {
    const tmdb = await findByImdbId(imdbId, type);
    if (!tmdb) {
      console.log(`English addon: no TMDB match for ${imdbId}`);
      return res.json({ streams: [] });
    }

    const [torrentioResult, otherResults] = await Promise.all([
      torrentioPromise,
      fetchAllStreams(tmdb.id, imdbId, mediaType, season, episode, {
        timeoutMs: deadlineAt - Date.now() - PROBE_RESERVE_MS,
        includeTorrentio: false
      })
    ]);
    const results = [torrentioResult, ...otherResults];

    const entries = dedupeByUrl(results.flatMap(({ providerId, providerName, streams: providerStreams }) =>
      providerStreams.map((raw) => ({ providerId, providerName, raw, resolution: extractResolution(raw) }))
    ));
    // Torrentio is an additional cached-debrid option, not one of the five
    // regular-provider slots, and is curated separately from them - see
    // curateTorrentioStreams in curate.js for why it isn't collapsed to one
    // entry the way every other provider is.
    //
    // Expressed as a function of the still-viable entries rather than computed
    // once, because the probe below re-runs it after dropping dead links. That
    // is what keeps both limits true of the final response and not merely of
    // the first guess at it.
    const curate = (available) => [
      ...curateTorrentioStreams(available.filter((entry) => entry.providerId === 'torrentio')),
      ...curateStreams(available.filter((entry) => entry.providerId !== 'torrentio'))
    ];

    // Do not expose a link simply because its provider returned it. A bounded
    // byte-range probe verifies the curated links (including their required
    // request headers) before Stremio sees them, and curation re-runs over what
    // survived, so a tier whose candidates all fail is refilled from the same
    // tier rather than left empty.
    const probeBudgetMs = deadlineAt - Date.now();
    const playable = probeBudgetMs >= MIN_PROBE_BUDGET_MS
      ? await selectPlayableStreams(entries, curate, {
        deadlineAt,
        shouldProbe: isProbeable,
        timeoutMs: Math.min(STREAM_PROBE_TIMEOUT_MS, probeBudgetMs)
      })
      : curate(entries);

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

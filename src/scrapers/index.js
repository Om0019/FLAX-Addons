const tmdb = require('../tmdb');
const sololatino = require('./sololatino');
const cinecalidad = require('./cinecalidad');
const tioplus = require('./tioplus');
const cinehdplus = require('./cinehdplus');
const cuevana3i = require('./cuevana3i');
const lamovie = require('./lamovie');
const pelispedia = require('./pelispedia');
const { fetchTextWithTimeout, normalizeUrl } = require('../http');
const { hasBlockedIpLiteralHost } = require('../net-guard');
const { createTtlCache } = require('../ttl-cache');

const SCRAPER_TIMEOUT_MS = 10000;
const SOLOLATINO_TIMEOUT_MS = 12000;
const SCRAPER_COLLECTION_TIMEOUT_MS = 11500;
const EMPTY_RESULT_GRACE_MS = 3500;
// Return as soon as this many sources have produced this many streams between
// them. Requiring two sources rather than one keeps the early exit from simply
// handing back whichever source happens to be quickest. Five streams rather than
// three costs about 190ms and was measured to restore the result count to what
// the old 3500ms wait produced, while more than halving the number of lookups
// that come back with a single option.
const FAST_SOURCE_MIN_STREAMS = 5;
const FAST_SOURCE_MIN_SOURCES = 2;
// If two sources have not delivered by this point, accept one. This is a
// relaxation deadline, not a floor: the two-source exit above is live from the
// first completion onwards.
const FAST_SOURCE_MIN_WAIT_MS = 3500;
const FAST_SOURCE_RELAXED_MIN_SOURCES = 1;
// A single probe must be able to finish inside the phase budget below, or a slow
// host guarantees the phase times out instead of ever completing. It used to be
// 5000ms against a 4000ms budget, which is why validation so often burned its
// whole allowance and still returned fewer streams than it wanted. Measured across
// three settings, tightening these changed no stream counts, so the headroom was
// pure latency.
const STREAM_VALIDATION_TIMEOUT_MS = 2800;
const STREAM_VALIDATION_TOTAL_TIMEOUT_MS = 3200;
const STREAM_VALIDATION_FAST_TIMEOUT_MS = 2400;
const MIN_CONFIRMED_STREAMS = 3;
const MAX_VALIDATION_CANDIDATES = 8;
const STREAM_CACHE_TTL_MS = 10 * 60 * 1000;
const EMPTY_STREAM_CACHE_TTL_MS = 15 * 1000;
const ENABLE_CINEHDPLUS = false;
const HOST_HEALTH_TTL_MS = 5 * 60 * 1000;
const HOST_DEAD_TTL_MS = 3 * 60 * 1000;
const HOST_HEALTH_MAX_EVENTS = 12;
// Both maps are keyed by unbounded input — every title ever requested, every host
// ever seen — and nothing evicted expired entries, so they grew for the life of the
// process. Sweep on write and cap the total.
const STREAM_CACHE_MAX_ENTRIES = 500;
const HOST_HEALTH_MAX_HOSTS = 500;

const streamCache = createTtlCache({ maxEntries: STREAM_CACHE_MAX_ENTRIES });
const hostHealth = createTtlCache({ maxEntries: HOST_HEALTH_MAX_HOSTS });
const inFlightRequests = new Map();

function getStreamHost(stream) {
  try {
    return new URL(stream.url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function isKnownBadStream(stream) {
  const url = (stream.url || '').toLowerCase();
  const title = (stream.title || '').toLowerCase();
  const name = (stream.name || '').toLowerCase();
  return url.includes('test-videos.co.uk')
    || url.includes('big_buck_bunny')
    || url.includes('magnet:')
    || url.includes('.torrent')
    || url.includes('strp2p.com')
    || title.includes('p2p')
    || title.includes('torrent')
    || name.includes('torrent');
}

function getHostHealth(host) {
  return hostHealth.get(host) || createEmptyHostHealth();
}

function createEmptyHostHealth() {
  return {
    events: [],
    avgLatencyMs: null,
    deadUntil: 0
  };
}

function isHardDeadStatus(status) {
  return [404, 410, 451].includes(status);
}

function isGatewayFailureStatus(status) {
  return [502, 503, 504].includes(status);
}

function recordHostHealth(stream, outcome, details = {}) {
  const host = getStreamHost(stream);
  if (!host) return;

  const current = getHostHealth(host);
  const event = {
    outcome,
    status: details.status || 0,
    latencyMs: details.latencyMs || null,
    at: Date.now()
  };
  const events = [...(current.events || []), event].slice(-HOST_HEALTH_MAX_EVENTS);
  const successfulLatencies = events
    .filter((item) => item.outcome === 'success' && Number.isFinite(item.latencyMs))
    .map((item) => item.latencyMs);
  const avgLatencyMs = successfulLatencies.length > 0
    ? Math.round(successfulLatencies.reduce((total, value) => total + value, 0) / successfulLatencies.length)
    : current.avgLatencyMs;
  const recentFailures = events.filter((item) => item.outcome !== 'success');
  const recentHardFailures = recentFailures.filter((item) => (
    item.outcome === 'hard-fail'
    || isHardDeadStatus(item.status)
  ));
  const recentTimeouts = recentFailures.filter((item) => item.outcome === 'timeout');
  const recentGatewayFailures = recentFailures.filter((item) => (
    item.outcome === 'gateway-fail'
    || isGatewayFailureStatus(item.status)
  ));

  let deadUntil = current.deadUntil || 0;
  if (
    recentHardFailures.length >= 2
    || recentTimeouts.length >= 3
    || recentGatewayFailures.length >= 3
  ) {
    deadUntil = Date.now() + HOST_DEAD_TTL_MS;
  }

  const health = {
    events,
    avgLatencyMs,
    deadUntil
  };

  if (getHostPenalty(health) === 0 && !avgLatencyMs) {
    hostHealth.delete(host);
    return;
  }

  hostHealth.set(host, health, HOST_HEALTH_TTL_MS);
}

function getHostPenalty(health) {
  const events = health.events || [];
  if (events.length === 0) return 0;

  const softFailures = events.filter((event) => event.outcome === 'soft-fail').length;
  const successes = events.filter((event) => event.outcome === 'success').length;
  const timeouts = events.filter((event) => event.outcome === 'timeout').length;
  const hardFailures = events.filter((event) => event.outcome === 'hard-fail' || isHardDeadStatus(event.status)).length;
  const gatewayFailures = events.filter((event) => event.outcome === 'gateway-fail' || isGatewayFailureStatus(event.status)).length;
  const latencyPenalty = health.avgLatencyMs
    ? Math.min(3, Math.floor(Math.max(0, health.avgLatencyMs - 1500) / 1000))
    : 0;
  const deadPenalty = health.deadUntil > Date.now() ? 20 : 0;

  return Math.max(0, softFailures + (timeouts * 2) + (hardFailures * 3) + (gatewayFailures * 2) + latencyPenalty + deadPenalty - successes);
}

function shouldSkipHost(stream) {
  const host = getStreamHost(stream);
  if (!host) return false;
  const health = getHostHealth(host);
  return health.deadUntil > Date.now();
}

function scoreStream(stream) {
  const host = getStreamHost(stream);
  const title = (stream.title || '').toLowerCase();
  const healthPenalty = getHostPenalty(getHostHealth(host));
  let baseScore = 9;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) baseScore = 0;
  else if (host.includes('turboviplay.com')) baseScore = 1;
  else if (host.includes('vimeos')) baseScore = 2;
  else if (host.includes('acek-cdn.com')) baseScore = 3;
  else if (host.includes('dramiyos-cdn.com') || host.includes('cfglobalcdn.com')) baseScore = 4;
  else if (host.includes('mediafire.com') || host.includes('fireload.com')) baseScore = 5;
  else if (host.includes('goodstream')) baseScore = 6;
  else if (host.includes('nupload')) baseScore = 6;
  else if (host.includes('premilkyway.com') || title.includes('hlswish')) baseScore = 7;
  else if (host.includes('cdn-tnmr.org')) baseScore = 8;

  return baseScore + healthPenalty;
}

function getHostFamily(stream) {
  const host = getStreamHost(stream);
  const title = (stream.title || '').toLowerCase();

  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return 'pelisplus-ip';
  if (host.includes('turboviplay.com')) return 'turboviplay';
  if (host.includes('vimeos')) return 'vimeos';
  if (host.includes('acek-cdn.com')) return 'acek-cdn';
  if (host.includes('dramiyos-cdn.com')) return 'dramiyos-cdn';
  if (host.includes('cfglobalcdn.com')) return 'cfglobalcdn';
  if (host.includes('mediafire.com')) return 'mediafire';
  if (host.includes('fireload.com')) return 'fireload';
  if (host.includes('goodstream')) return 'goodstream';
  if (host.includes('nupload')) return 'nupload';
  if (host.includes('premilkyway.com') || title.includes('hlswish')) return 'hlswish';
  if (host.includes('cdn-tnmr.org')) return 'cdn-tnmr';
  return host || 'unknown';
}

function sortStreams(streams) {
  const ranked = [...streams].sort((a, b) => scoreStream(a) - scoreStream(b));
  const byFamily = new Map();

  for (const stream of ranked) {
    const family = getHostFamily(stream);
    if (!byFamily.has(family)) byFamily.set(family, []);
    byFamily.get(family).push(stream);
  }

  const sortedFamilies = [...byFamily.entries()]
    .sort((a, b) => scoreStream(a[1][0]) - scoreStream(b[1][0]));

  const diversified = [];
  while (sortedFamilies.some(([, familyStreams]) => familyStreams.length > 0)) {
    for (const [, familyStreams] of sortedFamilies) {
      const stream = familyStreams.shift();
      if (stream) diversified.push(stream);
    }
  }

  return diversified;
}

function uniqueStreams(streams) {
  const seen = new Set();
  const unique = [];

  for (const stream of streams) {
    const normalizedUrl = normalizeUrl(stream.url);
    if (!normalizedUrl || seen.has(normalizedUrl)) continue;
    seen.add(normalizedUrl);
    unique.push({
      ...stream,
      url: normalizedUrl
    });
  }

  return unique;
}

function withTimeout(promise, timeoutMs, label, onTimeout) {
  let timeoutId;

  const timeoutPromise = new Promise((resolve) => {
    timeoutId = setTimeout(() => {
        console.warn(`${label} timed out after ${timeoutMs}ms`);
        if (onTimeout) onTimeout();
        resolve([]);
      }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutId);
  });
}

async function collectScraperResults(tasks, timeoutMs) {
  const results = [];
  let pending = tasks.length;
  let sourcesRequired = FAST_SOURCE_MIN_SOURCES;
  let resolveFastReturn;

  const hasEnoughStreamsForFastReturn = () => {
    const fulfilledWithStreams = results.filter((result) => (
      result.status === 'fulfilled'
      && Array.isArray(result.value)
      && result.value.length > 0
    ));
    const streamCount = fulfilledWithStreams.reduce((total, result) => total + result.value.length, 0);
    return fulfilledWithStreams.length >= sourcesRequired
      && streamCount >= FAST_SOURCE_MIN_STREAMS;
  };

  let fastReturnTimer;
  const fastReturnPromise = new Promise((resolve) => {
    resolveFastReturn = resolve;
    fastReturnTimer = setTimeout(() => {
      // Two sources have not turned up in time; one will do.
      sourcesRequired = FAST_SOURCE_RELAXED_MIN_SOURCES;
      if (hasEnoughStreamsForFastReturn()) {
        resolve('enough-streams');
      }
    }, FAST_SOURCE_MIN_WAIT_MS);
  });

  const trackedTasks = tasks.map((task) => (
    task.promise
      .then((value) => ({ status: 'fulfilled', value, name: task.name }))
      .catch((reason) => ({ status: 'rejected', reason, name: task.name }))
      .then((result) => {
        results.push(result);
        pending -= 1;
        if (hasEnoughStreamsForFastReturn()) {
          resolveFastReturn('enough-streams');
        }
        return result;
      })
  ));

  let collectionTimer;
  const allCompletePromise = Promise.all(trackedTasks).then(() => 'complete');
  const completionReason = await Promise.race([
    allCompletePromise,
    new Promise((resolve) => {
      collectionTimer = setTimeout(() => resolve('timeout'), timeoutMs);
    }),
    fastReturnPromise
  ]);

  clearTimeout(fastReturnTimer);
  clearTimeout(collectionTimer);

  if (pending > 0) {
    const pendingNames = tasks
      .filter((task) => !results.some((result) => result.name === task.name))
      .map((task) => task.name)
      .join(', ');
    const reason = completionReason === 'enough-streams' ? 'fast response target met' : 'timeout';
    console.warn(`Scraper orchestrator: Returning partial results (${reason}); still waiting on ${pendingNames}`);
  }

  return {
    completionReason,
    results,
    allCompletePromise
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createScraperTask(scraper, label, args, timeoutMs, extraTitles = []) {
  const controller = new AbortController();
  const promise = scraper.scrape(...args, { signal: controller.signal, extraTitles });
  return {
    name: label,
    promise: withTimeout(promise, timeoutMs, label, () => controller.abort()),
    abort: () => controller.abort()
  };
}

function abortPendingScrapers(tasks, results) {
  const completedNames = new Set(results.map((result) => result.name));
  tasks
    .filter((task) => !completedNames.has(task.name))
    .forEach((task) => task.abort());
}

function buildScraperArgs(scraperName, title, originalTitle, year, type, season, episode) {
  const originalFirstSources = type === 'series'
    ? new Set(['Cuevana3i', 'TioPlus', 'LaMovie', 'PelisPedia'])
    : new Set();

  if (
    originalFirstSources.has(scraperName)
    && originalTitle
    && cleanComparableTitle(originalTitle) !== cleanComparableTitle(title)
  ) {
    return [originalTitle, title, year, type, season, episode];
  }

  return [title, originalTitle, year, type, season, episode];
}

function cleanComparableTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function sanitizeStream(stream) {
  if (!stream.url) return stream;

  if (isKnownBadStream(stream)) {
    console.log(`Scraper orchestrator: Filtering suspicious placeholder stream: ${stream.url}`);
    return null;
  }

  try {
    const parsedUrl = new URL(stream.url);
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      console.log(`Scraper orchestrator: Filtering stream with unsupported protocol: ${stream.url}`);
      return null;
    }
    // A source that has been tampered with could name an internal address here and
    // have the proxy fetch it on a viewer's behalf. /proxy rejects those too; this
    // just stops one ever reaching a stream list. Public IP-literal hosts stay
    // allowed, since some sources legitimately serve streams from bare addresses.
    if (hasBlockedIpLiteralHost(stream.url)) {
      console.log(`Scraper orchestrator: Filtering stream pointing at a private address: ${stream.url}`);
      return null;
    }
  } catch {
    console.log(`Scraper orchestrator: Filtering stream with invalid URL: ${stream.url}`);
    return null;
  }

  return stream;
}

function looksLikePlayableUrl(url) {
  return /\.(m3u8|mp4|mkv|bin)(?:$|[?#])/i.test(url);
}

function isHtmlResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

async function isPlayableStream(stream, signal) {
  const startedAt = Date.now();
  const headers = {
    'User-Agent': stream?.behaviorHints?.proxyHeaders?.request?.['User-Agent']
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': stream?.behaviorHints?.proxyHeaders?.request?.Referer || 'https://sololatino.net/',
    'Range': 'bytes=0-2047'
  };

  try {
    // The validation probe asks for a 2KB range, so buffering the reply is bounded
    // and the deadline needs to cover it: a host that stalls mid-body is exactly the
    // kind we are trying to weed out here.
    const { res: response, text: body } = await fetchTextWithTimeout(stream.url, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal
    }, STREAM_VALIDATION_TIMEOUT_MS);

    if ([401, 403, 404, 410, 451].includes(response.status)) {
      console.log(`Scraper orchestrator: Filtering unplayable stream (${response.status}): ${stream.url}`);
      recordHostHealth(stream, isHardDeadStatus(response.status) ? 'hard-fail' : 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return false;
    }

    if (!response.ok && response.status !== 206) {
      console.log(`Scraper orchestrator: Filtering stream with bad validation status (${response.status}): ${stream.url}`);
      recordHostHealth(stream, isGatewayFailureStatus(response.status) ? 'gateway-fail' : 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return false;
    }

    if (stream.url.toLowerCase().includes('.m3u8')) {
      if (isHtmlResponse(response)) {
        recordHostHealth(stream, 'soft-fail', {
          status: response.status,
          latencyMs: Date.now() - startedAt
        });
        return false;
      }
      const playable = body.includes('#EXTM3U') || body.includes('#EXT-X-STREAM-INF') || body.includes('#EXTINF');
      recordHostHealth(stream, playable ? 'success' : 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return playable;
    }

    if (isHtmlResponse(response) && !looksLikePlayableUrl(response.url || stream.url)) {
      recordHostHealth(stream, 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return false;
    }

    const playable = looksLikePlayableUrl(response.url || stream.url)
      || (response.headers.get('content-type') || '').toLowerCase().startsWith('video/')
      || (response.headers.get('content-disposition') || '').toLowerCase().includes('attachment');
    recordHostHealth(stream, playable ? 'success' : 'soft-fail', {
      status: response.status,
      latencyMs: Date.now() - startedAt
    });
    return playable;
  } catch (error) {
    if (error.message.startsWith('Fetch aborted:')) {
      return false;
    }
    console.log(`Scraper orchestrator: Filtering stream that failed validation: ${stream.url} (${error.message})`);
    recordHostHealth(stream, error.message.includes('timeout') ? 'timeout' : 'soft-fail', {
      latencyMs: Date.now() - startedAt
    });
    return false;
  }
}

async function validatePlayableStreams(streams) {
  const sortedStreams = sortStreams(streams);
  const eligibleStreams = sortedStreams.filter((stream) => !shouldSkipHost(stream));
  const skippedStreams = sortedStreams.filter(shouldSkipHost);
  const streamsToValidate = eligibleStreams.slice(0, MAX_VALIDATION_CANDIDATES);
  const remainingStreams = [
    ...eligibleStreams.slice(MAX_VALIDATION_CANDIDATES),
    ...skippedStreams
  ];

  if (streamsToValidate.length === 0) {
    if (sortedStreams.length > 0) {
      console.warn('Scraper orchestrator: All candidate hosts are temporarily unhealthy; returning URL-sanitized streams as fallback.');
    }
    return sortedStreams;
  }

  const playableStreams = [];
  const validationController = new AbortController();
  let completed = 0;
  let resolveEnoughConfirmed;
  let resolveAllComplete;

  const enoughConfirmedPromise = new Promise((resolve) => {
    resolveEnoughConfirmed = resolve;
  });
  const allCompletePromise = new Promise((resolve) => {
    resolveAllComplete = resolve;
  });

  streamsToValidate.forEach((stream) => {
    isPlayableStream(stream, validationController.signal)
      .then((playable) => {
        if (playable) {
          playableStreams.push(stream);
          if (playableStreams.length >= MIN_CONFIRMED_STREAMS) {
            resolveEnoughConfirmed('enough-confirmed');
          }
        }
      })
      .catch((error) => {
        console.log(`Scraper orchestrator: Validation task failed for ${stream.url}: ${error.message}`);
        if (!error.message.startsWith('Fetch aborted:')) {
          recordHostHealth(stream, 'soft-fail');
        }
      })
      .finally(() => {
        completed += 1;
        if (completed === streamsToValidate.length) {
          resolveAllComplete('complete');
        }
      });
  });

  const timeoutMs = remainingStreams.length > 0
    ? STREAM_VALIDATION_FAST_TIMEOUT_MS
    : STREAM_VALIDATION_TOTAL_TIMEOUT_MS;
  const completionReason = await Promise.race([
    enoughConfirmedPromise,
    allCompletePromise,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
  ]);

  if (completionReason !== 'complete') {
    validationController.abort();
  }

  if (playableStreams.length > 0) {
    if (completionReason === 'timeout') {
      console.warn(`Scraper orchestrator: Validation timed out; returning ${playableStreams.length} confirmed playable streams and dropping slow candidates.`);
    }
    return sortStreams(playableStreams);
  }

  if (remainingStreams.length > 0) {
    console.warn('Scraper orchestrator: No validated streams yet; returning URL-sanitized streams to avoid a false empty result.');
    return sortedStreams;
  }

  if (sortedStreams.length > 0) {
    console.warn('Scraper orchestrator: Validation found no confirmed playable streams; returning URL-sanitized streams to avoid a false empty result.');
  }
  return sortedStreams;
}

/**
 * Combined scraping orchestrator.
 * Accepts IMDb ID or TMDB ID and queries all sources concurrently.
 */
async function getStreamsUncached(type, id, season, episode) {
  let title = '';
  let originalTitle = '';
  let year = null;
  let tmdbId = '';
  let imdbId = '';
  // Populated up front when the TMDB id is already known, so the translations
  // lookup overlaps the metadata lookup instead of following it.
  let alternativeTitlesPromise = null;

  try {
    // 1. Resolve metadata (Title, Year, ID mapping) using TMDB API
    if (id.startsWith('tmdb:')) {
      // ID format: tmdb:movie:12345 or tmdb:series:12345:1:1
      const parts = id.split(':');
      tmdbId = parts[2];
      alternativeTitlesPromise = tmdb.getAlternativeTitles(type, tmdbId);
      const meta = await tmdb.getMetaDetails(type, tmdbId, { includeEpisodes: false });
      if (meta) {
        title = meta.name;
        originalTitle = meta.originalTitle;
        year = meta.releaseInfo ? parseInt(meta.releaseInfo) : null;
        imdbId = meta.imdb_id;
      }
    } else if (id.startsWith('tt')) {
      // IMDb ID format: tt1234567 or tt1234567:1:1
      // If it contains season and episode, split them
      const parts = id.split(':');
      imdbId = parts[0];
      const details = await tmdb.findByImdbId(imdbId);
      if (details) {
        title = details.title;
        originalTitle = details.originalTitle;
        year = details.year;
        tmdbId = details.id;
      }
    } else {
      // Fallback: If it's a raw TMDB ID number
      alternativeTitlesPromise = tmdb.getAlternativeTitles(type, id);
      const meta = await tmdb.getMetaDetails(type, id, { includeEpisodes: false });
      if (meta) {
        title = meta.name;
        originalTitle = meta.originalTitle;
        year = meta.releaseInfo ? parseInt(meta.releaseInfo) : null;
        imdbId = meta.imdb_id;
      }
    }

    if (!title) {
      console.warn(`Scraper orchestrator: Could not resolve title/details for ID ${id} using TMDB.`);
      return [];
    }

    console.log(`Orchestrator matching: "${title}" (${year}), Type: ${type}, Season: ${season}, Episode: ${episode}`);

    // 1b. Widen the title pool with any other Spanish regional dub names
    // TMDB knows about (sites don't all agree on which one they use).
    const knownTitles = new Set([cleanComparableTitle(title), cleanComparableTitle(originalTitle)]);
    const alternativeTitles = await (alternativeTitlesPromise || tmdb.getAlternativeTitles(type, tmdbId));
    const extraTitles = alternativeTitles.filter((candidate) => {
      const clean = cleanComparableTitle(candidate);
      if (!clean || knownTitles.has(clean)) return false;
      knownTitles.add(clean);
      return true;
    });

    if (extraTitles.length > 0) {
      console.log(`Orchestrator: Found ${extraTitles.length} additional Spanish title variant(s): ${extraTitles.join(', ')}`);
    }

    // 2. Invoke scrapers in parallel
    const scraperTasks = [
      createScraperTask(sololatino, 'SoloLatino', buildScraperArgs('SoloLatino', title, originalTitle, year, type, season, episode), SOLOLATINO_TIMEOUT_MS, extraTitles),
      createScraperTask(cinecalidad, 'Cinecalidad', buildScraperArgs('Cinecalidad', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles),
      createScraperTask(tioplus, 'TioPlus', buildScraperArgs('TioPlus', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles),
      createScraperTask(cuevana3i, 'Cuevana3i', buildScraperArgs('Cuevana3i', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles),
      createScraperTask(lamovie, 'LaMovie', buildScraperArgs('LaMovie', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles),
      createScraperTask(pelispedia, 'PelisPedia', buildScraperArgs('PelisPedia', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles)
    ];

    if (ENABLE_CINEHDPLUS) {
      scraperTasks.push(createScraperTask(cinehdplus, 'CineHDPlus', buildScraperArgs('CineHDPlus', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles));
    }

    const collection = await collectScraperResults(scraperTasks, SCRAPER_COLLECTION_TIMEOUT_MS);

    const countStreams = (results) => results.reduce((total, res) => (
      total + (res.status === 'fulfilled' && Array.isArray(res.value) ? res.value.length : 0)
    ), 0);

    if (collection.completionReason !== 'complete' && countStreams(collection.results) === 0) {
      console.warn(`Scraper orchestrator: Partial collection had no streams; waiting up to ${EMPTY_RESULT_GRACE_MS}ms to avoid a false empty result.`);
      await Promise.race([
        collection.allCompletePromise,
        delay(EMPTY_RESULT_GRACE_MS)
      ]);
    }

    if (collection.completionReason !== 'complete') {
      abortPendingScrapers(scraperTasks, collection.results);
    }

    const streams = [];

    collection.results.forEach((res) => {
      const name = res.name;

      if (res.status === 'fulfilled') {
        if (res.value && res.value.length > 0) {
          console.log(`${name} returned ${res.value.length} streams`);
          streams.push(...res.value);
        } else {
          console.log(`${name} returned 0 streams`);
        }
      } else {
        console.error(`${name} failed during execution:`, res.reason);
      }
    });

    const directStreams = streams.filter((stream) => Boolean(stream?.url));
    const sanitizedStreams = uniqueStreams(directStreams.map(sanitizeStream).filter(Boolean));
    const playableStreams = await validatePlayableStreams(sanitizedStreams);
    return sortStreams(playableStreams);

  } catch (err) {
    console.error('Error in combined getStreams:', err.message);
    return [];
  }
}

async function getStreams(type, id, season, episode) {
  const key = [type, id, season || '', episode || ''].join(':');
  const cached = streamCache.get(key);

  if (cached) {
    console.log(`Scraper orchestrator: Cache hit for ${key} (${cached.length} streams)`);
    return cached;
  }

  if (inFlightRequests.has(key)) {
    console.log(`Scraper orchestrator: Reusing in-flight request for ${key}`);
    return inFlightRequests.get(key);
  }

  const request = getStreamsUncached(type, id, season, episode)
    .then((streams) => (
      streamCache.set(key, streams, streams.length > 0 ? STREAM_CACHE_TTL_MS : EMPTY_STREAM_CACHE_TTL_MS)
    ))
    .finally(() => {
      inFlightRequests.delete(key);
    });

  inFlightRequests.set(key, request);
  return request;
}

module.exports = {
  getStreams,
  __test: { sanitizeStream, streamCache, hostHealth }
};

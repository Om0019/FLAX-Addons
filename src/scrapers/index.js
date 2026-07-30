const tmdb = require('../tmdb');
const sololatino = require('./sololatino');
const cinecalidad = require('./cinecalidad');
const tioplus = require('./tioplus');
const cinehdplus = require('./cinehdplus');
const cuevana3i = require('./cuevana3i');
const lamovie = require('./lamovie');
const pelispedia = require('./pelispedia');
const tlnovelas = require('./tlnovelas');
const novelas360 = require('./novelas360');
const { fetchTextWithTimeout, normalizeUrl } = require('../http');
const { hasBlockedIpLiteralHost } = require('../net-guard');
const { createTtlCache } = require('../ttl-cache');
const {
  bestQuality,
  claimedQuality,
  completePlaylistLines,
  qualityFromManifest,
  qualityFromUrl,
  qualityRank,
  withQualityLabel
} = require('../quality');

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
// How long one probe may wait for an answer, which is not one number because the
// two places probes start from are not alike.
//
// Measured over 189 streams at the concurrency probes actually run at: half of all
// answers arrive by 1101ms and three quarters by 1629ms, but the tail is long and
// flat. A 2800ms deadline reached 90% of the answers available; 4000ms reaches 95%,
// 4500ms reaches 96%, and then nothing more arrives until 8000ms. The streams in
// that 2800-4000ms band are not slow-and-broken, they are slow-and-fine — the same
// hosts answer in ~1.4s when nothing else is in flight.
//
// A probe started while sources are still reporting overlaps work that is happening
// anyway, so it can have the deadline the measurements ask for: the phase budget
// below still bounds what anyone waits for, so a longer per-probe deadline buys
// answers without costing latency. A probe started in the final phase cannot — the
// phase ends the wait either way, so it is given exactly the budget that remains
// and nothing is served by pretending otherwise.
const STREAM_VALIDATION_EAGER_TIMEOUT_MS = 4000;
const STREAM_VALIDATION_TOTAL_TIMEOUT_MS = 3200;
const STREAM_VALIDATION_FAST_TIMEOUT_MS = 2400;
// Follow-up probe for one variant of a master playlist. Short on purpose: it only
// has to catch a host that is refusing or gone, and an inconclusive answer leaves
// the stream in the candidate list rather than dropping it.
const HLS_VARIANT_VALIDATION_TIMEOUT_MS = 1500;
// Probes read this many bytes. It also tells a truncated body from a complete one,
// which is what lets an empty playlist be told apart from one that simply has not
// been read far enough yet.
const PROBE_RANGE_BYTES = 2048;
const MIN_CONFIRMED_STREAMS = 3;
const MAX_VALIDATION_CANDIDATES = 8;
// Streams are probed as each source reports in, rather than waiting for every
// source first. Collection and validation used to run strictly one after the
// other, so the earliest source's streams sat unchecked until the slowest source
// finished. Capped so an early source cannot spend the whole budget.
const MAX_EAGER_VALIDATIONS = 8;
// Alternative titles only widen the pool of names the scrapers search for, so they
// are worth a short wait and nothing more. On the IMDb path the lookup cannot even
// start until the id mapping comes back, which put two full TMDB deadlines — up to
// 10s — ahead of the first scraper request on a cold lookup. Giving up early costs
// the extra titles for this request only: the call is left running and its answer
// lands in the TMDB cache for the next one.
const ALTERNATIVE_TITLES_MAX_WAIT_MS = 1500;
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

// A stream's hostname is a pure function of a URL that never changes, and it is
// asked for repeatedly — by the scorer, the family grouper and the health check,
// each of them inside a sort comparator. Parsed once per stream object instead.
const hostByStream = new WeakMap();

function getStreamHost(stream) {
  const cached = hostByStream.get(stream);
  if (cached !== undefined) return cached;

  let host;
  try {
    host = new URL(stream.url).hostname.toLowerCase();
  } catch {
    host = '';
  }

  hostByStream.set(stream, host);
  return host;
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

// 502/503/504 are the standard bad-gateway family. 520-526 are Cloudflare's own
// codes for the same condition — the edge answered but could not reach the origin
// behind it — and these sources sit behind Cloudflare almost without exception, so
// leaving them out meant a host whose origin was down (hglink.to and
// vidhideplus.com were both serving 522 when this was measured) never accumulated
// the failures that take it out of rotation.
function isGatewayFailureStatus(status) {
  return [502, 503, 504].includes(status) || (status >= 520 && status <= 526);
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

  const throttleProne = isThrottleProneHost(host);
  const timeoutThreshold = throttleProne ? 2 : 3;
  const gatewayFailThreshold = throttleProne ? 2 : 3;

  let deadUntil = current.deadUntil || 0;
  if (
    recentHardFailures.length >= 2
    || recentTimeouts.length >= timeoutThreshold
    || recentGatewayFailures.length >= gatewayFailThreshold
  ) {
    deadUntil = Date.now() + (throttleProne ? HOST_DEAD_TTL_MS * 2 : HOST_DEAD_TTL_MS);
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

  let softFailures = 0;
  let successes = 0;
  let timeouts = 0;
  let hardFailures = 0;
  let gatewayFailures = 0;

  for (const event of events) {
    if (event.outcome === 'soft-fail') softFailures += 1;
    if (event.outcome === 'success') successes += 1;
    if (event.outcome === 'timeout') timeouts += 1;
    if (event.outcome === 'hard-fail' || isHardDeadStatus(event.status)) hardFailures += 1;
    if (event.outcome === 'gateway-fail' || isGatewayFailureStatus(event.status)) gatewayFailures += 1;
  }

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
  let baseScore = 7;

  // Ordering measured, not guessed. 189 streams collected straight from the sources
  // and each one played end to end — master, variant, first segment — in July 2026:
  //
  //   vimeos        35/35  100%      acek-cdn      24/51   47%
  //   goodstream    30/31   97%      dramiyos-cdn  11/25   44%
  //   hlswish        4/11   36%      turboviplay    0/17    0%
  //   pelisplus-ip   0/17    0%
  //
  // acek-cdn and dramiyos-cdn were originally placed ahead of the families the
  // sample never touched, on the reasoning that 44-47% still beat a coin flip.
  // Watching them play in practice (Grey's Anatomy S21, reported endless buffering
  // on acek/dramiyos streams and 502s once the proxy gave up on a stalled fetch)
  // showed that a "success" in the sample only meant the first segment came back
  // — it says nothing about whether the CDN keeps up with real-time playback after
  // that, which these two do not reliably do. Moved below every family the sample
  // has no opinion on, so an unmeasured host — genuinely a coin flip — is now
  // preferred over a host with a documented near-coin-flip rate. Still ahead of
  // pelisplus-ip and turboviplay, which are not a coin flip: those are 0%.
  //
  // The families no stream in the sample belonged to — cfglobalcdn, mediafire,
  // fireload, nupload, cdn-tnmr — keep the relative order they had, because nothing
  // here says anything about them.
  //
  // Bare-IPv4 hosts are pelisplus, which serves HTTPS on addresses its certificates
  // do not cover; every one failed ERR_TLS_CERT_ALTNAME_INVALID. turboviplay serves
  // a master that loads and names variants on hosts that no longer resolve, which is
  // why nothing behind it plays. Both are ranked below an unrecognised host rather
  // than dropped: the day either is fixed, nothing else about those streams is wrong.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) baseScore = 10;
  else if (host.includes('turboviplay.com')) baseScore = 10;
  else if (host.includes('vimeos')) baseScore = 0;
  else if (host.includes('goodstream')) baseScore = 1;
  else if (host.includes('mediafire.com') || host.includes('fireload.com')) baseScore = 3;
  else if (host.includes('nupload')) baseScore = 4;
  else if (host.includes('premilkyway.com') || title.includes('hlswish')) baseScore = 5;
  else if (host.includes('cdn-tnmr.org')) baseScore = 6;
  else if (host.includes('acek-cdn.com')) baseScore = 8;
  else if (host.includes('dramiyos-cdn.com') || host.includes('cfglobalcdn.com')) baseScore = 9;

  return baseScore + healthPenalty;
}

// acek-cdn and dramiyos-cdn fail in a way the ordinary threshold below does not
// catch quickly: a "success" only proves the first probed bytes arrived, not that
// the CDN can sustain real-time playback, so a run of gateway failures or timeouts
// on these two families is a stronger signal than it is elsewhere. Pulled out of
// rotation after two rather than three, and kept out twice as long, so a viewer who
// just hit a 502 on one of these does not land on the same host again a few minutes
// later.
const THROTTLE_PRONE_HOSTS = ['acek-cdn.com', 'dramiyos-cdn.com', 'cfglobalcdn.com'];

function isThrottleProneHost(host) {
  return THROTTLE_PRONE_HOSTS.some((suffix) => host.includes(suffix));
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

/**
 * Host score decides the order; quality only separates streams a host score has
 * tied. Ranking on quality first would put a host known to fail behind a claim
 * written in a URL, and the claim is the weaker fact of the two.
 */
function compareRanked(a, b) {
  return (a.score - b.score) || (b.quality - a.quality);
}

/**
 * Scores are computed once per stream per sort rather than on every comparison:
 * scoring reaches into host health, which walks that host's event list, and a
 * comparator runs O(n log n) times. Deliberately not memoised across calls — probes
 * update host health while a request is in flight, and a later sort is supposed to
 * see the newer verdict.
 */
function rankStream(stream) {
  return {
    stream,
    score: scoreStream(stream),
    family: getHostFamily(stream),
    quality: qualityRank(stream.quality)
  };
}

function sortStreams(streams) {
  const ranked = streams.map(rankStream).sort(compareRanked);
  const byFamily = new Map();

  for (const entry of ranked) {
    if (!byFamily.has(entry.family)) byFamily.set(entry.family, []);
    byFamily.get(entry.family).push(entry);
  }

  // Families are ordered by their own best stream, on the same comparison, so a
  // family that leads with 1080p goes ahead of an equally scored one leading with
  // 480p instead of on whichever happened to be ranked first.
  const sortedFamilies = [...byFamily.entries()]
    .sort((a, b) => compareRanked(a[1][0], b[1][0]));

  const diversified = [];
  while (sortedFamilies.some(([, familyEntries]) => familyEntries.length > 0)) {
    for (const [, familyEntries] of sortedFamilies) {
      const entry = familyEntries.shift();
      if (entry) diversified.push(entry.stream);
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

async function collectScraperResults(tasks, timeoutMs, onResult, options = {}) {
  const results = [];
  let pending = tasks.length;
  let sourcesRequired = FAST_SOURCE_MIN_SOURCES;
  let deadlinePassed = false;
  let resolveFastReturn;

  // How many streams the eager probes have actually confirmed playable so far.
  // Counting raw streams alone is what made an early return worth so little: the
  // sources on this addon hand back a lot of URLs that are already dead, so three
  // raw streams was measured returning a single playable one while three sources
  // that had not reported yet were aborted mid-flight.
  const getConfirmedCount = options.getConfirmedCount || (() => 0);

  const hasEnoughStreamsForFastReturn = () => {
    const fulfilledWithStreams = results.filter((result) => (
      result.status === 'fulfilled'
      && Array.isArray(result.value)
      && result.value.length > 0
    ));
    if (fulfilledWithStreams.length < sourcesRequired) return false;

    const streamCount = fulfilledWithStreams.reduce((total, result) => total + result.value.length, 0);
    if (streamCount >= FAST_SOURCE_MIN_STREAMS) return true;

    // Past the deadline a smaller set will do, but only once the probes say those
    // streams play. Returning on a thin set the validator then guts is strictly
    // worse than waiting: the sources still in flight get cancelled either way.
    return deadlinePassed && getConfirmedCount() >= MIN_CONFIRMED_STREAMS;
  };

  // The confirmed count changes as probes settle, which is not a moment any source
  // completion tells us about, so the validator pokes this when a probe comes back
  // playable.
  if (options.gate) {
    options.gate.recheck = () => {
      if (hasEnoughStreamsForFastReturn()) resolveFastReturn('enough-streams');
    };
  }

  let fastReturnTimer;
  const fastReturnPromise = new Promise((resolve) => {
    resolveFastReturn = resolve;
    fastReturnTimer = setTimeout(() => {
      // The richer target has not arrived in time; one source will do, provided
      // what it brought has been shown to work.
      deadlinePassed = true;
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
        if (onResult && result.status === 'fulfilled' && Array.isArray(result.value) && result.value.length > 0) {
          try {
            onResult(result.value);
          } catch (error) {
            console.warn(`Scraper orchestrator: Eager validation hook failed: ${error.message}`);
          }
        }
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

/**
 * Resolves `promise`, or `fallbackValue` if it takes longer than `timeoutMs`. The
 * promise itself is left to finish — this bounds how long a caller waits, not the
 * work — so it must be one that settles on its own and never rejects.
 */
function resolveWithin(promise, timeoutMs, fallbackValue) {
  let timeoutId;
  const fallback = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(fallbackValue), timeoutMs);
  });

  return Promise.race([promise, fallback]).finally(() => clearTimeout(timeoutId));
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

  // Every stream that reaches a viewer passes through here, so this is where the
  // free reading is taken: whatever the URL and the source's own label claim. A
  // probe can upgrade it to a measurement later, and a stream that is never probed
  // still gets to say something.
  return annotateQuality(stream, claimedQuality(stream));
}

/** Keeps the better of a stream's existing reading and a new one. */
function annotateQuality(stream, quality) {
  const merged = bestQuality(stream.quality, quality);
  if (!merged || merged === stream.quality) return stream;
  return { ...stream, quality: merged };
}

function looksLikePlayableUrl(url) {
  return /\.(m3u8|mp4|mkv|bin)(?:$|[?#])/i.test(url);
}

function isHtmlResponse(response) {
  return (response.headers.get('content-type') || '').toLowerCase().includes('text/html');
}

/**
 * Whether a probe should be judged as an HLS playlist — by extension, or by the
 * content type when the URL carries no extension at all.
 *
 * Routing on `url.includes('.m3u8')` got this wrong both ways. A playlist served
 * from a path with no extension (`/hls/master?token=…`, which several of these
 * hosts do) fell through to the generic check, where a manifest content type
 * satisfies neither `video/*` nor an attachment disposition, and a perfectly good
 * stream was recorded as unplayable. In the other direction, an unrelated `.m3u8`
 * anywhere in a query string forced an MP4 down the playlist path, where the body
 * has no #EXTM3U and it was dropped for it.
 */
function hasM3u8Path(url) {
  if (!url) return false;

  try {
    // Deliberately the pathname alone. Matching the whole URL means a query
    // parameter that happens to end in .m3u8 — a fallback URL, a referrer — drags
    // an MP4 onto the playlist path.
    return /\.m3u8$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

/** A master playlist points at other playlists; a media playlist lists segments. */
function isMasterPlaylist(body) {
  return body.includes('#EXT-X-STREAM-INF') && !body.includes('#EXTINF');
}

/** Whether a playlist names anything to play, rather than being a bare header. */
function hasPlaylistEntries(body) {
  return body.includes('#EXT-X-STREAM-INF') || body.includes('#EXTINF');
}

/**
 * Probes ask for PROBE_RANGE_BYTES, so a body that fills the window may have been
 * cut off and the absence of an entry proves nothing. A short body is the whole
 * file, and there the absence is real. This is what keeps the emptiness check
 * above from failing a legitimate playlist that opens with a long run of
 * #EXT-X-MEDIA renditions.
 */
function isCompleteProbeBody(body) {
  return Buffer.byteLength(body) < PROBE_RANGE_BYTES;
}

/**
 * First playlist URI in a master playlist, resolved against the manifest URL.
 * Only complete lines are considered — the probe asks for a byte range, so the
 * body can stop mid-URI.
 */
function firstVariantUrl(body, manifestUrl) {
  for (const line of completePlaylistLines(body)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    try {
      return new URL(trimmed, manifestUrl).toString();
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Probes one variant of a master playlist. Returns true when it is a playlist,
 * false when the host gave a definite refusal, and null when the answer is
 * inconclusive — a timeout says we ran out of budget, not that the stream is bad.
 */
async function probeHlsVariant(variantUrl, headers, signal) {
  try {
    const { res, text } = await fetchTextWithTimeout(variantUrl, {
      method: 'GET',
      headers: { ...headers, Range: `bytes=0-${PROBE_RANGE_BYTES - 1}` },
      redirect: 'follow',
      signal
    }, HLS_VARIANT_VALIDATION_TIMEOUT_MS);

    // The master loaded over this same path a moment ago, so the route works and
    // any status the variant returns is about the variant. Treating 5xx as merely
    // inconclusive let a master whose variant hosts are gone survive validation
    // and be offered — the failure this whole probe exists to catch. Only an
    // explicit rate limit is genuinely transient.
    if (res.status === 429) return null;
    if (!res.ok && res.status !== 206) return false;
    if (isHtmlResponse(res)) return false;
    if (hasPlaylistEntries(text)) return true;

    // A variant that came back whole and still names nothing is an empty
    // playlist. Truncated, it is only unread.
    return isCompleteProbeBody(text) ? false : null;
  } catch (error) {
    // A host that is definitively not there is an answer. A timeout is not.
    return isDefiniteFetchFailure(error) ? false : null;
  }
}

function isHlsManifestProbe(response, streamUrl) {
  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  if (contentType.includes('mpegurl') || contentType.includes('application/vnd.apple')) {
    return true;
  }

  return hasM3u8Path(response.url) || hasM3u8Path(streamUrl);
}

/**
 * The outcome of one probe: whether the stream played, and anything the probe
 * learned about its quality on the way. Returning both keeps the manifest read
 * free — the body is in hand for the playability checks either way, and fetching
 * it again later to look at RESOLUTION would double the request count.
 *
 * `conclusive` says whether the probe actually learned anything. A refusal, an
 * empty playlist and a dead variant are findings about the stream; a deadline that
 * expired and a probe that was cancelled are findings about our budget. Both used
 * to be reported the same way, and the caller drops whatever comes back false, so
 * a stream the probe never got an answer from was thrown away as if it had failed.
 */
function verdict(playable, quality = null, { conclusive = true } = {}) {
  return { playable, quality, conclusive };
}

// Failures that describe the endpoint rather than our budget. A host that does not
// resolve, refuses the connection, or presents a certificate that cannot be
// verified answers the next request the same way and answers the viewer's player
// the same way, so each of these is a verdict. A deadline is not.
//
// The certificate cases are not hypothetical: pelisplus serves its streams from
// bare IPv4 addresses whose certificates do not cover the address, and every one
// sampled failed ERR_TLS_CERT_ALTNAME_INVALID. Those streams reach a viewer through
// this addon's proxy, so what Node refuses to fetch is exactly what cannot play.
const DEFINITE_FETCH_FAILURE_CODES = new Set([
  'ENOTFOUND',
  'ECONNREFUSED',
  'EHOSTUNREACH',
  'ERR_INVALID_URL'
]);

function isDefiniteFetchFailure(error) {
  const code = error?.cause?.code || '';
  if (!code) return false;
  return DEFINITE_FETCH_FAILURE_CODES.has(code)
    // The TLS verification family, which OpenSSL and Node spell several ways:
    // ERR_TLS_CERT_ALTNAME_INVALID, ERR_SSL_WRONG_VERSION_NUMBER, CERT_HAS_EXPIRED,
    // SELF_SIGNED_CERT_IN_CHAIN, UNABLE_TO_VERIFY_LEAF_SIGNATURE, HOSTNAME_MISMATCH.
    || /^ERR_(?:TLS|SSL)_/.test(code)
    || /^UNABLE_TO_/.test(code)
    || code.includes('CERT')
    || code === 'HOSTNAME_MISMATCH';
}

async function isPlayableStream(stream, signal, timeoutMs) {
  const startedAt = Date.now();
  const headers = {
    'User-Agent': stream?.behaviorHints?.proxyHeaders?.request?.['User-Agent']
      || 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': stream?.behaviorHints?.proxyHeaders?.request?.Referer || 'https://sololatino.net/',
    'Range': `bytes=0-${PROBE_RANGE_BYTES - 1}`
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
    }, timeoutMs);

    if ([401, 403, 404, 410, 451].includes(response.status)) {
      console.log(`Scraper orchestrator: Filtering unplayable stream (${response.status}): ${stream.url}`);
      recordHostHealth(stream, isHardDeadStatus(response.status) ? 'hard-fail' : 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return verdict(false);
    }

    if (!response.ok && response.status !== 206) {
      console.log(`Scraper orchestrator: Filtering stream with bad validation status (${response.status}): ${stream.url}`);
      recordHostHealth(stream, isGatewayFailureStatus(response.status) ? 'gateway-fail' : 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return verdict(false);
    }

    // Redirects are followed, and the URL a host lands on often names the rendition
    // when the one the source handed over did not.
    const redirectedQuality = qualityFromUrl(response.url);

    if (isHlsManifestProbe(response, stream.url)) {
      if (isHtmlResponse(response)) {
        recordHostHealth(stream, 'soft-fail', {
          status: response.status,
          latencyMs: Date.now() - startedAt
        });
        return verdict(false);
      }
      // #EXTM3U on its own is an empty container, not a stream. turboviplay serves
      // exactly that — `#EXTM3U\n#EXT-X-VERSION:6` and nothing else — for files it
      // no longer has, and counting the header alone as playable confirmed those
      // and put them at the top of the list. A playlist has to name something:
      // variants or segments.
      const playable = hasPlaylistEntries(body) || !isCompleteProbeBody(body);

      if (!playable && isCompleteProbeBody(body)) {
        console.log(`Scraper orchestrator: Filtering empty playlist with no variants or segments: ${stream.url}`);
      }

      // A master playlist that loads is not yet a stream that plays: it only
      // names other playlists, and those live on separate hosts that can be gone
      // while the master is served happily. turboviplay masters return 200 with
      // variants on hosts that no longer resolve, so the stream was ranked near
      // the top and then played nothing. Follow one variant before believing it.
      if (playable && isMasterPlaylist(body)) {
        const variantUrl = firstVariantUrl(body, response.url || stream.url);
        // No variant to follow means two different things. On a body that was read
        // whole it is a master naming nothing playable, and that is a refusal. On a
        // truncated one the first variant URI can simply sit past the range that was
        // asked for — a master with a long run of #EXT-X-MEDIA renditions, which is
        // ordinary for multi-language Latino content — and calling that unreachable
        // dropped a live stream and charged its host a hard failure, two of which
        // mark the whole CDN dead for three minutes.
        const variantVerdict = variantUrl
          ? await probeHlsVariant(variantUrl, headers, signal)
          : (isCompleteProbeBody(body) ? false : null);

        if (variantVerdict === false) {
          console.log(`Scraper orchestrator: Filtering master playlist whose variants are unreachable: ${stream.url}`);
          recordHostHealth(stream, 'hard-fail', {
            status: response.status,
            latencyMs: Date.now() - startedAt
          });
          return verdict(false);
        }
      }

      recordHostHealth(stream, playable ? 'success' : 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      // The variant list is only as complete as the range that was read, which is
      // what makes a truncated reading a floor rather than a figure.
      const measured = qualityFromManifest(body, { complete: isCompleteProbeBody(body) });
      return verdict(playable, bestQuality(measured, redirectedQuality));
    }

    if (isHtmlResponse(response) && !looksLikePlayableUrl(response.url || stream.url)) {
      recordHostHealth(stream, 'soft-fail', {
        status: response.status,
        latencyMs: Date.now() - startedAt
      });
      return verdict(false);
    }

    const playable = looksLikePlayableUrl(response.url || stream.url)
      || (response.headers.get('content-type') || '').toLowerCase().startsWith('video/')
      || (response.headers.get('content-disposition') || '').toLowerCase().includes('attachment');
    recordHostHealth(stream, playable ? 'success' : 'soft-fail', {
      status: response.status,
      latencyMs: Date.now() - startedAt
    });
    // A progressive file carries its dimensions in the container, not in anything a
    // 2KB range from the front reliably reaches, so this is the URL's word for it.
    return verdict(playable, redirectedQuality);
  } catch (error) {
    // Cancelled because the selection moved on. That says nothing about the stream.
    if (error.message.startsWith('Fetch aborted:')) {
      return verdict(false, null, { conclusive: false });
    }

    const timedOut = error.message.includes('timeout');
    const definite = !timedOut && isDefiniteFetchFailure(error);
    console.log(`Scraper orchestrator: ${timedOut ? 'Could not verify' : 'Filtering'} stream: ${stream.url} (${error.message})`);
    // Health still counts a timeout — a host that keeps running out the clock is a
    // bad bet even though no single timeout proves anything about one stream — and
    // counts a permanent failure as the hard one it is.
    recordHostHealth(stream, timedOut ? 'timeout' : (definite ? 'hard-fail' : 'soft-fail'), {
      latencyMs: Date.now() - startedAt
    });
    return verdict(false, null, { conclusive: definite });
  }
}

/**
 * Probes streams for playability and quality, at most once per URL. Sharing one of
 * these across the request lets validation start while sources are still reporting
 * and still be counted when the final selection is made — the selection asks for a
 * result and gets one that is already in flight, or already settled.
 *
 * Caching by URL also shares the verdict between two sources that found the same
 * link, which is correct for the quality half as well: a rendition ladder belongs
 * to the URL, not to whoever listed it.
 */
function createStreamValidator(signal, onConfirmed) {
  const byUrl = new Map();
  let confirmed = 0;

  return {
    /**
     * `timeoutMs` belongs to whoever starts the probe. A probe is shared by URL, so
     * the first caller's deadline is the one that applies — which is what we want:
     * the eager pass starts first and starts with the longer one.
     */
    validate(stream, timeoutMs) {
      const existing = byUrl.get(stream.url);
      if (existing) return existing;

      const probe = isPlayableStream(stream, signal, timeoutMs).catch((error) => {
        console.log(`Scraper orchestrator: Validation task failed for ${stream.url}: ${error.message}`);
        if (!error.message.startsWith('Fetch aborted:')) {
          recordHostHealth(stream, 'soft-fail');
        }
        // A probe that threw where it was not supposed to has not judged anything.
        return verdict(false, null, { conclusive: false });
      }).then((result) => {
        // Counted here rather than at the call site because probes are shared: the
        // eager pass and the final selection await the same promise, and a stream
        // must only ever count once.
        if (result && result.playable) {
          confirmed += 1;
          if (onConfirmed) onConfirmed();
        }
        return result;
      });

      byUrl.set(stream.url, probe);
      return probe;
    },

    get started() {
      return byUrl.size;
    },

    get confirmed() {
      return confirmed;
    }
  };
}

/**
 * Starts probes for a source's streams as soon as it reports, best-scoring first,
 * so the work overlaps the sources that have not finished yet.
 */
function startEagerValidation(streams, validator) {
  const candidates = sortStreams(
    streams.map(sanitizeStream).filter(Boolean).filter((stream) => !shouldSkipHost(stream))
  );

  for (const stream of candidates) {
    if (validator.started >= MAX_EAGER_VALIDATIONS) break;
    validator.validate(stream, STREAM_VALIDATION_EAGER_TIMEOUT_MS);
  }
}

async function validatePlayableStreams(streams, validator, validationController) {
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
  // Probes that came back with a real verdict of "not playable". Kept apart from
  // the ones still in flight, because an aborted probe also resolves false and
  // that is not evidence of anything.
  const rejectedUrls = new Set();
  let completed = 0;
  let resolveEnoughConfirmed;
  let resolveAllComplete;

  const enoughConfirmedPromise = new Promise((resolve) => {
    resolveEnoughConfirmed = resolve;
  });
  const allCompletePromise = new Promise((resolve) => {
    resolveAllComplete = resolve;
  });

  const timeoutMs = remainingStreams.length > 0
    ? STREAM_VALIDATION_FAST_TIMEOUT_MS
    : STREAM_VALIDATION_TOTAL_TIMEOUT_MS;

  streamsToValidate.forEach((stream) => {
    // Already-settled probes resolve immediately; this is where work done during
    // collection gets picked up rather than repeated. A probe that starts here gets
    // the phase's own budget: the phase ends the wait regardless, so a shorter
    // deadline would only produce an earlier — and equally inconclusive — non-answer.
    validator.validate(stream, timeoutMs)
      .then(({ playable, quality, conclusive }) => {
        if (playable) {
          // The probe read the manifest, so this is the one point where a claim can
          // be replaced by a measurement.
          playableStreams.push(annotateQuality(stream, quality));
          if (playableStreams.length >= MIN_CONFIRMED_STREAMS) {
            resolveEnoughConfirmed('enough-confirmed');
          }
          return;
        }
        // Only a probe that reached a verdict drops its stream. One that ran out of
        // time leaves it unproven, which is a place in the list rather than a
        // deletion: measured live, three of four streams the deadline discarded were
        // serving a playable manifest a moment later.
        if (conclusive) rejectedUrls.add(stream.url);
      })
      .finally(() => {
        completed += 1;
        if (completed === streamsToValidate.length) {
          resolveAllComplete('complete');
        }
      });
  });

  const completionReason = await Promise.race([
    enoughConfirmedPromise,
    allCompletePromise,
    new Promise((resolve) => setTimeout(() => resolve('timeout'), timeoutMs))
  ]);

  // Snapshot before aborting. Every probe that reached a verdict has already run
  // its handler; the ones abort() is about to cancel resolve later and must not be
  // mistaken for failures.
  const decidedBad = new Set(rejectedUrls);

  if (completionReason !== 'complete') {
    validationController.abort();
  }

  // MIN_CONFIRMED_STREAMS ends validation early, which is what keeps the response
  // fast — but it used to end the *result* too, so a lookup that found five working
  // links returned three and threw the rest away. Only a stream that actually failed
  // its probe is dropped now; the ones still in flight, and the ones past the
  // candidate cap, follow the confirmed streams instead of vanishing.
  const confirmed = sortStreams(playableStreams);
  const confirmedUrls = new Set(confirmed.map((stream) => stream.url));
  const unproven = [...eligibleStreams, ...skippedStreams].filter((stream) => (
    !confirmedUrls.has(stream.url) && !decidedBad.has(stream.url)
  ));

  if (completionReason === 'timeout' && confirmed.length > 0) {
    console.warn(`Scraper orchestrator: Validation timed out; ${confirmed.length} confirmed playable, ${unproven.length} unverified candidates kept.`);
  }

  const selected = [...confirmed, ...unproven];
  if (selected.length > 0) {
    return selected;
  }

  // Everything that was probed failed. Validation has false negatives — hosts that
  // refuse the Range probe but play fine — so an empty list here is more likely to
  // be wrong than the candidates are.
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
    const alternativeTitles = await resolveWithin(
      alternativeTitlesPromise || tmdb.getAlternativeTitles(type, tmdbId),
      ALTERNATIVE_TITLES_MAX_WAIT_MS,
      null
    );

    if (alternativeTitles === null) {
      console.warn(`Orchestrator: Alternative titles did not arrive within ${ALTERNATIVE_TITLES_MAX_WAIT_MS}ms; starting scrapers without them.`);
    }

    const extraTitles = (alternativeTitles || []).filter((candidate) => {
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
      createScraperTask(pelispedia, 'PelisPedia', buildScraperArgs('PelisPedia', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles),
      createScraperTask(tlnovelas, 'TLNovelas', buildScraperArgs('TLNovelas', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles),
      createScraperTask(novelas360, 'Novelas360', buildScraperArgs('Novelas360', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles)
    ];

    if (ENABLE_CINEHDPLUS) {
      scraperTasks.push(createScraperTask(cinehdplus, 'CineHDPlus', buildScraperArgs('CineHDPlus', title, originalTitle, year, type, season, episode), SCRAPER_TIMEOUT_MS, extraTitles));
    }

    // One controller and one validator for the whole request, so probes started
    // while sources are still reporting are the same ones the final selection
    // waits on, and a single abort cancels them all.
    const validationController = new AbortController();
    // The gate is handed to both sides because each needs the other: collection
    // decides when enough streams are confirmed, and only the validator knows when
    // that number changes.
    const fastReturnGate = { recheck: () => {} };
    const validator = createStreamValidator(validationController.signal, () => fastReturnGate.recheck());

    const collection = await collectScraperResults(
      scraperTasks,
      SCRAPER_COLLECTION_TIMEOUT_MS,
      (streams) => startEagerValidation(streams, validator),
      { getConfirmedCount: () => validator.confirmed, gate: fastReturnGate }
    );

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
    // Already ordered by validatePlayableStreams: confirmed streams first, each
    // group ranked by host. Re-sorting here undid that — it ranks purely on host
    // score, which floats an unproven stream from a well-scored host back above
    // streams that were actually proven to play. A turboviplay master whose
    // variants no longer resolve scores 1, so it landed at the top of the list
    // and was the first thing a viewer clicked.
    const selected = await validatePlayableStreams(sanitizedStreams, validator, validationController);
    // Labeling happens here rather than inside validatePlayableStreams, which has
    // three ways out: a label written twice reads as "1080p • 1080p".
    return selected.map(withQualityLabel);

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
  __test: {
    sanitizeStream,
    streamCache,
    hostHealth,
    createStreamValidator,
    isDefiniteFetchFailure,
    startEagerValidation,
    validatePlayableStreams,
    firstVariantUrl,
    isMasterPlaylist,
    sortStreams
  }
};

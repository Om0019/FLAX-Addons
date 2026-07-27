/**
 * Stream quality detection.
 *
 * Quality comes from three places, in descending order of how far it can be
 * trusted:
 *
 *   1. RESOLUTION on the #EXT-X-STREAM-INF lines of an HLS master playlist. The
 *      host is describing its own renditions, so this is measured rather than
 *      claimed. The validation probe in ./scrapers/index.js already reads the
 *      first PROBE_RANGE_BYTES of every candidate, so reading it costs nothing.
 *   2. BANDWIDTH on those same lines, when RESOLUTION is absent. Bitrate implies
 *      a resolution only roughly, so these are marked estimated and rendered with
 *      a leading ~ rather than passed off as a measurement.
 *   3. The stream URL and the label the source gave the option. Free, but a claim:
 *      /1080/ in a CDN path is the name of a directory, not a promise about what
 *      is inside it.
 *
 * A media playlist — segments, no variants — names no resolution at all, and
 * neither does a bare MP4. Those fall through to (3), or stay unlabeled: reading
 * width and height out of the container means parsing a moov box that progressive
 * files usually put at the far end, which does not fit the validation budget.
 */

// Rungs of an encoding ladder. Matching any three or four digit run instead —
// even a delimited one — turns cache keys and expiry stamps into resolutions.
const KNOWN_HEIGHTS = [2160, 1440, 1080, 720, 576, 540, 480, 360, 240];
const MAX_KNOWN_HEIGHT = 2160;

// Where a bitrate sits on a typical H.264 ladder, in bps. Only consulted when a
// variant declares no RESOLUTION. The bottom rung is a plausibility floor as much
// as a bucket: a master that says BANDWIDTH=1 is not describing 240p video, it is
// describing nothing, and guessing off it would label the whole catalogue.
const BANDWIDTH_LADDER = [
  [12000000, 2160],
  [7000000, 1440],
  [3500000, 1080],
  [1800000, 720],
  [800000, 480],
  [350000, 360],
  [150000, 240]
];

// How much a reading is worth when two of them disagree. A measurement always
// beats a claim, and the URL beats the site's own option label: paths are written
// by whatever packaged the rendition, labels by whoever wrote the page.
const CONFIDENCE = {
  manifest: 3,
  bandwidth: 2,
  url: 1,
  label: 0
};

// Path and query punctuation. A URL scan bounded by these skips the inside of a
// token — a1080b is not a resolution — while still catching /1080p/, _720p.,
// /hls/480/index.m3u8 and ?res=360.
const URL_BOUNDARY = '[/_.=&?,:-]';
const LABEL_BOUNDARY = '[^a-z0-9]';

// Tier words, in an order that matters: hdcam is a cam and not HD, and full hd is
// 1080 and not 720. The vague ones keep the wording the site used and borrow a
// height only for ranking — printing "720p" because a page said "HD" invents a
// precision nobody measured. 4K is the exception: it names 2160p exactly, so it is
// rendered that way rather than as a second spelling of the same rung.
const TIER_PATTERNS = [
  [/\b(?:hdcam|camrip|hdts|cam)\b/i, { tier: 'cam', label: 'CAM' }],
  [/\b(?:full\s*hd|fhd)\b/i, { height: 1080, label: 'FHD' }],
  [/\b(?:uhd|4k)\b/i, { height: 2160 }],
  [/\bhd\b/i, { height: 720, label: 'HD' }],
  [/\bsd\b/i, { height: 480, label: 'SD' }]
];

// A quality already written into a title, ours or the source's, with any bullet
// that joins it on. Used to keep a measurement from being appended next to the
// claim it contradicts.
//
// The tier words are here for the same reason the digits are: they are the same
// claim in a different spelling, and matching only digits meant LaMovie's own
// "Latino Full HD" survived a 720p measurement and reached viewers as
// "Latino Full HD • 720p". Kept in step with TIER_PATTERNS, longest alternative
// first so "full hd" is not left as a stray "full", and word-bounded so the "HD"
// inside a server name like CineHDPlus is not mistaken for a claim.
const TITLE_QUALITY_SOURCE = '\\s*[•·|]?\\s*(?:[≥~]?\\d{3,4}p|\\b(?:full\\s*hd|fhd|uhd|4k|hdcam|camrip|hdts|hd|sd|cam)\\b)';
const TITLE_QUALITY_TOKEN = new RegExp(TITLE_QUALITY_SOURCE, 'gi');
// Separate, non-global twin: a /g regex carries lastIndex between test() calls,
// so the two uses must not share one object.
const HAS_TITLE_QUALITY_TOKEN = new RegExp(TITLE_QUALITY_SOURCE, 'i');

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Playlist lines that were read whole. The probe asks for a byte range, so the
 * body can stop mid-line, and a half-read #EXT-X-STREAM-INF reports RESOLUTION=
 * 1920x10. The final line is only trusted when the body ended on a newline.
 */
function completePlaylistLines(body) {
  const text = String(body || '');
  const lines = text.split(/\r?\n/);
  if (!/\r?\n$/.test(text)) lines.pop();
  return lines;
}

function heightFromBandwidth(bandwidth) {
  if (!Number.isFinite(bandwidth)) return null;

  for (const [floor, height] of BANDWIDTH_LADDER) {
    if (bandwidth >= floor) return height;
  }

  return null;
}

function makeQuality(height, source, flags = {}) {
  return {
    height: height || null,
    tier: flags.tier || null,
    label: flags.label || null,
    source,
    estimated: source === 'bandwidth',
    atLeast: Boolean(flags.atLeast)
  };
}

/**
 * RESOLUTION and BANDWIDTH for every complete variant a master playlist declares.
 * Both attributes are unquoted integers, so they can be picked out of the
 * attribute list without parsing it — which is the point, because CODECS carries
 * commas inside its quotes and splitting on commas tears it apart. Anchoring on
 * the preceding : or , is what keeps AVERAGE-BANDWIDTH from being read as
 * BANDWIDTH.
 */
function parseMasterVariants(body) {
  const variants = [];

  for (const line of completePlaylistLines(body)) {
    if (!line.startsWith('#EXT-X-STREAM-INF')) continue;

    const resolution = line.match(/[:,]\s*RESOLUTION\s*=\s*(\d+)x(\d+)/i);
    const bandwidth = line.match(/[:,]\s*BANDWIDTH\s*=\s*(\d+)/i);

    variants.push({
      height: resolution ? parseInt(resolution[2], 10) : null,
      bandwidth: bandwidth ? parseInt(bandwidth[1], 10) : null
    });
  }

  return variants;
}

/**
 * The best rendition a master playlist offers, or null when it offers no clue.
 * The top of the ladder rather than the average: a player moves between variants
 * as the connection allows, so the highest one is what the stream is worth.
 *
 * `complete` says whether the whole playlist was read. A truncated body may hide
 * better variants further down, so its reading is a floor and gets rendered as
 * one — except at the top of the ladder, where there is nothing left to hide.
 */
function qualityFromManifest(body, { complete = true } = {}) {
  const variants = parseMasterVariants(body);
  if (variants.length === 0) return null;

  const declared = variants.map((variant) => variant.height).filter(Boolean);
  const source = declared.length > 0 ? 'manifest' : 'bandwidth';
  const heights = declared.length > 0
    ? declared
    : variants.map((variant) => heightFromBandwidth(variant.bandwidth)).filter(Boolean);

  if (heights.length === 0) return null;

  const height = Math.max(...heights);
  return makeQuality(height, source, {
    atLeast: !complete && height < MAX_KNOWN_HEIGHT
  });
}

function claimedHeights(text, boundary) {
  const heights = [];
  const opening = `(?:^|${boundary})`;
  // A lookahead rather than a match, so two claims sharing one delimiter are both
  // seen instead of the first eating the separator the second needs.
  const closing = `(?=$|${boundary})`;
  const push = (value) => {
    const height = parseInt(value, 10);
    if (KNOWN_HEIGHTS.includes(height)) heights.push(height);
  };

  // 1920x1080 — the second number is the one that names the rendition.
  for (const match of text.matchAll(new RegExp(`${opening}\\d{3,4}x(\\d{3,4})${closing}`, 'gi'))) {
    push(match[1]);
  }

  // 1080p, 720P
  for (const match of text.matchAll(new RegExp(`${opening}(\\d{3,4})p${closing}`, 'gi'))) {
    push(match[1]);
  }

  // A bare rung: /hls/1080/, ?res=720
  for (const match of text.matchAll(new RegExp(`${opening}(\\d{3,4})${closing}`, 'gi'))) {
    push(match[1]);
  }

  return heights;
}

/** Quality claimed by a stream URL: /1080p/, _720p., /hls/480/, ?res=360. */
function qualityFromUrl(url) {
  const text = String(url || '');
  const heights = claimedHeights(text, URL_BOUNDARY);

  if (new RegExp(`(?:^|${URL_BOUNDARY})(?:4k|uhd)(?=$|${URL_BOUNDARY})`, 'i').test(text)) {
    heights.push(2160);
  }

  return heights.length > 0
    ? makeQuality(Math.max(...heights), 'url')
    : null;
}

/**
 * Quality claimed by the label a source gave the option — "Latino 1080p",
 * "FULL HD", "CAM". An explicit resolution wins over a tier word, since 1080p
 * says more than HD and some pages carry both.
 */
function qualityFromLabel(...texts) {
  const text = texts.filter(Boolean).join(' ');
  if (!text) return null;

  const heights = claimedHeights(text, LABEL_BOUNDARY);
  if (heights.length > 0) {
    return makeQuality(Math.max(...heights), 'label');
  }

  for (const [pattern, flags] of TIER_PATTERNS) {
    if (pattern.test(text)) {
      return makeQuality(flags.height, 'label', flags);
    }
  }

  return null;
}

/** The better of two readings: higher confidence first, then higher resolution. */
function bestQuality(a, b) {
  if (!a) return b || null;
  if (!b) return a;

  const byConfidence = CONFIDENCE[b.source] - CONFIDENCE[a.source];
  if (byConfidence !== 0) return byConfidence > 0 ? b : a;

  return (b.height || 0) > (a.height || 0) ? b : a;
}

/** What a stream claims about itself, before anything has been probed. */
function claimedQuality(stream) {
  return bestQuality(
    qualityFromUrl(stream?.url),
    qualityFromLabel(stream?.title, stream?.name)
  );
}

/**
 * Sort key: taller is better, and at equal height the better-evidenced reading
 * wins. A cam sinks below an unknown, because unknown might be anything and a cam
 * is definitely a phone pointed at a screen.
 */
function qualityRank(quality) {
  if (!quality) return 0;
  if (quality.tier === 'cam') return -10;
  if (!quality.height) return 0;
  return quality.height * 10 + (CONFIDENCE[quality.source] || 0);
}

function formatQuality(quality) {
  if (!quality) return '';
  if (quality.label) return quality.label;
  if (!quality.height) return '';

  const base = `${quality.height}p`;
  if (quality.atLeast) return `≥${base}`;
  if (quality.estimated) return `~${base}`;
  return base;
}

function isMeasured(quality) {
  return quality?.source === 'manifest' || quality?.source === 'bandwidth';
}

/**
 * Writes the detected quality into the title Stremio shows. Appended rather than
 * substituted, so the source and server name a viewer picks by are still there.
 *
 * A measurement replaces any quality already in the title, because the two can
 * disagree: LaMovie hands over its own "Latino 1080p" for ladders that top out at
 * 720p, and appending to that reads as "1080p • 720p". A claim never overwrites
 * another claim — there is nothing to prefer about it — and it is not restated
 * beside one either: the claim in "Latino Full HD" is read straight back out of
 * that title, and appending it produced "Latino Full HD • FHD".
 */
function withQualityLabel(stream) {
  const label = formatQuality(stream?.quality);
  if (!label) return stream;

  const title = String(stream.title || '');
  const measured = isMeasured(stream.quality);

  if (!measured && HAS_TITLE_QUALITY_TOKEN.test(title)) {
    return stream;
  }

  const base = measured
    ? title.replace(TITLE_QUALITY_TOKEN, '').trim()
    : title;

  // Already says it — either the source did, or this ran twice.
  if (new RegExp(`(?:^|\\s)${escapeRegExp(label)}(?:$|\\s)`, 'i').test(base)) {
    return stream;
  }

  return {
    ...stream,
    title: base ? `${base} • ${label}` : label
  };
}

module.exports = {
  bestQuality,
  claimedQuality,
  completePlaylistLines,
  formatQuality,
  qualityFromLabel,
  qualityFromManifest,
  qualityFromUrl,
  qualityRank,
  withQualityLabel,
  __test: {
    BANDWIDTH_LADDER,
    KNOWN_HEIGHTS,
    heightFromBandwidth,
    parseMasterVariants
  }
};

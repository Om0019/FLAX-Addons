/**
 * Shaping the aggregated provider output into what Stremio receives: which
 * duplicates survive, which links are worth probing, and how a raw provider
 * stream becomes a Stremio stream object.
 */

const { extractContainer, extractResolution, formatStreamName, formatStreamDescription } = require('./stream-template');
const { resolutionTier, TIER_ORDER } = require('./curate');

/**
 * Two providers reaching the same CDN link is ordinary — several of these
 * resolve through shared hosts — and without this the same link was offered
 * twice, taking two of the viewer's slots to say one thing.
 *
 * Which duplicate survives is not arbitrary. Castle returns one URL — a path
 * under `/720/` — three times over, labelled 1080P, 720P and 480P. Keeping the
 * first occurrence kept the highest *claim*, so a 720p stream took the 1080p
 * slot and Castle never filled the 720p tier it actually belonged in. A URL
 * offered at several resolutions is at most the lowest of them, so that is the
 * one we keep: a label is a claim about the bytes, and the same bytes cannot be
 * two resolutions. Provider attribution still goes to the highest-ranked
 * provider offering the link, since ordering across providers is unchanged.
 */
function dedupeByUrl(entries) {
  const bestByUrl = new Map();
  for (const entry of entries) {
    const url = entry.raw?.url;
    if (!url) continue;

    const existing = bestByUrl.get(url);
    if (!existing) {
      bestByUrl.set(url, entry);
      continue;
    }
    // Same link from the same provider under a different label: demote to the
    // more conservative one. Across providers, first (highest-ranked) wins.
    if (existing.providerId === entry.providerId &&
      TIER_ORDER.indexOf(resolutionTier(entry.resolution)) > TIER_ORDER.indexOf(resolutionTier(existing.resolution))) {
      bestByUrl.set(url, { ...existing, resolution: entry.resolution, raw: entry.raw });
    }
  }
  return [...bestByUrl.values()];
}

/**
 * Stremio receives the URL verbatim, so it has to be one. 4KHDHub's Direct-R2
 * links carry the release filename unencoded — literal spaces in the path — and
 * a player handed that has no obligation to guess what was meant. Re-serialising
 * through URL fixes the encoding without touching sequences that are already
 * escaped, which matters because these paths are signature-checked.
 */
function normalizeUrl(url) {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
}

function normalizeStream(raw, providerName) {
  const behaviorHints = { notWebReady: true };
  if (raw.headers && Object.keys(raw.headers).length > 0) {
    behaviorHints.proxyHeaders = { request: raw.headers };
  }
  // Carried through from the provider, not invented here: it is what tells
  // Stremio that the next episode should come from the same source, and
  // rebuilding behaviorHints from scratch was silently dropping it.
  if (raw.behaviorHints?.bingeGroup) {
    behaviorHints.bingeGroup = raw.behaviorHints.bingeGroup;
  }

  return {
    name: formatStreamName(providerName, raw.__cached === true),
    title: formatStreamDescription({
      language: 'English',
      container: extractContainer(raw.url),
      resolution: extractResolution(raw)
    }),
    url: normalizeUrl(raw.url),
    behaviorHints
  };
}

module.exports = { dedupeByUrl, normalizeUrl, normalizeStream };

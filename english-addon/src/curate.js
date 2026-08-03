/**
 * Trims the combined stream list down to at most 2 per resolution tier, each
 * from a different provider, so one dead link still leaves a working
 * alternative without burying the list in near-duplicates. Anything below
 * 720p - 480p, 360p, or a stream whose resolution a provider never labeled
 * at all - is only included when none of 720p/1080p/2160p turned up
 * anything; otherwise it's padding, not a fallback.
 *
 * Torrentio goes first by design: when it has a cached result for a tier,
 * that's a direct debrid-backed link and gets first pick. When it doesn't
 * (nothing cached, or the debrid check couldn't run - see torbox-cache.js),
 * it simply has no entries in that tier, so pickTopDistinctProviders falls
 * straight through to the next-ranked provider with no special-casing
 * needed - "priority with instant fallback" is just what this ranking does.
 *
 * Everything after it follows what was actually observed working:
 * hdhub4u/uhdmovies/4khdhubnew/castle/netmirror consistently returned
 * results in testing; videasy has been deprioritized due to reliability;
 * vidsrc/vidfast/vidlink/allwish did not (in this dev sandbox - that looked
 * network-related rather than a real pattern, so they're kept in rotation
 * rather than dropped, just ranked last).
 */

const PROVIDER_PRIORITY = [
  'torrentio', 'hdhub4u', 'uhdmovies', '4khdhubnew', 'castle', 'netmirror',
  'videasy', 'vidsrc', 'vidfast', 'vidlink', 'allwish'
];

const PER_TIER_LIMIT = 2;
const PRIMARY_TIERS = ['2160p', '1080p', '720p'];
// 480p, 360p, and "no resolution info at all" are all treated as one bucket:
// each is a worse bet than any primary tier, so there's no reason to rank
// them against each other, only against whether a primary tier has anything.
const FALLBACK_TIER = 'fallback';

function providerRank(providerId) {
  const idx = PROVIDER_PRIORITY.indexOf(providerId);
  return idx === -1 ? PROVIDER_PRIORITY.length : idx;
}

function resolutionTier(resolution) {
  const normalized = String(resolution || '').toLowerCase();
  if (normalized.includes('2160') || normalized.includes('4k')) return '2160p';
  if (normalized.includes('1080')) return '1080p';
  if (normalized.includes('720')) return '720p';
  return FALLBACK_TIER;
}

/** Best `limit` entries by provider priority, at most one per provider. */
function pickTopDistinctProviders(entries, limit) {
  const sorted = [...entries].sort((a, b) => providerRank(a.providerId) - providerRank(b.providerId));
  const picked = [];
  const usedProviders = new Set();

  for (const entry of sorted) {
    if (usedProviders.has(entry.providerId)) continue;
    usedProviders.add(entry.providerId);
    picked.push(entry);
    if (picked.length >= limit) break;
  }

  return picked;
}

/**
 * @param {{ providerId: string, resolution: string|null }[]} entries
 * @returns entries to keep, ordered highest resolution first
 */
function curateStreams(entries) {
  const byTier = new Map([['2160p', []], ['1080p', []], ['720p', []], [FALLBACK_TIER, []]]);
  for (const entry of entries) {
    byTier.get(resolutionTier(entry.resolution)).push(entry);
  }

  const hasPrimaryTierResults = PRIMARY_TIERS.some((tier) => byTier.get(tier).length > 0);

  const selected = [];
  for (const tier of PRIMARY_TIERS) {
    selected.push(...pickTopDistinctProviders(byTier.get(tier), PER_TIER_LIMIT));
  }
  if (!hasPrimaryTierResults) {
    selected.push(...pickTopDistinctProviders(byTier.get(FALLBACK_TIER), PER_TIER_LIMIT));
  }

  return selected;
}

module.exports = { curateStreams, resolutionTier };

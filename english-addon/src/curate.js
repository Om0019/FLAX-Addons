/**
 * Trims the combined stream list to at most 3 non-AIOStreams streams, ranked
 * by provider reliability first and resolution second. AIOStreams entries
 * never pass through this at all - they get their own three-tier cap via
 * curateAiostreams below (one 2160p, one 1080p, one lower/unlabeled), applied
 * by server.js ahead of this list entirely.
 *
 * Reliability dominates. A provider several ranks down in PROVIDER_PRIORITY
 * does not get to jump a reliable provider by claiming a higher resolution -
 * "higher quality" is not evidence the link actually plays, and an unproven
 * 2160p claim from a shaky source is not a better bet than a proven
 * provider's 1080p. Resolution only breaks ties between providers the list
 * doesn't otherwise distinguish.
 *
 * Quality does one other job: a provider contributes at most one entry, its
 * single best resolution - not because quality outranks reliability, but
 * because the rule that lets a reliable, multi-resolution provider through
 * at all only grants it one slot, not one per resolution it happens to
 * offer. hdhub4u having 2160p, 1080p and 720p links for the same title is
 * one strong source, not three of the three slots.
 *
 * AIOStreams goes first by design, ahead of this list entirely: when it has
 * a result, that's a direct debrid-backed link and gets first pick, as
 * server.js's own AIOStreams handling reflects. Reliability here otherwise
 * reflects a 12-title reliability probe (6 popular + 6 non-popular
 * movies/series, each provider's raw output sample-probed for actual
 * playability, not just whether it returned a URL):
 *
 *   videasy       92%      hdhub4u     33%
 *   4khdhubnew    75%      castle      33%
 *   uhdmovies     50%      streamflix   8%
 *
 * videasy and 4khdhubnew held up on both popular and non-popular titles.
 * hdhub4u/uhdmovies/castle looked strong on blockbusters alone (as high as
 * 67-83%) but collapsed to 0-17% on non-popular titles - they lean heavily
 * on trending-content indexes. streamflix returns a URL on nearly every
 * title (100% hit rate) but the URL is rarely actually playable (8%
 * confirmed) - ranked near the bottom despite the high hit rate for exactly
 * that reason. peachify 403s on every server in testing; ranked with
 * allwish (anime-only, so untested by general movies/series) at the end
 * rather than dropped, since either could still contribute on a title the
 * probe sample didn't cover.
 *
 * netmirror, vidlink, vidsrc and vidfast are absent deliberately - see the
 * registry in src/providers/index.js for what each one does now.
 */

const PROVIDER_PRIORITY = [
  'aiostreams', 'videasy', '4khdhubnew', 'uhdmovies', 'hdhub4u', 'castle',
  'streamflix', 'peachify', 'allwish'
];

const MAX_STREAMS = 3;
const PRIMARY_TIERS = ['2160p', '1080p', '720p'];
// 480p, 360p, and "no resolution info at all" are all treated as one bucket:
// each is a worse bet than any primary tier, so there's no reason to rank
// them against each other, only against whether a primary tier has anything.
const FALLBACK_TIER = 'fallback';
// Best first, so a larger index is the more conservative claim. Used both as
// curateStreams' tiebreak and, in the server's response shaping, to resolve
// the same link arriving under two different resolution labels; kept beside
// resolutionTier so the two cannot drift apart.
const TIER_ORDER = [...PRIMARY_TIERS, FALLBACK_TIER];

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

function tierRank(entry) {
  return TIER_ORDER.indexOf(resolutionTier(entry.resolution));
}

// AIOStreams gets its own three-tier cap, separate from the five-provider
// PRIMARY_TIERS/FALLBACK_TIER split above: one 2160p pick, one 1080p pick,
// and one pick for everything else (720p, 480p, 360p, or no resolution info
// at all, all treated as a single "whatever's playable at a lower tier"
// slot rather than three separate ones). Unlike curateStreams, this isn't
// capping *per provider* - AIOStreams is one source - it's capping the
// whole result to three streams total, one per tier.
const AIOSTREAMS_TIERS = ['2160p', '1080p', 'other'];

function aiostreamsTier(resolution) {
  const normalized = String(resolution || '').toLowerCase();
  if (normalized.includes('2160') || normalized.includes('4k')) return '2160p';
  if (normalized.includes('1080')) return '1080p';
  return 'other';
}

/**
 * @param {{ resolution: string|null }[]} entries
 * @returns at most one entry per tier (2160p, 1080p, other), tiers in that order
 */
function curateAiostreams(entries) {
  const bestPerTier = new Map();
  for (const entry of entries) {
    const tier = aiostreamsTier(entry.resolution);
    if (!bestPerTier.has(tier)) bestPerTier.set(tier, entry);
  }
  return AIOSTREAMS_TIERS.map((tier) => bestPerTier.get(tier)).filter(Boolean);
}

/**
 * @param {{ providerId: string, resolution: string|null }[]} entries
 * @returns entries to keep, ordered most reliable provider first
 */
function curateStreams(entries) {
  const bestPerProvider = new Map();
  for (const entry of entries) {
    const existing = bestPerProvider.get(entry.providerId);
    if (!existing || tierRank(entry) < tierRank(existing)) {
      bestPerProvider.set(entry.providerId, entry);
    }
  }

  return [...bestPerProvider.values()]
    .sort((a, b) => providerRank(a.providerId) - providerRank(b.providerId) || tierRank(a) - tierRank(b))
    .slice(0, MAX_STREAMS);
}

module.exports = { curateStreams, curateAiostreams, resolutionTier, TIER_ORDER };

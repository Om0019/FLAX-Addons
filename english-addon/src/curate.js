/**
 * Trims the combined stream list to at most 5 non-torrentio streams, ranked
 * by provider reliability first and resolution second. (Torrentio has its
 * own separate slots, added on top in server.js - this cap doesn't count
 * them.)
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
 * one strong source, not three of the five slots.
 *
 * Torrentio goes first by design, ahead of this list entirely: when it has a
 * cached result, that's a direct debrid-backed link and gets first pick, as
 * server.js's own torrentio handling reflects. Reliability here otherwise
 * reflects what was actually observed working: hdhub4u/uhdmovies/4khdhubnew/
 * castle consistently returned playable links in testing. streamflix is
 * ranked below that: its links only state a resolution when the release
 * filename happens to carry one. videasy is ranked last of the working
 * sources: most of its servers answer 404/500 on any given title, worse
 * than peachify's own hit rate. allwish is anime-only and contributes
 * nothing to anything else, so it costs nothing to leave in rotation at the
 * end.
 *
 * netmirror, vidlink, vidsrc and vidfast are absent deliberately - see the
 * registry in src/providers/index.js for what each one does now.
 */

const PROVIDER_PRIORITY = [
  'torrentio', 'hdhub4u', 'uhdmovies', '4khdhubnew', 'castle',
  'streamflix', 'peachify', 'videasy', 'allwish'
];

const MAX_STREAMS = 5;
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

// Separate from MAX_STREAMS deliberately: Torrentio is one provider
// surfacing many distinct cached torrents (different releases, different
// hashes), not many providers each claiming a title. The "one entry per
// provider" rule in curateStreams doesn't apply here.
//
// It used to keep up to 5 entries ranked by resolution alone, on the theory
// that discarding any of TorBox's confirmed-instant releases was a waste.
// In practice a title with many cached releases skews toward one tier -
// fifteen 2160p torrents was the observed count for a real title - so those
// 5 slots were routinely 2160p five times over: every visible option
// claimed the same resolution, with 1080p/720p/unknown releases (just as
// instant) never shown at all. One entry per resolution tier fixes that:
// the list is capped at TIER_ORDER.length (2160p/4k, 1080p, 720p, unknown)
// by construction, and each slot is a genuinely different quality rather
// than a coin flip between same-tier duplicates.
/**
 * @param {{ resolution: string|null }[]} entries all already known to be Torrentio's
 * @returns entries to keep, at most one per resolution tier, best tier first
 */
function curateTorrentioStreams(entries) {
  const bestPerTier = new Map();
  for (const entry of entries) {
    const tier = resolutionTier(entry.resolution);
    if (!bestPerTier.has(tier)) {
      bestPerTier.set(tier, entry);
    }
  }
  return TIER_ORDER.map((tier) => bestPerTier.get(tier)).filter(Boolean);
}

module.exports = { curateStreams, curateTorrentioStreams, resolutionTier, TIER_ORDER };

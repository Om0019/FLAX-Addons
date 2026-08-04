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
 * castle consistently returned playable links in testing. netmirror sits
 * just below them - verified end to end (real HLS ladder, real audio
 * tracks, working segments) across several titles, but through a single
 * narrow path (Netflix/Prime/Hotstar/Disney search only, not a general
 * catalog), so it's trusted less than sources proven across a broader range
 * of content. streamflix is ranked below that: its links only state a
 * resolution when the release filename happens to carry one. videasy is
 * ranked lower still: most of its servers answer 404/500 on any given
 * title. peachify is last of the working sources; allwish is anime-only and
 * contributes nothing to anything else, so it costs nothing to leave in
 * rotation at the end.
 *
 * vidlink, vidsrc and vidfast are absent deliberately - see the registry in
 * src/providers/index.js for what each one does now.
 */

const PROVIDER_PRIORITY = [
  'torrentio', 'hdhub4u', 'uhdmovies', '4khdhubnew', 'castle', 'netmirror',
  'streamflix', 'videasy', 'peachify', 'allwish'
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
// provider" rule in curateStreams doesn't apply here - collapsing Torrentio
// to a single stream would have been throwing away the other cached
// releases TorBox already confirmed are instant, for no reason but an
// arbitrary cap. Ranked by resolution only, since every entry already comes
// from the one most-trusted source and there is no second provider to break
// ties against.
const TORRENTIO_STREAM_LIMIT = 5;

/**
 * @param {{ resolution: string|null }[]} entries all already known to be Torrentio's
 * @returns entries to keep, ordered highest resolution first
 */
function curateTorrentioStreams(entries) {
  return [...entries]
    .sort((a, b) => tierRank(a) - tierRank(b))
    .slice(0, TORRENTIO_STREAM_LIMIT);
}

module.exports = { curateStreams, curateTorrentioStreams, resolutionTier, TIER_ORDER };

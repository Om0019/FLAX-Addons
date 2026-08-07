/**
 * Caps the non-AIOStreams portion of a request's already-validated stream
 * list to at most 3 streams, one per scraper, favoring the scrapers measured
 * to actually deliver a playable link. AIOStreams entries (identified by
 * `__sourceLabel`, set by the orchestrator in src/scrapers/index.js) are
 * left untouched and uncapped, mirroring english-addon/src/curate.js's own
 * AIOStreams/non-AIOStreams split.
 *
 * This runs on `selected` - the list src/scrapers/index.js has already
 * probed and sorted (confirmed-playable first, each group ranked by host
 * quality) - rather than on the raw per-scraper output. Picking each
 * scraper's first surviving entry from that list is what gives a scraper
 * whose top pick died a second chance from its own remaining streams,
 * without a separate refill loop: a dead stream is already gone from
 * `selected` by the time this runs. The relative order of what's kept is
 * left exactly as validation produced it - this only decides which entries
 * survive, not how they're ordered.
 *
 * SCRAPER_PRIORITY reflects a 13-title reliability probe (6 popular + 6
 * non-popular movies/series, one telenovela to fairly test the
 * telenovela-specific sources), sample-probing each scraper's raw output for
 * actual playability rather than just whether it returned a URL:
 *
 *   SoloLatino   92%      Cinecalidad  54%
 *   TioPlus      92%      TLNovelas/   scoped to telenovela content -
 *   PelisPedia   92%      Ennovelas/   general movies/series are not a
 *   Embed69      85%      Novelas360   fair test of these three
 *   LaMovie      54%      Cuevana3i     0% - found the right page every
 *                                           time but extracted zero player
 *                                           links across all 13 titles,
 *                                           reads as a current site break
 *
 * The telenovela-specific three are kept ahead of Cuevana3i despite the
 * unfair mainstream-title sample: Cuevana3i's failure was measured on its
 * own home turf (general movies/series) and still came up empty, while the
 * telenovela three simply weren't given the content they're built for.
 */

const SCRAPER_PRIORITY = [
  'SoloLatino', 'TioPlus', 'PelisPedia', 'Embed69', 'LaMovie', 'Cinecalidad',
  'TLNovelas', 'Ennovelas', 'Novelas360', 'Cuevana3i'
];

const MAX_NON_AIOSTREAMS = 3;

function scraperRank(sourceLabel) {
  const idx = SCRAPER_PRIORITY.indexOf(sourceLabel);
  return idx === -1 ? SCRAPER_PRIORITY.length : idx;
}

/**
 * @param {{ __sourceLabel?: string }[]} selected already-validated streams
 * @returns the same streams, non-AIOStreams ones capped to at most 3 - one
 *   per scraper, most reliable scrapers first - in their original order
 */
function curateNonAiostreams(selected) {
  const bestPerScraper = new Map();
  for (const stream of selected) {
    if (stream.__sourceLabel === 'AIOStreams') continue;
    if (!bestPerScraper.has(stream.__sourceLabel)) {
      bestPerScraper.set(stream.__sourceLabel, stream);
    }
  }

  const keep = new Set(
    [...bestPerScraper.values()]
      .sort((a, b) => scraperRank(a.__sourceLabel) - scraperRank(b.__sourceLabel))
      .slice(0, MAX_NON_AIOSTREAMS)
  );

  return selected.filter((stream) => stream.__sourceLabel === 'AIOStreams' || keep.has(stream));
}

module.exports = { curateNonAiostreams, SCRAPER_PRIORITY, MAX_NON_AIOSTREAMS };

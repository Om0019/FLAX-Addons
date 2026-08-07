/**
 * Helpers shared by the source scrapers.
 *
 * Note that slugifyTitle is deliberately NOT here. Each site guesses URLs with its
 * own conventions — sololatino joins with "y", tioplus with "and", cuevana3i strips
 * punctuation the others keep — and collapsing those would quietly change which
 * fallback URLs get probed. They stay per-scraper on purpose.
 */

/**
 * Reduces a title to comparable form: lowercase, accents removed, non-alphanumerics
 * dropped. "Anatomía de Grey" and "anatomia-de-grey" both become "anatomiadegrey".
 */
function cleanText(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** First four-digit year found in a value, or null. */
function extractYear(value) {
  const match = String(value || '').match(/\b(?:19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

/** Every distinct four-digit year across the given values, as strings. */
function extractCandidateYears(...values) {
  const years = new Set();

  for (const value of values) {
    const matches = String(value || '').match(/\b(?:19|20)\d{2}\b/g) || [];
    for (const match of matches) {
      years.add(match);
    }
  }

  return years;
}

/**
 * Searches every title in `titles` at once and returns the match belonging to the
 * earliest title in the list — priority order is the caller's and has to survive
 * the race, so this is not "whichever answered first".
 *
 * These lookups used to run strictly one after another, which meant a title the
 * site happens to file under its original name paid a full extra search round trip
 * before that name was ever tried. They are independent GETs against the same
 * search endpoint, so overlapping them costs one wasted request in the case where
 * the first title matches anyway, and saves a whole round trip in the case where it
 * does not. Only the two titles that are always worth trying belong here; the
 * alternative-title tail stays sequential, since there can be several and firing
 * them all would multiply the load on the site for a case that rarely pays off.
 *
 * Failures are deferred the same way results are: an error surfaces only once every
 * higher-priority title has settled without a match, which is exactly the point at
 * which the sequential version would have made that request and thrown. A rejection
 * from a title that never gets consulted is absorbed rather than left unhandled.
 */
async function raceTitleSearches(titles, search) {
  const attempts = titles.map((title) => (
    Promise.resolve()
      .then(() => search(title))
      .then((match) => ({ match }), (error) => ({ error }))
  ));

  for (const attempt of attempts) {
    const { match, error } = await attempt;
    if (error) throw error;
    if (match) return match;
  }

  return null;
}

/**
 * Runs `worker` over `items` with at most `concurrency` in flight, collecting the
 * truthy results. Results arrive in completion order, not input order.
 */
async function mapWithConcurrency(items, concurrency, worker) {
  const results = [];
  let index = 0;

  async function runNext() {
    while (index < items.length) {
      const currentIndex = index++;
      const result = await worker(items[currentIndex], currentIndex);
      if (result) results.push(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => runNext())
  );

  return results;
}

module.exports = {
  cleanText,
  extractCandidateYears,
  extractYear,
  mapWithConcurrency,
  raceTitleSearches
};

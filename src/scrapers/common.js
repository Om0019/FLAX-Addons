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
  mapWithConcurrency
};

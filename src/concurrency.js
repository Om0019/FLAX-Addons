/**
 * Shared concurrency helpers.
 *
 * Several places in this addon have the same shape: a list of candidates that has
 * already been sorted into preference order, where the first one that works wins.
 * Run strictly one at a time, a chain of dead candidates costs a full round trip
 * each before reaching a live one; run all at once, one lookup becomes a burst
 * against every host the list names. These bound the overlap instead.
 */

/**
 * Runs `worker` over `items` with at most `concurrency` in flight and resolves to
 * the result of the *earliest* item that produced one — not whichever finished
 * first. Callers rank their candidates before calling, and that ranking has to
 * decide the winner, or overlapping them would quietly change which mirror, page or
 * server gets used.
 *
 * Once a winner is known, no further items are started; runners stop after the
 * attempt they are already inside. `worker` failures are treated as "this candidate
 * did not work" — the sequential loops this replaced all caught per candidate and
 * carried on — so a worker that wants its failures logged should log them itself.
 */
function firstResultInOrder(items, concurrency, worker) {
  const pending = items.map(() => {
    let settle;
    const promise = new Promise((resolve) => { settle = resolve; });
    return { promise, settle };
  });

  let cursor = 0;
  let stopped = false;

  async function runNext() {
    while (!stopped) {
      const index = cursor++;
      if (index >= items.length) return;
      let outcome = null;
      try {
        outcome = await worker(items[index], index);
      } catch {
        outcome = null;
      }
      pending[index].settle(outcome);
    }
  }

  // At least one runner whenever there is anything to run: with none, no entry
  // would ever settle and the await below would never return.
  const runners = items.length === 0 ? 0 : Math.max(1, Math.min(concurrency, items.length));
  Array.from({ length: runners }, () => runNext());

  return (async () => {
    for (const entry of pending) {
      const outcome = await entry.promise;
      if (outcome) {
        stopped = true;
        return outcome;
      }
    }
    return null;
  })();
}

module.exports = { firstResultInOrder };

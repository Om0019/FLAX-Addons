// A stream URL can be syntactically valid yet point to an expired token, a
// provider error page, or an unavailable host. Probe only the small curated
// set immediately before returning it to Stremio. This is deliberately a
// range request: no media is downloaded during discovery.

const STREAM_PROBE_TIMEOUT_MS = 2000;

function usableUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function clearlyNotMedia(contentType) {
  return /(?:text\/html|application\/(?:json|xml)|text\/plain)/i.test(contentType || '');
}

/**
 * Releases a probe's response body.
 *
 * The probe only ever reads headers, and a body nobody reads or cancels holds
 * its connection open — undici keeps the request in flight until the object is
 * collected. Measured, every probe leaked one socket to a third-party CDN, and
 * the probe runs on every curated stream of every request.
 */
async function discardBody(response) {
  if (!response.body || response.bodyUsed) return;
  await response.body.cancel().catch(() => {});
}

async function probeStream(stream, { timeoutMs = STREAM_PROBE_TIMEOUT_MS } = {}) {
  if (!usableUrl(stream?.url)) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(stream.url, {
      method: 'GET',
      headers: { ...(stream.headers || {}), Range: 'bytes=0-2047', Accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal
    });

    try {
      const contentType = response.headers.get('content-type');

      // Explicitly dead links
      if (response.status === 404 || response.status === 410) {
        return false;
      }

      // If it returned an HTML page (like a Cloudflare block or error page), drop it
      if (clearlyNotMedia(contentType)) {
        return false;
      }

      // Otherwise, assume it's playable (many servers return 403/416 to probes but work in players)
      return true;
    } finally {
      await discardBody(response);
    }
  } catch (error) {
    // If it's an AbortError (timeout), we might be dropping a slow but working stream. 
    // Let's keep it if it just timed out, as Stremio's player has longer timeouts.
    if (error.name === 'AbortError') {
      console.warn(`Probe timed out for ${stream.url}, keeping it anyway`);
      return true;
    }
    // Network errors (DNS, connection refused, etc.) mean it's dead
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function filterPlayableStreams(entries, options = {}) {
  const checks = await Promise.all(entries.map(async (entry) => {
    const playable = await probeStream(entry.raw, options);
    if (!playable) {
      console.warn(`English addon: dropping unreachable ${entry.providerId} stream`);
    }
    return playable ? entry : null;
  }));
  return checks.filter(Boolean);
}

/**
 * Probes `entries`, and tops the survivors back up from `reserve` until either
 * `target` of them are playable or the reserve runs out.
 *
 * Curation picks its candidates before anything is probed, so without this a
 * tier whose picks are both dead simply disappears from the response — even
 * when a lower-ranked provider had a working link that curation set aside. Each
 * round probes only as many replacements as were lost, so the common case where
 * everything works costs exactly what it did before.
 */
async function filterPlayableStreamsWithBackfill(entries, reserve, options = {}) {
  const { target = entries.length, deadlineAt = Infinity } = options;
  const queue = [...reserve];
  const playable = await filterPlayableStreams(entries, options);

  while (playable.length < target && queue.length > 0 && Date.now() < deadlineAt) {
    const replacements = queue.splice(0, target - playable.length);
    playable.push(...await filterPlayableStreams(replacements, options));
  }

  return playable;
}

module.exports = {
  STREAM_PROBE_TIMEOUT_MS,
  probeStream,
  filterPlayableStreams,
  filterPlayableStreamsWithBackfill
};

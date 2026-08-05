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

// An HLS playlist is text, and plenty of hosts label it `text/plain` rather
// than `application/vnd.apple.mpegurl`. Content type alone would throw those
// away as error pages, so before dropping a text response we look at what it
// actually is: a playlist announces itself on its first line.
const HLS_MAGIC = '#EXTM3U';

async function looksLikeHlsPlaylist(response) {
  try {
    const text = await response.text();
    return text.trimStart().startsWith(HLS_MAGIC);
  } catch {
    return false;
  }
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
      // - unless the "text" is in fact an HLS playlist, which is exactly what we
      // wanted to find.
      if (clearlyNotMedia(contentType)) {
        return await looksLikeHlsPlaylist(response);
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
 * Curates, probes, and re-curates over what survived, until the selection stops
 * changing or the budget runs out.
 *
 * Curation picks its candidates before anything is probed, so a tier whose picks
 * are all dead would otherwise vanish from the response even when a lower-ranked
 * provider had a working link for it.
 *
 * Refilling that gap from a flat list of runners-up is the obvious approach and
 * it is wrong: curation's rules — at most two per resolution tier, each from a
 * different provider, fallback tiers only when no primary tier produced anything
 * — hold only at the moment curation runs. A flat reserve is ordered across
 * tiers, so a dead 2160p pair pulled its replacements from the 1080p leftovers
 * and handed back four 1080p streams. Re-running `curate` over the survivors
 * re-establishes every one of those rules by construction, rather than
 * re-implementing them here where they would drift.
 *
 * Verdicts are remembered by URL, so each link is probed at most once no matter
 * how many rounds it survives into; a round that discovers no new candidates
 * ends the loop, which also bounds it.
 *
 * `shouldProbe` exempts entries whose playability a probe cannot establish.
 * An exempt entry is never fetched and never recorded as dead, so it passes
 * through curation untouched — the same treatment an unprobed stream gets when
 * the budget runs out.
 */
async function selectPlayableStreams(entries, curate, options = {}) {
  const { deadlineAt = Infinity, shouldProbe = () => true, ...probeOptions } = options;
  const verdictByUrl = new Map();
  const dead = new Set();

  for (;;) {
    const selection = curate(entries.filter((entry) => !dead.has(entry)));
    const unprobed = selection.filter((entry) => !verdictByUrl.has(entry.raw?.url) && shouldProbe(entry));

    // Nothing new to check, or no time left to check it: keep what has not been
    // disproved. An unprobed stream is unverified, not known-bad.
    if (unprobed.length === 0 || Date.now() >= deadlineAt) {
      return selection.filter((entry) => verdictByUrl.get(entry.raw?.url) !== false);
    }

    await Promise.all(unprobed.map(async (entry) => {
      const playable = await probeStream(entry.raw, probeOptions);
      verdictByUrl.set(entry.raw?.url, playable);
      if (!playable) {
        console.warn(`English addon: dropping unreachable ${entry.providerId} stream`);
        dead.add(entry);
      }
    }));
  }
}

module.exports = {
  STREAM_PROBE_TIMEOUT_MS,
  probeStream,
  filterPlayableStreams,
  selectPlayableStreams
};

// A stream URL can be syntactically valid yet point to an expired token, a
// provider error page, or an unavailable host. Probe only the small curated
// set immediately before returning it to Stremio. This is deliberately a
// range request: no media is downloaded during discovery.

const STREAM_PROBE_TIMEOUT_MS = 4000;

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

async function probeStream(stream, { timeoutMs = STREAM_PROBE_TIMEOUT_MS } = {}) {
  if (!usableUrl(stream?.url)) return false;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(stream.url, {
      method: 'GET',
      // Preserve the source's required Referer/Origin/etc., while enforcing
      // a tiny response body so probing does not consume the actual stream.
      headers: { ...(stream.headers || {}), Range: 'bytes=0-2047', Accept: '*/*' },
      redirect: 'follow',
      signal: controller.signal
    });
    const contentType = response.headers.get('content-type');
    // A successful range or full response is sufficient. Some CDNs omit a
    // media content-type, so only reject types that positively identify an
    // error/document response.
    return response.ok && !clearlyNotMedia(contentType);
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function filterPlayableStreams(entries) {
  const checks = await Promise.all(entries.map(async (entry) => {
    const playable = await probeStream(entry.raw);
    if (!playable) {
      console.warn(`English addon: dropping unreachable ${entry.providerId} stream`);
    }
    return playable ? entry : null;
  }));
  return checks.filter(Boolean);
}

module.exports = { STREAM_PROBE_TIMEOUT_MS, probeStream, filterPlayableStreams };

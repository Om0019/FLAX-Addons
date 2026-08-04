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

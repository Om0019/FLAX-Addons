const DEFAULT_TIMEOUT_MS = 6000;

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&#038;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeUrl(value, baseUrl) {
  if (!value) return null;

  let url = decodeHtmlEntities(value).trim();
  url = url.replace(/\\\//g, '/');

  try {
    return new URL(url, baseUrl).toString();
  } catch {
    return null;
  }
}

/**
 * Shared timeout/abort plumbing. `consume` decides how much of the exchange the
 * deadline covers: returning the response ends it at the headers, while reading
 * the body inside `consume` keeps the timer and the caller's signal armed until
 * the body is done.
 */
async function fetchWithDeadline(url, options, timeoutMs, consume) {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  const externalSignal = options.signal;
  const abortFromExternalSignal = () => controller.abort();

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      externalSignal.addEventListener('abort', abortFromExternalSignal, { once: true });
    }
  }

  const { signal, ...fetchOptions } = options;

  try {
    const res = await fetch(url, {
      ...fetchOptions,
      signal: controller.signal
    });

    return await consume(res);
  } catch (error) {
    if (error.name === 'AbortError') {
      if (!timedOut) {
        throw new Error(`Fetch aborted: ${url}`);
      }
      throw new Error(`Fetch timeout after ${timeoutMs}ms: ${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternalSignal);
    }
  }
}

/**
 * Fetches with a deadline on the response *headers* only. Once they arrive the
 * timer is cleared and the caller owns the body, so use this solely when the body
 * is streamed rather than buffered and is bounded some other way — the /proxy
 * route, where pipeline() ends the read when the client disconnects, and HEAD or
 * manual-redirect probes that never read a body at all.
 *
 * If you intend to buffer the body, use fetchTextWithTimeout/fetchJsonWithTimeout.
 * Reading a body off this response is unbounded and, because the caller's signal
 * is unhooked at the headers, uncancellable.
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchWithDeadline(url, options, timeoutMs, (res) => res);
}

/**
 * Fetches and buffers the body under a single deadline covering headers *and*
 * body, honouring the caller's signal throughout. A host that returns headers
 * promptly and then trickles (or stalls on) the body is the common failure here,
 * and it is invisible to a headers-only timeout.
 */
async function fetchTextWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return fetchWithDeadline(url, options, timeoutMs, async (res) => ({
    res,
    text: await res.text()
  }));
}

/**
 * As fetchTextWithTimeout, but parses the body as JSON. `data` is null when the
 * body is absent or not valid JSON, so callers can inspect res.ok/res.status and
 * handle an error page without a parse failure masking the real status.
 */
async function fetchJsonWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const { res, text } = await fetchTextWithTimeout(url, options, timeoutMs);

  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  return { res, text, data };
}

module.exports = {
  decodeHtmlEntities,
  fetchJsonWithTimeout,
  fetchTextWithTimeout,
  fetchWithTimeout,
  normalizeUrl
};

/**
 * Renders every stream's Name/Description in a fixed layout, applied once at
 * the HTTP boundary (src/server.js) so every provider's raw output goes
 * through the same formatting.
 *
 *   Name:        {cached ? "⚡️ " : ""}{indexer}
 *   Description: {container ? container : ""}{resolution ? " • " + resolution : ""}
 *
 * `indexer` is the provider's own label (e.g. "VidSrc", "Torrentio") - these
 * vendored files don't expose a finer per-tracker field (Torrentio's actual
 * indexer, e.g. "YTS") separately from its free-text title, so this doesn't
 * try to parse it out.
 */

const CONTAINER_PATTERN = /\.(mp4|mkv|m3u8|avi|mov|webm)(?:$|[?#])/i;
const RESOLUTION_PATTERN = /\b(2160p|4k|1080p|720p|480p|360p)\b/i;

function extractContainer(url) {
  const match = String(url || '').match(CONTAINER_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function extractResolution(raw) {
  if (raw.quality && raw.quality !== 'Unknown') return raw.quality;
  const text = `${raw.title || ''} ${raw.name || ''}`;
  const match = text.match(RESOLUTION_PATTERN);
  if (!match) return null;
  return match[1].toLowerCase() === '4k' ? '2160p' : match[1].toLowerCase();
}

function formatStreamName(indexer, cached) {
  return cached ? `⚡️ ${indexer}` : indexer;
}

function formatStreamDescription({ container, resolution }) {
  return [container, resolution].filter(Boolean).join(' • ') || ' ';
}

module.exports = { extractContainer, extractResolution, formatStreamName, formatStreamDescription };

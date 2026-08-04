/**
 * Renders every stream's Name/Description in a fixed layout, applied at the
 * HTTP boundary (src/server.js) so every scraper's raw output goes through
 * the same formatting rather than each one building display text itself.
 *
 *   Name:        {cached ? "⚡️ " : ""}{indexer}
 *   Description: Latino{container ? " • " + container : ""}{resolution ? " • " + resolution : ""}
 *
 * `indexer` is whatever a scraper set as the stream's `name` before this
 * runs (e.g. "SoloLatino", "Torrentio") - there's no finer per-tracker
 * detail (e.g. Torrentio's own indexer like "YTS") available as a separate
 * field on these stream objects, only embedded in free-text titles, so this
 * doesn't try to parse it out.
 */

const { formatQuality } = require('./quality');

const CONTAINER_PATTERN = /\.(mp4|mkv|m3u8|avi|mov|webm)(?:$|[?#])/i;

function extractContainer(url) {
  const match = String(url || '').match(CONTAINER_PATTERN);
  return match ? match[1].toLowerCase() : null;
}

function formatStreamName(indexer, cached) {
  return cached ? `⚡️ ${indexer}` : indexer;
}

function formatStreamDescription({ language, container, resolution }) {
  return [language, container, resolution].filter(Boolean).join(' • ') || ' ';
}

function applyStreamTemplate(stream, addonName) {
  const indexer = stream.name || addonName;
  const container = extractContainer(stream.url);
  const resolution = formatQuality(stream.quality) || null;
  const cached = stream.__cached === true;

  return {
    ...stream,
    name: formatStreamName(indexer, cached),
    title: formatStreamDescription({ language: 'Latino', container, resolution })
  };
}

module.exports = { applyStreamTemplate, formatStreamName, formatStreamDescription, extractContainer };

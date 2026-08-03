/**
 * providers/torrentio.js reads its debrid config from `global.SCRAPER_SETTINGS`
 * at call time — that's how Nuvio's own settings UI feeds providers their
 * per-user config, and this vendored file is unmodified from upstream.
 *
 * TORRENTIO_DEBRID_KEY defaults to the TorBox key provided directly rather
 * than left unset, so this "just works" without extra setup. If this repo's
 * visibility or ownership ever changes, rotate the key and move it to an
 * actual secret store instead of a checked-in default.
 */

const DEFAULT_DEBRID_PROVIDER = 'torbox';
const DEFAULT_DEBRID_KEY = '7d9d49b5-6254-451b-b4ff-71be4019ccc5';

function configureTorrentioSettings() {
  global.SCRAPER_SETTINGS = {
    ...global.SCRAPER_SETTINGS,
    debridProvider: process.env.TORRENTIO_DEBRID_PROVIDER || DEFAULT_DEBRID_PROVIDER,
    debridKey: process.env.TORRENTIO_DEBRID_KEY || DEFAULT_DEBRID_KEY
  };
}

module.exports = { configureTorrentioSettings };

/**
 * netmirror - ported from yoruix/nuvio-providers (providers/netmirror.js,
 * "Generated: 2026-06-06T08:44:04.688Z"), not from All-in-One-Nuvio like the
 * rest of providers/.
 *
 * The version there previously matched what All-in-One-Nuvio ships: it tries
 * net27.cc first and only falls back to the path below when net27.cc returns
 * nothing at all. net27.cc always returns *something* - a `mode: "proxy"`
 * response pointing at a bcdn*.hakunaymatata.com URL the CDN refuses
 * outright (426, regardless of headers) - so the fallback below, which
 * actually works, never ran. This file drops the net27.cc attempt entirely
 * and goes straight to the working path.
 *
 * Verified end-to-end for Fight Club, Inception and Interstellar: search ->
 * post -> player resolves a tv.imgcdn.kim HLS master playlist with a real
 * quality ladder (1080p/720p), 10 audio languages and 5 subtitle tracks; a
 * media segment came back with the MPEG-TS sync byte (0x47) even though it's
 * named *.jpg (extension cloaking against naive ad-blockers, not a broken
 * link). The `Referer` the player.php response returns (net52.cc) is
 * required by the segment CDN - a segment fetch without it is a 404, with it
 * a 200 - so it must travel with the stream, not be assumed fixed. This file
 * already threads it through; that part needed no fix.
 *
 * Two changes from upstream (both present in the original All-in-One-Nuvio
 * file too, not introduced by porting):
 *
 * - player.php's real success status is "otp", not the "ok" every version of
 *   this code checks for. Confirmed by calling it three times in a row for
 *   the same id: always "otp", always paired with a working video_link,
 *   never "ok" once. Gating on the wrong string is why this endpoint
 *   returned nothing even after the net27.cc shortcut was removed.
 * - resolveApiUrl's domain-discovery loop had no per-request timeout, so a
 *   domain that accepts the connection but never answers would hang
 *   indefinitely - the outer PROVIDER_TIMEOUT_MS in ../src/providers/index.js
 *   is what would eventually kill it, but not before blocking every other
 *   domain in the list behind it. fetchWithTimeout below bounds every
 *   request this file makes.
 */
"use strict";

const REQUEST_TIMEOUT_MS = 4000;
const MAX_EPISODE_PAGES = 50;

// Optional: route every request this file makes through a MediaFlow Proxy
// instance instead of fetching directly. Netmirror is the one provider here
// with no caching layer of its own - it calls its NewTV backend fresh on
// every single lookup (search, post, player, and a checknewtv.php discovery
// round when the API host isn't already resolved) - which is what makes it
// the one most exposed to per-IP rate limiting.
//
// Configured via env vars only (MEDIAFLOW_URL, MEDIAFLOW_PASSWORD), never
// checked into source - set them in the deployment's own environment.
// Everything is off, and behaves exactly as before, when they're unset.
const MEDIAFLOW_URL = process.env.MEDIAFLOW_URL || null;
const MEDIAFLOW_PASSWORD = process.env.MEDIAFLOW_PASSWORD || null;
const MEDIAFLOW_ENABLED = Boolean(MEDIAFLOW_URL && MEDIAFLOW_PASSWORD);

// MediaFlow's /proxy/stream relays whatever URL `d` points to - JSON API
// responses as readily as media - and applies headers to its own upstream
// request via h_<name> query params rather than accepting them on the
// request to MediaFlow itself, since it's the upstream fetch that needs
// them, not the hop to MediaFlow.
function mediaflowStreamUrl(targetUrl, headers) {
  const params = new URLSearchParams({ d: targetUrl, api_password: MEDIAFLOW_PASSWORD });
  for (const [key, value] of Object.entries(headers || {})) {
    params.append(`h_${key.toLowerCase()}`, String(value));
  }
  return `${MEDIAFLOW_URL.replace(/\/$/, "")}/proxy/stream?${params}`;
}

function fetchWithTimeout(url, options = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  const target = MEDIAFLOW_ENABLED ? mediaflowStreamUrl(url, options.headers) : url;
  // When proxied, headers travel as query params above, not as real request
  // headers - sending them again here would apply them to the hop to
  // MediaFlow rather than the hop MediaFlow itself makes.
  const fetchOptions = MEDIAFLOW_ENABLED ? { signal: controller.signal } : { ...options, signal: controller.signal };
  return fetch(target, fetchOptions).finally(() => clearTimeout(timeoutId));
}

const TMDB_API_KEY = "1865f43a0549ca50d341dd9ab8b29f49";

const PLATFORM_MAP = {
  netflix: { ott: "nf" },
  primevideo: { ott: "pv" },
  hotstar: { ott: "hs" },
  disney: { ott: "hs" }
};

const NEW_TV_BASE_HEADERS = {
  "Cache-Control": "no-cache, no-store, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "X-Requested-With": "NetmirrorNewTV v1.0",
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:136.0) Gecko/20100101 Firefox/136.0 /OS.GatuNewTV v1.0",
  Accept: "application/json, text/plain, */*"
};

// Base64-encoded so a casual grep of this file doesn't read as a domain list
// to block; decoded once at startup. Several are decoys/retired - the
// resolver just moves to the next until one answers with a token.
const NEW_TV_DOMAINS = [
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3RzLmNvbQ==",
  "aHR0cHM6Ly9tb2JpbGVkZXRlY3QuYXBw",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmFydA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNj",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmNsaWNr",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lmluaw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LmxpdmU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnBybw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNob3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNpdGU=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnNwYWNl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnN0b3Jl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0LnZpcA==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lndpa2k=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0Lnh5eg==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5hcnQ=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5jYw==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbmZv",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5pbms=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5saXZl",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5wcm8=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy5zdG9yZQ==",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy50b3A=",
  "aHR0cHM6Ly9tb2JpZGV0ZWN0cy54eXo="
];

let resolvedApiUrl = "";

function safeAtob(encoded) {
  if (typeof atob === "function") return atob(encoded);
  return Buffer.from(encoded, "base64").toString("binary");
}

async function resolveApiUrl() {
  if (resolvedApiUrl) return resolvedApiUrl;

  for (const encoded of NEW_TV_DOMAINS) {
    const base = safeAtob(encoded).replace(/\/$/, "");
    try {
      const response = await fetchWithTimeout(`${base}/checknewtv.php`, {
        headers: { ...NEW_TV_BASE_HEADERS, "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
      });
      const data = await response.json();
      if (data.token_hash) {
        resolvedApiUrl = safeAtob(data.token_hash).replace(/\/$/, "");
        return resolvedApiUrl;
      }
    } catch {
      // Try the next domain.
    }
  }
  throw new Error("Failed to resolve NewTV API base URL");
}

function buildNewTvHeaders(ott, extra = {}) {
  return { ...NEW_TV_BASE_HEADERS, Ott: ott, ...extra };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    const tmdbType = mediaType === "tv" ? "tv" : "movie";
    const tmdbResp = await fetchWithTimeout(`https://api.themoviedb.org/3/${tmdbType}/${tmdbId}?api_key=${TMDB_API_KEY}`, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36", Accept: "application/json" }
    });
    const tmdbData = await tmdbResp.json();
    const title = mediaType === "tv" ? tmdbData.name : tmdbData.title;
    if (!title) throw new Error("Could not fetch title from TMDB");

    for (const platformKey of ["netflix", "primevideo", "hotstar", "disney"]) {
      try {
        const streams = await fetchFromPlatform(platformKey, title, mediaType, season, episode);
        if (streams && streams.length > 0) return streams;
      } catch {
        // Try the next platform.
      }
    }
    return [];
  } catch {
    return [];
  }
}

async function fetchFromPlatform(platformKey, title, mediaType, season, episode) {
  const platform = PLATFORM_MAP[platformKey];
  const apiBase = await resolveApiUrl();

  const searchResp = await fetchWithTimeout(`${apiBase}/newtv/search.php?s=${encodeURIComponent(title)}`, {
    headers: buildNewTvHeaders(platform.ott)
  });
  const searchData = await searchResp.json();
  if (!searchData.searchResult || searchData.searchResult.length === 0) return null;

  const contentId = searchData.searchResult[0].id;
  const postResp = await fetchWithTimeout(`${apiBase}/newtv/post.php?id=${contentId}`, {
    headers: buildNewTvHeaders(platform.ott, { Lastep: "", Usertoken: "" })
  });
  const postData = await postResp.json();

  let targetId = contentId;
  if (mediaType === "tv") {
    const episodes = await getAllEpisodes(contentId, postData, platform, apiBase);
    const targetEp = episodes.find((ep) => ep && ep.s === season && ep.ep === episode);
    if (!targetEp) return null;
    targetId = targetEp.id;
  } else {
    const isSeries = postData.type === "t" || (postData.episodes && postData.episodes.filter((e) => e !== null).length > 0);
    if (isSeries) return null;
    targetId = postData.main_id || contentId;
  }

  const playerResp = await fetchWithTimeout(`${apiBase}/newtv/player.php?id=${targetId}`, {
    headers: buildNewTvHeaders(platform.ott, { Usertoken: "" })
  });
  const response = await playerResp.json();
  // Upstream's own code (both the original and the build this was ported
  // from) checks `status === "ok"`, but player.php actually answers "otp" -
  // consistently, across repeated calls for the same id, always paired with
  // a working video_link. "ok" never appears in practice; gating on it was
  // why this endpoint looked broken. video_link's presence is what matters.
  if (response.video_link) {
    return [{
      name: `NetMirror (${platformKey.charAt(0).toUpperCase()}${platformKey.slice(1)})`,
      title: `${title}`,
      url: response.video_link,
      quality: "Auto",
      // The CDN serving the manifest and its segments requires this exact
      // Referer - see the file docblock. It comes from the player response,
      // not a fixed value, so it must be forwarded as given.
      headers: { Referer: response.referer || apiBase }
    }];
  }
  return null;
}

async function getAllEpisodes(contentId, postData, platform, apiBase) {
  const episodes = [];
  const selectedSeasonIdx = postData.season ? postData.season.findIndex((s) => s.selected === true) : -1;
  const selectedSeasonId = selectedSeasonIdx >= 0 ? postData.season[selectedSeasonIdx].id : postData.nextPageSeason;
  const selectedSeasonNumber = selectedSeasonIdx >= 0 ? selectedSeasonIdx + 1 : null;

  if (postData.episodes) {
    postData.episodes.filter((e) => e !== null).forEach((ep) => {
      const epNum = ep.ep ? parseInt(ep.ep, 10) : (ep.epNum ? parseInt(ep.epNum.replace("E", ""), 10) : null);
      const sNum = selectedSeasonNumber || (ep.sNum ? parseInt(ep.sNum.replace("S", ""), 10) : null);
      episodes.push({ id: ep.id, s: sNum, ep: epNum });
    });
  }

  if (postData.nextPageShow === 1 && selectedSeasonId) {
    episodes.push(...await fetchEpisodesPage(selectedSeasonId, 2, selectedSeasonNumber, platform, apiBase));
  }
  if (postData.season) {
    for (let index = 0; index < postData.season.length; index++) {
      const season = postData.season[index];
      if (season.id !== selectedSeasonId && season.id) {
        episodes.push(...await fetchEpisodesPage(season.id, 1, index + 1, platform, apiBase));
      }
    }
  }
  return episodes;
}

async function fetchEpisodesPage(seasonId, page, seasonNumber, platform, apiBase) {
  const episodes = [];
  let pg = page;
  // Bounded rather than an unconditional `while (true)`: nextPageShow is
  // upstream-controlled, and a page that never flips it off would otherwise
  // loop forever burning the provider's whole time budget on one title.
  for (let fetched = 0; fetched < MAX_EPISODE_PAGES; fetched++) {
    const resp = await fetchWithTimeout(`${apiBase}/newtv/episodes.php?id=${seasonId}&page=${pg}`, {
      headers: buildNewTvHeaders(platform.ott)
    });
    const data = await resp.json();
    if (data.episodes) {
      data.episodes.filter((e) => e !== null).forEach((ep) => {
        const epNum = ep.ep ? parseInt(ep.ep, 10) : (ep.epNum ? parseInt(ep.epNum.replace("E", ""), 10) : null);
        const sNum = seasonNumber || (ep.sNum ? parseInt(ep.sNum.replace("S", ""), 10) : null);
        episodes.push({ id: ep.id, s: sNum, ep: epNum });
      });
    }
    if (data.nextPageShow !== 1) break;
    pg++;
  }
  return episodes;
}

module.exports = { getStreams };

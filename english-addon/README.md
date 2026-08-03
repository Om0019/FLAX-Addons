# English Streams (Stremio addon)

A Stremio addon aggregating English-language sources, built by wrapping
providers ported from the [All-in-One-Nuvio](https://github.com/D3adlyRocket/All-in-One-Nuvio)
local-scraper repo. Independent of the Latino addon at the repo root —
separate `package.json`, separate server, separate port.

## Why this works without deobfuscating anything

Nuvio's local scrapers are meant to run in a restricted mobile sandbox: no
Node built-ins, no `async`/`await`. That's what made porting SoloLatino to
Nuvio (`nuvio-addon/` in this repo) genuinely hard — Node's `crypto` had to
be reimplemented by hand.

This is the reverse direction: a Stremio addon runs in ordinary Node, same as
the rest of this repo, with no such restrictions. Each vendored file in
`providers/` is obfuscated but still just a valid CommonJS module exporting
`getStreams(tmdbId, mediaType, seasonNum, episodeNum)` — so it's used as-is,
unmodified, straight from upstream. `src/providers/index.js` just requires
each one and calls that function.

## Providers included

VidSrc, VidFast, VidLink, VidEasy, All-Wish, Castle, NetMirror, 4KHDHub-NEW,
HDHub4u, UHDMovies, Torrentio.

**`vixsrc` was left out on purpose.** It's a 1.1MB bundle (vs. 12–45KB for
the others) that pulls in `sqlite`, `worker_threads`, `http2` — a different
shape of thing than the rest. In testing it took ~16s per call and returned
zero results.

**Torrentio** needs a debrid provider API key to return anything (it's a
torrent-indexer front end; without a debrid account there's nothing to hand
back as a direct stream). It's wired up and enabled — it just returns an
empty list until that's configured. `providers/torrentio.js` reads its
settings through `getDebridSettings()`; exactly how to feed it a key from
outside Nuvio's app UI needs to be worked out once the key is available.

Verified end-to-end against the running server (`tt0137523` / Fight Club):
35 streams back from 6 of 11 providers in ~5.8s. A series lookup
(`tt0944947:1:1` / Game of Thrones S1E1) returned 30 streams.

## Running it

```
cd english-addon
npm install
npm start          # defaults to :7001, set PORT to change
```

Then add `http://localhost:7001/manifest.json` to Stremio. Runs fine
alongside the Latino addon at the repo root — different port, fully
independent process.

## Layout

```
english-addon/
  index.js              # bootstrap, mirrors the root index.js
  src/
    server.js            # /manifest.json, /stream/:type/:id.json
    tmdb.js               # IMDb id -> TMDB id (providers need TMDB ids)
    providers/index.js    # loads providers/*.js, calls getStreams with a timeout
  providers/              # vendored, unmodified files from All-in-One-Nuvio
```

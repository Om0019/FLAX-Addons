# Nuvio addon (SoloLatino)

A [Nuvio Streams](https://github.com/tapframe/NuvioStreamingApp) local-scraper
port of this repo's SoloLatino source, kept as a separate, independent addon
in this repo — it does not touch or depend on `src/`, `index.js`, or the
Stremio addon at the repo root.

## What this is

Nuvio's local-scraper model is different from Stremio's: there's no server
and no manifest HTTP endpoint. Nuvio loads `providers/sololatino.js` directly
and calls `getStreams(tmdbId, mediaType, seasonNum, episodeNum)` on it, which
must return a Promise resolving to an array of stream objects. `manifest.json`
here is a *repository* manifest — the thing you point Nuvio's Settings →
Local Scrapers at — not a Stremio addon manifest.

## Adding it to Nuvio

In the Nuvio app: Settings → Local Scrapers → add repository URL pointing at
this folder's raw `manifest.json`, e.g.

```
https://raw.githubusercontent.com/om0019/latino/<branch>/nuvio-addon/manifest.json
```

## Scope and known limitation

This is a from-scratch port, not a shared module — Nuvio's sandbox has no
Node built-ins (`crypto`, `Buffer`, `fs`) and no `async`/`await`, so nothing
here can `require('../src/...')`. Everything the scraper needs (HTTP fetch
with timeouts, a TTL cache, TMDB lookup, the SoloLatino search/match/session
flow, and the generic iframe-unpacking logic from `src/unpacker.js`) is
reimplemented in the single file `providers/sololatino.js`, using Promise
chains instead of async/await and hand-written base64 helpers instead of
`Buffer`.

**embed69 links currently resolve to nothing.** `src/unpacker.js` decrypts
embed69's player links with AES-256-CBC, keyed by a SHA-256 proof-of-work —
real cryptographic primitives that need `crypto`, which this sandbox doesn't
have. In testing, embed69 is presently SoloLatino's main working source (the
addon's other player, pelisserieshoy, was returning no working servers at
scrape time regardless of this port). Filemoon (AES-GCM, and per the
original code's own findings gated behind a captcha on nearly every file
anyway) and the Pelisplus mirrors (AES-CBC) are stubbed out for the same
reason. Everything else from `src/unpacker.js` — Dean Edwards `eval`
unpacking, VOE, Dood, Streamtape, Nupload, MediaFire, VidGuard, Xupalace
multi-server pages, JS-redirect and iframe chasing — is ported and working.

Next step to make this fully functional: a pure-JS AES-CBC decrypt + SHA-256
implementation (no external deps allowed in the sandbox) to un-stub
`decryptEmbed69`/`resolvePelisplus` in `providers/sololatino.js`.

## Porting the other scrapers

Only `sololatino.js` has been ported so far, as a proof of concept. The repo
has eight more sources under `src/scrapers/` (cuevana3i, cinecalidad,
cinehdplus, tioplus, lamovie, pelispedia, tlnovelas, novelas360, ennovelas) —
each would follow the same pattern: pull in only what that scraper needs from
`src/scrapers/common.js` and `src/unpacker.js`, convert async/await to
Promise chains, and export `getStreams`, then add an entry to
`manifest.json`.

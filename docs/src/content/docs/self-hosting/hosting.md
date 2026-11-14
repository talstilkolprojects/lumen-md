---
title: Where Lumen runs
description: What works on which host — Cloudflare Pages, Netlify, Vercel and the Docker image — and how each one is configured.
---

Lumen is a static app: `npm run build` produces `dist/`, and any host that
serves files can run it. Each host still has to do three things right: send
the security headers of `security/policy.json` (the app's strict
Content-Security-Policy, and the *different* policy of the two runner pages
that the Web Playground and live-js blocks open in a sandboxed frame), serve
the same-origin WebAssembly runtimes, and know the deployment's own endpoint
origins. The table is checked by `src/__tests__/hosting.test.ts` against the
configuration files, so it cannot drift from them.

## What works where

| Capability | Cloudflare Pages | Netlify | Vercel | Docker image (compose, Fly) |
|---|---|---|---|---|
| The editor under the full policy (response header + `<meta>`) | ✅ `_headers` | ✅ `_headers` | ✅ `vercel.ts` | ✅ `deploy/nginx.conf` |
| Deep links (SPA routes) | ✅ | ✅ `netlify.toml` redirect | ✅ rewrite | ✅ `try_files` |
| Web Playground (sandboxed runner, own policy, framed by the app) | ✅ `! Header` detaches the catch-all | ✅ edge function `runner-headers` | ✅ excluded from the catch-all | ✅ own `location` |
| live-js runner | ✅ | ✅ edge function | ✅ | ✅ |
| Workers that need eval (Graphviz, Ruby, TypeScript checker, webR) with their own policy | ✅ | ✅ | ✅ | ✅ |
| On-device OCR (tesseract.js worker policy) | ✅ | ✅ | ✅ | ✅ |
| Same-origin WebAssembly runtimes (Python, Ruby, ONNX Runtime, the dictation VAD model, OCR; ≈100 MB). R (webR, GPL-3.0) is not in the build: each user downloads it from an R block, or the operator stages it with `npm run webr:local` | ✅ in `dist/` | ✅ | ✅ | ✅ `LUMEN_RUNTIMES=full` (default) · `slim` drops them |
| Your endpoint origins in `connect-src` (`VITE_*_ENDPOINT`) | ✅ at build time | ✅ at build time | ✅ `vercel.ts` at build time | ✅ build args → nginx |
| HSTS | ✅ | ✅ | ✅ | — the TLS terminator in front sends it |
| Cross-origin isolation (COOP / COEP, multi-threaded WebAssembly) | — | — | — | ✅ (decision 15.10(7) whether it stays) |

Everything above the HSTS row works on every host. The last two rows are
deliberate differences, explained in `docs/security/headers.md`.

## One image

The compose bundle and the Fly deployment build the same `Dockerfile`:
nginx with `deploy/nginx.conf`, listening on 8080 as a non-root user
(`docker-compose.yml` maps it to port 80). Until plan 13.2 there were two
Dockerfiles with two different nginx configurations.

Build arguments:

| Argument | Default | What |
|---|---|---|
| `VITE_*_ENDPOINT`, `VITE_*_URL`, `VITE_CSP_CONNECT_EXTRA` | empty | The deployment's own services; added to `connect-src` in the header and the `<meta>` policy |
| `LUMEN_RUNTIMES` | `full` | `slim` removes the same-origin WebAssembly runtimes (≈100 MB measured on 24.10.2026: Pyodide 13.6, ruby.wasm 30.6, ONNX Runtime 41.2, tesseract.js 11.8, plus the 2.3 MB Silero VAD model; webR is never in the image, see live R below). The live-python and live-ruby blocks, OCR and local transcription then report that their runtime is not installed; everything else, the Web Playground, plugins and the canvas fonts included, is unchanged |

```bash
# the full image (compose: make onprem-up; Fly: fly deploy)
docker build -t lumen .
# a smaller one without the WebAssembly runtimes
docker build -t lumen --build-arg LUMEN_RUNTIMES=slim .
```

## Netlify

Netlify applies `dist/_headers` to every response and cannot detach the
catch-all rules the way Cloudflare's `! Header` lines do, so the two runner
pages used to inherit the app's `X-Frame-Options: DENY` and CSP, and the Web
Playground could not run there. `netlify/edge-functions/runner-headers.ts`
runs for `/playground-runner.html` and `/livejs-runner.html` only, drops the
frame denial and sets the runner's policy. Its policy strings are rendered
from `security/policy.json`: `npm run headers` fails when they drift.

## Embed providers

The sites an `embed` block may frame are one list, `embedProviders` in
`security/policy.json`. Every host's `frame-src` is rendered from it
(`@embedProviders` in the policy), the embed block frames only those sites
(any other link shows "Could not recognize the embed URL" and keeps the link),
and airplane mode reads the same list. To allow another provider, add its
origin there and run `npm run headers:write`. `npm run headers` fails when a
`frame-src` names an https site itself instead of through the list.

## Live R (webR)

webR's binaries (R, libgfortran) are GPL-3.0, so no Lumen build or image
contains them. The first Run of a `live-r` block on a device offers the
download: the licence and the source come first, the files come from
webR's own CDN (`webr.r-wasm.org`, or the npm package on `cdn.jsdelivr.net`),
each one is checked against the checksums in the build's
`runtimes/webr.json`, and the service worker then serves them from this
origin, offline included. Both hosts are in `connect-src` for that download
only. An operator who accepts distributing webR under GPL-3.0 can serve it
instead: `npm run webr:local` before `npm run build` stages it in
`public/webr/`, and the R block then uses it without asking.

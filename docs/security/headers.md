# Security headers: one source

Every Content-Security-Policy and security header Lumen ships is written once, in
[`security/policy.json`](../../security/policy.json), and rendered into the files each
host reads by [`scripts/headers.mjs`](../../scripts/headers.mjs) (plan 0.17).

```sh
npm run headers         # check (CI): exit 1 + a directive-level diff when any copy differs
npm run headers:write   # rewrite the policy values in place in every source
```

A host's exceptions (`hosts.<host>.csp` in the policy) are rules on a route's directives:
`omit` drops whole directives, `remove` drops single sources from a directive, and `add`
appends sources. They apply in that order.

`--write` replaces header **values** only. Each file keeps its own structure, comments and
formatting. The check also fails on problems `--write` cannot fix, and these need a hand
edit once:

- a route with no block in a file;
- a CSP that applies to the wrong route (for example, a new page the Vercel catch-all
  does not exclude);
- a required header that is missing;
- a framed runner page that gets `X-Frame-Options`;
- a `<meta>` CSP in an HTML page the policy does not list.

For `public/_headers` and `deploy/vercel.base.json`, the script emulates the host. It works out which
headers each route's sample paths (`routes.*.samples`) really receive and maps each CSP
line to its route from that result. For nginx, `sources[file].blocks` names the route of
each `location`.

The build-time endpoint extension (`src/build/cspEndpoints.ts`) still runs on the
**built** copies: `dist/index.html`, `dist/_headers`, the nginx
`__CSP_CONNECT_EXTRA__` placeholder, and the same placeholder in the Vercel config,
which `vercel.ts` fills at build time (see below). It never touches the sources, so it and this check
cannot conflict. It still leaves `connect-src 'none'` (the live-js runner) untouched,
which `headersPolicy.test.ts` checks.

## Routes

| Route | Kind | Paths | `_headers` (Cloudflare, Netlify) | Netlify edge function | `deploy/vercel.base.json` | `deploy/nginx.conf` (the one nginx image, 13.2) | meta | Tauri |
|---|---|---|---|---|---|---|---|---|
| `app` | document; also the other workers under `/assets/` and the service worker | everything else | `/*` | n/a | catch-all regex | `http` level, `location /assets/`, `location = /sw.js` (0.20) | `index.html` | `app.security.csp` |
| `playground-runner` | document, framed by the app | `/playground-runner.html` | own block (Cloudflare detaches the catch-all; Netlify cannot) | own entry, drops `X-Frame-Options` (13.2) | own entry | own location | `playground-runner.html` (0.20) | n/a |
| `livejs-runner` | document, framed by the app | `/livejs-runner.html` | own block | own entry (13.2) | own entry | own location (new) | `livejs-runner.html` | n/a |
| `tesseract` | worker | `/tesseract/*` | own block | n/a | own entry | own location (new) | n/a | n/a |
| `eval-workers` | worker | `/assets/{graphviz,ruby,tsCheck}.worker-*`, `/webr/*` | own blocks (`/webr/*` new) | n/a | own entries (`/webr/` new) | assets regex (new) + runtime include | n/a | n/a |

Until 13.2 there were two nginx configs (`docker/nginx.conf` for the compose bundle, `deploy/nginx.conf` for the Fly image); the compose bundle now builds the same image (see [docs/self-hosting/hosting](../src/content/docs/self-hosting/hosting.md)). The inventory below is the state before 0.17 and keeps the old file names.

## Inventory before 0.17

These are the CSPs per route and per source, compared with the policy chosen below.
"=" means identical.

| Route | `_headers` | `vercel.json` | `docker/nginx.conf` | `deploy/nginx.conf` | meta | Tauri |
|---|---|---|---|---|---|---|
| app | = | = | different (D1), and never served (D2, D3) | **none** (D4) | = (trailing `;` only) | different (D5) |
| playground-runner | = | = | = | = | none | n/a |
| livejs-runner | = | = | = | **none** (meta only) | = without `frame-ancestors` | n/a |
| tesseract | = | = | = | **none** | n/a | n/a |
| eval-workers `/assets/*.worker-*` | = | = | = | **none** | n/a | n/a |
| eval-workers `/webr/*` | **app policy** (D6) | **app policy** (D6) | = except `base-uri` | **none** | n/a | n/a |

These are the other security headers on the app document:

| Header | `_headers` | `vercel.json` | `docker/nginx.conf` | `deploy/nginx.conf` |
|---|---|---|---|---|
| X-Frame-Options | DENY | DENY | DENY (never served, D2) | **SAMEORIGIN** (D7) |
| Referrer-Policy | strict-origin-when-cross-origin | same | same (never served) | same |
| Permissions-Policy | `interest-cohort=(), geolocation=(self), microphone=(self), camera=(self)` | same | **none** | `camera=(), microphone=(self), geolocation=()` (D8) |
| X-Content-Type-Options | nosniff | nosniff | nosniff (never served) | nosniff |
| Strict-Transport-Security | 2 years, subdomains, preload | same | none | none |
| COOP / COEP | none | none | none | `same-origin` / `credentialless` (D9) |

## Differences and decisions

The rule: the canonical policy for a route is the strictest one the app actually needs.
Nothing that was stricter is loosened without the reason given here. On every web host,
index.html's meta CSP is enforced next to the header, and Tauri's policy is enforced next
to it as well. So the effective policy is always the intersection of the two.

- **D1 · docker app CSP drifted from all the others.** It had scheme-less
  `fonts.googleapis.com` / `fonts.gstatic.com`, no `cdn.tldraw.com` font, no `media-src`,
  and `frame-src 'self' blob: https:`. It had no `base-uri`, `form-action`,
  `frame-ancestors` or Trusted Types. **The `_headers` / `vercel.json` / meta policy wins.**
  - The https-only font hosts and `base-uri` / `form-action` / `frame-ancestors` / Trusted
    Types are stricter.
  - tldraw loads its default assets from cdn.tldraw.com (`src/ui/CanvasTldraw.tsx` sets
    no `assetUrls`).
  - Documents may contain `<video>` / `<audio>` that pass the sanitizer, with https: or
    blob: sources.
  - The embed block frames `data:text/html` (gist) and only the listed embed origins
    (`src/plugins/EmbedBlock.tsx`). Nothing frames `blob:`, so the explicit list replaces
    the blanket `https:`.
- **D2 · docker's app headers never reached the page.** They sat at server level, but
  `location /` has its own `add_header Cache-Control`. A location with any `add_header`
  inherits none from the server. Checked with nginx 1.24: `/` and every SPA route were
  served with `Cache-Control` only. The headers now live in `location /`.
- **D3 · docker's app CSP was malformed.** It was split over lines with `\`. nginx keeps
  the backslash and the bare newline in the header value, which was confirmed by serving
  it. It is now one line.
- **D4 · deploy/nginx.conf (root Dockerfile, fly.toml) sent no CSP header for the app,
  the live-js runner, the OCR worker or the eval workers.** Only the meta tag applied, and
  workers had no policy at all. The image now sends the same policies as every other host.
  nginx 1.24 checked the config and the served headers.
- **D5 · Tauri.**
  - `'unsafe-eval'` dropped. Tauri sends this policy with `.html` assets only (tauri 2.12
    `manager::get_asset`, `is_html`). Workers never got it, and the page was already held
    to no-eval by index.html's meta.
  - `img-src asset: tauri:` dropped. Nothing uses the asset protocol (`convertFileSrc`),
    and the meta blocked it anyway.
  - `frame-src https:` replaced by the embed list. The meta enforced that list anyway.
  - `font-src https://cdn.tldraw.com` added (tldraw, as D1).
  - `connect-src` gets the full app list, plus `ipc:` and `http://ipc.localhost` (Tauri 2
    IPC on macOS/Linux and on Windows). 0.17 kept `https:` there as an exception; plan 2.1
    removed it (see "Desktop (Tauri)" below).
- **D6 · webR's worker lost eval on Cloudflare and Vercel.** The F4/P3 change gave eval to
  `/assets/*.worker-*` only. `/webr/webr-worker.js` fell under the app policy (no eval,
  Trusted Types). R.js evaluates side modules' EM_ASM code and `webr::eval_js()`
  (`emscripten_run_script_int`) with `eval`, and `scripts/copy-webr.mjs` assumes the
  policy grants it. The docker image already did. **docker wins:** `/webr/*` joins
  `eval-workers` on every host. That route allows no network beyond `'self'` and keeps
  `base-uri 'none'`, which docker's copy lacked.
- **D7 · X-Frame-Options SAMEORIGIN → DENY on the deploy image.** DENY is stricter.
  Nothing frames the app, and the framed runner pages carry no X-Frame-Options on any
  host (`frame-ancestors 'self'` instead).
- **D8 · Permissions-Policy.** The deploy image's `camera=()` / `geolocation=()` win.
  Nothing in the app uses either: `getUserMedia` is audio-only in
  `src/ui/VoiceDictation.tsx`, and there is no `navigator.geolocation`. Cloudflare's
  `interest-cohort=()` is kept. The result is
  `interest-cohort=(), geolocation=(), microphone=(self), camera=()` everywhere, and
  docker gains it.
- **D9 · COOP/COEP stay on the deploy image only.** This is a documented per-host
  exception, not a stricter-or-looser choice. It enables cross-origin isolation, and so
  multi-threaded WebAssembly. Its cost is that cross-origin iframes which do not send COEP
  (most of the embed list) cannot load there. See open items.
- **Runner documents on nginx** now also carry Referrer-Policy and Permissions-Policy.
  Cloudflare and Vercel always sent them through the catch-all.

## Per-host exceptions

These are written in `policy.json` under `hosts`.

| Host | Exception | Why |
|---|---|---|
| meta | no `frame-ancestors` | ignored in `<meta>` (CSP3), and browsers log an error |
| meta | no Trusted Types | enforced by the production response headers only. The dev server, Tauri and Capacitor have not been verified under them |
| Tauri | no `frame-ancestors`, no Trusted Types | a top-level window is never framed (on Linux Tauri injects the policy as `<meta>`). Trusted Types as for meta |
| Tauri | `connect-src` + `ipc:` `http://ipc.localhost` | Tauri 2 IPC. No `https:`: the list is the app's explicit one. A build with deployment endpoints adds them with `--tauri-config` (below) |
| Tauri | `frame-src` + the embed providers | Tauri sends one policy with every `.html` asset, `/content-frame.html` included, so the providers the content frame embeds are listed there (plan W4.15). The app's windows frame only `/content-frame.html` |
| nginx | `connect-src` + `__CSP_CONNECT_EXTRA__` | filled by the `Dockerfile` from `dist/.csp-connect-extra` |
| nginx | no HSTS | plain-HTTP listener behind the operator's TLS terminator. `includeSubDomains; preload` on someone else's domain is their call |
| nginx | COOP `same-origin`, COEP `credentialless` | cross-origin isolation (D9). COEP goes on every document and worker it serves. Since 13.2 this is the compose bundle's image too; keeping it is decision 15.10(7) |
| Netlify | runner pages and the content frame: `X-Frame-Options` dropped, CSP replaced, by `netlify/edge-functions/runner-headers.ts` | Netlify's `_headers` cannot detach the catch-all rules (13.2); the function's policy strings are a `headers.mjs` source |

## Images in notes and WebSockets (plan 2.2)

**Images from other sites.** A static policy cannot hold one user's choices, so the
renderer enforces the choice (`src/lib/remoteImages.ts`). Since plan W4.15 the app's own
policy has no `https:` in `img-src` or `media-src` at all: an image or media file the user
allowed renders inside the content frame (next section).

- An `<img>` from another origin renders as a placeholder. This covers Markdown images and
  raw HTML `<img>`, `srcset` included, in the preview, the fast first paint, search answers
  and the WYSIWYG editor. The placeholder shows the alt text and the host, with **Load**
  (this image, until the page reloads) and **Always allow _host_**. The allowed hosts are
  kept in this browser (`localStorage["lumen.remoteImages.allowedHosts"]`).
- The raw-HTML sanitizer removes the other-site loads that no placeholder guards: a
  `<source srcset>` (the `<picture>` falls back to its `<img>`), video posters, the legacy
  `background` attribute, and `href` on anything but links (SVG `<image>`). `<video>` /
  `<audio>` lose `autoplay`, get `preload="none"`, and keep at most one other-site URL,
  their own `src` (the first `<source src>` is hoisted, `<track>` dropped). The preview
  holds that `src` back behind the same placeholder, because WebKit fetches a video `src`
  despite `preload="none"` (seen in CI's Playwright WebKit).
- HTML export keeps the real `<img>`, because the exported file is for its readers. Print
  shows what the preview shows.
- Not covered: images inside Mermaid labels, the live-SVG block (DOMPurify, a separate
  surface), and the sandboxed playground runner (`img-src *`).

`e2e/remote-images.spec.ts` counts the requests: a tracking pixel makes none until the
user clicks.

**WebSockets.** `connect-src` no longer has a bare `ws:` / `wss:`. These are the
WebSockets the app opens:

| Socket | Where it is set | How the policy allows it |
|---|---|---|
| Public signaling `wss://signaling.yjs.dev`, `wss://y-webrtc-eu.fly.dev` | `src/collab/yjs.ts`, only when the user opts in (there is no default server) | listed |
| The deployment's signaling / persistent collab server | `VITE_WEBRTC_SIGNALING_URL` (comma list), `VITE_YJS_WEBSOCKET_URL` | added at build time (`src/build/cspEndpoints.ts`, `WEBSOCKET_ENV_VARS`) |
| A server the user types into Collab settings | `localStorage` `lumen.collab.signaling` / `lumen.collab.ws` | only when the build lists it (`VITE_CSP_CONNECT_EXTRA`). Otherwise `yjs.ts` skips it with a warning, and the dialog says so |
| Vite's dev server (HMR) | `npm run dev` | the dev page alone gets `ws://*:<port>` / `wss://*:<port>`. CSP3 `'self'` covers the same host too. No build carries it |

IPv6 addresses cannot be named: CSP source lists have no IPv6 literal, and Chromium ignores
`ws://[::1]:4444` as an invalid source. The build skips such a URL with a warning, and the
runtime check (`src/lib/cspConnect.ts`) treats one as allowing nothing, as the browser does.
Give an IPv6-only server a hostname.

A search of `src/` found no other socket: no `EventSource`, no Supabase realtime channel,
and `WebSocketStream` / `WebTransport` appear only in the live-js and Ruby blocklists.
Checked in Chromium: a listed `wss://` host is allowed, an unlisted `wss://` host is
blocked, `ws://` on the page's own host is allowed through `'self'`, and `ws://*:5173`
parses and matches only that port. Not checked: Firefox and WebKit (CI runs the e2e
suite there against the dev server, whose HMR socket now relies on the explicit
`ws://*:5173`), the y-websocket persistent server end to end, and Supabase realtime if a
future feature subscribes to a channel (it would need `wss://*.supabase.co`).

## The content frame (plan W4.15)

The app's policy frames nothing but itself (`frame-src 'self'`) and loads images and media
only from itself and the hosts it needs. What another site serves into a note renders, once
the user allowed it, inside `/content-frame.html` (`public/content-frame.html` + `.js`,
route `content-frame` in `policy.json`): a same-origin page with its own header policy on
every host (Cloudflare `_headers`, Vercel, the Netlify edge function, nginx) and a `<meta>`
copy for the dev server and Capacitor.

| Content | Frame sandbox | What the frame's policy allows |
|---|---|---|
| Image (Markdown, raw `<img>`, WYSIWYG) | `allow-scripts` (opaque origin) | `img-src https:` |
| `<video>` / `<audio>` | `allow-scripts` | `media-src https:` (posters stay removed by the sanitizer) |
| Embed block, raw `<iframe>` | `allow-scripts allow-same-origin allow-popups allow-presentation allow-forms` (the embed block's old flags; airplane mode's frame guard takes `allow-popups` away while the switch is on) | `frame-src` = the providers the embed block knows (`src/plugins/EmbedBlock.tsx`) |
| Gist | `allow-scripts` | `script-src https://gist.github.com`, `style-src https://github.githubassets.com` |

- **Nothing loads before the user allows it.** Images and media keep the plan 2.2
  placeholder. Embeds and raw iframes now wait too (before, they loaded when the note
  opened): **Load** / **Always allow _host_**, the same choice and the same stored list as
  for images (`src/renderer/RemoteFrame.tsx`). A link to a site the embed block does not
  know stays a link: no policy frames it.
- **Why embeds keep `allow-same-origin`.** A nested frame inherits its parent's sandbox
  flags, and the providers' players need their own origin (storage, cookies, and YouTube a
  referrer, else "Error 153"). So the content frame runs at the app's origin for embeds.
  Its only script is inline in `public/content-frame.html`: it builds elements from the request in the
  `#fragment` with `createElement` and properties, never HTML, and its policy has
  `connect-src 'none'` and no `'unsafe-inline'` script.
- **Gists.** A Gist embed is a script that `document.write()`s the gist and its
  stylesheet (the old `data:` wrapper inherited the app's `script-src 'self'`, so Gists
  never rendered). The content frame writes that script only in an opaque-origin frame,
  and refuses otherwise. The desktop app shows a Gist as a link.
- **The request travels in the `#fragment`**: it is never sent to a server and is not
  part of the service worker's cache key (the page is precached like the runner pages).
  The frame reports the size its content wants with `postMessage`; the app matches the
  message to the frame by its window (`src/lib/contentFrame.ts`).
- **A hash, not a nonce (plan W10.D1).** WebKit does not match `'self'` in an
  opaque-origin frame, so the page's script used to carry the build's fixed nonce, which
  is written in the open source and protects nothing. The script is now inline and
  `script-src` lists its `sha256-…` and `https://gist.github.com` only: nothing but that
  exact script runs, in every engine, on the app's hosts and on the frame site alike.
  Changing the script means a new hash in `policy.json`; `contentFrame.test.ts`
  computes it from the page and fails until it matches.

### Its own site (plan W6.40, review E52)

Embeds kept `allow-same-origin`, so the content frame ran with the app's origin: any
future sink in the content frame's script would have been full XSS on the app. Now:

- **The frame has its own site**: `VITE_CONTENT_FRAME_URL`, officially
  `https://lumen-md-frame.pages.dev/` (Cloudflare Pages by Direct Upload,
  `scripts/content-frame-site.mjs`; `pages.dev` is on the Public Suffix List, so it is
  another *site*, not only another origin). Host `content-frame-site` in `policy.json`,
  checked file `deploy/content-frame/_headers`: no `sandbox`, `frame-ancestors` = the apps.
  The app's `frame-src` is `'self'` plus that origin. There an embed's `allow-same-origin`
  is the frame site's origin.
- **Without one** (a build with no `VITE_CONTENT_FRAME_URL`): images, media and Gists
  still render in an opaque frame on the app's host, and the host's header adds
  `sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox` to
  `/content-frame.html`, so even a top-level visit runs it opaque. Embeds become a link.
- **`postMessage`**: the app takes a size report only from the frame's own window *and*
  the origin that frame has (`"null"` for an opaque one, the frame site's for an embed).
  On the frame site the page posts only to the app origin named in the request.
- **Why not a sandboxed `srcdoc` with a `<meta>` CSP.** A `srcdoc` (like `about:blank`,
  `blob:` and `data:`) inherits the app's policy container, and policies only add up: it
  can never allow what the app's `img-src` / `frame-src` refuse. Checked in Chromium: the
  remote image in such a frame is refused by the app's `img-src 'self'`.
- **e2e**: `playwright.config.ts` gives the dev server the frame URL
  `http://127.0.0.1:5173/content-frame.html` (the app is `localhost:5173`, another
  origin and site); `e2e/content-frame-origin.spec.ts` evaluates code inside each kind
  of frame and checks it can't reach the app's `localStorage`, IndexedDB or document.

**connect-src, also W4.15.** Dropped: `wss://y-webrtc-signaling-eu.herokuapp.com` (Heroku
ended free dynos in November 2022; y-webrtc 10.3.0, the version in the lockfile, replaced
it with `wss://y-webrtc-eu.fly.dev` as its own default, which is now the second opt-in
public server), `https://cdn-lfs.huggingface.co` (covered by `https://*.huggingface.co`),
`https://www.gstatic.com` (nothing in `src/` uses it) and `https://*.supabase.co` (a
deployment that uses Supabase sets `VITE_SUPABASE_URL`, which `src/build/cspEndpoints.ts`
adds). The font hosts stay: the service worker's runtime cache fetches the Google Fonts
files.

**style-src `'unsafe-inline'`: the plan, not done yet.** React's `style={…}` goes through
the CSSOM, which CSP does not govern, so the app itself needs `'unsafe-inline'` only for
`<style>` elements other code injects and for `style="…"` attributes in HTML it inserts as
markup (KaTeX, Shiki, Mermaid's SVG, the sanitized note HTML). The step that is possible
without breaking those: split the directive into CSP3's `style-src-elem 'self' 'nonce-…'`
(CodeMirror takes a nonce through `EditorView.cspNonce`; each other `<style>` injector
needs an inventory) and `style-src-attr 'unsafe-inline'`. With `https:` gone from
`img-src`, an inline style can no longer load anything from another site, which was the
main risk of `'unsafe-inline'` in styles.

## Desktop (Tauri)

Plan 2.1 leaves no open scheme in the desktop policy. It has no `unsafe-eval`, and
`connect-src`, `img-src`, `media-src` and `frame-src` allow only `'self'` (plus `data:` /
`blob:` where the app makes them) and named hosts.

- **`connect-src`** is the app's list plus Tauri's IPC. Tauri enforces index.html's meta
  policy next to its own, so the `https:` that 0.17 kept there never allowed anything the
  meta did not. Its only purpose was build-time endpoint origins. These origins come from
  `VITE_*_ENDPOINT` and `VITE_CSP_CONNECT_EXTRA`. The Vite build adds them to the meta but
  cannot add them to `tauri.conf.json`, which the Rust build compiles in. The release
  workflow sets none of them. A desktop build that does set them passes the matching policy
  to the Tauri CLI:

  ```sh
  npm run build    # with the deployment's VITE_* variables; writes dist/.csp-connect-extra
  npm run tauri:build -- --config "$(node scripts/headers.mjs --tauri-config dist/.csp-connect-extra)"
  ```

  `tauri build --config` merges the JSON over `tauri.conf.json`. `headersPolicy.test.ts`
  checks what the script prints. The desktop build itself has not been run with it.
- **`img-src`** is `'self' data: blob:` plus the hosts the app itself loads images from:
  - tldraw's icons and embed icons, from `cdn.tldraw.com` (also CSS `mask-image`);
  - the map block's tiles, from `*.tile.openstreetmap.org`;
  - account avatars, from `avatars.githubusercontent.com` and `*.googleusercontent.com`.
  
  The web policies list the same hosts. Images from other sites in a note load on the web
  inside the content frame, whose own policy has `https:`; on desktop Tauri sends the app
  policy with that page too, so they do not load there. The placeholder (plan 2.2) says so
  and offers no Load button.
- **`media-src`** is `'self' blob:`. `<video>` / `<audio>` from other sites in a note do
  not play on desktop.
- **Not checked here:** rendering inside the desktop app (Graphviz, Python, OCR, the
  canvas icons, map tiles). It is the owner's manual check in plan 15.8.

## Vercel: endpoint origins at build time (0.20)

A static `vercel.json` is read from the repository, so it could not carry the origins of
the `VITE_*_ENDPOINT` workers a deployment is built with: the header blocked them while
the page's `<meta>` allowed them. Vercel now reads [`vercel.ts`](../../vercel.ts), which
it runs at build time with the project's environment. It loads
`deploy/vercel.base.json` (rendered from the policy and checked like every other source,
with a `__CSP_CONNECT_EXTRA__` placeholder in the app policy's `connect-src`, from
`hosts.vercel`) and replaces the placeholder with the configured origins, or removes it.
The app policy also covers the other workers under `/assets/` and `sw.js` on Vercel, so
their requests to those workers pass too. `vercel.ts` has no imports beyond Node's, and
`src/__tests__/vercelConfig.test.ts` keeps its endpoint rules equal to
`cspEndpoints.ts` and checks the generated config path by path.

## Not covered, and open items for the owner

1. **`vercel.ts` on a real deployment.** It follows Vercel's documented programmatic
   configuration, and its output is tested, but no preview deployment has run it yet
   (the preview deploys are rate-limited). Check the response headers of the first one:
   `curl -sI <preview>/ | grep -i content-security` should list the endpoint origins.
2. **The deploy image's COOP/COEP.** It buys threads for WebAssembly, but blocks
   YouTube, Vimeo and similar embeds, and severs `window.opener` for popups. Decide
   whether it should stay, become opt-in, or spread to the other hosts.
3. **webR on Cloudflare/Vercel (D6).** CI runs the `webr::eval_js()` e2e under the nginx
   headers (job "e2e under deploy headers"), which serve `/webr/` the same eval-workers
   policy as Cloudflare and Vercel. A run on a preview deployment is still to do.
4. **The extension and VS Code webview policies** (`extension/`, `packages/vscode-lumen`)
   and the srcdoc sandboxes' inline policies are separate surfaces, and are not part of
   this policy.
7. **Images and media inside notes on desktop.** Since plan 2.1 the desktop app loads none
   from other sites. If they should load on desktop as they do on the web, the Tauri
   policy (which Tauri also sends with `/content-frame.html`) would need `https:` in
   `img-src` / `media-src`, and `src/lib/remoteImages.ts` would stop treating desktop as
   unavailable. The renderer's own gate (plan 2.2) still holds them back until the user
   allows them.
8. **Desktop builds with deployment endpoints** use `--tauri-config` (see "Desktop
   (Tauri)"). This has not been tried in a real desktop build.
9. **Collab servers typed in at runtime** (plan 2.2). Before, the bare `wss:` let any
   such server connect. Now it connects only when the build lists it, and otherwise the
   default server is used. Decide whether that is right for the hosted app, or whether a
   few known self-hosting setups should be listed.
10. **Managing allowed image hosts.** "Always allow" has no settings screen to undo it
    yet. `forgetRemoteImageHost()` exists, and clearing site data resets the list.
11. **Closed: live-js in WebKit, a dynamic `import()` reached the network.** WebKit
    does not apply the runner's `script-src` to a dynamic `import()` from a worker. A CI
    probe on #233 showed it for blob: and data: workers, classic and module alike; fetch
    stayed blocked there, so `connect-src` does apply. Giving the worker its own CSP from a
    same-origin URL is not possible: an opaque-origin frame cannot start a worker from a
    URL (SecurityError in Chromium, an error event in Firefox and WebKit). So the worker
    itself closes it (`src/plugins/liveJsWorkerSource.ts`): it refuses any run whose source
    contains the word `import`, even in strings and comments, before compiling it, and it
    removes every way to compile a string afterwards: `eval`, the `Function`,
    `AsyncFunction`, `GeneratorFunction` and `AsyncGeneratorFunction` constructors (also
    through `.constructor`), and string handlers of `setTimeout` / `setInterval`.
    `ShadowRealm` (another string compiler, and `importValue()` is an import) and `FontFace`
    are removed too. The word check uses no built-in method, so an earlier run in a `shared`
    scope cannot switch it off. `e2e/security.spec.ts` expects nothing to leave in all three
    engines, including imports built from strings.

Done in 0.20: the playground runner's `<meta>` copy and WebKit nonce, the build-time
endpoint origins on Vercel, and the CSP of the other workers and `sw.js` on both nginx
images (the app policy, as Cloudflare and Vercel already served them).

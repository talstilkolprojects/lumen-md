# Lumen — Launch Deploy Guide

Eight blockers stand between "feature complete" and "Lumen 1.0 live to the
public." This document walks each one in order, with the **exact commands**
and **exact dashboard clicks** required. Most are external-account work — the
code is done.

> **Roughly 3 working days** if you sequence them as listed.

---

## 0. Prerequisites (one-time, ~30 min)

- [ ] Buy `lumen.app` (or whichever domain) — Cloudflare Registrar / Namecheap.
- [ ] Cloudflare account (free) — used for DNS + Workers.
- [ ] Stripe account (free until you start billing).
- [ ] Apple Developer Program ($99/yr).
- [ ] Google Play Developer ($25 one-time).
- [ ] Sentry account (free tier).
- [ ] Supabase project (free) — already optional; required for billing/sync/publish.
- [ ] Chrome Web Store registration ($5 one-time).

---

## 1. Signaling server for collab (P1-09) — 30 min

Lumen falls back to `wss://signaling.yjs.dev` (Yjs's public server). For
launch, run your own so a public outage doesn't disable collab.

```bash
cd sync-server
npm install
# Test locally (PORT defaults to 4444)
PORT=4444 node server.js
curl http://localhost:4444/healthz   # → {"ok":true,...}  (/health and / also work)

# Deploy to Fly.io (free):
brew install flyctl
fly launch --name lumen-signal     # accept defaults
fly deploy
# → wss://lumen-signal.fly.dev/
```

`server.js` speaks the y-webrtc signaling protocol (`subscribe` /
`unsubscribe` / `publish` / `ping`). Fly and the Docker `HEALTHCHECK` probe
`/healthz`. Optional env: `SIGNAL_HEARTBEAT_MS` (default 30000),
`SIGNAL_RATE_LIMIT_MAX` (messages/min/IP, default 120), and resource caps
`SIGNAL_MAX_TOPICS_PER_CONN` (64), `SIGNAL_MAX_TOPIC_LENGTH` (256 chars),
`SIGNAL_MAX_PAYLOAD` (262144 bytes/message), `SIGNAL_MAX_CONNS_PER_IP` (64).
Behind a reverse proxy set `SIGNAL_TRUST_PROXY=1` (already in `sync-server/fly.toml`)
so per-IP limits use `Fly-Client-IP` / `X-Forwarded-For` instead of the proxy's address.

Update `.env.production`:

```
VITE_WEBRTC_SIGNALING_URL=wss://lumen-signal.fly.dev,wss://signaling.yjs.dev
```

(Comma-separated → first one is primary, second is fallback.)

---

## 2. Persistent collab server (P2-03, plan 3.6) — 30 min

`sync-server/collab-server.mjs`: Hocuspocus (MIT) with per-room token auth
and SQLite storage (Node's built-in `node:sqlite`, Node ≥ 22.13) plus
backups. Image: `docker/Dockerfile.collab`; on its own:
`docker compose -f docker/collab.yml up -d`.

```bash
# Fly.io, from the repo root
fly launch --name lumen-collab --dockerfile docker/Dockerfile.collab --no-deploy
fly volumes create collab_data --size 1
# fly.toml: [[mounts]] source = "collab_data", destination = "/data"
fly secrets set COLLAB_ACCESS_KEY=$(openssl rand -hex 24) COLLAB_TOKEN_SECRET=$(openssl rand -hex 32)
fly deploy
```

| Variable | Meaning |
|---|---|
| `COLLAB_ACCESS_KEY` | Operator key users enter in Collab settings → "Server access token". It only buys a short-lived token for one room. Unset = anyone who knows a room name gets one (warned at start). `COLLAB_TOKEN` is the older name. |
| `COLLAB_TOKEN_SECRET` | HMAC key that signs room tokens, ≥ 32 characters. Never leaves the server. Unset = random per start. |
| `COLLAB_TOKEN_TTL_S` | Room token lifetime, default 600. The client asks for a new one on every reconnect. |
| `COLLAB_DATA_DIR` | `collab.sqlite` and `backups/` (the image uses `/data/collab`, on the volume). |
| `COLLAB_BACKUP_INTERVAL_MS` / `COLLAB_BACKUP_KEEP` | Backup every hour by default and on shutdown; keep the newest 24. |

Health: `/healthz` → `{"ok":true,"service":"lumen-collab","persistence":"sqlite"}`.
CI checks it on every push to main once the repository variable
`COLLAB_URL` (and `SIGNAL_URL` for the signaling server) is set; until then
the job reports "skipped".

`.env.production` (no token here — nothing secret goes into the build):

```
VITE_YJS_WEBSOCKET_URL=wss://lumen-collab.fly.dev
```

The old y-websocket + LevelDB server (`persistent-server.js`) speaks a
different protocol; the app no longer connects to it. Its rooms are not
lost: at start the new server imports, once, every room in
`COLLAB_LEGACY_LEVELDB_DIR` (the image sets `/data/yjs`, where the old one
stored them) without overwriting rooms SQLite already has.

---

## 3. CSP + headers in production (DONE — verify only)

The CSP lives in two places that are both enforced: the `<meta>` tag in
`index.html` and `public/_headers` (copied to `dist/_headers`). Cloudflare
Pages **and Netlify** serve `dist/_headers`; `netlify.toml` deliberately
sets no CSP of its own. The self-hosted nginx image uses
`docker/nginx.conf`.

Your own workers (SSO, billing/entitlements, publish, audit, marketplace,
self-hosted LanguageTool, Supabase) are added to `connect-src`
**automatically at build time** from the `VITE_*_ENDPOINT` / `VITE_*_URL`
variables (see `src/build/cspEndpoints.ts`): set them before
`npm run build`. For the Docker web image pass them as build args, e.g.
`docker build -f docker/Dockerfile.web --build-arg VITE_WORKOS_ENDPOINT=https://auth.example.org .`
Verify after deploy: the response header and the meta tag both list your
worker origins in `connect-src`.

`connect-src` is an explicit allowlist, so endpoints users set at
**runtime** (a LAN Ollama host in `lumen.ollama.baseUrl`, a marketplace
backend in `lumen.marketplace.url`) only work when their origin is allowed.
List such origins in `VITE_CSP_CONNECT_EXTRA` (comma/space separated, e.g.
`http://192.168.1.20:11434,https://market.example.org`) at build time; an
override whose origin isn't allowed is ignored with a console warning
instead of failing silently.

Run `npm run build && wrangler pages deploy dist` (Cloudflare) or let
Netlify build from `netlify.toml`.

---

## 4. Stripe billing edge worker (P2-05) — 1 hour

Code is in `edge-workers/billing/worker.ts`. Configure + deploy:

```bash
# 4a. Create the Supabase entitlements table (one-time)
psql "<your-supabase-conn-string>" <<EOF
-- user_id is text, not a uuid FK: besides Supabase user ids it holds
-- 'workos:<user id>' and 'workos-org:<organization id>' rows for SSO users.
create table if not exists entitlements (
  user_id text primary key,
  tier text not null default 'free',
  status text not null default 'active',
  stripe_customer_id text,
  stripe_subscription_id text,
  renews_at bigint,
  updated_at timestamptz default now()
);
-- Upgrading a table created from an older version of this guide:
--   alter table entitlements drop constraint if exists entitlements_user_id_fkey;
--   alter table entitlements alter column user_id type text;
EOF

# 4b. Create Stripe products + prices
# https://dashboard.stripe.com/products → New product → "Lumen Pro" → $8/mo
# https://dashboard.stripe.com/products → New product → "Lumen Team" → $16/seat/mo
# Copy the price IDs into src/billing/checkout.ts:
#   PRICE_IDS = { pro: "price_…", team: "price_…" }

# 4c. Deploy worker
cd edge-workers/billing
npm i -g wrangler
wrangler login
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE
# Sellable prices (same ids as VITE_PRICE_ID_PRO / VITE_PRICE_ID_TEAM);
# /checkout refuses any other price and derives the tier from this list:
wrangler secret put STRIPE_PRICE_PRO     # e.g. price_123 (comma-separate monthly,yearly)
wrangler secret put STRIPE_PRICE_TEAM
wrangler deploy
# → https://lumen-billing.<your>.workers.dev

# 4d. Wire the Stripe webhook to /webhook on that URL via the Stripe Dashboard.
#     Events: checkout.session.completed, checkout.session.async_payment_succeeded,
#     checkout.session.async_payment_failed, customer.subscription.created,
#     customer.subscription.updated, customer.subscription.deleted.
#     Access is granted only once Stripe reports the payment as paid.
# 4e. Set client env:
#   VITE_BILLING_ENDPOINT=https://lumen-billing.<your>.workers.dev/checkout
#   VITE_ENTITLEMENT_ENDPOINT=https://lumen-billing.<your>.workers.dev/entitlements
# 4f. List every web origin that calls the worker (comma-separated) in
#     wrangler.toml → [vars] ALLOWED_ORIGIN, e.g. "https://lumen.app,http://localhost:5173".
#     The entitlement fetch uses credentials, so browsers need the exact origin
#     echoed back — `*` is only returned to unlisted origins and won't work there.
```

`GET /entitlements` contract (consumed by `src/billing/useEntitlement.ts`):

| Request | Response |
|---|---|
| no `Authorization` header | `200 {"entitlement":{"tier":"free","status":"none"}}` |
| `Authorization: Bearer <supabase access token>`, no row in `entitlements` | `200` free, as above |
| valid token, row present | `200 {"entitlement":{"tier":"pro","status":"active","renewsAt":1767225600,"subscriptionId":"sub_…"}}` |
| invalid / expired token | `401` (client falls back to Free) |
| Supabase unreachable | `502` (client falls back to Free) |

Stored Stripe statuses are normalised: `complete` → `active`, `unpaid` → `past_due`,
anything unrecognised → `none`. Only `active` / `trialing` unlock paid capabilities.
Responses are `Cache-Control: private, no-store`.

```bash
# Smoke test after deploy:
curl -s https://lumen-billing.<your>.workers.dev/entitlements            # → free
curl -s -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
     https://lumen-billing.<your>.workers.dev/entitlements                # → your plan
```

---

## 5. Publish edge worker (P3-08) — 30 min

Read-mode publishing. Same shape as the billing worker:

```bash
cd edge-workers/publish
wrangler kv:namespace create PUBLISHED
# → paste id into wrangler.toml under [[kv_namespaces]]
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE
wrangler deploy

# Client env:
#   VITE_PUBLISH_ENDPOINT=https://lumen-publish.<your>.workers.dev
```

---

## 5b. SSO edge worker — WorkOS (ε.1 / F4.3) — 45 min

Enterprise SAML / OIDC sign-in. Optional — skip it and Lumen keeps its
local-only / Supabase auth. Details in `edge-workers/auth/README.md`.

```bash
# 5b-1. WorkOS dashboard: API Keys → copy the secret key (sk_…) + client id.
#       Redirects → add https://<worker host>/api/sso/callback
#       Organizations → create one per customer, add its email domain(s)
#       and attach an SSO connection (SAML or OIDC).
cd edge-workers/auth
wrangler secret put WORKOS_API_KEY
wrangler secret put WORKOS_CLIENT_ID
wrangler secret put SESSION_SECRET        # openssl rand -base64 48
# If billing is deployed too, let SSO users prove who they are to it:
#   generate ONE new value (openssl rand -base64 48), then
wrangler secret put BILLING_TOKEN_SECRET  # that value
#   and in edge-workers/billing: wrangler secret put SSO_TOKEN_SECRET  (same value)
#   Entitlement rows for SSO users are keyed `workos:<user id>`, or
#   `workos-org:<organization id>` for an org-wide (enterprise) plan.
# 5b-2. Set ALLOWED_ORIGINS in wrangler.toml to your app origin(s), and give
#       the worker a host on the SAME SITE as the app (see below), e.g. the
#       `routes` example in edge-workers/auth/wrangler.toml.
wrangler deploy
# verify: GET https://auth.<your-domain>/health → configured:true

# Client env:
#   VITE_WORKOS_ENDPOINT=https://auth.<your-domain>
```

**Serve the SSO worker on the app's own site.** The nonce and session
cookies are set by the worker. If it lives on a different registrable
domain than the app (e.g. `lumen-auth.<you>.workers.dev` while the app is on
`example.org`), they are third-party cookies — Safari blocks those
outright, so sign-in ends in `state_mismatch` and sessions never stick.
Use a sibling subdomain (`auth.example.org` for an app on
`app.example.org` / `example.org`) or a route on the app's own host
(`example.org/api/sso/*`, then `VITE_WORKOS_ENDPOINT=https://example.org`).
`*.workers.dev` is fine for local testing in Chrome only; the app logs a
warning when the configured endpoint is cross-site. Cookies are
`SameSite=None; Secure`, so serve over HTTPS (or `http://localhost`).

---

## 6. Cloud sync (Dropbox) — 1 hour (P2-04)

```bash
# 6a. Register a Dropbox app:
# https://www.dropbox.com/developers/apps → Create app
# Permissions: "App folder" + files.content.write + files.content.read
# Redirect URIs: https://lumen.app/oauth/dropbox

# 6b. Set env:
#   VITE_DROPBOX_APP_KEY=<your-app-key>

# 6c. Test:
# In Lumen → Settings → Cloud sync → Connect Dropbox → OAuth flow → done.
```

---

## 7. Mobile (P2-07) — ~2 days calendar (a few hours work)

### iOS

```bash
# 7a. macOS prereq
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -license accept

# 7b. Sync + open
npm run ios:open

# 7c. In Xcode:
#   Signing & Capabilities → set Team to your Apple Developer team.
#   Bundle ID stays com.lumen.editor (or change).
#   Increment "Build" number on every TestFlight upload.

# 7d. Archive + upload
#   Product → Destination → "Any iOS Device (arm64)"
#   Product → Archive
#   Distribute App → App Store Connect → Upload
#   Wait ~10 min for processing → add to internal TestFlight group.

# 7e. Submit for review
#   App Store Connect → My Apps → Lumen → "+ Version" → fill metadata
#   Submit (typically 24–72 h review).
```

### Android

```bash
# 7a. Prereq
brew install --cask android-studio
# Set ANDROID_HOME after first launch.

# 7b. Add Android platform
npm install @capacitor/android
npx cap add android
npm run android:open

# 7c. In Android Studio:
#   Build → Generate Signed Bundle / APK → Android App Bundle (.aab)
#   Create keystore (KEEP IT — losing it locks you out of updates).
#   release variant → app-release.aab.

# 7d. Upload to Play Console (https://play.google.com/console).
```

---

## 8. Web app deploy (Cloudflare Pages) — 15 min

```bash
# 8a. Connect repo to Cloudflare Pages:
# https://dash.cloudflare.com → Workers & Pages → Create → Pages → Connect to Git

# 8b. Build settings:
#   Framework: Vite
#   Build command: npm run build
#   Output: dist
#   Env vars: paste every VITE_* from steps 1–7

# 8c. Custom domain:
#   Pages → lumen-app → Custom domains → Add → lumen.app
```

PWA service worker auto-updates clients on next visit.

### Marketing site (`/landing.html`) — same deploy

The landing page lives at `public/landing.html` and ships in the same Pages
deploy. Audit:

- [ ] Replace placeholder screenshots with real ones (use `npm run preview`
      to capture).
- [ ] `<title>` + Open Graph meta on every social card.
- [ ] Run `npx lhci autorun` and confirm Lighthouse Performance ≥ 90,
      Accessibility ≥ 95, SEO ≥ 95.

---

## 9. Tauri macOS — sign + notarize (15 min)

```bash
# 9a. Apple Developer ID Application certificate (one-time):
# https://developer.apple.com/account/resources/certificates/add
# Type: Developer ID Application

# 9b. App-specific password:
# https://appleid.apple.com → Sign-in & Security → App-Specific Passwords

# 9c. Build
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="abcd-efgh-ijkl-mnop"
export APPLE_TEAM_ID="ABCDEF1234"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDEF1234)"
npm run tauri:build

# 9d. Verify
codesign --verify --deep --strict src-tauri/target/release/bundle/macos/Lumen.app
spctl -a -t exec -vv      src-tauri/target/release/bundle/macos/Lumen.app
# Both should report "accepted" with "Notarized".
```

Upload `Lumen_*.dmg` to the GitHub Release that `release.yml` already
created from your tag push.

---

## 10. Chrome Web Store (Web Clipper) — 30 min

```bash
# 10a. Generate icons (16/32/48/128 PNG) — use any of the existing favicons:
cd extension/icons
# (manually create 16x16.png, 32x32.png, 48x48.png, 128x128.png)

# 10b. Zip
cd ..
zip -r lumen-clipper-0.1.0.zip extension/* -x "*.DS_Store"

# 10c. Upload
# https://chrome.google.com/webstore/devconsole → Add new item
# Upload zip, fill description, screenshots, privacy policy URL.
# Review takes 2-7 days.
```

---

## Post-launch checklist

After every step above is green:

- [ ] All 9 Playwright E2E pass on CI Mac runner (chromium / firefox / webkit).
- [ ] Lighthouse: Performance ≥ 90, A11y ≥ 95, Best practices ≥ 95, SEO ≥ 95, PWA ≥ 90.
- [ ] axe-core a11y test passes (no critical/serious violations).
- [ ] `npm run budget` passes — bundle still within targets.
- [ ] Sentry receiving events from at least one production session.
- [ ] First 10 users invited via TestFlight + Play Internal track.
- [ ] `https://lumen.app/p/<test-slug>` returns a published note.
- [ ] Right-click → "Save selection to Lumen" creates a clip.
- [ ] Subscribe → return to app → Pro features unlock.
- [ ] `⌘K → "AI: Switch to local AI"` downloads + serves answers offline.

---

## Rollback plan

Every step is independently reversible:

| Step | Rollback |
| --- | --- |
| Signaling | Remove `VITE_WEBRTC_SIGNALING_URL` → falls back to public Yjs |
| Persistent collab | Remove `VITE_YJS_WEBSOCKET_URL` → WebRTC-only |
| Stripe | Disable `VITE_BILLING_ENDPOINT` → entitlements default to Free |
| Publish | Remove `VITE_PUBLISH_ENDPOINT` → publish command throws "offline" |
| Dropbox | Remove `VITE_DROPBOX_APP_KEY` → cloud sync UI hidden |
| Mobile | App Store / Play "Take down" controls |
| macOS DMG | Re-upload signed binary via `release.yml` |
| Chrome | Disable in Web Store dashboard |

The web app survives every backend going down — local-first by design.

---

Ready to launch.

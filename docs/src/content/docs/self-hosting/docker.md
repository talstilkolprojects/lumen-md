---
title: Self-hosting with Docker
description: Run Lumen on your own infrastructure with the docker-compose bundle.
---

> Lumen is a **local-first** editor — by default everything runs inside
> your browser, no servers needed. This guide is for teams who want to
> own the persistence layer (collab, billing, audit log) on their own
> infrastructure.

## What's in the bundle

`docker-compose.yml` brings up five services on a single VM:

| Service | Port | What |
|---|---|---|
| `lumen-web` | 80 | nginx serving the React SPA + strict CSP |
| `lumen-signal` | 4444 | y-webrtc signaling — peers find each other |
| `lumen-collab` | 4445 | Persistent y-websocket (LevelDB on the `collab-data` volume; health: `/healthz`) |
| `lumen-billing` | 4446 | Stripe webhook handler (optional) |
| `postgres` | 5432 | Entitlements + audit log (collab does **not** write here — a Postgres snapshot archive is not implemented) |

A LevelDB volume (`collab-data`) and a Postgres volume (`postgres-data`)
persist outside container lifecycles.

## Prerequisites

- A Linux VM with **2 vCPU + 4 GB RAM** (Hetzner CX22, DigitalOcean
  basic-2, AWS t4g.medium are all fine)
- **Docker 24+** and **Docker Compose v2**
- A domain pointing at the VM (we'll use `lumen.example.com` below)

## 5-minute install

```bash
# 1. Clone Lumen
git clone https://github.com/talstilkol/lumen-md.git
cd lumen-md

# 2. Copy + edit the env template
cp .env.onprem.example .env.onprem
$EDITOR .env.onprem
#   set LUMEN_PG_PASSWORD to a strong value
#   set LUMEN_BASE_URL to your domain
#   leave LUMEN_COLLAB_TOKEN empty for now (see the note below)
#   leave Stripe / Sentry / WorkOS empty for now

# 3. Build + start
make onprem-up
```

After ~60 s of image build + container start, visit
`http://<vm-ip>` and you should see the Lumen editor.

:::caution[`LUMEN_COLLAB_TOKEN` in this bundle]
The bundle passes `LUMEN_COLLAB_TOKEN` to the collab server, but not to the
app it builds (`docker/Dockerfile.web` has no `VITE_YJS_WEBSOCKET_TOKEN`
argument), and the app has no screen for entering one yet. With a token
set, the app's own clients are refused by the collab server. Keep it
empty, or build the web image yourself with `VITE_YJS_WEBSOCKET_TOKEN`
(see [Persistent rooms](/collab/persistent/)). New rooms are end-to-end
encrypted either way.
:::

## DNS setup (recommended)

Point these subdomains at the VM:

```
lumen.example.com    A    <vm-ip>
signal.example.com   A    <vm-ip>   # or proxy via lumen-web
collab.example.com   A    <vm-ip>
```

Then put a TLS terminator (Caddy, Cloudflare Tunnel, or your existing
nginx) in front. The bundled nginx serves HTTP only; the ports are
mapped 1:1 so a reverse proxy can terminate SSL upstream.

Serve Lumen from the root of its own (sub)domain, as above. The
security headers that ship with the app (the bundled nginx config,
`public/_headers` and `vercel.json`) match root paths. If you build with
a sub-path `base` such as `/app/`, prefix those routes yourself,
including the Web Playground's `/playground-runner.html`, `/assets/*`
and `/playground/*` rules. Without them the playground preview is blocked.

On Netlify the Web Playground preview doesn't load: Netlify's `_headers`
format can't lift the app-wide frame and CSP headers for the runner page.
Cloudflare Pages, Vercel and this Docker image are supported.

## Optional: Billing

If you want to gate Pro features (persistent collab, semantic search,
fine-tune AI) behind a paywall, add Stripe credentials and re-up with
the `billing` profile:

```bash
# In .env.onprem
STRIPE_SECRET_KEY=sk_live_xxx
STRIPE_WEBHOOK_SECRET=whsec_xxx

# Bring up with the billing service
docker compose --env-file .env.onprem --profile billing up -d
```

The billing worker runs `wrangler local-mode` so the same code that
powers the Cloudflare deployment also runs in your VM.

## Optional: Sentry telemetry

Set `SENTRY_DSN=https://…@sentry.io/…` in `.env.onprem` to enable
opt-in error reporting. Users still see a toggle in Settings to turn
it off; you control which DSN.

## Optional: SSO with WorkOS

Set `WORKOS_API_KEY=…` and `WORKOS_CLIENT_ID=…` to enable SAML / OIDC
sign-in. A workspace admin pastes their IdP metadata URL into Settings
→ Organisation; WorkOS handles the protocol dance.

## Daily ops

| What | Command |
|---|---|
| Tail logs | `make onprem-logs` |
| Restart everything | `make onprem-down && make onprem-up` |
| Check Postgres | `docker compose exec postgres psql -U lumen` |
| Hard reset (deletes all data) | `make onprem-reset` |

## Backup

The two Docker volumes are the only state Lumen owns:

```bash
# Postgres dump
docker compose exec postgres pg_dump -U lumen lumen | gzip > lumen-pg-$(date +%F).sql.gz

# LevelDB collab snapshots
docker run --rm -v lumen_collab-data:/data -v "$(pwd)":/backup alpine \
  tar czf /backup/lumen-collab-$(date +%F).tar.gz -C /data .
```

User documents themselves never leave the browser — they live in OPFS
(Origin Private File System) per browser, per origin. Encourage users
to back up their local content with `⌘K → Export the whole vault…`
(see [Export and import](/workspace/export-import/)).

## Updating Lumen

```bash
git pull
make onprem-up   # rebuilds images + restarts containers
```

Database migrations run automatically on container start
(`docker/postgres-init.sql` is idempotent).

## Sizing for scale

Single-VM 2 vCPU / 4 GB handles:

- Up to ~50 concurrent collab rooms (LevelDB hot cache)
- ~1k entitlement reads / sec
- Linear cost on audit volume — every mutation writes one row

For larger deployments, split:

- `lumen-web` + `lumen-signal` on one VM (stateless, horizontally
  scalable)
- `lumen-collab` on a dedicated VM with a persistent EBS / Block-Storage
  volume
- Postgres on managed RDS / Cloud SQL

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| 502 from `lumen.example.com` | reverse proxy can't reach `lumen-web:80` |
| Editor loads but collab silently fails | `lumen-signal` not reachable; check WS upgrade rules in proxy |
| Pro features stay locked | `lumen-billing` not in the compose profile, or webhook signature secret wrong |
| `pg_isready` fails | `LUMEN_PG_PASSWORD` mismatch between `.env.onprem` and the volume |

If something else breaks, `make onprem-logs` is your friend — the
five-line per-service prefix makes it easy to spot the offender.

#!/usr/bin/env bash
# Plan W7.23: the Cloudflare Workers Builds build command (dashboard → the Worker
# lumen-md-repro → Settings → Build):
#   Build command:  bash scripts/supply-chain/cf-build.sh
#   Deploy command: npx --yes wrangler@4 deploy --config cloudflare/repro/wrangler.jsonc
#   Build variables: NODE_VERSION=<the Node major Vercel uses>, plus the same VITE_* as Vercel
# It builds dist/ exactly as Vercel does (npm ci from package-lock.json, then
# npm run build) and writes its manifest — every file's SHA-256 — to
# .repro-out/lumen-build.json, the only file the Worker serves. The second
# host compares it with the files Vercel serves (scripts/supply-chain/repro-second-host.sh).
# Free plan (developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing,
# updated 28.10.2026): 3,000 build minutes a month, 1 concurrent build, 20 min per build.
set -euo pipefail
cd "$(dirname "$0")/../.."
start=$SECONDS
export TZ=UTC LC_ALL=C
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct 2>/dev/null || echo 0)
export SOURCE_DATE_EPOCH
echo "commit ${WORKERS_CI_COMMIT_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)} · node $(node -v) · SOURCE_DATE_EPOCH=$SOURCE_DATE_EPOCH"
[ -d node_modules ] || npm ci --no-audit --no-fund
npm run build
rm -rf .repro-out && mkdir -p .repro-out
node scripts/supply-chain/dist-manifest.mjs --builder cloudflare-workers-builds --build-seconds $((SECONDS - start)) --out .repro-out/lumen-build.json
elapsed=$((SECONDS - start))
echo "build + manifest: ${elapsed} s (target ≤ 900 s, the free plan stops at 1200 s)"

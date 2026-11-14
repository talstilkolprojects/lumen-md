#!/usr/bin/env bash
# Plan W4.27: deploy this checkout's build to Cloudflare Pages by Direct Upload,
# the second host next to Vercel. A Direct Upload builds on this machine, so it
# uses none of Cloudflare's 500 builds a month and none of Vercel's deployments.
#
#   bash scripts/pages-deploy.sh            # preview, named after the current branch
#   bash scripts/pages-deploy.sh --prod     # production (branch main)
#
# Needs: `npx wrangler@4 login` once, and the project (owner commands, docs
# self-hosting/second-host). The deployment carries this commit's hash, so it
# can be compared with Vercel's deployment of the same commit.
set -euo pipefail
cd "$(dirname "$0")/.."
PROJECT=${CF_PAGES_PROJECT:-lumen-md}
branch=$(git rev-parse --abbrev-ref HEAD)
[ "${1:-}" = "--prod" ] && branch=main
sha=$(git rev-parse HEAD)
dirty=false; git diff --quiet HEAD || dirty=true
node scripts/hosting-gate.mjs --host cloudflare-pages
npm run build
node scripts/pages-check.mjs --prepare
node scripts/host-parity.mjs --dist dist
npx --yes wrangler@4 pages deploy dist --project-name "$PROJECT" --branch "$branch" --commit-hash "$sha" --commit-message "$(git log -1 --format=%s)" --commit-dirty="$dirty"
echo "Deployed $sha ($branch) to Cloudflare Pages project $PROJECT"

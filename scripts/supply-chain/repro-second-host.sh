#!/usr/bin/env bash
# Plan W7.23: on the second host (#509's factory, nightly or after a push to main):
# is the commit Cloudflare rebuilt byte-for-byte what Vercel serves?
#
#   LUMEN_REPRO_WORKER=https://lumen-md-repro.<subdomain>.workers.dev \
#     bash scripts/supply-chain/repro-second-host.sh [--local-build] [--vercel-url URL]
#
# 1. Fetch the Cloudflare manifest (<worker>/lumen-build.json): its commit and
#    every file's SHA-256 (built by scripts/supply-chain/cf-build.sh).
# 2. Find that commit's Vercel deployment through the public GitHub Deployments API
#    (Vercel records one per commit; environment_url is the immutable deployment),
#    falling back to the production site; --vercel-url overrides it.
# 3. Compare it with Vercel's own manifest (<deployment>/.well-known/lumen-build.json,
#    written by the `manifest` gate of scripts/vercel-build.mjs), then check that
#    Vercel serves the bytes its manifest names (every file fetched and hashed).
#    A deployment without the manifest (before the gate) is hashed over HTTP
#    instead (scripts/supply-chain/repro-compare.mjs). The verdict goes to
#    reports/repro/ledger.jsonl (the streak of identical commits; target 10) and,
#    when identical, an in-toto statement for W7.22 to sign.
# 4. --local-build, when they differ: build the same commit here and run diffoscope on
#    each differing file (Vercel's bytes vs the local build's), into reports/repro/<sha>/.
# Needs: node ≥ 22, gh (read-only, no token needed for a public repo), curl; diffoscope
# for step 4 (apt install diffoscope). Exit 0 identical, 1 different, 2 error.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd); cd "$ROOT"
REPO=${LUMEN_REPO:-talstilkol/lumen-md}
PROD=${LUMEN_PROD_URL:-https://lumen-md.vercel.app}
WORKER=${LUMEN_REPRO_WORKER:?set LUMEN_REPRO_WORKER to the Worker URL (https://lumen-md-repro.<subdomain>.workers.dev)}
LOCAL=0 VERCEL_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --local-build) LOCAL=1 ;;
    --vercel-url) VERCEL_URL=${2:?}; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac; shift
done
OUT=$ROOT/reports/repro; mkdir -p "$OUT"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

curl -fsS "${WORKER%/}/lumen-build.json" -o "$TMP/cloudflare.json" || { echo "no manifest at ${WORKER%/}/lumen-build.json" >&2; exit 2; }
SHA=$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).commit)' "$TMP/cloudflare.json")
SECS=$(node -e 'const m=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(m.buildSeconds??""))' "$TMP/cloudflare.json")
echo "Cloudflare built $SHA${SECS:+ in ${SECS} s (target ≤ 900)}"
if [ -z "$VERCEL_URL" ]; then
  VERCEL_URL=$(gh api "repos/$REPO/deployments?sha=$SHA&per_page=20" --jq '.[] | select(.creator.login | test("vercel"; "i")) | .statuses_url' 2>/dev/null \
    | while read -r u; do gh api "$u" --jq '[.[] | select(.state=="success") | .environment_url][0] // empty' 2>/dev/null; done | grep -m1 '^https://' || true)
  [ -n "$VERCEL_URL" ] || { VERCEL_URL=$PROD; echo "note: no Vercel deployment recorded for $SHA on GitHub; comparing with $PROD (it may be on another commit)"; }
fi
echo "Vercel: $VERCEL_URL"
if curl -fsS "${VERCEL_URL%/}/.well-known/lumen-build.json" -o "$TMP/vercel.json" 2>/dev/null; then
  node scripts/supply-chain/repro-compare.mjs "$TMP/cloudflare.json" "$TMP/vercel.json" --labels cloudflare,vercel \
    --ledger "$OUT/ledger.jsonl" --attest "$OUT/$SHA.intoto.json" | tee "$OUT/$SHA.txt"
  code=${PIPESTATUS[0]}
  echo "== does Vercel serve what its manifest says?"
  node scripts/supply-chain/repro-compare.mjs "$TMP/vercel.json" "origin:$VERCEL_URL" --labels vercel-manifest,vercel-served | tail -1 | tee -a "$OUT/$SHA.txt"
  served=${PIPESTATUS[0]}
  [ "$served" = 0 ] || { echo "SERVED ≠ BUILT on Vercel"; [ "$code" = 0 ] && code=2; }
else
  echo "note: $VERCEL_URL has no /.well-known/lumen-build.json (built before the manifest gate): hashing what it serves"
  node scripts/supply-chain/repro-compare.mjs "$TMP/cloudflare.json" "origin:$VERCEL_URL" --labels cloudflare,vercel \
    --ledger "$OUT/ledger.jsonl" --attest "$OUT/$SHA.intoto.json" | tee "$OUT/$SHA.txt"
  code=${PIPESTATUS[0]}
fi
if [ -n "$SECS" ] && [ "$SECS" -gt 900 ]; then echo "SLOW: the Cloudflare build took ${SECS} s (> 900 s)"; [ "$code" = 0 ] && code=1; fi
if [ "$code" = 1 ] && [ "$LOCAL" = 1 ]; then
  D=$OUT/$SHA; mkdir -p "$D/vercel"
  git fetch -q origin "$SHA" 2>/dev/null || true
  git worktree add --detach --quiet "$TMP/local" "$SHA" && (cd "$TMP/local" && npm ci --no-audit --no-fund && SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) TZ=UTC npm run build) \
    && node scripts/supply-chain/repro-compare.mjs "$TMP/cloudflare.json" "$TMP/local/dist" --labels cloudflare,local | tee "$D/cloudflare-vs-local.txt"
  grep -E '^differs ' "$OUT/$SHA.txt" | awk '{print $2}' | while read -r f; do
    mkdir -p "$D/vercel/$(dirname "$f")"; curl -fsS "${VERCEL_URL%/}/$f" -o "$D/vercel/$f" || continue
    if command -v diffoscope >/dev/null; then diffoscope --text "$D/$(echo "$f" | tr / _).diff" "$D/vercel/$f" "$TMP/local/dist/$f" >/dev/null 2>&1; echo "diffoscope: $D/$(echo "$f" | tr / _).diff"
    else cmp -l "$D/vercel/$f" "$TMP/local/dist/$f" | head -5; fi
  done
  git worktree remove --force "$TMP/local" 2>/dev/null
fi
exit "$code"

#!/usr/bin/env bash
# Open a parallel work lane: one worktree + one branch, ready to run.
# Protocol: docs/dev/lanes.md.
#
#   scripts/lane.sh <name> <base-branch>
#
#   <name>         the new branch (e.g. fix/sync-retry); the worktree goes to
#                  ../w-<name> next to this checkout, with "/" turned into "-"
#   <base-branch>  any commit-ish to branch from (main, fix/codex-backlog, origin/main)
#
# Environment:
#   LUMEN_NODE_MODULES  node_modules to symlink into the lane
#                       (default: the main checkout's node_modules)
#   PW_CHROMIUM         Chromium executable for the chromium project (optional;
#                       also read again when the tests run)
#   LANE_PORT           dev-server port for e2e (default: a free port, picked now)
#   LANE_SKIP_TSC=1     skip the baseline `tsc --noEmit`
#
# The lane gets playwright.lane.config.ts (gitignored): the repo config with its
# own port, so two lanes can run e2e at once:
#   npx playwright test -c playwright.lane.config.ts e2e/smoke.spec.ts
set -euo pipefail

die() { echo "lane: $*" >&2; exit 1; }

[ $# -eq 2 ] || die "usage: scripts/lane.sh <name> <base-branch>"
name=$1
base=$2

git check-ref-format --branch "$name" >/dev/null 2>&1 || die "'$name' is not a valid branch name"
top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside a lumen-md checkout"
git rev-parse --verify --quiet "$base^{commit}" >/dev/null || die "base '$base' is not a branch or commit here (git fetch first?)"
git rev-parse --verify --quiet "refs/heads/$name" >/dev/null && die "branch '$name' already exists"

dir="$(dirname "$top")/w-${name//\//-}"
[ -e "$dir" ] && die "$dir already exists"

# node_modules: explicit path, else the main worktree's (first entry of `git worktree list`).
main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
nm=${LUMEN_NODE_MODULES:-$main/node_modules}
[ -d "$nm" ] || die "no node_modules at $nm (run npm ci in the main checkout or set LUMEN_NODE_MODULES)"
nm=$(cd "$nm" && pwd -P)

git worktree add --quiet -b "$name" "$dir" "$base"
# Shared, read-mostly deps. Vite's writable cache is not shared: with a
# symlinked node_modules, vite.config.ts puts it in the lane's own .vite/
# (src/build/laneCache.ts), so concurrent dev servers do not swap each
# other's pre-bundled deps.
ln -s "$nm" "$dir/node_modules"

# A port nothing listens on right now. The lane config bakes it in (every
# Playwright worker must agree on it); PW_PORT overrides it at test time.
port=${LANE_PORT:-$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')}

cat >"$dir/playwright.lane.config.ts" <<EOF
// Written by scripts/lane.sh for lane "$name" — local only (gitignored).
// The repo's Playwright config on this lane's own dev-server port, so lanes
// run e2e side by side. Regenerate by deleting this file and rerunning lane.sh,
// or override at run time with PW_PORT / PW_CHROMIUM / PLAYWRIGHT_BASE_URL.
import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

const PORT = Number(process.env.PW_PORT ?? $port);
const BASE_URL = process.env.PLAYWRIGHT_BASE_URL ?? \`http://localhost:\${PORT}\`;
const CHROMIUM = process.env.PW_CHROMIUM ?? $(node -e 'console.log(JSON.stringify(process.env.PW_CHROMIUM ?? ""))');

export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: BASE_URL },
  projects: (base.projects ?? []).map((p) =>
    p.name === "chromium" && CHROMIUM
      ? { ...p, use: { ...p.use, launchOptions: { ...p.use?.launchOptions, executablePath: CHROMIUM } } }
      : p,
  ),
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: \`npm run dev -- --port \${PORT} --strictPort\`,
        url: BASE_URL,
        // Never reuse: a server already on this port belongs to another lane.
        reuseExistingServer: false,
        timeout: 120_000,
      },
});
EOF

echo "lane:   $name  (from $base @ $(git rev-parse --short "$base^{commit}"))"
echo "dir:    $dir"
echo "deps:   node_modules -> $nm  (Vite cache: $dir/.vite)"
echo "e2e:    port $port${PW_CHROMIUM:+, chromium $PW_CHROMIUM}  (npx playwright test -c playwright.lane.config.ts)"

if [ "${LANE_SKIP_TSC:-}" = 1 ]; then
  echo "tsc:    skipped (LANE_SKIP_TSC=1)"
  exit 0
fi
# Baseline only: errors here already exist on <base>, so they don't stop the lane.
log=$(mktemp)
if (cd "$dir" && npx tsc --noEmit -p .) >"$log" 2>&1; then
  echo "tsc:    clean"
else
  n=$(grep -c 'error TS' "$log" || true)
  if [ "$n" -eq 0 ]; then
    echo "tsc:    did not run cleanly:"
    tail -5 "$log" | sed 's/^/        /'
  else
    echo "tsc:    $n error(s) on the base already — fix or note them before you start:"
    grep 'error TS' "$log" | head -10 | sed 's/^/        /'
    if [ "$n" -gt 10 ]; then echo "        … $((n - 10)) more"; fi
  fi
fi
rm -f "$log"

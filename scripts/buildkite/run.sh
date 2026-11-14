#!/usr/bin/env bash
# One Buildkite job of lumen-md's pipeline (plan W7.21). The job's script
# comes on stdin (a quoted heredoc in .buildkite/pipeline.yml): ci.yml's
# `run:` steps, each as `gate "<name>" [ENV=value…] <<'EOF' … EOF`.
#
#   LUMEN_CI_EXEC=docker (the Linux host): the script runs in Playwright's own
#     image for the lockfile's version (scripts/factory/Dockerfile.factory, as
#     the nightly factory uses), with the checkout mounted at /lumen.
#   LUMEN_CI_EXEC=native (the Mac): the script runs on macOS itself, so
#     WebKit is Playwright's macOS WebKit, not the Linux build.
#
# Before the script: `npm ci` (or LUMEN_CI_INSTALL), and on the Mac the
# job's browsers (LUMEN_CI_BROWSERS). Each gate runs in its own `bash -e`,
# like a GitHub step; the job stops at the first failure unless
# LUMEN_CI_KEEP_GOING=1, and `gates_done` exits 1 if any gate failed.
# Per-gate exit codes and seconds go to ci-out/gates-<job>.tsv.
set -euo pipefail
cd "$(dirname "$0")/../.."
EXEC="${LUMEN_CI_EXEC:-$([ "$(uname -s)" = Darwin ] && echo native || echo docker)}"
DOCKER="${DOCKER:-docker}"
JOB="${LUMEN_CI_JOB:-job}"
mkdir -p ci-out
SCRIPT="ci-out/.job-${JOB}${BUILDKITE_PARALLEL_JOB:+-$BUILDKITE_PARALLEL_JOB}.sh"

{
  cat <<'PRELUDE'
# prelude (scripts/buildkite/run.sh)
export CI=1 GITHUB_STEP_SUMMARY="$PWD/ci-out/summary.md"
LUMEN_FAILED=()
LUMEN_TSV="ci-out/gates-${LUMEN_CI_JOB:-job}${BUILDKITE_PARALLEL_JOB:+-$BUILDKITE_PARALLEL_JOB}.tsv"
: > "$LUMEN_TSV"
gate() {
  local title="$1"; shift
  local f; f="$(mktemp)"; cat > "$f"
  if [ "${#LUMEN_FAILED[@]}" -gt 0 ] && [ -z "${LUMEN_CI_KEEP_GOING:-}" ]; then
    echo "--- :fast_forward: $title (not run: an earlier step failed)"; rm -f "$f"; printf '%s\t%s\t%s\n' "$title" skipped 0 >> "$LUMEN_TSV"; return 0
  fi
  echo "--- $title"
  local start=$SECONDS code=0
  env "$@" bash -e "$f" || code=$?
  rm -f "$f"
  printf '%s\t%s\t%s\n' "$title" "$code" "$((SECONDS - start))" >> "$LUMEN_TSV"
  if [ "$code" -ne 0 ]; then echo "^^^ +++"; echo "✗ $title: exit $code"; LUMEN_FAILED+=("$title"); fi
  return 0
}
gates_done() {
  if [ "${#LUMEN_FAILED[@]}" -gt 0 ]; then echo "+++ ✗ ${#LUMEN_FAILED[@]} failed"; printf '  ✗ %s\n' "${LUMEN_FAILED[@]}"; exit 1; fi
  echo "+++ ✓ every step passed"
}
echo "--- :npm: install"
eval "${LUMEN_CI_INSTALL:-npm ci --no-audit --no-fund}" || { echo "^^^ +++"; echo "✗ install failed"; exit 1; }
if [ "${LUMEN_CI_EXEC_INSIDE:-}" = native ] && [ -n "${LUMEN_CI_BROWSERS:-}" ]; then
  echo "--- :playwright: browsers: ${LUMEN_CI_BROWSERS}"
  npx playwright install ${LUMEN_CI_BROWSERS//,/ }
fi
# Lighthouse CI looks for Chrome; Playwright's Chromium is the one in the image.
if [ -z "${CHROME_PATH:-}" ] && [ -f node_modules/playwright-core/package.json ]; then
  CHROME_PATH="$(node -e 'try{console.log(require("playwright-core").chromium.executablePath())}catch{}' 2>/dev/null || true)"; export CHROME_PATH
fi
# job script
PRELUDE
  cat
} > "$SCRIPT"

PASS=(CI BUILDKITE BUILDKITE_COMMIT BUILDKITE_BRANCH BUILDKITE_BUILD_URL BUILDKITE_BUILD_NUMBER BUILDKITE_PULL_REQUEST BUILDKITE_PARALLEL_JOB BUILDKITE_PARALLEL_JOB_COUNT LUMEN_CI_JOB LUMEN_CI_KEEP_GOING LUMEN_CI_INSTALL LUMEN_CI_BROWSERS)

if [ "$EXEC" = native ]; then
  export LUMEN_CI_EXEC_INSIDE=native
  exec bash "$SCRIPT"
fi

PW="$(node -p 'require("./package-lock.json").packages["node_modules/@playwright/test"].version')"
TAG="lumen-factory:pw-$PW"
if ! "$DOCKER" image inspect "$TAG" > /dev/null 2>&1; then
  echo "--- :docker: building $TAG"
  "$DOCKER" build -f scripts/factory/Dockerfile.factory --build-arg "PW_VERSION=$PW" -t "$TAG" scripts/factory
fi
CACHE="${LUMEN_CI_CACHE:-$HOME/.cache/lumen-ci}"
mkdir -p "$CACHE/npm"
envs=(); for v in "${PASS[@]}"; do [ -n "${!v+x}" ] && envs+=(-e "$v"); done
uid="$(id -u):$(id -g)"
# --ipc=host: Chromium needs more shared memory than Docker's 64 MB; --init reaps a server left in the background.
exec "$DOCKER" run --rm --init --ipc=host -u "$uid" \
  -e HOME=/tmp/home -e npm_config_cache=/cache/npm -e LUMEN_CI_EXEC_INSIDE=docker "${envs[@]}" \
  -v "$PWD:/lumen" -v "$CACHE:/cache" -w /lumen "$TAG" bash "$SCRIPT"

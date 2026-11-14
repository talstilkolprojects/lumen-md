#!/usr/bin/env bash
# Plan W4.27: run `npm run ci:local` (typecheck, lint, vitest, build, bundle
# budget, i18n, e2e on Chromium...) inside Dockerfile.ci. Arguments go to
# ci:local (e.g. --only typecheck,test, --skip e2e, --coverage).
# Needs Docker (or Podman: DOCKER=podman). No GitHub Actions, no Vercel.
set -euo pipefail
cd "$(dirname "$0")/.."
DOCKER=${DOCKER:-docker}
PW=$(node -p 'require("./package-lock.json").packages["node_modules/@playwright/test"].version')
TAG="lumen-ci:pw-$PW"
"$DOCKER" build -f Dockerfile.ci --build-arg "PW_VERSION=$PW" -t "$TAG" .
mkdir -p ci-docker-out
# --ipc=host: Chromium needs more shared memory than Docker's 64 MB default.
"$DOCKER" run --rm --ipc=host -v "$PWD/ci-docker-out:/lumen/ci-docker-out" "$TAG" "$@" 2>&1 | tee ci-docker-out/ci-local.log
exit "${PIPESTATUS[0]}"

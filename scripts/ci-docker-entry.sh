#!/usr/bin/env bash
# Inside Dockerfile.ci (plan W4.27): make sure git works, then run ci:local.
set -uo pipefail
cd /lumen
git config --global --add safe.directory /lumen
if ! git rev-parse --verify -q HEAD >/dev/null; then
  # A worktree's .git is a file pointing outside the build context: test this
  # tree as a one-commit repository instead.
  rm -rf .git && git init -q && git add -A && git -c user.name=ci -c user.email=ci@example.com commit -qm "ci-docker snapshot [skip ci]"
fi
echo "ci-docker: $(git log -1 --format='%h %s'), node $(node -v), $(npx --no playwright --version)"
npm run ci:local -- "$@"
code=$?
cp -r playwright-report ci-docker-out/ 2>/dev/null || true
exit $code

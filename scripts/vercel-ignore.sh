#!/usr/bin/env bash
# Vercel "ignoreCommand" for the web app project.
#
#   exit 0 → skip this deployment (nothing the web build consumes changed)
#   exit 1 → build
#
# Vercel limits `ignoreCommand` to 256 characters, so the logic lives here
# and vercel.json only calls this script. Usage:
#
#   scripts/vercel-ignore.sh [BASE] [HEAD]      (defaults: HEAD^ HEAD)
#
# Rules:
#   • Markdown outside public/ and src/ never triggers a build.
#   • Directories that are deployed elsewhere (docs site, edge workers, the
#     signaling server, MCP/API/marketplace servers, packages, the browser
#     extension, Tauri/iOS/Android shells, e2e, CI, the committed nightly
#     reports under reports/) do not trigger a build —
#     EXCEPT for files inside them that src/ (non-test code) imports; those
#     are web build inputs even though they live outside src/.
#   • Anything else (src/, public/, index.html, package*.json, vite/tsconfig,
#     vercel.json, scripts/, …) triggers a build.
#   • When history is unavailable (shallow clone, first commit), build.
#   • Before anything else: only main (production) and the integration
#     trains (verify/*) build. A PR branch is verified through the train
#     (verify/train-2) and skipped here. LUMEN_BUILD_ALL=1 (a Vercel project
#     variable) builds every branch again.
#   • Then: a commit that is no longer its branch's head when its
#     build starts is skipped. A newer push is queued behind it, and Vercel
#     builds one deployment at a time, so the superseded one only delays it.
#     When the branch head cannot be read (no network, a deleted branch),
#     the other rules decide.
set -u
cd "$(dirname "$0")/.." || exit 1

REF="${VERCEL_GIT_COMMIT_REF:-}"
if [ -n "$REF" ] && [ "${LUMEN_BUILD_ALL:-}" != "1" ] && [ "$REF" != "main" ]; then
  case "$REF" in
    verify/*) ;;
    *)
      echo "vercel-ignore: $REF is a PR branch: verified through the train (verify/train-2)"
      exit 0
      ;;
  esac
fi

REMOTE="${LUMEN_IGNORE_REMOTE:-https://github.com/talstilkol/lumen-md}"
if [ -n "${VERCEL_GIT_COMMIT_REF:-}" ] && [ -n "${VERCEL_GIT_COMMIT_SHA:-}" ]; then
  H="$(timeout 20 git ls-remote "$REMOTE" "refs/heads/$VERCEL_GIT_COMMIT_REF" 2>/dev/null | cut -f1)"
  if [ -n "$H" ] && [ "$H" != "$VERCEL_GIT_COMMIT_SHA" ]; then
    echo "vercel-ignore: $VERCEL_GIT_COMMIT_SHA is no longer the head of $VERCEL_GIT_COMMIT_REF ($H): skipped"
    exit 0
  fi
fi

BASE="${1:-HEAD^}"
HEAD_REF="${2:-HEAD}"

git rev-parse --verify -q "$BASE" >/dev/null 2>&1 || exit 1
changed="$(git diff --name-only "$BASE" "$HEAD_REF" 2>/dev/null)" || exit 1
[ -z "$changed" ] && exit 0

NON_APP='^(docs|edge-workers|sync-server|mcp-server|api-server|marketplace-server|packages|extension|src-tauri|ios|android|e2e|reports|\.github)/'

# Repo-relative stems (no extension) of modules outside src/ that src/ imports,
# e.g. "edge-workers/research/extract". Test files are ignored: they are not
# part of the production bundle.
shared="$(grep -rhoE --include='*.ts' --include='*.tsx' --exclude-dir=__tests__ \
  "from [\"']\.\./(\.\./)+[^\"']+" src 2>/dev/null \
  | sed -E "s/^from [\"']//; s#^(\.\./)+##; s/\.(ts|tsx|js|mjs)$//" | sort -u)"

while IFS= read -r f; do
  [ -z "$f" ] && continue
  case "$f" in
    public/*|src/*) exit 1 ;;            # always app inputs
    *.md|*.MD) continue ;;               # docs-only change
  esac
  if printf '%s\n' "$f" | grep -qE "$NON_APP"; then
    stem="${f%.*}"
    for s in $shared; do
      if [ "$stem" = "$s" ] || [ "$f" = "$s" ]; then exit 1; fi
    done
    continue
  fi
  exit 1
done <<EOF
$changed
EOF
exit 0

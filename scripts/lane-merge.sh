#!/usr/bin/env bash
# Coordinator side of the lanes protocol (docs/dev/lanes.md): merge lane
# branches into a target, one --no-ff merge each, then check the result.
#
#   scripts/lane-merge.sh <target-branch> <branch...>
#
# Runs in the current checkout (it must be clean, untracked files included;
# <target> gets checked out).
# A conflict only in generated files — i18n/keys/*.json, package-lock.json — is
# resolved by regenerating them from the merged sources:
#   i18n/keys/*.json   node scripts/extract-i18n-keys.mjs
#   package-lock.json  npm install --package-lock-only   (from the merged package.json)
# Any other conflict stops the run with the merge left in progress, so you can
# resolve it by hand and rerun with the branches that are left. An i18n/keys/ that
# merged cleanly but no longer matches the strings is regenerated in the merge too.
#
# A merge that touches package.json or package-lock.json gets its lockfile
# settled by `npm install --package-lock-only` inside the merge (a clean
# textual merge can still miss entries the merged package.json needs).
#
# Afterwards: npx tsc --noEmit -p . and npx vitest run, then a summary. If
# dependencies changed since node_modules was last installed (also by an earlier, interrupted run), the checks need them installed
# first (lanes only touch the lockfile, docs/dev/lanes.md rule 4): the run
# stops before the checks (exit 2) so you can `npm install` and rerun the
# same command (merged branches are skipped), or installs them itself with
# LANE_INSTALL=1.
#
# Environment:
#   LANE_TRAILER       text appended to every merge commit message (e.g. the
#                      Co-Authored-By / Claude-Session lines)
#   LANE_SKIP_TESTS=1  skip vitest (tsc still runs)
#   LANE_INSTALL=1     run `npm install` before the checks when the merges
#                      changed dependencies (it updates the node_modules that
#                      lanes link to)
set -uo pipefail

# Checking out and merging can rewrite this very file: run from a copy.
if [ -z "${LANE_MERGE_SELF:-}" ]; then
  self=$(mktemp)
  cp "$0" "$self"
  LANE_MERGE_SELF=$self exec bash "$self" "$@"
fi
trap 'rm -f "$LANE_MERGE_SELF"' EXIT

die() { echo "lane-merge: $*" >&2; exit 1; }

[ $# -ge 2 ] || die "usage: scripts/lane-merge.sh <target-branch> <branch...>"
target=$1
shift
branches=("$@")

top=$(git rev-parse --show-toplevel 2>/dev/null) || die "run this inside a lumen-md checkout"
cd "$top" || exit 1
# Untracked files count: one under src/ could satisfy a lane's import in the
# checks below without being in the commits that get pushed.
dirty=$(git status --porcelain --untracked-files=all)
[ -z "$dirty" ] || die "working tree has uncommitted changes or untracked files; commit them or move them away first:
$(echo "$dirty" | head -5 | sed 's/^/  /')"
git rev-parse -q --verify MERGE_HEAD >/dev/null && die "a merge is already in progress (finish it or git merge --abort)"
git rev-parse --verify --quiet "refs/heads/$target" >/dev/null || die "target branch '$target' does not exist (create it: git branch $target <base>)"
for b in "${branches[@]}"; do
  git rev-parse --verify --quiet "$b^{commit}" >/dev/null || die "branch '$b' not found"
done

if [ "$(git symbolic-ref --quiet --short HEAD 2>/dev/null)" != "$target" ]; then
  git checkout --quiet "$target" || die "could not check out $target"
fi

# i18n/keys/<domain>.json: one file per domain since plan 0.3.
GENERATED=("i18n/keys/*.json" "package-lock.json")
is_generated() { local f; for f in "${GENERATED[@]}"; do [[ "$1" == $f ]] && return 0; done; return 1; }

regenerate() {
  case $1 in
    i18n/keys/*.json)
      node scripts/extract-i18n-keys.mjs >/dev/null 2>&1 || return 1 ;;
    package-lock.json)
      # Start from our side, then let npm fold in whatever the merged package.json needs.
      git checkout --ours -- package-lock.json &&
        npm install --package-lock-only --no-audit --no-fund >/dev/null 2>&1 || return 1 ;;
  esac
  git add -- "$1"
}

print_merges() {
  echo
  echo "== lane-merge into $target"
  printf '%-40s %-10s %s\n' "branch" "merge" "result"
  for row in "${summary[@]}"; do
    IFS='|' read -r b sha res <<<"$row"
    printf '%-40s %-10s %s\n' "$b" "$sha" "$res"
  done
}

summary=()
i=0
for b in "${branches[@]}"; do
  i=$((i + 1))
  if git merge-base --is-ancestor "$b" HEAD; then
    summary+=("$b|-|already merged")
    continue
  fi
  msg="Merge branch '$b' into $target"
  notes=()
  # Stop before committing, so generated files can be fixed inside the merge itself.
  if ! git merge --quiet --no-ff --no-commit "$b" >/dev/null 2>&1; then
    mapfile -t conflicted < <(git diff --name-only --diff-filter=U)
    if [ ${#conflicted[@]} -eq 0 ]; then
      git merge --abort 2>/dev/null
      die "merging $b failed before any conflict (untracked files in the way?): run git merge --no-ff $b to see why"
    fi
    other=()
    for f in "${conflicted[@]}"; do is_generated "$f" || other+=("$f"); done
    if [ ${#other[@]} -gt 0 ]; then
      echo >&2
      echo "lane-merge: STOP — $b conflicts with $target in files a person has to resolve:" >&2
      printf '    %s\n' "${other[@]}" >&2
      echo "The merge is left in progress. Resolve those files (generated ones too: rerun" >&2
      echo "node scripts/extract-i18n-keys.mjs / npm install --package-lock-only), git add, git commit," >&2
      rest=("${branches[@]:$i}")
      if [ ${#rest[@]} -gt 0 ]; then
        echo "then continue with:  scripts/lane-merge.sh $target ${rest[*]}" >&2
      else
        # Not tsc / vitest directly: this command skips the merged branch and
        # still runs the dependency and i18n gates before the checks.
        echo "then run the checks:  scripts/lane-merge.sh $target $b" >&2
      fi
      echo "Or give up on this branch: git merge --abort" >&2
      [ ${#summary[@]} -gt 0 ] && { echo "Merged before the stop:" >&2; printf '    %s\n' "${summary[@]%%|*}" >&2; }
      exit 1
    fi
    for f in "${conflicted[@]}"; do
      if ! regenerate "$f"; then
        echo "lane-merge: STOP — could not regenerate $f while merging $b (merge left in progress; git merge --abort to undo)" >&2
        exit 1
      fi
    done
    notes+=("regenerated ${conflicted[*]} (conflict)")
  fi
  # Both sides can make the same textual change (say, the same new "count")
  # and merge cleanly into a keys.json that no longer matches the strings.
  if ! node scripts/extract-i18n-keys.mjs --check >/dev/null 2>&1; then
    regenerate i18n/keys/ai.json || die "could not regenerate i18n/keys/ while merging $b (merge left in progress)"
    notes+=("refreshed i18n/keys/ (stale after the merge)")
  fi
  # The same for the lockfile: one lane can drop a transitive entry the
  # other's new package reuses, and the text still merges cleanly.
  if ! git diff --cached --quiet HEAD -- package.json package-lock.json; then
    lock_before=$(git hash-object package-lock.json 2>/dev/null || true)
    npm install --package-lock-only --no-audit --no-fund >/dev/null 2>&1 || die "npm install --package-lock-only failed while merging $b (merge left in progress)"
    if [ "$(git hash-object package-lock.json 2>/dev/null || true)" != "$lock_before" ]; then
      git add -- package-lock.json
      notes+=("normalised package-lock.json (npm install --package-lock-only)")
    fi
  fi

  msgfile=$(mktemp)
  {
    echo "$msg"
    if [ ${#notes[@]} -gt 0 ]; then echo; printf '%s\n' "${notes[@]/#/Generated files: }"; fi
    if [ -n "${LANE_TRAILER:-}" ]; then echo; echo "$LANE_TRAILER"; fi
  } >"$msgfile"
  if ! git commit --quiet --cleanup=strip -F "$msgfile" >/dev/null; then
    rm -f "$msgfile"
    die "commit of the merge of $b failed (merge left in progress)"
  fi
  rm -f "$msgfile"
  if [ ${#notes[@]} -gt 0 ]; then
    summary+=("$b|$(git rev-parse --short HEAD)|$(IFS=';'; echo "${notes[*]}")")
  else
    summary+=("$b|$(git rev-parse --short HEAD)|clean")
  fi
done

# Lanes add packages to the lockfile only: the checks need them installed.
# "Installed" = node_modules was (re)installed after the last commit on this
# branch that changed package.json / package-lock.json (npm rewrites
# node_modules/.package-lock.json on every install). This holds across runs:
# a run resumed after a conflict still sees a dependency change merged by
# the earlier one.
# A newer install is not enough: it may have been made on another branch,
# from another lockfile. So the installed tree (npm's hidden lockfile) must
# also be the one this package-lock.json describes: every package it needs
# at its version, and nothing it does not know (optional ones may be absent).
mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
LOCK_MATCHES='
const fs = require("fs");
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8")).packages || {};
let lock, have;
try { lock = read("package-lock.json"); have = read("node_modules/.package-lock.json"); } catch { process.exit(1); }
const deps = (o) => Object.entries(o).filter(([p, e]) => p.startsWith("node_modules/") && !e.link);
for (const [p, e] of deps(lock)) {
  if (e.optional || e.devOptional) { if (have[p] && have[p].version !== e.version) process.exit(1); continue; }
  if (!have[p] || have[p].version !== e.version) process.exit(1);
}
for (const [p] of deps(have)) if (!(p in lock)) process.exit(1);
'
stale_reason=""
deps_stale() {
  [ -f package-lock.json ] || [ -f package.json ] || return 1
  local changed installed
  changed=$(git log -1 --first-parent --format=%ct HEAD -- package.json package-lock.json)
  [ -n "$changed" ] || return 1
  installed=$(mtime node_modules/.package-lock.json)
  if [ -z "$installed" ] || [ "$changed" -gt "$installed" ]; then
    stale_reason="dependencies (package.json / package-lock.json) changed on $target after node_modules was last installed"
    return 0
  fi
  [ -f package-lock.json ] || return 1
  if ! node -e "$LOCK_MATCHES" >/dev/null 2>&1; then
    stale_reason="node_modules was installed from a different lockfile than $target's package-lock.json (another branch's?)"
    return 0
  fi
  return 1
}
if deps_stale; then
  if [ "${LANE_INSTALL:-}" = 1 ]; then
    echo "== $stale_reason: npm install (LANE_INSTALL=1)"
    npm install --no-audit --no-fund >/dev/null 2>&1 || die "npm install failed; fix it, then rerun this command (merged branches are skipped)"
  else
    print_merges
    echo >&2
    echo "lane-merge: STOP before the checks — $stale_reason. Run npm install (or rerun with LANE_INSTALL=1), then rerun this same command: merged branches are skipped and the checks run." >&2
    exit 2
  fi
fi

echo "== checks on $target @ $(git rev-parse --short HEAD)"
ok=1
log=$(mktemp)

if npx tsc --noEmit -p . >"$log" 2>&1; then
  tsc_result="clean"
else
  ok=0
  tsc_result="$(grep -c 'error TS' "$log" || true) error(s)"
  grep 'error TS' "$log" | head -10 | sed 's/^/    /'
fi

if node scripts/extract-i18n-keys.mjs --check >"$log" 2>&1; then
  i18n_result="up to date"
else
  ok=0
  i18n_result="stale — run npm run i18n:extract and commit"
fi

if [ "${LANE_SKIP_TESTS:-}" = 1 ]; then
  vitest_result="skipped (LANE_SKIP_TESTS=1)"
elif npx vitest run >"$log" 2>&1; then
  vitest_result="green — $(grep -E '^\s*Tests\s' "$log" | tail -1 | sed -E 's/^\s*Tests\s+//')"
else
  ok=0
  vitest_result="FAILED — $(grep -E '^\s*Tests\s' "$log" | tail -1 | sed -E 's/^\s*Tests\s+//')"
  grep -E '^\s*(FAIL|×)\s' "$log" | head -15 | sed 's/^/    /'
fi
rm -f "$log"

print_merges
echo
echo "tsc:     $tsc_result"
echo "i18n:    $i18n_result"
echo "vitest:  $vitest_result"
[ $ok = 1 ] && echo "result:  ready" || echo "result:  NOT ready — fix the failures above before pushing $target"
[ $ok = 1 ]

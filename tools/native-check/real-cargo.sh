#!/bin/bash
# The real cargo, without crate downloads (plan W4.23 follow-up, W6.24).
#   real-cargo.sh <path/to/src-tauri> <crates.io index checkout>
# The index is a git clone of github.com/rust-lang/crates.io-index (≈8 GB checked
# out; `git clone --depth 1`). Cargo reads it as a local registry, so the REAL
# manifest parser, resolver, feature check and `--locked` rule run; only crate
# sources are missing. Checks:
#   1. cargo check --locked --offline: "ok" only when it compiles; stopping at the
#      first crate download is UNKNOWN (exit 3), not a pass;
#   2. every path crate without dependencies is compiled and tested by cargo.
# Never writes Cargo.lock (it runs on a copy).
set -u
T=$(cd "$1" && pwd); INDEX=$(cd "$2" && pwd)
[ -f "$INDEX/config.json" ] || { echo "FAIL $INDEX is not a crates.io index checkout"; exit 2; }
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
mkdir -p "$W/home" "$W/reg"; ln -s "$INDEX" "$W/reg/index"
printf '[source.crates-io]\nreplace-with = "index"\n[source.index]\nlocal-registry = "%s"\n' "$W/reg" > "$W/home/config.toml"
cp -r "$T" "$W/src" && rm -rf "$W/src/target"
export CARGO_HOME=$W/home CARGO_TARGET_DIR=$W/target
# Exit codes: 0 every check passed; 1 a check failed; 3 nothing failed, but a
# check could not finish (cargo stopped at a crate download), so the result is
# unknown. A download stop is never reported as "ok" (plan W10.B15, audit W4.23).
status=0; unknown=0
echo "## real cargo against the crates.io index ($(git -C "$INDEX" log -1 --format='%h %cs' 2>/dev/null))"
out=$(cd "$W/src" && cargo check --locked --offline 2>&1); rc=$?
first=$(printf '%s\n' "$out" | grep -m1 -E '^error')
if [ $rc -eq 0 ]; then
  echo "ok   cargo check --locked: compiled"
elif printf '%s' "$first" | grep -q 'failed to download'; then
  echo "UNKNOWN cargo check --locked: the manifest, resolver and Cargo.lock got as far as the first crate download, which failed (${first#error: }); nothing was compiled, so pass or fail is not known"
  unknown=1
else
  echo "FAIL cargo check --locked"; printf '%s\n' "$out" | head -20 | sed 's/^/     /'; status=1
fi
for m in "$W"/src/*/Cargo.toml; do
  [ -f "$m" ] || continue
  d=$(dirname "$m")
  # a path crate whose [dependencies] (all targets) is empty
  if ! sed -n '/^\[\(target\..*\.\)\?dependencies\]/,/^\[/p' "$m" | grep -qE '^[A-Za-z0-9_-]+ *='; then
    name=$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$m" | head -1)
    res=$(cd "$d" && cargo test --offline 2>&1 | grep -E '^test result' | head -1)
    if printf '%s' "$res" | grep -q '^test result: ok'; then echo "ok   cargo test $name: ${res#test result: }"
    else echo "FAIL cargo test $name"; (cd "$d" && cargo test --offline 2>&1 | tail -20 | sed 's/^/     /'); status=1; fi
  fi
done
[ $status -ne 0 ] && exit $status
[ $unknown -ne 0 ] && { echo "result: UNKNOWN (exit 3): a check stopped before it compiled anything"; exit 3; }
exit 0

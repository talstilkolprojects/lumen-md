#!/bin/bash
# The real cargo, without crate downloads (plan W4.23 follow-up, W6.24).
#   real-cargo.sh <path/to/src-tauri> <crates.io index checkout>
# The index is a git clone of github.com/rust-lang/crates.io-index (≈8 GB checked
# out; `git clone --depth 1`). Cargo reads it as a local registry, so the REAL
# manifest parser, resolver, feature check and `--locked` rule run; only crate
# sources are missing. Checks:
#   1. cargo check --locked --offline gets past the manifest, the resolver and the
#      lock, and stops only at the first crate download;
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
status=0
echo "## real cargo against the crates.io index ($(git -C "$INDEX" log -1 --format='%h %cs' 2>/dev/null))"
out=$(cd "$W/src" && cargo check --locked --offline 2>&1); first=$(printf '%s\n' "$out" | grep -m1 -E '^error')
if printf '%s' "$first" | grep -q 'failed to download'; then
  echo "ok   cargo check --locked: manifest, resolver and Cargo.lock accepted (stops at: ${first#error: })"
else
  echo "FAIL cargo check --locked"; printf '%s\n' "$out" | head -20 | sed 's/^/     /'; status=1
fi
for m in "$W"/src/*/Cargo.toml; do
  d=$(dirname "$m")
  # a path crate whose [dependencies] (all targets) is empty
  if ! sed -n '/^\[\(target\..*\.\)\?dependencies\]/,/^\[/p' "$m" | grep -qE '^[A-Za-z0-9_-]+ *='; then
    name=$(sed -n 's/^name *= *"\(.*\)"/\1/p' "$m" | head -1)
    res=$(cd "$d" && cargo test --offline 2>&1 | grep -E '^test result' | head -1)
    if printf '%s' "$res" | grep -q '^test result: ok'; then echo "ok   cargo test $name: ${res#test result: }"
    else echo "FAIL cargo test $name"; (cd "$d" && cargo test --offline 2>&1 | tail -20 | sed 's/^/     /'); status=1; fi
  fi
done
exit $status

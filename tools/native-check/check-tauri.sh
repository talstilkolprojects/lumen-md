#!/bin/bash
# Type-check a src-tauri tree offline (plan W4.23).
#   check.sh <path/to/src-tauri> [desktop|mobile|both]
# Path crates (vault, desktop, keychain) are compiled for real, and their
# std-only tests run; src/lib.rs + src/main.rs are checked with rustc against
# the stub tauri/serde/plugin crates in ./rust-stubs (signatures of tauri 2.x and
# the plugins at the versions in Cargo.lock). Exit != 0 on any error.
set -u
D=$(cd "$(dirname "$0")" && pwd)
T=$(cd "$1" && pwd); MODE=${2:-both}
if grep -qE '^tauri = .*"tray-icon"' "$T/Cargo.toml"; then STUB=${NATIVE_STUBS:-$D}/out-tray; FEAT=tray-icon; else STUB=${NATIVE_STUBS:-$D}/out; FEAT=none; fi
W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
CFGS=(--check-cfg 'cfg(desktop)' --check-cfg 'cfg(mobile)' --check-cfg 'cfg(test)' --check-cfg 'cfg(feature, values(any()))')
rc() { rustc --edition 2021 -C debug-assertions -L "$STUB" -L "$W" --out-dir "$W" "${CFGS[@]}" "$@"; }
status=0
echo "## $T  (tauri features: $FEAT)"
EXTERNS=(--extern tauri --extern serde --extern serde_json)
for dep in $(sed -n '/^\[dependencies\]/,/^\[/p;/^\[target/,/^\[/p' "$T/Cargo.toml" | grep -oE '^[a-z0-9_-]+ *=' | tr -d ' =' | sort -u); do
  case $dep in
    tauri|serde|serde_json) ;;
    tauri-plugin-*) EXTERNS+=(--extern "${dep//-/_}") ;;
    keyring) ;;  # macOS/Windows only; not checked on Linux
    *)
      path=$(grep -E "^$dep *=" "$T/Cargo.toml" | grep -oE 'path *= *"[^"]+"' | sed -E 's/.*"(.+)"/\1/')
      if [ -n "$path" ]; then
        crate=${dep//-/_}
        lib=$T/$path/src/lib.rs
        ext=(); grep -q '^serde' "$T/$path/Cargo.toml" && ext+=(--extern serde)
        if rc --crate-type rlib --crate-name "$crate" "${ext[@]}" "$lib" 2>"$W/$crate.err"; then
          echo "ok   path crate $crate ($path)"
        else
          echo "FAIL path crate $crate ($path)"; cat "$W/$crate.err"; status=1
        fi
        EXTERNS+=(--extern "$crate")
      else
        echo "note: dependency $dep has no stub (add one under stubs/)"; status=1
      fi
      ;;
  esac
done
run_pass() { # $1 = desktop|mobile
  local cfg=$1
  if rc --crate-type rlib --crate-name lumen_lib --cfg "$cfg" "${EXTERNS[@]}" "$T/src/lib.rs" 2>"$W/lib-$cfg.err"; then
    echo "ok   src/lib.rs (--cfg $cfg, target linux)"; grep -E '^warning' "$W/lib-$cfg.err" | sort | uniq -c | sed 's/^/     /'
  else
    echo "FAIL src/lib.rs (--cfg $cfg)"; grep -vE '^\s*$' "$W/lib-$cfg.err" | head -150; status=1; return
  fi
  if rc --crate-type bin --crate-name lumen --cfg "$cfg" --extern lumen_lib "${EXTERNS[@]}" "$T/src/main.rs" --emit=metadata 2>"$W/main-$cfg.err"; then
    echo "ok   src/main.rs (--cfg $cfg)"
  else
    echo "FAIL src/main.rs (--cfg $cfg)"; head -60 "$W/main-$cfg.err"; status=1
  fi
  if rc --test --crate-name lumen_lib_tests --cfg "$cfg" "${EXTERNS[@]}" "$T/src/lib.rs" --emit=metadata 2>"$W/test-$cfg.err"; then
    echo "ok   src/lib.rs #[cfg(test)] code type-checks (--cfg $cfg)"
  else
    echo "FAIL src/lib.rs tests (--cfg $cfg)"; head -60 "$W/test-$cfg.err"; status=1
  fi
}
case $MODE in desktop) run_pass desktop ;; mobile) run_pass mobile ;; *) run_pass desktop; run_pass mobile ;; esac
node -e 'JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"))' "$T/tauri.conf.json" && echo "ok   tauri.conf.json parses" || { echo "FAIL tauri.conf.json"; status=1; }
node "$D/lockcheck.mjs" "$T" || status=1
exit $status

#!/bin/bash
# Plan W4.23: compile Lumen's native code offline — no crates.io, Android SDK,
# Gradle repositories or Xcode needed.
#
#   bash tools/native-check/run.sh            # this checkout
#   bash tools/native-check/run.sh <repo>     # another checkout or worktree
#
# 1. The std-only Rust crates (src-tauri/desktop, keychain, vault, whisper_core)
#    are compiled and their tests run (rustc --test).
# 2. src-tauri/src (lib.rs, main.rs and modules) is type-checked by rustc against
#    stub crates (rust-stubs/) that copy the signatures of tauri 2 and the
#    plugins Lumen uses; `#[tauri::command]` enforces argument, return-value
#    and Send rules as the real macro does. Cargo.lock is checked against
#    Cargo.toml (what `cargo check --locked` refuses), and Cargo.toml for
#    duplicate keys and tables (cargo refuses the manifest).
# 2b. With NATIVE_CHECK_INDEX=<clone of rust-lang/crates.io-index>: the real
#    cargo resolves against it (real-cargo.sh) and tests dependency-free crates.
# 3. android/app/src/main/java and mobile/android are compiled with javac
#    -Xlint:all -Werror against stub android/Capacitor classes (java-stubs/)
#    and an R class generated from res/; every @resource reference is checked.
# 4. Swift files are listed: they need Xcode (owner step, see the docs page
#    contributing/native-check).
# Stubs are signatures only: a real `cargo check` / `tauri build`, Gradle and
# Xcode build remain the final word (they need the network or a Mac).
set -u
D=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "${1:-$D/../..}" && pwd)
CACHE=$(mktemp -d); trap 'rm -rf "$CACHE"' EXIT
export NATIVE_STUBS=$CACHE
status=0
command -v rustc >/dev/null || { echo "rustc not found (install Rust: https://rustup.rs)"; exit 2; }
echo "# Native code check (plan W4.23) — $(rustc --version), $(javac -version 2>&1 | grep -v JAVA_TOOL)"
OUT=$CACHE/out "$D/build-rust-stubs.sh" >/dev/null || { echo "FAIL building the stub crates"; exit 2; }
FEATURES=tray-icon OUT=$CACHE/out-tray "$D/build-rust-stubs.sh" >/dev/null || { echo "FAIL building the stub crates"; exit 2; }

echo; echo "## 1. std-only Rust crates: compile + tests"
t() { # name, file, extra rustc args
  local name=$1 file=$2; shift 2
  [ -f "$REPO/$file" ] || return 0
  if rustc --edition 2021 --test -o "$CACHE/t-$name" "$@" "$REPO/$file" 2>"$CACHE/t-$name.err"; then
    local res; res=$("$CACHE/t-$name" 2>&1 | grep -E '^test result')
    echo "ok   $file: ${res#test result: }"; echo "$res" | grep -q '^test result: ok' || status=1
  else
    echo "FAIL $file"; cat "$CACHE/t-$name.err"; status=1
  fi
}
t desktop src-tauri/desktop/src/lib.rs
t keychain src-tauri/keychain/src/lib.rs
t vault src-tauri/vault/src/lib.rs -L "$CACHE/out" --extern serde
t whisper src-tauri/src/whisper_core.rs

echo; echo "## 2. src-tauri against tauri 2 signatures"
"$D/check-tauri.sh" "$REPO/src-tauri" 2>&1 | grep -vE 'never (read|used)|warnings emitted' || status=1
[ "${PIPESTATUS[0]}" = 0 ] || status=1

echo; echo "## 2b. Real cargo (manifest, resolver, --locked; no crate downloads)"
if [ -n "${NATIVE_CHECK_INDEX:-}" ]; then
  "$D/real-cargo.sh" "$REPO/src-tauri" "$NATIVE_CHECK_INDEX" || status=1
else
  echo "—    skipped: set NATIVE_CHECK_INDEX to a clone of github.com/rust-lang/crates.io-index"
fi

echo; echo "## 3. Android (javac + resources)"
if [ -d "$REPO/android/app/src/main/java" ]; then
  "$D/check-android.sh" "$REPO" 2>&1 | grep -v JAVA_TOOL_OPTIONS; [ "${PIPESTATUS[0]}" = 0 ] || status=1
else
  echo "—    no android/ project on this branch"
fi

echo; echo "## 4. Not compiled here (need Xcode on a Mac)"
(cd "$REPO" && git ls-files '*.swift' | sed 's/^/     /')
echo; [ $status = 0 ] && echo "native check: PASS" || echo "native check: FAIL"
exit $status

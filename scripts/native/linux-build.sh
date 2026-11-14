#!/usr/bin/env bash
# Plan W6.24: the real native builds on a Linux host — the second host of the
# verification factory (#509, Oracle Ampere arm64) or any Ubuntu 24.04 machine
# or container with crates.io, npm and Google Maven reachable.
#
#   bash scripts/native/linux-build.sh --install     # once: apt packages, rustup, JDK, Android SDK
#   bash scripts/native/linux-build.sh               # cargo check --locked, tauri build, Gradle assemble
#   bash scripts/native/linux-build.sh --dry-run     # print every command, change nothing
#
# Options:
#   --install          install what is missing first (needs sudo for apt)
#   --updater-bump     also try `cargo update -p tauri-plugin-updater --precise 2.14.1`
#                      (zip 4.6.1 → 9, security/known-bad.json); kept only if
#                      `cargo check --locked` still passes, otherwise Cargo.lock is restored
#   --skip-tauri-build only cargo check (fast)
#   --skip-android     no Gradle step
#   --bundles LIST     tauri bundles (default: deb,rpm,appimage)
#
# Every step prints PASS or FAIL and its time; the summary goes to
# reports/native/<commit>.txt (gitignored under /reports/). Exit 1 if a step failed.
#
# Android: Google ships no Android SDK build tools (aapt2) for Linux on ARM
# ("Linux machines with ARM-based CPUs aren't currently supported",
# developer.android.com/studio/install, checked 14.11.2026), so on aarch64 the
# Gradle step is skipped and named; run it on an x86-64 host, on the Mac, or on
# Codemagic (codemagic.yaml → android-aab / mobile-release).
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
cd "$ROOT"
INSTALL=0 DRY=0 BUMP=0 TAURI_BUILD=1 ANDROID=1 BUNDLES=deb,rpm,appimage
while [ $# -gt 0 ]; do
  case "$1" in
    --install) INSTALL=1 ;;
    --dry-run) DRY=1 ;;
    --updater-bump) BUMP=1 ;;
    --skip-tauri-build) TAURI_BUILD=0 ;;
    --skip-android) ANDROID=0 ;;
    --bundles) BUNDLES=${2:?--bundles needs a list}; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

ARCH=$(uname -m)
SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
REPORT_DIR=$ROOT/reports/native
REPORT=$REPORT_DIR/$SHA.txt
ANDROID_SDK=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}
# The Android SDK packages for android/variables.gradle (compileSdk 36).
COMPILE_SDK=$(sed -n 's/^ *compileSdkVersion *= *\([0-9]*\).*/\1/p' android/variables.gradle 2>/dev/null)
COMPILE_SDK=${COMPILE_SDK:-36}
# Android command-line tools (developer.android.com/studio/install → "Command line tools only", 14.11.2026).
CMDLINE_TOOLS_ZIP=commandlinetools-linux-15859902_latest.zip
status=0
summary=()

run() { # print, then run unless --dry-run
  printf '$ %s\n' "$*"
  [ "$DRY" = 1 ] && return 0
  "$@"
}

step() { # name, command...
  local name=$1; shift
  echo; echo "== $name"
  local t0=$SECONDS
  if [ "$DRY" = 1 ]; then
    run "$@"; summary+=("DRY   $name"); return 0
  fi
  if run "$@"; then
    summary+=("PASS  $name ($((SECONDS - t0)) s)")
  else
    summary+=("FAIL  $name ($((SECONDS - t0)) s)"); status=1
  fi
}

skip() { summary+=("SKIP  $1 — $2"); echo; echo "== $1: skipped — $2"; }

have() { command -v "$1" >/dev/null 2>&1; }

install_all() {
  echo "== install (arch $ARCH)"
  # tauri: v2.tauri.app/start/prerequisites (Debian/Ubuntu), plus rpm for the .rpm bundle.
  run sudo apt-get update
  run sudo apt-get install -y --no-install-recommends \
    libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev \
    libayatana-appindicator3-dev librsvg2-dev pkg-config git unzip rpm openjdk-21-jdk-headless
  if ! have cargo; then
    run sh -c "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal"
    # shellcheck disable=SC1091
    [ "$DRY" = 1 ] || . "$HOME/.cargo/env"
  fi
  if ! have node || ! node -v | grep -qE '^v(2[2-9]|[3-9][0-9])\.'; then
    run sh -c "curl -fsSL https://deb.nodesource.com/setup_22.x | sudo bash - && sudo apt-get install -y nodejs"
  fi
  if [ "$ANDROID" = 1 ] && [ "$ARCH" = x86_64 ] && [ ! -x "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
    run mkdir -p "$ANDROID_SDK/cmdline-tools"
    run curl -fsSLo "/tmp/$CMDLINE_TOOLS_ZIP" "https://dl.google.com/android/repository/$CMDLINE_TOOLS_ZIP"
    run unzip -q -o "/tmp/$CMDLINE_TOOLS_ZIP" -d "$ANDROID_SDK/cmdline-tools"
    run rm -rf "$ANDROID_SDK/cmdline-tools/latest"
    run mv "$ANDROID_SDK/cmdline-tools/cmdline-tools" "$ANDROID_SDK/cmdline-tools/latest"
  fi
  if [ "$ANDROID" = 1 ] && [ "$ARCH" = x86_64 ]; then
    run sh -c "yes | '$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager' --licenses >/dev/null"
    run "$ANDROID_SDK/cmdline-tools/latest/bin/sdkmanager" "platform-tools" "platforms;android-$COMPILE_SDK" "build-tools;$COMPILE_SDK.0.0"
  fi
}

[ "$INSTALL" = 1 ] && install_all
# shellcheck disable=SC1091
[ -f "$HOME/.cargo/env" ] && . "$HOME/.cargo/env"

echo "# Native builds (plan W6.24) — $SHA on $(uname -sm)"
missing=()
for t in cargo rustc node npm git; do have "$t" || missing+=("$t"); done
pkg-config --exists webkit2gtk-4.1 2>/dev/null || missing+=("libwebkit2gtk-4.1-dev")
if [ ${#missing[@]} -gt 0 ] && [ "$DRY" = 0 ]; then
  echo "missing: ${missing[*]} — run: bash scripts/native/linux-build.sh --install"; exit 2
fi
[ "$DRY" = 0 ] && { cargo --version; node -v; }

# 1. The web build: tauri::generate_context!() embeds ../dist (frontendDist), so
#    cargo check fails without it; Capacitor copies the same dist/.
[ -d node_modules ] || step "npm ci" npm ci
step "web build (npm run build → dist/)" npm run build

# 2. cargo check --locked: the lock must already match Cargo.toml (no silent update).
step "cargo check --locked (src-tauri, all targets)" cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml
step "cargo test --locked (desktop, vault, keychain crates)" cargo test --locked --manifest-path src-tauri/Cargo.toml -p lumen-desktop -p lumen-vault -p lumen-keychain

# 3. Optional: the updater bump the security list asks for (zip 4.6.1 → 9).
if [ "$BUMP" = 1 ]; then
  echo; echo "== cargo update -p tauri-plugin-updater --precise 2.14.1"
  if [ "$DRY" = 1 ]; then
    run cargo update --manifest-path src-tauri/Cargo.toml -p tauri-plugin-updater --precise 2.14.1
    run cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml
  else
    cp src-tauri/Cargo.lock "$ROOT/src-tauri/Cargo.lock.before-bump"
    if cargo update --manifest-path src-tauri/Cargo.toml -p tauri-plugin-updater --precise 2.14.1 \
      && cargo check --locked --all-targets --manifest-path src-tauri/Cargo.toml \
      && cargo tree --manifest-path src-tauri/Cargo.toml -i zip --depth 1; then
      rm -f src-tauri/Cargo.lock.before-bump
      summary+=("PASS  updater bump: tauri-plugin-updater 2.14.1, zip 9 — commit src-tauri/Cargo.lock")
    else
      mv src-tauri/Cargo.lock.before-bump src-tauri/Cargo.lock
      summary+=("FAIL  updater bump: did not compile, Cargo.lock restored"); status=1
    fi
  fi
fi

# 4. tauri build for Linux (no updater artifacts: createUpdaterArtifacts is false,
#    so no signing key is needed here; the release signs in 11.5).
if [ "$TAURI_BUILD" = 1 ]; then
  step "tauri build ($BUNDLES)" npx tauri build --ci --bundles "$BUNDLES"
  [ "$DRY" = 1 ] || ls -la src-tauri/target/release/bundle/*/ 2>/dev/null
else
  skip "tauri build" "--skip-tauri-build"
fi

# 5. Android: Capacitor sync and the Gradle assemble (debug APK + its Espresso test APK;
#    a signed AAB when the four ANDROID_* variables of plan 15.7 are set).
if [ "$ANDROID" = 0 ]; then
  skip "Android Gradle assemble" "--skip-android"
elif [ "$ARCH" != x86_64 ]; then
  skip "Android Gradle assemble" "no Android SDK build tools for Linux on $ARCH; run it on x86-64, the Mac or Codemagic"
else
  export ANDROID_HOME=$ANDROID_SDK
  step "npx cap sync android" npx cap sync android
  step "Gradle assembleDebug assembleDebugAndroidTest" sh -c "cd android && ./gradlew --no-daemon assembleDebug assembleDebugAndroidTest"
  if [ -n "${ANDROID_KEYSTORE_PATH:-}" ]; then
    step "signed AAB + APK (npm run mobile:android)" npm run mobile:android -- --skip-web
  else
    skip "signed AAB" "ANDROID_KEYSTORE_PATH not set (the upload key of plan 15.7)"
  fi
fi

echo; echo "== summary ($SHA)"
printf '%s\n' "${summary[@]}"
if [ "$DRY" = 0 ]; then
  mkdir -p "$REPORT_DIR"
  { echo "commit $SHA"; echo "host $(uname -sm) $(date -u +%FT%TZ)"; printf '%s\n' "${summary[@]}"; } > "$REPORT"
  echo "report: ${REPORT#"$ROOT"/}"
fi
exit $status

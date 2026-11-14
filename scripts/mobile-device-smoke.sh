#!/usr/bin/env bash
# Plan W6.24: a phone-free smoke run of the Android debug APK on real cloud devices.
#
#   bash scripts/mobile-device-smoke.sh testlab [APK] [--physical]
#       Firebase Test Lab robo (mobile/testlab/robo.yaml): crawls the app on two
#       virtual devices (Hebrew and English), or one physical with --physical.
#       Needs: gcloud, FIREBASE_PROJECT, and either an active gcloud login or
#       GCLOUD_KEY_FILE (the service account's JSON text, role Firebase Test Lab Admin).
#   bash scripts/mobile-device-smoke.sh browserstack [APK] [TEST_APK]
#       BrowserStack App Automate (the fallback: Test Lab shuts down on 30.9.2027):
#       runs the Espresso launch test (android/app/src/androidTest/.../LaunchSmokeTest)
#       on BROWSERSTACK_DEVICES (default: two Android phones from the live device list).
#       Needs: BROWSERSTACK_USERNAME, BROWSERSTACK_ACCESS_KEY.
#   --dry-run   print the commands, run nothing
#
# APK defaults to the newest release/mobile/lumen-*-debug.apk (npm run mobile:android
# -- --unsigned); TEST_APK to Gradle's app-debug-androidTest.apk (assembleDebugAndroidTest).
# Secrets are read from the environment only and never put on a command line: the
# gcloud key goes to a 0600 temp file, the BrowserStack key to a 0600 netrc file.
# Exit 0 = every device passed (robo: no crash); anything else is a failure.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
cd "$ROOT"
MODE=${1:-}; [ $# -gt 0 ] && shift
DRY=0 PHYSICAL=0 POS=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1 ;;
    --physical) PHYSICAL=1 ;;
    *) POS+=("$a") ;;
  esac
done
TMP=$(mktemp -d); chmod 700 "$TMP"; trap 'rm -rf "$TMP"' EXIT

newest_debug_apk() { ls -t release/mobile/lumen-*-debug.apk 2>/dev/null | head -1 || true; }
APK=${POS[0]:-$(newest_debug_apk)}
need_file() { [ "$DRY" = 1 ] || [ -f "$1" ] || { echo "no $2 at '${1:-?}' — $3" >&2; exit 2; }; }
need_env() { [ "$DRY" = 1 ] || [ -n "${!1:-}" ] || { echo "$1 is not set — $2" >&2; exit 2; }; }

testlab() {
  need_file "$APK" "debug APK" "build it: npm run mobile:android -- --unsigned"
  need_env FIREBASE_PROJECT "the Firebase project id (console.firebase.google.com → Project settings)"
  command -v gcloud >/dev/null || [ "$DRY" = 1 ] || { echo "gcloud not found — cloud.google.com/sdk/docs/install" >&2; exit 2; }
  if [ -n "${GCLOUD_KEY_FILE:-}" ]; then
    (umask 077; printf '%s' "$GCLOUD_KEY_FILE" > "$TMP/key.json")
    echo "\$ gcloud auth activate-service-account --key-file=<temp 0600>"
    [ "$DRY" = 1 ] || gcloud auth activate-service-account --quiet --key-file="$TMP/key.json"
  fi
  local group=robo; [ "$PHYSICAL" = 1 ] && group=robo-physical
  local cmd=(gcloud firebase test android run "mobile/testlab/robo.yaml:$group" --app "$APK" --project "${FIREBASE_PROJECT:-<FIREBASE_PROJECT>}" --format=json)
  echo "\$ ${cmd[*]}"
  [ "$DRY" = 1 ] && return 0
  local code=0
  "${cmd[@]}" > "$TMP/outcomes.json" || code=$?
  cat "$TMP/outcomes.json"
  case $code in
    0) echo "robo: every device passed, 0 crashes" ;;
    10) echo "robo: FAILED — a crash or a failed start on at least one device (see the results link above)" ;;
    15|20) echo "robo: Test Lab could not finish (infrastructure, exit $code) — run again" ;;
    18) echo "robo: a device in mobile/testlab/robo.yaml is not offered any more — pick another from 'gcloud firebase test android models list'" ;;
    *) echo "robo: gcloud failed (exit $code)" ;;
  esac
  return $code
}

bs_api() { # method path [curl args...] — the key stays in a 0600 netrc file
  local method=$1 p=$2; shift 2
  curl -fsS --netrc-file "$TMP/netrc" -X "$method" "https://api-cloud.browserstack.com$p" "$@"
}

browserstack() {
  local test_apk=${POS[1]:-android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk}
  need_file "$APK" "debug APK" "build it: npm run mobile:android -- --unsigned"
  need_file "$test_apk" "Espresso test APK" "build it: (cd android && ./gradlew assembleDebugAndroidTest)"
  need_env BROWSERSTACK_USERNAME "BrowserStack → Account → Access keys"
  need_env BROWSERSTACK_ACCESS_KEY "BrowserStack → Account → Access keys"
  echo "\$ POST /app-automate/espresso/v2/app (file=$APK)"
  echo "\$ POST /app-automate/espresso/v2/test-suite (file=$test_apk)"
  echo "\$ POST /app-automate/espresso/v2/build {app, testSuite, devices, project: lumen-md}"
  echo "\$ GET  /app-automate/espresso/v2/builds/<build_id> until it is no longer running"
  [ "$DRY" = 1 ] && return 0
  (umask 077; printf 'machine api-cloud.browserstack.com login %s password %s\n' "$BROWSERSTACK_USERNAME" "$BROWSERSTACK_ACCESS_KEY" > "$TMP/netrc")
  local js='const j=JSON.parse(require("fs").readFileSync(0,"utf8"));'
  local app suite devices body build
  app=$(bs_api POST /app-automate/espresso/v2/app -F "file=@$APK" | node -e "${js}process.stdout.write(j.app_url)")
  suite=$(bs_api POST /app-automate/espresso/v2/test-suite -F "file=@$test_apk" | node -e "${js}process.stdout.write(j.test_suite_url)")
  if [ -n "${BROWSERSTACK_DEVICES:-}" ]; then
    devices=$BROWSERSTACK_DEVICES
  else # two real Android phones, newest OS first, from the live list
    devices=$(bs_api GET /app-automate/devices.json | node -e "${js}const a=j.filter(d=>d.os==='android'&&d.realMobile!==false).sort((x,y)=>parseFloat(y.os_version)-parseFloat(x.os_version));const seen=new Set();const out=[];for(const d of a){const k=d.device.split(' ')[0];if(seen.has(k))continue;seen.add(k);out.push(d.device+'-'+d.os_version);if(out.length===2)break}process.stdout.write(out.join(','))")
  fi
  echo "devices: $devices"
  body=$(APP="$app" SUITE="$suite" DEVICES="$devices" node -e 'process.stdout.write(JSON.stringify({app:process.env.APP,testSuite:process.env.SUITE,devices:process.env.DEVICES.split(",").map(s=>s.trim()).filter(Boolean),project:"lumen-md",deviceLogs:true}))')
  build=$(bs_api POST /app-automate/espresso/v2/build -H "Content-Type: application/json" -d "$body" | node -e "${js}process.stdout.write(j.build_id)")
  echo "build: $build (app-automate.browserstack.com)"
  local state deadline=$((SECONDS + 1800))
  while :; do
    state=$(bs_api GET "/app-automate/espresso/v2/builds/$build" | tee "$TMP/build.json" | node -e "${js}process.stdout.write(String(j.status))")
    case "$state" in
      running|queued|"") ;;
      *) break ;;
    esac
    [ $SECONDS -lt $deadline ] || { echo "browserstack: still '$state' after 30 min" >&2; return 1; }
    sleep 20
  done
  cat "$TMP/build.json"; echo
  if [ "$state" = passed ]; then echo "browserstack: every device passed"; return 0; fi
  echo "browserstack: FAILED (status $state)"; return 1
}

case "$MODE" in
  testlab) testlab ;;
  browserstack) browserstack ;;
  *) sed -n '2,22p' "$0"; exit 2 ;;
esac

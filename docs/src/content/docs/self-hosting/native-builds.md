---
title: Native builds on free hosts
description: How the desktop app, the Android AAB and the iOS IPA are really compiled without GitHub Actions — a Linux script for the second host, Codemagic's free macOS minutes, and a robo run on Firebase Test Lab or BrowserStack.
---

Plan W6.24. The native code (Rust in `src-tauri/`, Java in `android/`, Swift in
`ios/`) is compiled by its own toolchains — `cargo`, Gradle and Xcode — on
hosts that cost nothing. Nothing runs on a push: every build is started by hand.

## Desktop on Linux: `scripts/native/linux-build.sh`

On Ubuntu 24.04 (the verification factory's second host, a VM or a container):

```bash
bash scripts/native/linux-build.sh --install   # once: WebKitGTK headers, rustup, Node 22, JDK 21, Android SDK
bash scripts/native/linux-build.sh             # npm run build, cargo check --locked, cargo test, tauri build, Gradle
bash scripts/native/linux-build.sh --updater-bump   # also tauri-plugin-updater 2.14.1 (zip 9)
bash scripts/native/linux-build.sh --dry-run   # the commands only
```

- `cargo check --locked` refuses a `Cargo.lock` that does not match
  `Cargo.toml`; the script never updates the lock silently.
- `tauri::generate_context!()` embeds `dist/`, so the web build runs first.
- `--updater-bump` keeps the new lock only if `cargo check --locked` still passes.
- **Android needs x86-64.** Google ships no Android build tools for Linux on ARM
  ("Linux machines with ARM-based CPUs aren't currently supported",
  developer.android.com/studio/install). On the Oracle Ampere host the Gradle
  step is skipped and named; run it on x86-64, the Mac or Codemagic.
- The summary is written to `reports/native/<commit>.txt`.

## Phones and macOS: Codemagic

`codemagic.yaml` has these workflows (Codemagic → the app → Start new build):

| Workflow | What it does |
| --- | --- |
| `mobile-release` | the signed AAB and the signed IPA from **one commit**; the AAB goes to Play's internal track, the IPA to TestFlight; `BUILD-INFO.txt` and `SHA256SUMS` name the commit |
| `android-robo` | the debug APK on Firebase Test Lab robo; with `LUMEN_SMOKE=browserstack`, the Espresso launch test on BrowserStack |
| `desktop-macos` | `cargo check --locked` and `tauri build` for macOS |
| `ios-testflight`, `android-aab` | one platform each (plan W4.22) |

The free tier (codemagic.io/pricing, checked 14.11.2026): 500 macOS M2 minutes
a month, one build at a time, 120 minutes per build, one user. Keys live in
Codemagic environment groups (`lumen_ios`, `lumen_android`, `lumen_play`,
`lumen_testlab`, `lumen_browserstack`) and are named in the repository, never stored.

## A robo run without a phone

```bash
npm run mobile:android -- --unsigned
FIREBASE_PROJECT=<id> bash scripts/mobile-device-smoke.sh testlab   # 2 virtual devices, Hebrew and English
bash scripts/mobile-device-smoke.sh testlab --physical              # 1 physical device
```

The devices are in `mobile/testlab/robo.yaml`. The no-cost Spark plan allows
10 virtual and 5 physical runs a day. **Firebase Test Lab shuts down on
30 September 2027** (firebase.google.com/docs/test-lab/usage-quotas-pricing),
so the fallback is BrowserStack App Automate:

```bash
(cd android && ./gradlew assembleDebugAndroidTest)
BROWSERSTACK_USERNAME=… BROWSERSTACK_ACCESS_KEY=… bash scripts/mobile-device-smoke.sh browserstack
```

It runs `LaunchSmokeTest` (the app starts and its WebView loads to 100 %) on two
real Android phones. BrowserStack's free trial includes 100 App Automate minutes.

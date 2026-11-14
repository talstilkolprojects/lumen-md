# Releasing Lumen

This document covers building and shipping Lumen across all targets:

| Target          | Tooling                | Output                              |
| --------------- | ---------------------- | ----------------------------------- |
| **Web (PWA)**   | Vite                   | `dist/` — static files for any host |
| **macOS**       | Tauri 2 + Rust         | `Lumen.app` + `Lumen_*.dmg`         |
| **Windows**     | Tauri 2 + Rust         | `Lumen_*.msi` + `Lumen_*.exe`       |
| **Linux**       | Tauri 2 + Rust         | `.deb`, `.rpm`, `.AppImage`         |
| **iOS**         | Capacitor 8 + Xcode    | `Lumen.ipa` (TestFlight / App Store)|
| **Android**     | Capacitor 8 + Gradle   | `Lumen.aab` (Play Store)            |

> Web and macOS builds are reproducible from CI. iOS / Android still need
> a developer account (Apple, Google) for signing + store submission, so
> the final upload is a local Xcode / Android Studio step.

---

## Versioning

Bump the version in three places, in lock-step:

1. `package.json` → `"version"`
2. `src-tauri/tauri.conf.json` → `"version"` and `src-tauri/Cargo.toml`
3. iOS Xcode project (`MARKETING_VERSION` in `ios/App/App.xcodeproj/project.pbxproj`)
4. Android Gradle (`android/app/build.gradle` → `versionName` / `versionCode`)

Use [semver](https://semver.org/): `MAJOR.MINOR.PATCH` for the marketing
string, monotonically increasing integer for App Store / Play Store
internal codes.

---

## 1. Web build (PWA)

```bash
npm install
npm run typecheck && npm run test
npm run build              # → dist/
npm run budget             # fail-fast on bundle bloat
npm run preview            # smoke-test locally
```

Deploy `dist/` to anything static — Cloudflare Pages, Netlify, Vercel,
GitHub Pages, your own nginx. The service worker auto-updates clients on
the next visit.

---

## 2. macOS (Tauri)

### Prerequisites

```bash
# One-time
xcode-select --install
brew install rust         # or use rustup
rustup target add aarch64-apple-darwin x86_64-apple-darwin
```

### Build

```bash
npm run tauri:build
# → src-tauri/target/release/bundle/macos/Lumen.app
# → src-tauri/target/release/bundle/dmg/Lumen_<version>_<arch>.dmg
```

The default build is an **ad-hoc signed** bundle for the Mac it was built
on. Users opening the .dmg on another Mac will hit Gatekeeper warnings
("cannot be opened because the developer cannot be verified") — they can
right-click → Open to bypass.

### Signed + notarized build (production)

For a release that runs without warnings:

```bash
# .env or shell:
export APPLE_ID="you@example.com"
export APPLE_PASSWORD="app-specific-password"   # appleid.apple.com → Sign-in & Security
export APPLE_TEAM_ID="ABCDEF1234"
export APPLE_SIGNING_IDENTITY="Developer ID Application: Your Name (ABCDEF1234)"

npm run tauri:build
```

Tauri picks the env vars up automatically and runs `codesign` +
`notarytool` against the resulting bundle. Verify:

```bash
codesign -dv --verbose=4 src-tauri/target/release/bundle/macos/Lumen.app
spctl -a -t exec -vv      src-tauri/target/release/bundle/macos/Lumen.app
```

### Universal binary (Intel + Apple Silicon)

```bash
npm run tauri:build -- --target universal-apple-darwin
```

---

## 3. iOS (Capacitor 8)

### Prerequisites

```bash
# One-time
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
xcodebuild -license accept

# Capacitor 8 uses Swift Package Manager — no CocoaPods needed.
```

### Develop (run on simulator / device)

```bash
npm run build              # produces dist/
npx cap sync ios           # copies dist/ + plugins into ios/App/App/public
npx cap open ios           # opens Xcode
```

In Xcode:
1. Pick the `App` scheme + your target device or simulator.
2. ⌘R to build & run.

### Archive for the App Store

In Xcode:
1. Select **Any iOS Device (arm64)** as the run target.
2. **Product → Archive** — produces an `.xcarchive`.
3. **Distribute App → App Store Connect → Upload**.
4. Wait for processing (~10 min), then add to TestFlight or submit for review.

### Bundle identifier + signing

- Open `ios/App/App.xcodeproj` → **Signing & Capabilities** tab.
- Set your **Team** (your Apple Developer team).
- Optionally change the **Bundle Identifier** (default `com.lumen.editor`).
- Provisioning profile is created automatically the first time.

### Permission strings shipped

`ios/App/App/Info.plist` already includes user-facing permission strings
for: photo library, camera, microphone, speech recognition, and
file-sharing. Edit there if you change the wording.

---

## 4. Android (Capacitor 8)

### Prerequisites

```bash
brew install --cask android-studio
# Set ANDROID_HOME after first launch of Android Studio + SDK Manager.
```

### Initialise

```bash
npx cap add android        # one-time
npm run build
npx cap sync android
npx cap open android       # opens Android Studio
```

### Build an `.aab` (Play Store)

In Android Studio:
1. **Build → Generate Signed Bundle / APK → Android App Bundle**.
2. Pick / create your keystore, fill alias + password.
3. **release** build variant → produces `app-release.aab`.
4. Upload to [Play Console](https://play.google.com/console).

---

## 5. CI release pipeline

`.github/workflows/release.yml` runs on tag push (`v*`) and produces:

- Web bundle as a workflow artifact + GitHub Pages deploy.
- macOS `.dmg` (Apple Silicon + Intel) attached to the GitHub Release.
- Windows `.msi` + Linux `.AppImage` attached to the same Release.
- iOS / Android archives are NOT produced by CI (signing keys live on
  developer machines) — see sections 3 and 4 above.

### Signing and updates (plan 11.5)

Every secret is optional: without it the step is skipped with a warning and
the build still succeeds (unsigned). Tal sets them up in plan 15.7.

| Secret / variable | What it does | Without it |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`) | Signs the update artifacts (`.sig`); `latest.json` is published | No auto-update |
| `vars.LUMEN_UPDATER_PUBKEY` | The public key compiled into the app | The updater is off ("not configured") |
| `vars.LUMEN_UPDATER_ENDPOINT` | Where `latest.json` lives (default: this repo's latest release) | — |
| `WINDOWS_CERTIFICATE` (base64 .pfx) + `WINDOWS_CERTIFICATE_PASSWORD` | Authenticode-signs the Windows installer | Unsigned: SmartScreen warns |
| `APPLE_CERTIFICATE`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Signs and notarises the macOS app | Ad-hoc signed, Gatekeeper warns |

Create the updater key once: `npx tauri signer generate -w ~/.tauri/lumen.key`.
The app checks for updates only when asked (*Check for updates…*), never under the
"local only" privacy policy, and every check goes in the privacy log. The
plugin refuses a download whose signature does not match, and
`requireSignedVersion` refuses a downgrade.

The build carries no source maps (`scripts/check-sourcemaps.mjs`; the startup
budget fails a build that has any). `LUMEN_SOURCEMAP=1 npm run build` makes
them for a local investigation only.

```bash
# Cut a release:
git tag v0.2.0
git push --tags
# → CI takes over, creates the GitHub Release + uploads artifacts.
```

---

## Smoke-test checklist

After every build, before publishing:

- [ ] Open the .app / .dmg / .ipa on a clean device — first-launch loads
- [ ] `⌘K` → command palette appears
- [ ] Type something → `⌘S` → file save dialog → reload → restored
- [ ] Switch to RTL locale → flip is correct
- [ ] Paste a YouTube URL → "wrap as embed" pill → renders the video
- [ ] Print preview → colors preserved (PDF export)
- [ ] Toggle theme → no flash of unstyled content
- [ ] Offline mode (DevTools → Network → Offline) → app still works

---

## Release notes

Add an entry to `CHANGELOG.md` for every version. Keep entries terse,
group under `Added` / `Changed` / `Fixed` headings, and link to PRs.

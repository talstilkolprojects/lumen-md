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

## The whole release in one command (plan W4.5)

```bash
npm run release -- 0.2.0-beta.1 --dry-run     # build, sign and check everything; publish nothing; the tree is put back
npm run release -- 0.2.0-beta.1 --publish     # the owner: commit + tag, build, sign, push, GitHub release
```

It runs, in order: a preflight that names every missing key or tool with its
fix · the version bump and the `CHANGELOG.md` section from the merged pull
requests · the updater placeholder in `src-tauri/tauri.conf.json`
(`${LUMEN_UPDATER_PUBKEY}`) filled with the key and the GitHub Releases
endpoint, and refused when empty · two web builds compared file by file
(`repro-check`) · `tauri build` with `TAURI_SIGNING_PRIVATE_KEY`, `latest.json`
with every signature checked (and a changed byte refused) · `sbom.cdx.json` ·
Hebrew + English notes from `release-notes/<version>.{he,en}.md` ·
`SHA256SUMS` signed with minisign and verified · `gh release create` (a beta is
a pre-release) and the `beta-channel` pointer. Without the owner's keys a dry
run signs with throwaway TEST keys; `--fake-build` stands in for the build
where `node_modules` or Rust are missing. Full page: docs *Project → Releasing
a version* (`docs/src/content/docs/project/releasing.md`).

The steps below run one part at a time.

## Versioning and the release pipeline (plan 13.4)

One script runs the whole release on your machine — GitHub Actions are not
needed (`.github/workflows/release.yml` runs the same steps on a tag push when
Actions are on):

```bash
node scripts/release.mjs plan                    # next version from Conventional Commits + changelog preview
node scripts/release.mjs prepare --commit --tag  # bump every manifest, write CHANGELOG.md, commit, tag vX.Y.Z
git push origin HEAD vX.Y.Z
node scripts/release.mjs build [--desktop]       # typecheck, tests, build, budget, no source maps → release/
node scripts/release.mjs publish                 # GitHub release (gh CLI), notes from CHANGELOG.md, every file in release/
node scripts/release.mjs verify release/         # anyone: check SHA256SUMS (and SHA256SUMS.asc)
node scripts/release.mjs rollback 0.3.0 --to 0.2.1
```

**Version.** `feat` → minor, `fix` / `perf` → patch, a breaking change
(`feat!:` or `BREAKING CHANGE:`) → major (minor while the version is 0.x).
`--version X.Y.Z` overrides. `prepare` bumps, in lock-step:

1. `package.json` and `package-lock.json` (root entry only)
2. `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml` (`[package]`)
3. the iOS project: `MARKETING_VERSION`, and `CURRENT_PROJECT_VERSION` + 1
4. Android (`android/app/build.gradle` → `versionName` / `versionCode`) once
   the Android project exists (plan 13.3)

and adds the version's section to `CHANGELOG.md` under `[Unreleased]`
(Added / Fixed / Performance / Breaking, with commit links). `[skip ci]` is
dropped from commit subjects.

**Artifacts and signatures** (`build`, all into `release/`):

| Artifact | Signed by | Key (owner, plan 15.7) |
|---|---|---|
| `lumen-web-vX.tgz` | `SHA256SUMS` + `SHA256SUMS.asc` | `LUMEN_RELEASE_GPG_KEY` (a GPG key id) |
| desktop bundles (`--desktop`) | Apple / Authenticode + the updater's minisign `.sig` | see "Signing" below, `TAURI_SIGNING_PRIVATE_KEY` |
| `latest.json` (Tauri updater) | built from the `.sig` files | — |
| iOS `.ipa`, Android `.aab` (plan 13.3) | Xcode / Gradle, store signing | put them in `release/` before `build`'s checksum step |

Every key is optional: without one, that signature is skipped with a warning
and the release still builds.

**Rollback.** `rollback <bad> --to <good>` makes the bad release a
pre-release, so it is no longer "latest": download links and the desktop
updater's `releases/latest/download/latest.json` fall back to the good release
at once. Apps already on the bad version stay on it (the updater never
downgrades), so ship the fix as the next patch (`prepare --version …`). The
command prints how to redeploy the web app from the good tag (or
`npx vercel rollback`).

---

## Beta channel and feature flags (plan 14.4)

New features reach a **beta** before they reach everyone:

```bash
node scripts/release.mjs plan --beta                    # e.g. 0.2.0-beta.1 (or -beta.N+1 on a beta train)
node scripts/release.mjs prepare --beta --commit --tag
git push origin HEAD v0.2.0-beta.1
node scripts/release.mjs build [--desktop]              # a beta builds with VITE_LUMEN_CHANNEL=beta
node scripts/release.mjs publish                        # a GitHub pre-release: never "latest"
node scripts/release.mjs deploy-beta                    # the beta web app (Vercel preview + $LUMEN_BETA_HOST)
# …when the beta is good:
node scripts/release.mjs prepare --commit --tag         # 0.2.0, changelog since the last *stable* tag
```

- **Web.** The beta is its own deployment: `deploy-beta` makes a Vercel
  *preview* deployment of `dist/` and, when `LUMEN_BETA_HOST` is set, points
  that host at it. Stable stays the production deployment. For self-hosting,
  build once with `VITE_LUMEN_CHANNEL=beta` into a second site. The beta build
  shows a **Beta** badge in the status bar.
- **Desktop.** Stable apps read `releases/latest/download/latest.json`.
  GitHub's "latest" never points at a pre-release, so stable users never get
  a beta. Beta apps read the rolling **`beta-channel`** pre-release's
  `latest.json`, which `publish` updates for every beta and for every stable
  release newer than the last beta. Build settings:
  `LUMEN_UPDATER_ENDPOINT` (stable) and `LUMEN_UPDATER_ENDPOINT_BETA`
  (`https://github.com/<owner>/<repo>/releases/download/beta-channel/latest.json`).
  The user switches with *Update channel* in the palette. On Windows a beta
  ships the NSIS installer only, because MSI takes only numeric pre-release
  versions.
- **Feature flags** (`src/flags/flags.json`): a feature ships as stage
  `beta` with `since.beta`, the first beta that has it. It is on in beta
  builds and off in stable. Promote it in a later release with
  `stage: "stable"` and `since.stable`. `npm run flags:check` (also run by
  `build`) refuses a flag that reached stable without an earlier beta, and
  one without its strings in English and Hebrew. Flags are local only: no
  remote config. A user can override any flag under *Feature flags…*.
  `plan` lists the flags still in beta, for the release notes.

## Stores and package managers (plan W1.24)

`build --desktop` leaves the bundles and `SHA256SUMS` in `release/`. Then:

```bash
node scripts/release.mjs packages        # → release/packages/, checked offline
```

It writes, with every hash taken from `SHA256SUMS`:

| Channel | Files | Submit |
|---|---|---|
| Homebrew | `homebrew/lumen-md.rb` (cask, arm + intel) | a tap (`brew tap talstilkol/lumen-md`), or a PR to `Homebrew/homebrew-cask` |
| winget | `winget/manifests/t/Talstilkol/Lumen/<v>/` (version, installer, en-US locale; schema 1.6.0) | `wingetcreate submit <dir>` or a PR to `microsoft/winget-pkgs` |
| Flathub | `flatpak/io.github.talstilkol.Lumen.json` + `.metainfo.xml` (the `.deb`, unpacked) | a new-app PR to `flathub/flathub` |
| AUR | `aur/lumen-md-bin/PKGBUILD` + `.SRCINFO` | `git push` to `ssh://aur@aur.archlinux.org/lumen-md-bin.git` |

A channel whose bundle is not in `SHA256SUMS` is skipped and reported; it is
never written with a placeholder hash. The checks run without the network:

- **winget:** the official JSON schemas, vendored in `scripts/vendor/winget-schemas` (MIT).
- **Homebrew:** the cask's stanzas, their order and brew's `desc` rules, plus `ruby -c` when Ruby is installed.
- **Flathub:** the keys flatpak-builder needs, permissions Flathub rejects, and the metainfo's required elements.
- **AUR:** `bash -n`, and `.SRCINFO` agreeing with the `PKGBUILD`.

The stores' own tools are the final check, run by the owner before
submitting:
- `brew audit --new --cask`
- `winget validate`
- `flatpak-builder` + `flatpak run --command=flathub-build org.flatpak.Builder`
- `makepkg` + `namcap`

Nothing here submits anything: the submissions, and the store accounts,
are the owner's.

Notes for the owner:
- **Flathub id:** Flathub needs an id under a domain or code host you
  control, so the manifest uses `io.github.talstilkol.Lumen`, not the
  bundle id `app.lumen.editor`.
- **Flathub file access:** the sandbox gets the network and `Documents`.
  Other vault folders open through the file-chooser portal.
- **Pre-releases:** for a version like `0.2.0-beta.1`, the PKGBUILD's
  `pkgver` is `0.2.0_beta.1`, because pacman versions cannot contain `-`.

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

## Store submission (plan 13.7)

Listings (English and Hebrew), privacy-label answers, the screenshot script
and the desktop manifests are prepared in `store/` and `fastlane/metadata/`.
The step-by-step for each store is in [store/SUBMISSION.md](store/SUBMISSION.md).
`npm run store:check` keeps the listings within each store's limits.

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

## Signatures, SBOM and reproducible builds (plan W1.27)

Every release carries `SHA256SUMS` (each file of `dist/` and each desktop /
mobile artifact), a CycloneDX SBOM `sbom.cdx.json`, and minisign signatures
of both, made **on the release owner's machine** — no CI system holds the
key. Full steps: docs → Security → Supply chain.

```bash
# once: make the key, commit only the public half
LUMEN_RELEASE_PASSPHRASE=… node scripts/supply-chain/keys.mjs --out ~/.lumen-release
cp ~/.lumen-release/lumen-release.pub security/release-key.pub

# each release
npm run repro                     # two clean builds, same SHA-256 per file
npm run build
LUMEN_RELEASE_PASSPHRASE=… npm run release:sign -- --key ~/.lumen-release/lumen-release.key \
  --artifact src-tauri/target/release/bundle/dmg/Lumen_<version>_aarch64.dmg
npm run release:verify            # what anyone can run with the public key
```

Upload `release/SHA256SUMS`, `release/sbom.cdx.json` and their `.minisig`
files with the release.

### "What's new" in the app (plan 14.6)

The app shows each version's `CHANGELOG.md` section once after an update, in
the interface language. Translations live in `changelog/<locale>.md`
(`changelog/he.md` to start): `release.mjs prepare` copies the new section
into each of them marked `<!-- untranslated -->` — translate it and delete
that line before tagging, or the app shows the English notes (under
translated headings) with a note that they aren't translated yet. The notes
are built into the app (`virtual:lumen-whats-new` in `vite.config.ts`).

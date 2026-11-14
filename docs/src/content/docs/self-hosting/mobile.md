---
title: Android and iOS builds
description: How the Android APK and iOS IPA are built on every pull request, what is unsigned until the store accounts exist, and which secrets sign them.
---

Lumen's mobile apps are the same web build wrapped by Capacitor: `android/`
and `ios/App/` are committed project skeletons, `npx cap sync` copies
`dist/` into them. `.github/workflows/mobile.yml` builds both on every pull
request, so a change that breaks the native projects shows up before it
merges.

## One command on your own machine (plan W4.22)

GitHub Actions are off in this repository (the owner's decision, 9.11), so
the mobile builds also run as one local command each. The workflow below is
kept for when Actions are on.

```bash
npm run mobile:check                                   # what is missing for each platform, and the fix
npm run mobile:android -- --version 0.2.0-beta.1       # signed AAB + signed APK + debug APK → release/mobile/
npm run mobile:ios -- --version 0.2.0-beta.1           # on a Mac: archive, upload, TestFlight
```

Both commands start with a preflight. It lists every missing tool, key or
setting with the exact command that fixes it, and stops before building.
`--dry-run` prints the commands without running them. `--version` defaults to
`package.json`.

**Build numbers.** Both stores need a number that grows on every upload. It
comes from the version: major·10⁶ + minor·10⁴ + patch·10² + the beta number
(99 for the release). For example, 0.2.0-beta.1 → 20001, 0.2.0-beta.2 → 20002,
and 0.2.0 → 20099. Android gets it as `versionCode`. iOS gets it as
`CURRENT_PROJECT_VERSION`, with `MARKETING_VERSION` set to 0.2.0, because iOS
takes no `-beta` in the version.

### Android

1. The web build (`VITE_LUMEN_CHANNEL=beta` for a beta), then `npx cap sync android`.
2. Gradle runs `assembleDebug bundleRelease assembleRelease` with `-PversionCode` / `-PversionName`.
3. Checks: the AAB is checked with `jarsigner` and the APK with `apksigner`. A
   bundle signed with the debug key (`CN=Android Debug`) is refused, because
   Play would reject it.
4. Output: `release/mobile/lumen-<v>.aab` (for Play), `lumen-<v>.apk`
   (sideloading), `lumen-<v>-debug.apk` (emulator and Firebase Test Lab), and
   `SHA256SUMS`.

Needs: JDK 21, the Android SDK with `platforms;android-36` (`ANDROID_HOME`),
and the upload keystore in `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. You make the keystore once:

```bash
keytool -genkeypair -v -keystore ~/.lumen-android/upload.jks -alias lumen -keyalg RSA -keysize 4096 -validity 10000
```

Keep it and its password in your password manager. With Play App Signing,
Google holds the app key and this is only the upload key, so a lost one can
be replaced. The first AAB has to be uploaded in the Play Console
(*Testing → Internal testing*). `--unsigned` builds only the debug APK, with
no keystore.

### iOS → TestFlight

1. The web build, then `npx cap sync ios`.
2. `xcodebuild archive` runs with **automatic signing through the App Store
   Connect API key** (`-allowProvisioningUpdates -authenticationKeyPath …`), so
   Xcode makes or reuses the distribution certificate and profile. There is no
   `.p12` and no profile to export by hand.
3. `xcodebuild -exportArchive` runs with an `exportOptions.plist` made for the
   build (method `app-store-connect`, destination `upload`). It uploads to App
   Store Connect. A beta is marked for internal testing only.
4. App Store Connect processes the build in 10–30 minutes. It then appears in
   **TestFlight → Internal Testing** for the team.

`--altool` exports the `.ipa` and uploads it with
`xcrun altool --upload-app … --apiKey --apiIssuer` instead. Apple marks
`--upload-app` as deprecated in favour of `--upload-package`, but it still
works. `--no-upload` only leaves `release/mobile/lumen-<v>.ipa`.

Needs: a Mac with Xcode 16 or newer, plus `APPLE_TEAM_ID`, `ASC_KEY_ID` and
`ASC_ISSUER_ID`. It also needs the key file: `ASC_KEY_PATH` points to
`AuthKey_<id>.p8`, or `ASC_KEY` holds its text. Make the key in App Store
Connect → Users and Access → Integrations → App Store Connect API, with the
**Admin** role, so Xcode may manage certificates. The `.p8` can be downloaded
only once. The app record (`com.lumen.editor`) must exist in App Store
Connect. Until `ITSAppUsesNonExemptEncryption` is set in `Info.plist` (see
`store/SUBMISSION.md`), App Store Connect asks the export-compliance question
for each build.

### Without a Mac or an Android SDK: Codemagic

`codemagic.yaml` runs the same two commands on Codemagic's macOS M2 machines.
It has no `triggering:` section, so nothing builds on a push. You start each
build by hand in the Codemagic UI. On 12.11.2026, Codemagic's pricing page
said a **personal account gets 500 free macOS M2 minutes a month**, reset on
the 1st. It also said there are no free minutes on Linux or Windows, and no
free minutes for Teams. So both workflows use the Mac, and an iOS build of
about 15–25 minutes fits many times a month. The environment groups
`lumen_ios` and `lumen_android` hold the same variables as above (the
keystore as `ANDROID_KEYSTORE_BASE64`). Check the current terms at
docs.codemagic.io/billing/pricing before relying on them.

### Smoke tests without a phone

- **Android:** a Firebase Test Lab robo run of the debug APK
  (`gcloud firebase test android run --type robo --app release/mobile/lumen-<v>-debug.apk --device model=<id>,version=<api>`).
  It is free on the Spark plan (see *Owner sessions* 1.6), or you can use an
  emulator from Android Studio.
- **iOS:** TestFlight on Tal's device, or BrowserStack App Live with the
  `.ipa` (open-source plan).

## What every pull request produces

| Job | Runner | Artifact | Signed? |
|---|---|---|---|
| Android APK | `ubuntu-24.04`, Temurin 21, Android SDK 36 | `lumen-android`: `app-debug.apk` (debug key, installable on a developer device) and `app-release-unsigned.apk` | debug: yes (debug key) · release: only with the keystore secrets |
| iOS IPA | `macos-14`, Xcode | `lumen-ios`: `Lumen-unsigned.ipa` | only with the certificate and profile secrets |

Without the store accounts (plan 15.7) both jobs stay green and the
artifacts are unsigned: they prove that the native projects compile against
the current web build. An unsigned IPA installs nowhere; the debug APK
installs on any Android device with developer mode.

Locally: `npm run android:open` / `npm run ios:open` build the web app, sync
it into the native project and open Android Studio / Xcode.

## Signing (optional secrets)

Set these repository secrets and the same jobs sign the release artifacts;
the release pipeline (plan 13.4) then publishes them.

| Secret | What |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | The release keystore, base64 (`base64 -w0 release.keystore`) |
| `ANDROID_KEYSTORE_PASSWORD` | Its password |
| `ANDROID_KEY_ALIAS` | The key alias inside it |
| `ANDROID_KEY_PASSWORD` | The key's password |
| `IOS_CERTIFICATE_P12_BASE64` | The distribution certificate with its private key, as a `.p12`, base64 |
| `IOS_CERTIFICATE_PASSWORD` | The `.p12` password |
| `IOS_PROVISIONING_PROFILE_BASE64` | The App Store provisioning profile for `com.lumen.editor`, base64 |
| `IOS_PROVISIONING_PROFILE_NAME` | Its name, as shown in the Apple developer portal |
| `APPLE_TEAM_ID` | The team identifier |

`android/app/build.gradle` reads the keystore from `ANDROID_KEYSTORE_PATH`
(the workflow decodes the secret there) and signs the release build only
when it is set; nothing in the repository holds key material. The iOS
export uses `ios/exportOptions.plist` (method `app-store-connect`) with the
team and profile filled in from the secrets.

Versions: `./gradlew -PversionCode=42 -PversionName=1.2.0` sets the Android
version; the iOS version is `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`
in the Xcode project. The release pipeline sets both from the tag.

## Safari and storage

Safari deletes a site's storage after seven days without a visit, and grants
`navigator.storage.persist()` only to installed apps. When the vault is not
persisted in Safari or in any iOS browser, and Lumen is not installed and not
the native app, a reminder shows once a week: export the vault, or add Lumen
to the Home Screen / Dock, where storage is kept. The native apps keep their
storage like any app.

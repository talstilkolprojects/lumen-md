---
title: Android and iOS builds
description: How the Android APK and iOS IPA are built on every pull request, what is unsigned until the store accounts exist, and which secrets sign them.
---

Lumen's mobile apps are the same web build wrapped by Capacitor: `android/`
and `ios/App/` are committed project skeletons, `npx cap sync` copies
`dist/` into them. `.github/workflows/mobile.yml` builds both on every pull
request, so a change that breaks the native projects shows up before it
merges.

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

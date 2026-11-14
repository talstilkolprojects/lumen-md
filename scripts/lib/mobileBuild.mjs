/**
 * Mobile builds in one command (plan W4.22): the pure parts of
 * scripts/mobile-build.mjs, shared with its tests. No child processes, no
 * file system: the caller gathers facts and runs the commands returned here.
 *
 *   npm run mobile:android   Capacitor + Gradle → a signed AAB (Play) + signed APK + debug APK
 *   npm run mobile:ios       on a Mac: xcodebuild archive → upload to App Store Connect → TestFlight
 *   npm run mobile:check     the preflight of both, without building
 */
import { parseVersion } from "./release.mjs";

/**
 * One build number for both stores from the version, increasing with semver
 * order: major·10⁶ + minor·10⁴ + patch·10² + (beta n, or 99 for the release).
 * 0.2.0-beta.1 → 20001, 0.2.0-beta.2 → 20002, 0.2.0 → 20099, 0.2.1 → 20199.
 * Play's versionCode and iOS's CFBundleVersion must both grow on every upload.
 */
export function buildNumber(version) {
  const v = parseVersion(version);
  let pre = 99;
  if (v.pre) {
    const m = /^(?:beta|rc|alpha)\.(\d+)$/.exec(v.pre);
    if (!m || Number(m[1]) < 1 || Number(m[1]) > 98) throw new Error(`build number: pre-release must be beta.N / rc.N / alpha.N with N 1–98 (got ${v.pre})`);
    pre = Number(m[1]);
  }
  if (v.minor > 99 || v.patch > 99) throw new Error("build number: minor and patch must be ≤ 99");
  const n = v.major * 1_000_000 + v.minor * 10_000 + v.patch * 100 + pre;
  if (n < 1 || n > 2_100_000_000) throw new Error(`build number ${n} is outside Play's range`);
  return n;
}

/** iOS takes only numbers in CFBundleShortVersionString: 0.2.0-beta.1 → 0.2.0 (the build number tells betas apart). */
export const marketingVersion = (version) => String(version).replace(/^v/, "").replace(/-.*$/, "");

/** compileSdk from android/variables.gradle. */
export function compileSdkOf(variablesGradle) {
  const m = /compileSdkVersion\s*=\s*(\d+)/.exec(String(variablesGradle));
  return m ? Number(m[1]) : null;
}

/** The major version in `java -version` output (stderr). */
export function javaMajor(text) {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(String(text));
  if (!m) return null;
  return m[1] === "1" ? Number(m[2]) : Number(m[1]);
}

/** Xcode's major version from `xcodebuild -version`. */
export function xcodeMajor(text) {
  const m = /^Xcode (\d+)/m.exec(String(text));
  return m ? Number(m[1]) : null;
}

const add = (items) => (ok, what, fix, blocking = true) => items.push({ ok: !!ok, what, fix, blocking: !ok && blocking });

/** What the Android build needs, as { ok, what, fix, blocking }. `f` = facts gathered by the caller. */
export function androidPreflight(f, { unsigned = false } = {}) {
  const items = [];
  const a = add(items);
  a(f.nodeModules, "node_modules is installed (Capacitor CLI)", "npm ci");
  a(f.androidProject, "android/ (the Capacitor project) is in the checkout", "git checkout a branch with android/ (plan 13.3), or npx cap add android");
  a(f.java && f.java >= 21, `JDK 21 or newer (found: ${f.java ?? "none"})`, "install Temurin 21: https://adoptium.net (macOS: brew install --cask temurin@21), then set JAVA_HOME");
  a(f.sdk, `Android SDK (ANDROID_HOME, ANDROID_SDK_ROOT or android/local.properties sdk.dir)${f.sdk ? `: ${f.sdk}` : ""}`, "install Android Studio (or the command-line tools) and set ANDROID_HOME, e.g. export ANDROID_HOME=~/Library/Android/sdk");
  if (f.sdk) {
    a(f.platform, `SDK platform android-${f.compileSdk} (compileSdk in android/variables.gradle)`, `"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-${f.compileSdk}" "build-tools;${f.compileSdk}.0.0"`);
    a(f.licenses, "Android SDK licences accepted", `yes | "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses`);
  }
  if (!unsigned) {
    a(f.keystore, "the upload keystore (ANDROID_KEYSTORE_PATH) exists", "make it once: keytool -genkeypair -v -keystore ~/.lumen-android/upload.jks -alias lumen -keyalg RSA -keysize 4096 -validity 10000 — then export ANDROID_KEYSTORE_PATH=~/.lumen-android/upload.jks");
    a(f.keystorePasswords, "ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS and ANDROID_KEY_PASSWORD are set", "export ANDROID_KEYSTORE_PASSWORD=… ANDROID_KEY_ALIAS=lumen ANDROID_KEY_PASSWORD=… (from your password manager)");
    if (f.keystore && f.keystorePasswords) a(f.aliasOk, "the keystore opens with that password and has the alias", "check: keytool -list -keystore \"$ANDROID_KEYSTORE_PATH\" -alias \"$ANDROID_KEY_ALIAS\"");
  }
  return items;
}

/** What the iOS build and upload need. */
export function iosPreflight(f, { upload = true, altool = false } = {}) {
  const items = [];
  const a = add(items);
  a(f.mac, "running on macOS", "iOS builds need a Mac with Xcode — or Codemagic's free macOS minutes (docs: Android and iOS builds → Without a Mac)");
  if (!f.mac) return items;
  a(f.nodeModules, "node_modules is installed (Capacitor CLI)", "npm ci");
  a(f.xcode && f.xcode >= 16, `Xcode 16 or newer (found: ${f.xcode ?? "none"})`, "install Xcode from the App Store, then: sudo xcode-select -s /Applications/Xcode.app && xcodebuild -runFirstLaunch");
  a(/^[A-Z0-9]{10}$/.test(f.teamId ?? ""), "APPLE_TEAM_ID (10 letters/digits)", "export APPLE_TEAM_ID=… (developer.apple.com → Membership details → Team ID)");
  a(/^[A-Z0-9]{10}$/.test(f.keyId ?? ""), "ASC_KEY_ID (the App Store Connect API key id)", "App Store Connect → Users and Access → Integrations → App Store Connect API → Team keys → + (role Admin, so Xcode can make the signing certificate), then export ASC_KEY_ID=…");
  a(/^[0-9a-f-]{36}$/i.test(f.issuerId ?? ""), "ASC_ISSUER_ID (UUID above the key list)", "export ASC_ISSUER_ID=… (same page, Issuer ID)");
  a(f.keyFile, "the API key file (ASC_KEY_PATH → AuthKey_<id>.p8, or its text in ASC_KEY)", "download AuthKey_<id>.p8 once (it can be downloaded only once), keep it outside the repo: export ASC_KEY_PATH=~/.lumen-ios/AuthKey_<id>.p8");
  if (upload && altool) a(f.altoolKeyName, "for --altool the key file is named AuthKey_<ASC_KEY_ID>.p8 (altool finds it by name)", "mv the .p8 to AuthKey_$ASC_KEY_ID.p8");
  a(f.appRecord !== false, "the app exists in App Store Connect (bundle id com.lumen.editor)", "App Store Connect → Apps → + → New App, bundle id com.lumen.editor (register it first under Certificates, IDs & Profiles → Identifiers)", false);
  a(f.encryptionKey, "Info.plist answers export compliance (ITSAppUsesNonExemptEncryption)", "not set yet (store/SUBMISSION.md): App Store Connect asks about encryption once per build before TestFlight shows it", false);
  return items;
}

/** The Android commands, in order (cwd: repo root unless noted). */
export function androidCommands({ version, channel = "stable", unsigned = false, skipWeb = false }) {
  const code = buildNumber(version);
  const props = [`-PversionCode=${code}`, `-PversionName=${version}`];
  return [
    ...(skipWeb ? [] : [{ cmd: "npm", args: ["run", "build"], env: { VITE_LUMEN_CHANNEL: channel } }]),
    { cmd: "npx", args: ["cap", "sync", "android"] },
    { cmd: "./gradlew", args: ["--no-daemon", ...props, "assembleDebug", ...(unsigned ? [] : ["bundleRelease", "assembleRelease"])], cwd: "android" },
  ];
}

/** Where Gradle leaves the outputs, and the names they get in release/mobile/. */
export function androidOutputs(version, { unsigned = false } = {}) {
  const out = [{ from: "android/app/build/outputs/apk/debug/app-debug.apk", to: `lumen-${version}-debug.apk`, signed: "debug" }];
  if (!unsigned) {
    out.push({ from: "android/app/build/outputs/bundle/release/app-release.aab", to: `lumen-${version}.aab`, signed: "upload" });
    out.push({ from: "android/app/build/outputs/apk/release/app-release.apk", to: `lumen-${version}.apk`, signed: "upload" });
  }
  return out;
}

/**
 * `jarsigner -verify -verbose -certs` output → { signed, debug, subject }.
 * An AAB is signed like a jar (Play re-signs it with the app key); a debug
 * certificate ("CN=Android Debug") must never reach the store.
 */
export function parseJarsigner(text) {
  const t = String(text);
  const signed = /^jar verified\./m.test(t) && !/jar is unsigned/.test(t);
  const subject = /X\.509, ([^\n\[]+)/.exec(t)?.[1]?.trim() ?? null;
  return { signed, debug: /CN=Android Debug/.test(t), subject };
}

/**
 * `apksigner verify --print-certs -v` output → { signed, debug, subject }.
 * With minSdk 24 Gradle signs APKs with scheme v2/v3 only, which jarsigner
 * cannot see, so APKs are checked with apksigner.
 */
export function parseApksigner(text) {
  const t = String(text);
  const signed = /^Verifies$/m.test(t) || /Verified using v[23] scheme[^:]*: true/.test(t);
  const subject = /Signer #1 certificate DN: (.+)/.exec(t)?.[1]?.trim() ?? null;
  return { signed, debug: /CN=Android Debug/.test(t), subject };
}

/** The newest build-tools folder name (36.0.0 > 35.0.1 > 9.0.0). */
export function newestBuildTools(names) {
  const key = (n) => n.split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  return [...names].filter((n) => /^\d+\.\d+\.\d+/.test(n)).sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (y[i] ?? 0) - (x[i] ?? 0);
    return 0;
  })[0] ?? null;
}

/** exportOptions.plist for App Store Connect, made per build (the committed template keeps its placeholders). */
export function exportOptionsPlist({ teamId, upload = true, internalOnly = false }) {
  if (!/^[A-Z0-9]{10}$/.test(teamId ?? "")) throw new Error("exportOptions: not a team id");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key>
  <string>app-store-connect</string>
  <key>destination</key>
  <string>${upload ? "upload" : "export"}</string>
  <key>teamID</key>
  <string>${teamId}</string>
  <key>signingStyle</key>
  <string>automatic</string>
  <key>manageAppVersionAndBuildNumber</key>
  <false/>
  <key>uploadSymbols</key>
  <true/>
  <key>testFlightInternalTestingOnly</key>
  <${internalOnly ? "true" : "false"}/>
</dict>
</plist>
`;
}

/**
 * The iOS commands. Signing is automatic: Xcode makes or reuses the
 * distribution certificate and profile through the App Store Connect API key
 * (-allowProvisioningUpdates), so no .p12 or profile is exported by hand.
 * Default upload: `xcodebuild -exportArchive` with destination "upload".
 * `altool: true`: export the .ipa, then `xcrun altool --upload-app`.
 */
export function iosCommands({ version, channel = "stable", teamId, keyId, issuerId, keyPath, archive, exportDir, exportOptions, upload = true, altool = false, skipWeb = false }) {
  const auth = ["-allowProvisioningUpdates", "-authenticationKeyPath", keyPath, "-authenticationKeyID", keyId, "-authenticationKeyIssuerID", issuerId];
  const xcUpload = upload && !altool;
  const cmds = [
    ...(skipWeb ? [] : [{ cmd: "npm", args: ["run", "build"], env: { VITE_LUMEN_CHANNEL: channel } }]),
    { cmd: "npx", args: ["cap", "sync", "ios"] },
    {
      cmd: "xcodebuild",
      args: ["-project", "ios/App/App.xcodeproj", "-scheme", "App", "-configuration", "Release", "-destination", "generic/platform=iOS", "-archivePath", archive, "archive", ...auth, `DEVELOPMENT_TEAM=${teamId}`, "CODE_SIGN_STYLE=Automatic", `MARKETING_VERSION=${marketingVersion(version)}`, `CURRENT_PROJECT_VERSION=${buildNumber(version)}`, "-skipPackagePluginValidation"],
    },
    { cmd: "xcodebuild", args: ["-exportArchive", "-archivePath", archive, "-exportOptionsPlist", exportOptions, "-exportPath", exportDir, ...auth], note: xcUpload ? "uploads to App Store Connect" : "writes the .ipa" },
  ];
  if (upload && altool) cmds.push({ cmd: "xcrun", args: ["altool", "--upload-app", "-f", `${exportDir}/App.ipa`, "-t", "ios", "--apiKey", keyId, "--apiIssuer", issuerId], env: { API_PRIVATE_KEYS_DIR: keyPath.replace(/\/[^/]+$/, "") } });
  return cmds;
}

/** A command as one shell line (for --dry-run and the docs). */
export function shellLine({ cmd, args, env, cwd }) {
  const q = (s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${String(s).replace(/'/g, "'\\''")}'`);
  const e = Object.entries(env ?? {}).map(([k, v]) => `${k}=${q(v)} `).join("");
  return `${cwd ? `(cd ${cwd} && ` : ""}${e}${cmd} ${args.map(q).join(" ")}${cwd ? ")" : ""}`;
}

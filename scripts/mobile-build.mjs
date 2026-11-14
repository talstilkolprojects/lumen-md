#!/usr/bin/env node
/**
 * Android and iOS builds in one command each (plan W4.22), no GitHub Actions:
 *
 *   npm run mobile:android [-- --version X] [--unsigned] [--skip-web] [--dry-run]
 *       web build → npx cap sync android → Gradle: signed AAB (Play upload) + signed APK
 *       + debug APK (emulator / Firebase Test Lab) → release/mobile/ with SHA256SUMS;
 *       the AAB's signature is checked (jarsigner) and a debug certificate refused.
 *   npm run mobile:ios [-- --version X] [--no-upload] [--altool] [--skip-web] [--dry-run]
 *       on a Mac: web build → npx cap sync ios → xcodebuild archive (automatic signing
 *       through the App Store Connect API key) → upload to App Store Connect, where the
 *       build appears in TestFlight for internal testers.
 *   npm run mobile:check            the preflight of both, nothing built
 *
 * Every missing tool, key or setting is listed first, each with the command that fixes it.
 * --dry-run prints the exact commands without running them. Keys are the owner's
 * (plan 15.7) and are read from the environment only; nothing is written to the repo.
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { isBeta, sha256sums } from "./lib/release.mjs";
import { androidCommands, androidOutputs, androidPreflight, buildNumber, compileSdkOf, exportOptionsPlist, iosCommands, iosPreflight, javaMajor, newestBuildTools, parseApksigner, parseJarsigner, shellLine, xcodeMajor } from "./lib/mobileBuild.mjs";

const ROOT = process.cwd();
const OUT = path.join(ROOT, "release", "mobile");
const [target, ...args] = process.argv.slice(2);
const has = (f) => args.includes(f);
const opt = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const exists = (p) => existsSync(path.isAbsolute(p) ? p : path.join(ROOT, p));
const expand = (p) => (p ? p.replace(/^~(?=\/|$)/, homedir()) : p);
const out = (bin, a, extra = {}) => {
  const r = spawnSync(bin, a, { cwd: ROOT, encoding: "utf8", ...extra });
  return r.error ? null : `${r.stdout ?? ""}${r.stderr ?? ""}`;
};

function report(title, items) {
  console.log(`\n== ${title}`);
  for (const i of items) console.log(`${i.ok ? "✓" : i.blocking ? "✗" : "·"} ${i.what}${i.ok ? "" : `\n    → ${i.fix}`}`);
  return items.filter((i) => i.blocking);
}

function sdkDir() {
  const env = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  if (env) return env;
  try {
    return /^sdk\.dir=(.+)$/m.exec(readFileSync(path.join(ROOT, "android", "local.properties"), "utf8"))?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
}

function androidFacts(unsigned) {
  const sdk = sdkDir();
  const compileSdk = exists("android/variables.gradle") ? compileSdkOf(readFileSync(path.join(ROOT, "android/variables.gradle"), "utf8")) : null;
  const ks = expand(process.env.ANDROID_KEYSTORE_PATH);
  const pw = process.env.ANDROID_KEYSTORE_PASSWORD;
  const alias = process.env.ANDROID_KEY_ALIAS;
  const keystore = !!ks && existsSync(ks);
  const keystorePasswords = !!(pw && alias && process.env.ANDROID_KEY_PASSWORD);
  let aliasOk = false;
  if (!unsigned && keystore && keystorePasswords) {
    // The password goes through the environment, never the command line.
    const r = spawnSync("keytool", ["-list", "-keystore", ks, "-alias", alias, "-storepass:env", "ANDROID_KEYSTORE_PASSWORD"], { encoding: "utf8" });
    aliasOk = r.status === 0;
  }
  return {
    nodeModules: exists("node_modules/@capacitor/cli"),
    androidProject: exists("android/gradlew"),
    java: javaMajor(out("java", ["-version"]) ?? ""),
    sdk,
    compileSdk,
    platform: !!sdk && !!compileSdk && existsSync(path.join(sdk, "platforms", `android-${compileSdk}`)),
    licenses: !!sdk && existsSync(path.join(sdk, "licenses")),
    keystore,
    keystorePasswords,
    aliasOk,
  };
}

function iosKey() {
  const p = expand(process.env.ASC_KEY_PATH);
  if (p && existsSync(p)) return { path: p, temp: false };
  const text = process.env.ASC_KEY;
  if (text && /-----BEGIN PRIVATE KEY-----/.test(text)) {
    // A CI service (Codemagic) passes the key's text: write it where xcodebuild and altool look.
    const dir = mkdtempSync(path.join(tmpdir(), "lumen-asc-"));
    const file = path.join(dir, `AuthKey_${process.env.ASC_KEY_ID ?? "key"}.p8`);
    writeFileSync(file, text, { mode: 0o600 });
    return { path: file, temp: true };
  }
  return null;
}

function iosFacts(key) {
  const plist = exists("ios/App/App/Info.plist") ? readFileSync(path.join(ROOT, "ios/App/App/Info.plist"), "utf8") : "";
  return {
    mac: process.platform === "darwin",
    nodeModules: exists("node_modules/@capacitor/cli"),
    xcode: process.platform === "darwin" ? xcodeMajor(out("xcodebuild", ["-version"]) ?? "") : null,
    teamId: process.env.APPLE_TEAM_ID,
    keyId: process.env.ASC_KEY_ID,
    issuerId: process.env.ASC_ISSUER_ID,
    keyFile: !!key && /-----BEGIN PRIVATE KEY-----/.test(readFileSync(key.path, "utf8")),
    altoolKeyName: !!key && path.basename(key.path) === `AuthKey_${process.env.ASC_KEY_ID}.p8`,
    encryptionKey: /ITSAppUsesNonExemptEncryption/.test(plist),
  };
}

function exec(c, dryRun) {
  console.log(`$ ${shellLine(c)}${c.note ? `   # ${c.note}` : ""}`);
  if (dryRun) return;
  const r = spawnSync(c.cmd, c.args, { cwd: path.join(ROOT, c.cwd ?? "."), stdio: "inherit", env: { ...process.env, ...(c.env ?? {}) }, shell: process.platform === "win32" });
  if (r.status !== 0) throw new Error(`${c.cmd} failed (${r.status ?? r.signal})`);
}

const version = (opt("--version") ?? JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version).replace(/^v/, "");
const channel = isBeta(version) ? "beta" : "stable";
const dryRun = has("--dry-run");

function android() {
  const unsigned = has("--unsigned");
  const blocking = report(`Android ${version} (build ${buildNumber(version)}, ${unsigned ? "debug APK only" : "signed AAB + APK"})`, androidPreflight(androidFacts(unsigned), { unsigned }));
  if (blocking.length && !dryRun) throw new Error(`${blocking.length} item(s) missing — fix the ✗ lines above`);
  console.log(`\n== build${dryRun ? " (dry run: commands only)" : ""}`);
  for (const c of androidCommands({ version, channel, unsigned, skipWeb: has("--skip-web") })) exec(c, dryRun);
  if (dryRun) return;
  mkdirSync(OUT, { recursive: true });
  const copied = [];
  for (const o of androidOutputs(version, { unsigned })) {
    if (!exists(o.from)) throw new Error(`Gradle made no ${o.from}`);
    if (o.signed === "upload") {
      const file = path.join(ROOT, o.from);
      let v;
      if (o.from.endsWith(".aab")) v = parseJarsigner(out("jarsigner", ["-verify", "-verbose", "-certs", file], { maxBuffer: 1 << 28 }) ?? "");
      else {
        const sdk = sdkDir();
        const bt = sdk && existsSync(path.join(sdk, "build-tools")) ? newestBuildTools(readdirSync(path.join(sdk, "build-tools"))) : null;
        if (!bt) throw new Error("no Android build-tools to check the APK signature (sdkmanager \"build-tools;36.0.0\")");
        v = parseApksigner(out(path.join(sdk, "build-tools", bt, process.platform === "win32" ? "apksigner.bat" : "apksigner"), ["verify", "--print-certs", "-v", file]) ?? "");
      }
      if (!v.signed) throw new Error(`${o.from} is not signed`);
      if (v.debug) throw new Error(`${o.from} is signed with the DEBUG key: Play refuses it (is ANDROID_KEYSTORE_PATH set?)`);
      console.log(`signed: ${o.to} (${v.subject})`);
    }
    copyFileSync(path.join(ROOT, o.from), path.join(OUT, o.to));
    copied.push(o.to);
  }
  writeSums();
  console.log(`\nrelease/mobile/: ${copied.join(", ")}
Next (owner):
  · Play Console → Lumen → Testing → Internal testing → Create release → upload release/mobile/lumen-${version}.aab
    (the first upload must be in the console; Play App Signing keeps the app key, this keystore is the upload key)
  · smoke test without a phone (Firebase Test Lab, no-cost Spark quota):
    gcloud firebase test android run --type robo --app release/mobile/lumen-${version}-debug.apk --device model=<id>,version=<api>`);
}

function ios() {
  const upload = !has("--no-upload");
  const altool = has("--altool");
  const key = iosKey();
  try {
    const blocking = report(`iOS ${version} (marketing ${version.replace(/-.*/, "")}, build ${buildNumber(version)}${upload ? ", upload to TestFlight" : ", .ipa only"})`, iosPreflight(iosFacts(key), { upload, altool }));
    if (blocking.length && !dryRun) throw new Error(`${blocking.length} item(s) missing — fix the ✗ lines above`);
    const work = path.join(ROOT, "build", "ios");
    const exportOptions = path.join(work, "exportOptions.plist");
    const teamId = process.env.APPLE_TEAM_ID ?? "TEAMID0000";
    if (!dryRun) {
      rmSync(work, { recursive: true, force: true });
      mkdirSync(work, { recursive: true });
      writeFileSync(exportOptions, exportOptionsPlist({ teamId, upload: upload && !altool, internalOnly: isBeta(version) }));
    }
    console.log(`\n== build${dryRun ? " (dry run: commands only)" : ""}`);
    const cmds = iosCommands({ version, channel, teamId, keyId: process.env.ASC_KEY_ID ?? "<ASC_KEY_ID>", issuerId: process.env.ASC_ISSUER_ID ?? "<ASC_ISSUER_ID>", keyPath: key?.path ?? "<ASC_KEY_PATH>", archive: path.join(work, "Lumen.xcarchive"), exportDir: path.join(work, "export"), exportOptions, upload, altool, skipWeb: has("--skip-web") });
    for (const c of cmds) exec(c, dryRun);
    if (dryRun) return;
    const ipa = readdirSync(path.join(work, "export")).find((n) => n.endsWith(".ipa"));
    if (ipa) {
      mkdirSync(OUT, { recursive: true });
      copyFileSync(path.join(work, "export", ipa), path.join(OUT, `lumen-${version}.ipa`));
      writeSums();
    }
    console.log(upload
      ? `\nUploaded build ${buildNumber(version)}. App Store Connect processes it (10–30 min, an e-mail when done); then it is in TestFlight → Internal Testing for the team.${isBeta(version) ? " (internal testing only: a beta build cannot go to the App Store)" : ""}`
      : `\nrelease/mobile/lumen-${version}.ipa — upload later with: xcrun altool --upload-app -f release/mobile/lumen-${version}.ipa -t ios --apiKey $ASC_KEY_ID --apiIssuer $ASC_ISSUER_ID`);
  } finally {
    if (key?.temp) rmSync(path.dirname(key.path), { recursive: true, force: true });
  }
}

function writeSums() {
  const names = readdirSync(OUT).filter((n) => n !== "SHA256SUMS" && !n.startsWith("."));
  writeFileSync(path.join(OUT, "SHA256SUMS"), sha256sums(names.map((name) => ({ name, data: readFileSync(path.join(OUT, name)) }))));
}

function check() {
  const a = report("Android", androidPreflight(androidFacts(false)));
  const key = iosKey();
  try {
    const i = report("iOS", iosPreflight(iosFacts(key)));
    console.log(`\nAndroid: ${a.length ? `${a.length} missing` : "ready"} · iOS: ${i.length ? `${i.length} missing` : "ready"}`);
    if (a.length || i.length) process.exitCode = 1;
  } finally {
    if (key?.temp) rmSync(path.dirname(key.path), { recursive: true, force: true });
  }
}

const run = { android, ios, check }[target];
if (!run) {
  console.error("usage: node scripts/mobile-build.mjs android | ios | check [--version X] [--dry-run] [--skip-web] (android: --unsigned; ios: --no-upload, --altool)");
  process.exit(2);
}
try {
  run();
} catch (e) {
  console.error(`mobile: ${e.message}`);
  process.exit(1);
}

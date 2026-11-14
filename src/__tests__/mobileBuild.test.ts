/**
 * Plan W4.22 — Android and iOS builds in one command (scripts/mobile-build.mjs):
 * build numbers that only grow, the preflight that names every missing piece
 * with its fix, the exact Gradle / xcodebuild / altool commands, the AAB and
 * APK signature checks (a debug key is refused), and the Codemagic config.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import * as M from "../../scripts/lib/mobileBuild.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { compareVersions } from "../../scripts/lib/release.mjs";

const ROOT = resolve(__dirname, "..", "..");
type Item = { ok: boolean; what: string; fix: string; blocking: boolean };
type Cmd = { cmd: string; args: string[]; env?: Record<string, string>; cwd?: string };
const blockingText = (items: Item[]) => items.filter((i) => i.blocking).map((i) => `${i.what} → ${i.fix}`).join("\n");

describe("build numbers (W4.22)", () => {
  it("grow with the version on both stores, betas before their release", () => {
    const order = ["0.1.0", "0.2.0-beta.1", "0.2.0-beta.2", "0.2.0-beta.10", "0.2.0", "0.2.1-rc.1", "0.2.1", "0.3.0", "1.0.0-beta.1", "1.0.0"];
    const codes = order.map((v) => M.buildNumber(v) as number);
    for (let i = 1; i < order.length; i++) {
      expect(compareVersions(order[i], order[i - 1])).toBe(1);
      expect(codes[i]).toBeGreaterThan(codes[i - 1]);
    }
    expect(M.buildNumber("0.2.0-beta.1")).toBe(20001);
    expect(M.buildNumber("0.2.0")).toBe(20099);
    expect(() => M.buildNumber("0.2.0-beta.99")).toThrow(/1–98/);
    expect(() => M.buildNumber("0.2.0-nightly")).toThrow();
    expect(() => M.buildNumber("0.100.0")).toThrow(/≤ 99/);
    expect(M.marketingVersion("v0.2.0-beta.1")).toBe("0.2.0");
  });
});

describe("tool versions (W4.22)", () => {
  it("reads java, Xcode and compileSdk", () => {
    expect(M.javaMajor('openjdk version "21.0.12.1" 2026-08-18')).toBe(21);
    expect(M.javaMajor('java version "1.8.0_402"')).toBe(8);
    expect(M.javaMajor("")).toBeNull();
    expect(M.xcodeMajor("Xcode 16.4\nBuild version 16F6")).toBe(16);
    expect(M.compileSdkOf(readFileSync(join(ROOT, "android/variables.gradle"), "utf8"))).toBe(36);
    expect(M.newestBuildTools(["9.0.0", "35.0.1", "36.0.0", "36.0.0-rc1", "notes"])).toBe("36.0.0");
    expect(M.newestBuildTools([])).toBeNull();
  });
});

describe("preflight says exactly what is missing (W4.22)", () => {
  const ready = { nodeModules: true, androidProject: true, java: 21, sdk: "/sdk", compileSdk: 36, platform: true, licenses: true, keystore: true, keystorePasswords: true, aliasOk: true };

  it("Android: ready means nothing blocking; each missing piece has its fix", () => {
    expect(blockingText(M.androidPreflight(ready))).toBe("");
    const t = blockingText(M.androidPreflight({ ...ready, nodeModules: false, java: 17, platform: false, licenses: false, keystore: false, keystorePasswords: false }));
    for (const re of [/node_modules.*npm ci/, /JDK 21 or newer \(found: 17\).*temurin/, /android-36.*sdkmanager" "platforms;android-36"/, /licences.*--licenses/, /ANDROID_KEYSTORE_PATH.*keytool -genkeypair/, /ANDROID_KEY_ALIAS/]) expect(t).toMatch(re);
    expect(blockingText(M.androidPreflight({ ...ready, aliasOk: false }))).toMatch(/opens with that password and has the alias/);
    // No SDK: one line, not three.
    expect(M.androidPreflight({ ...ready, sdk: null }).filter((i: Item) => i.blocking)).toHaveLength(1);
    // A debug-only build needs no keystore.
    expect(blockingText(M.androidPreflight({ ...ready, keystore: false, keystorePasswords: false }, { unsigned: true }))).toBe("");
  });

  const mac = { mac: true, nodeModules: true, xcode: 16, teamId: "ABCDE12345", keyId: "KEY1234567", issuerId: "69a6de7e-1111-47e3-e053-5b8c7c11a4d1", keyFile: true, altoolKeyName: true, appRecord: undefined, encryptionKey: false };

  it("iOS: off a Mac it says so and points to Codemagic; on a Mac each key and setting is named", () => {
    const off = M.iosPreflight({ mac: false });
    expect(off).toHaveLength(1);
    expect(off[0].fix).toMatch(/Codemagic/);
    expect(blockingText(M.iosPreflight(mac))).toBe("");
    const t = blockingText(M.iosPreflight({ ...mac, xcode: 15, teamId: "x", keyId: undefined, issuerId: "nope", keyFile: false }));
    for (const re of [/Xcode 16 or newer \(found: 15\)/, /APPLE_TEAM_ID/, /ASC_KEY_ID.*role Admin/, /ASC_ISSUER_ID/, /AuthKey_<id>\.p8/]) expect(t).toMatch(re);
    expect(blockingText(M.iosPreflight({ ...mac, altoolKeyName: false }, { altool: true }))).toMatch(/AuthKey_<ASC_KEY_ID>\.p8/);
    // Export compliance is Tal's answer, so it is a note, never a blocker.
    const note = M.iosPreflight(mac).find((i: Item) => /ITSAppUsesNonExemptEncryption/.test(i.what));
    expect(note).toMatchObject({ ok: false, blocking: false });
  });
});

describe("the commands (W4.22)", () => {
  it("Android: beta web build, cap sync, then debug APK, signed AAB and APK with the version", () => {
    const c: Cmd[] = M.androidCommands({ version: "0.2.0-beta.1", channel: "beta" });
    expect(c.map(M.shellLine)).toEqual([
      "VITE_LUMEN_CHANNEL=beta npm run build",
      "npx cap sync android",
      "(cd android && ./gradlew --no-daemon -PversionCode=20001 -PversionName=0.2.0-beta.1 assembleDebug bundleRelease assembleRelease)",
    ]);
    expect(M.androidCommands({ version: "0.2.0", unsigned: true, skipWeb: true }).map(M.shellLine)).toEqual(["npx cap sync android", "(cd android && ./gradlew --no-daemon -PversionCode=20099 -PversionName=0.2.0 assembleDebug)"]);
    expect(M.androidOutputs("0.2.0-beta.1").map((o: { to: string }) => o.to)).toEqual(["lumen-0.2.0-beta.1-debug.apk", "lumen-0.2.0-beta.1.aab", "lumen-0.2.0-beta.1.apk"]);
    // build.gradle reads exactly these two properties.
    const gradle = readFileSync(join(ROOT, "android/app/build.gradle"), "utf8");
    expect(gradle).toContain('project.property("versionCode")');
    expect(gradle).toContain('project.property("versionName")');
    expect(gradle).toContain('System.getenv("ANDROID_KEYSTORE_PATH")');
  });

  const ios = { version: "0.2.0-beta.1", channel: "beta", teamId: "ABCDE12345", keyId: "KEY1234567", issuerId: "iss", keyPath: "/k/AuthKey_KEY1234567.p8", archive: "/w/Lumen.xcarchive", exportDir: "/w/export", exportOptions: "/w/exportOptions.plist" };

  it("iOS: archive with automatic signing through the API key, then upload by xcodebuild", () => {
    const c: Cmd[] = M.iosCommands(ios);
    const archive = c.find((x) => x.args.includes("archive")) as Cmd;
    for (const a of ["-allowProvisioningUpdates", "DEVELOPMENT_TEAM=ABCDE12345", "CODE_SIGN_STYLE=Automatic", "MARKETING_VERSION=0.2.0", "CURRENT_PROJECT_VERSION=20001", "-authenticationKeyIssuerID"]) expect(archive.args).toContain(a);
    expect(archive.args[archive.args.indexOf("-authenticationKeyPath") + 1]).toBe(ios.keyPath);
    expect(c.at(-1)?.args[0]).toBe("-exportArchive");
    expect(c.some((x) => x.cmd === "xcrun")).toBe(false);
  });

  it("iOS --altool: export the .ipa, then altool finds the key by its folder", () => {
    const c: Cmd[] = M.iosCommands({ ...ios, altool: true });
    const last = c.at(-1) as Cmd;
    expect(M.shellLine(last)).toBe("API_PRIVATE_KEYS_DIR=/k xcrun altool --upload-app -f /w/export/App.ipa -t ios --apiKey KEY1234567 --apiIssuer iss");
  });

  it("exportOptions: App Store Connect, upload or export, internal-only for a beta", () => {
    const up = M.exportOptionsPlist({ teamId: "ABCDE12345", upload: true, internalOnly: true });
    expect(up).toMatch(/<key>method<\/key>\s*<string>app-store-connect<\/string>/);
    expect(up).toMatch(/<key>destination<\/key>\s*<string>upload<\/string>/);
    expect(up).toMatch(/<key>signingStyle<\/key>\s*<string>automatic<\/string>/);
    expect(up).toMatch(/<key>testFlightInternalTestingOnly<\/key>\s*<true\/>/);
    expect(M.exportOptionsPlist({ teamId: "ABCDE12345", upload: false })).toMatch(/<string>export<\/string>[\s\S]*testFlightInternalTestingOnly<\/key>\s*<false\/>/);
    expect(() => M.exportOptionsPlist({ teamId: "__TEAM_ID__" })).toThrow();
  });

  it("quotes what a shell would split", () => {
    expect(M.shellLine({ cmd: "echo", args: ["a b", "it's"] })).toBe("echo 'a b' 'it'\\''s'");
  });
});

// Real `jarsigner -verify -verbose -certs` output (JDK 21), trimmed, from bundles signed in this sandbox with throwaway keystores.
const SIGNED = `s        185 Thu Nov 12 15:55:54 IST 2026 META-INF/MANIFEST.MF
      >>> Signer
      X.509, CN=Lumen Test Upload, O=Test
      Signature algorithm: SHA384withRSA, 2048-bit key
sm        12 Thu Nov 12 15:55:53 IST 2026 base/manifest/AndroidManifest.xml
- Signed by "CN=Lumen Test Upload, O=Test"

jar verified.

Warning:
This jar contains entries whose signer certificate is self-signed.`;
const DEBUG = SIGNED.replace(/CN=Lumen Test Upload, O=Test/g, "CN=Android Debug, O=Android, C=US");
const UNSIGNED = "  s = signature was verified \n  m = entry is listed in manifest\nno manifest.\njar is unsigned.\n";
const TAMPERED = "jarsigner: java.lang.SecurityException: SHA-384 digest error for base/manifest/AndroidManifest.xml\n";

describe("signature checks (W4.22)", () => {
  it("an AAB signed with the upload key passes; debug, unsigned and changed bundles do not", () => {
    expect(M.parseJarsigner(SIGNED)).toEqual({ signed: true, debug: false, subject: "CN=Lumen Test Upload, O=Test" });
    expect(M.parseJarsigner(DEBUG)).toMatchObject({ signed: true, debug: true });
    expect(M.parseJarsigner(UNSIGNED).signed).toBe(false);
    expect(M.parseJarsigner(TAMPERED).signed).toBe(false);
  });

  it("an APK is read from apksigner (scheme v2/v3, which jarsigner cannot see)", () => {
    const out = "Verifies\nVerified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nNumber of signers: 1\nSigner #1 certificate DN: CN=Lumen Upload, O=Lumen\n";
    expect(M.parseApksigner(out)).toEqual({ signed: true, debug: false, subject: "CN=Lumen Upload, O=Lumen" });
    expect(M.parseApksigner("DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF").signed).toBe(false);
    expect(M.parseApksigner(out.replace("CN=Lumen Upload, O=Lumen", "C=US, O=Android, CN=Android Debug")).debug).toBe(true);
  });
});

describe("wiring (W4.22)", () => {
  it("the npm scripts exist and a dry run prints the commands without building", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts["mobile:android"]).toBe("node scripts/mobile-build.mjs android");
    expect(pkg.scripts["mobile:ios"]).toBe("node scripts/mobile-build.mjs ios");
    expect(pkg.scripts["mobile:check"]).toBe("node scripts/mobile-build.mjs check");
    const r = spawnSync(process.execPath, ["scripts/mobile-build.mjs", "android", "--version", "0.2.0-beta.1", "--dry-run"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANDROID_HOME: "", ANDROID_SDK_ROOT: "", ANDROID_KEYSTORE_PATH: "" } });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/== Android 0\.2\.0-beta\.1 \(build 20001, signed AAB \+ APK\)/);
    expect(r.stdout).toMatch(/✗ the upload keystore \(ANDROID_KEYSTORE_PATH\) exists\n {4}→ make it once: keytool -genkeypair/);
    expect(r.stdout).toMatch(/\$ \(cd android && \.\/gradlew --no-daemon -PversionCode=20001 -PversionName=0\.2\.0-beta\.1 assembleDebug bundleRelease assembleRelease\)/);
    const bad = spawnSync(process.execPath, ["scripts/mobile-build.mjs", "android", "--version", "0.2.0-beta.1"], { cwd: ROOT, encoding: "utf8", env: { ...process.env, ANDROID_HOME: "", ANDROID_SDK_ROOT: "", ANDROID_KEYSTORE_PATH: "" } });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toMatch(/item\(s\) missing — fix the ✗ lines above/);
  });

  it("Codemagic runs the same scripts, only when started by hand, on the free macOS M2 machines", () => {
    const y = readFileSync(join(ROOT, "codemagic.yaml"), "utf8");
    expect(y).not.toMatch(/^\s*triggering:/m);
    // Every workflow (W4.22's two, and those W6.24 added) runs on the free M2 machine, and no other.
    const workflows = [...y.matchAll(/^  ([a-z][\w-]*):\s*$/gm)].map((m) => m[1]);
    expect(workflows).toEqual(expect.arrayContaining(["ios-testflight", "android-aab"]));
    expect((y.match(/^ *instance_type:.*$/gm) ?? []).map((l) => l.trim())).toEqual(workflows.map(() => "instance_type: mac_mini_m2"));
    expect(y).toContain("script: npm run mobile:ios");
    expect(y).toContain("script: npm run mobile:android");
    // The script takes the key's text from the group (ASC_KEY) as well as a path.
    expect(readFileSync(join(ROOT, "scripts/mobile-build.mjs"), "utf8")).toContain("process.env.ASC_KEY");
  });
});

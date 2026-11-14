// @vitest-environment node
/**
 * Plan 13.3 — Android and iOS in CI, and the Safari eviction reminder.
 *
 * The APK and IPA builds themselves run only on GitHub's runners (an Android
 * SDK and Xcode); here the workflow is held to its contract: both jobs on
 * every pull request, the unsigned artifacts without any secret, signing
 * only when the secrets exist, and the native projects it builds in place.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { REMINDER_EVERY_MS, isWebKitBrowser, shouldRemind, type ReminderEnv } from "../storage/evictionReminder";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";

const ROOT = resolve(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const wf = YAML.parse(read("docs/archive/workflows/mobile.yml")) as {
  on: Record<string, unknown>;
  jobs: Record<string, { "runs-on": string; env?: Record<string, string>; steps: { name?: string; uses?: string; run?: string; if?: string; with?: Record<string, string> }[] }>;
};
const steps = (job: string) => wf.jobs[job].steps;
const runOf = (job: string, name: RegExp) => steps(job).find((s) => s.name && name.test(s.name))?.run ?? "";

describe("mobile.yml: APK and IPA on every pull request", () => {
  it("runs both jobs on pull requests, on pinned images", () => {
    expect(Object.keys(wf.on)).toContain("pull_request");
    expect(wf.jobs.android["runs-on"]).toBe("ubuntu-24.04");
    expect(wf.jobs.ios["runs-on"]).toBe("macos-14");
  });

  it("every action is pinned to a full commit SHA with a version comment", () => {
    const text = read("docs/archive/workflows/mobile.yml");
    for (const line of text.split("\n").filter((l) => /uses:/.test(l))) {
      expect(line, line).toMatch(/uses: [\w./-]+@[0-9a-f]{40} # v\d/);
    }
  });

  it("Android: web build → cap sync → debug APK, and a release APK that is unsigned without the keystore secret", () => {
    const names = steps("android").map((s) => s.name ?? s.uses ?? "");
    const order = ["Build the web app", "Capacitor sync", "Debug APK", "Release keystore", "Release APK"].map((n) => names.findIndex((x) => x.startsWith(n)));
    expect(order.every((i, k) => i >= 0 && (k === 0 || i > order[k - 1]))).toBe(true);
    expect(runOf("android", /^Debug APK/)).toContain("assembleDebug");
    expect(runOf("android", /^Release APK/)).toContain("assembleRelease");
    const keystore = steps("android").find((s) => s.name?.startsWith("Release keystore"))!;
    expect(keystore.if).toBe("env.HAS_KEYSTORE == 'true'");
    expect(wf.jobs.android.env?.HAS_KEYSTORE).toBe("${{ secrets.ANDROID_KEYSTORE_BASE64 != '' }}");
    const upload = steps("android").find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(upload.if).toBeUndefined(); // uploaded with or without signing
    expect(upload.with?.path).toContain("apk/debug/*.apk");
    expect(upload.with?.path).toContain("apk/release/*.apk");
  });

  it("Android: the Gradle project signs only when the four ANDROID_* variables are set", () => {
    const gradle = read("android/app/build.gradle");
    expect(gradle).toContain('System.getenv("ANDROID_KEYSTORE_PATH")');
    for (const v of ["ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD"]) expect(gradle).toContain(`System.getenv("${v}")`);
    expect(gradle).toMatch(/if \(keystorePath\) \{\s*signingConfig signingConfigs\.release/);
    // No key material in the repo.
    expect(gradle).not.toMatch(/storePassword\s+"/);
    expect(existsSync(join(ROOT, "android/app/release.keystore"))).toBe(false);
    // Versions come from the release pipeline (13.4), with defaults.
    expect(gradle).toContain('project.hasProperty("versionCode")');
    expect(read("android/app/src/main/res/values/strings.xml")).toContain('<string name="app_name">Lumen</string>');
    expect(JSON.parse(read("capacitor.config.json")).appId).toBe("com.lumen.editor");
    expect(read("android/app/build.gradle")).toContain('applicationId "com.lumen.editor"');
  });

  it("iOS: web build → cap sync → archive; unsigned archive and unsigned IPA without the secrets, exportArchive with them", () => {
    const archive = runOf("ios", /^Archive/);
    expect(archive).toContain("-project ios/App/App.xcodeproj -scheme App");
    expect(archive).toContain("CODE_SIGNING_ALLOWED=NO");
    expect(archive).toContain("CODE_SIGN_STYLE=Manual");
    const ipa = runOf("ios", /^IPA$/);
    expect(ipa).toContain("-exportArchive");
    expect(ipa).toContain("Lumen-unsigned.ipa");
    expect(ipa).toContain("ios/exportOptions.plist");
    const signing = steps("ios").find((s) => s.name?.startsWith("Signing certificate"))!;
    expect(signing.if).toBe("env.HAS_SIGNING == 'true'");
    expect(wf.jobs.ios.env?.HAS_SIGNING).toBe("${{ secrets.IOS_CERTIFICATE_P12_BASE64 != '' }}");
    const upload = steps("ios").find((s) => s.uses?.startsWith("actions/upload-artifact"))!;
    expect(upload.with?.path).toBe("build/ipa/*.ipa");
    // The scheme xcodebuild is given exists and points at the App target.
    const scheme = read("ios/App/App.xcodeproj/xcshareddata/xcschemes/App.xcscheme");
    const target = /([0-9A-F]{24}) \/\* App \*\/ = \{\s*isa = PBXNativeTarget;/.exec(read("ios/App/App.xcodeproj/project.pbxproj"))![1];
    expect(scheme).toContain(`BlueprintIdentifier = "${target}"`);
    expect(read("ios/exportOptions.plist")).toContain("<key>com.lumen.editor</key>");
  });

  it("the secrets are documented and nothing in the repo stands in for them", () => {
    const doc = read("docs/src/content/docs/self-hosting/mobile.md");
    for (const s of ["ANDROID_KEYSTORE_BASE64", "ANDROID_KEYSTORE_PASSWORD", "ANDROID_KEY_ALIAS", "ANDROID_KEY_PASSWORD", "IOS_CERTIFICATE_P12_BASE64", "IOS_CERTIFICATE_PASSWORD", "IOS_PROVISIONING_PROFILE_BASE64", "IOS_PROVISIONING_PROFILE_NAME", "APPLE_TEAM_ID"]) {
      expect(doc, s).toContain(s);
      expect(read("docs/archive/workflows/mobile.yml")).toContain(`secrets.${s}`);
    }
    expect(existsSync(join(ROOT, "docs/src/content/docs/he/self-hosting/mobile.md"))).toBe(true);
  });
});

describe("Safari eviction reminder (13.3.3)", () => {
  const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
  const iphone = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/123.0 Mobile/15E148 Safari/604.1";
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
  const firefox = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:125.0) Gecko/20100101 Firefox/125.0";
  const base: ReminderEnv = { status: "denied", userAgent: safari, standalone: false, native: false, now: 1_000_000_000_000, shownAt: null };

  it("recognises Safari and every iOS browser, not Chrome or Firefox", () => {
    expect(isWebKitBrowser(safari)).toBe(true);
    expect(isWebKitBrowser(iphone)).toBe(true);
    expect(isWebKitBrowser(chrome)).toBe(false);
    expect(isWebKitBrowser(firefox)).toBe(false);
  });

  it("reminds when storage is not persisted in a WebKit browser that is neither installed nor native", () => {
    expect(shouldRemind(base)).toBe(true);
    expect(shouldRemind({ ...base, status: "unsupported" })).toBe(true);
    expect(shouldRemind({ ...base, status: "persisted" })).toBe(false);
    expect(shouldRemind({ ...base, standalone: true })).toBe(false);
    expect(shouldRemind({ ...base, native: true })).toBe(false);
    expect(shouldRemind({ ...base, userAgent: chrome })).toBe(false);
  });

  it("at most once a week", () => {
    expect(shouldRemind({ ...base, shownAt: base.now - REMINDER_EVERY_MS + 1 })).toBe(false);
    expect(shouldRemind({ ...base, shownAt: base.now - REMINDER_EVERY_MS })).toBe(true);
  });

  it("is loaded lazily after the persistence request, and its strings are in every locale", () => {
    const main = read("src/main.tsx");
    expect(main).toMatch(/requestPersistentStorage\(\)\.then\(\(status\) => \{\s*if \(status !== "persisted"\) void import\("\.\/storage\/evictionReminder"\)/);
    // English ships with the lazy chunk (src/i18n/lazy/eviction.json), not the startup bundle.
    const en = read("src/i18n/lazy/eviction.json");
    expect(read("src/i18n/index.ts")).not.toContain('"storage.eviction.');
    for (const lang of ["he", "ar", "ru", "fr", "de", "ja", "zh-CN"]) {
      // The per-domain layout (plan 0.3): every domain file of the language.
      const bundle = readLocale(lang) as Record<string, string>;
      for (const k of ["storage.eviction.title", "storage.eviction.body", "storage.eviction.export"]) {
        expect(en, `en ${k}`).toContain(`"${k}":`);
        expect(bundle[k], `${lang} ${k}`).toBeTruthy();
      }
    }
  });
});

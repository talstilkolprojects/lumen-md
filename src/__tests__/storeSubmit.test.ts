/**
 * Plan 13.7 — store submission prep: listings within every store's limits
 * in English and Hebrew (App Store keywords counted in UTF-8 bytes), the
 * fastlane metadata and privacy answers generated and current, the
 * screenshot plan at the stores' exact sizes, and the desktop manifests.
 * The submission itself is Tal's (15.7).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { desktopManifests, fastlaneFiles, LIMITS, listingProblems, privacyAnswers, sumOf } from "../../scripts/lib/store.mjs";
// @ts-expect-error — plain .mjs helpers without types
import { plan, seedName } from "../../scripts/lib/screenshots.mjs";

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), "utf8");
const listing = JSON.parse(read("store/listing.json"));
const labels = JSON.parse(read("store/privacy-labels.json"));

describe("listings", () => {
  it("are within every store's limits, in English and Hebrew", () => {
    expect(listingProblems(listing)).toEqual([]);
    expect(Object.keys(listing.locales)).toEqual(["en", "he"]);
  });

  it("App Store keywords are counted in bytes: Hebrew letters take two", () => {
    const he = listing.locales.he.keywords;
    expect(Buffer.byteLength(he, "utf8")).toBeLessThanOrEqual(LIMITS.apple.keywords.max);
    expect(Buffer.byteLength(he, "utf8")).toBeGreaterThan([...he].length);
    const tooLong = structuredClone(listing);
    tooLong.locales.he.keywords = "פתקים,עברית,כתיבה,סיכומים,מחקר,יומן,פרטי,מסמכים,תיעוד,ארגון";
    expect([...tooLong.locales.he.keywords].length).toBeLessThan(100);
    expect(listingProblems(tooLong).join()).toMatch(/keywords: \d+ > 100 bytes/);
  });

  it("refuses competitor names in keywords, superlatives, spaces in keywords, over-long names, missing URLs", () => {
    const mk = (f: (l: typeof listing) => void) => {
      const l = structuredClone(listing);
      f(l);
      return listingProblems(l).join("\n");
    };
    expect(mk((l) => (l.locales.en.keywords += ",obsidian"))).toMatch(/other apps' names/);
    expect(mk((l) => (l.locales.en.promotional = "The best notes app."))).toMatch(/superlatives/);
    expect(mk((l) => (l.locales.en.keywords = "notes, markdown"))).toMatch(/spaces around commas/);
    expect(mk((l) => (l.locales.he.name = "א".repeat(31)))).toMatch(/apple he\.name: 31 > 30/);
    expect(mk((l) => (l.urls.privacy = "http://x"))).toMatch(/urls\.privacy/);
  });

  it("the fastlane files are generated and current (App Store he, Play iw-IL)", () => {
    const files = fastlaneFiles(listing);
    for (const [p, text] of Object.entries(files)) expect(read(p), p).toBe(text);
    expect(files["fastlane/metadata/he/name.txt"]).toBe(`${listing.locales.he.name}\n`);
    expect(files["fastlane/metadata/android/iw-IL/short_description.txt"]).toBe(`${listing.locales.he.short}\n`);
    expect(files["fastlane/metadata/review_information/notes.txt"]).toMatch(/No sign-in is needed/);
  });
});

describe("privacy-label answers", () => {
  it("come from store/privacy-labels.json and are current", () => {
    expect(read("store/privacy-answers.md")).toBe(privacyAnswers(labels));
  });

  it("say no data is collected or tracked, while disclosing the conditional crash reporter", () => {
    const md = privacyAnswers(labels);
    expect(md).toMatch(/collect data from this app\?\* → \*\*No, we do not collect data/);
    expect(md).toMatch(/used to track the user\?\* → \*\*No\*\*/);
    expect(md).toMatch(/required user data types\?\* → \*\*No\*\*/);
    expect(md).toContain("Crash Data");
    expect(md).toContain("VITE_SENTRY_DSN");
    for (const f of labels.optionalFeatures) expect(md).toContain(f.feature);
  });

  it("would say Yes if the labels said data is collected, and refuses an unknown format", () => {
    const l = structuredClone(labels);
    l.apple.dataNotCollected = false;
    l.google.dataCollected = true;
    const md = privacyAnswers(l);
    expect(md).toMatch(/collect data from this app\?\* → \*\*Yes\*\*/);
    expect(md).toMatch(/required user data types\?\* → \*\*Yes\*\*/);
    expect(() => privacyAnswers({ format: "x" })).toThrow(/format/);
  });
});

describe("screenshots", () => {
  const cfg = JSON.parse(read("store/screenshots.json"));

  it("each device's viewport × scale is the store's required size", () => {
    for (const [id, d] of Object.entries(cfg.devices) as Array<[string, { viewport: number[]; scale: number; pixels: number[] }]>) {
      expect([d.viewport[0] * d.scale, d.viewport[1] * d.scale], id).toEqual(d.pixels);
    }
    expect(cfg.devices["iphone-6.9"].pixels).toEqual([1320, 2868]);
    expect(cfg.devices["ipad-13"].pixels).toEqual([2064, 2752]);
  });

  it("every scene in Hebrew and English on every device that fits it, numbered, with an ASCII seed", () => {
    const p = plan(cfg);
    const per = (dev: string, loc: string) => p.filter((s: { device: string; locale: string }) => s.device === dev && s.locale === loc).map((s: { file: string }) => s.file);
    expect(per("iphone-6.9", "he")).toEqual(["01-editor.png", "02-search.png", "03-palette.png", "04-capture.png"]);
    expect(per("desktop", "en")).toEqual(["01-editor.png", "02-search.png", "03-palette.png", "04-graph.png"]);
    expect(p.length).toBe(32);
    for (const s of p) for (const name of Object.keys(s.seed)) expect(/^[a-z0-9-]+\.md$/.test(name), name).toBe(true);
    const he = p.find((s: { locale: string; scene: string }) => s.locale === "he" && s.scene === "editor");
    expect(he.seed[seedName("seminar.md", "he")]).toMatch(/^# סמינר מחקר/);
    expect(he.open).toBe(seedName("seminar.md", "he"));
    // The phone shows reading view; the Hebrew search types a Hebrew word.
    expect(p.find((s: { device: string; scene: string }) => s.device === "android-phone" && s.scene === "editor").mode).toBe("preview");
    expect(p.find((s: { locale: string; scene: string }) => s.locale === "he" && s.scene === "search").type).toBe("ראיון");
  });

  it("scene commands exist in the palette", () => {
    // useCommands.ts, or its per-domain modules once split (plan 0.2).
    const dir = join(root, "src/commands/domains");
    const cmds = [read("src/commands/useCommands.ts"), ...(existsSync(dir) ? readdirSync(dir).map((f) => read(`src/commands/domains/${f}`)) : [])].join("\n");
    for (const s of cfg.scenes.filter((x: { command?: string }) => x.command)) expect(cmds, s.command).toContain(`id: "${s.command}"`);
  });

  it("screenshots are build output, not committed", () => {
    expect(read(".gitignore")).toMatch(/^store\/screenshots\/$/m);
  });
});

describe("desktop manifests", () => {
  const sums = ["a".repeat(64) + "  Lumen_1.2.0_x64-setup.exe", "b".repeat(64) + "  Lumen_1.2.0_universal.dmg", ""].join("\n");
  const m = desktopManifests({ version: "1.2.0", sums, files: { windows: "Lumen_1.2.0_x64-setup.exe", mac: "Lumen_1.2.0_universal.dmg" }, listing });

  it("winget: the installer from the release, its SHA-256 (upper case), MIT, the privacy URL", () => {
    const inst = m["manifests/l/Lumen/Lumen/1.2.0/Lumen.Lumen.installer.yaml"];
    expect(inst).toContain("InstallerUrl: https://github.com/talstilkol/lumen-md/releases/download/v1.2.0/Lumen_1.2.0_x64-setup.exe");
    expect(inst).toContain(`InstallerSha256: ${"A".repeat(64)}`);
    expect(inst).toContain("InstallerType: nullsoft");
    const loc = m["manifests/l/Lumen/Lumen/1.2.0/Lumen.Lumen.locale.en-US.yaml"];
    expect(loc).toContain("License: MIT");
    expect(loc).toContain(`PrivacyUrl: ${listing.urls.privacy}`);
  });

  it("Homebrew cask: version, sha256, a URL templated on the version", () => {
    const cask = m["Casks/l/lumen.rb"];
    expect(cask).toContain('version "1.2.0"');
    expect(cask).toContain(`sha256 "${"b".repeat(64)}"`);
    expect(cask).toContain('url "https://github.com/talstilkol/lumen-md/releases/download/v#{version}/Lumen_#{version}_universal.dmg"');
    expect(cask).toContain('app "Lumen.app"');
  });

  it("refuses betas and missing checksums", () => {
    expect(() => desktopManifests({ version: "1.2.0-beta.1", sums, files: { windows: "x", mac: "y" }, listing })).toThrow(/stable/);
    expect(() => sumOf(sums, "nope.exe")).toThrow(/no entry/);
  });
});

describe("the checklist", () => {
  it("covers each store, closes on a submission (not on approval), and names Tal and 15.7", () => {
    const md = read("store/SUBMISSION.md");
    for (const h of ["## 1. Apple: App Store and TestFlight", "## 2. Google Play: internal testing first", "## 3. Desktop: Microsoft Store, winget, Homebrew"]) expect(md).toContain(h);
    expect(md).toMatch(/closes \*\*when a build is sent for review in at least one store\*\*/);
    expect(md).toContain("15.7");
    expect(existsSync(join(root, "store/privacy-labels.json"))).toBe(true);
  });
});

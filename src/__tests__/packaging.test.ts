/**
 * Plan W1.24 — store and package-manager manifests generated from the
 * release (scripts/lib/packaging.mjs) and their offline checks
 * (scripts/lib/packagingCheck.mjs, winget against its vendored schemas).
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs module without type declarations
import { ARTIFACTS, allPackages, aurPackage, caskDesc, flatpakManifest, homebrewCask, packagingMeta, parseSums, toYaml, wingetManifests, wingetObjects } from "../../scripts/lib/packaging.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { checkAur, checkCask, checkFlatpak, checkWinget } from "../../scripts/lib/packagingCheck.mjs";

const ROOT = resolve(__dirname, "../..");
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const tauri = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8"));
const hex = (c: string) => c.repeat(64);
const meta = (version = "0.1.0") => packagingMeta({ pkg, tauri, version, repo: "talstilkol/lumen-md", licenseSha256: hex("9") });
const sumsFor = (v: string, which = ["macArm", "macIntel", "winExe", "winMsi", "deb"]) =>
  parseSums(which.map((k, i) => `${hex("abcde"[i])}  ${ARTIFACTS[k](v)}`).join("\n"));

describe("metadata", () => {
  it("parses SHA256SUMS (text and binary mode)", () => {
    const m = parseSums(`${hex("A")}  a.dmg\n${hex("b")} *b.exe\nnot a line\n`);
    expect([...m]).toEqual([["a.dmg", hex("a")], ["b.exe", hex("b")]]);
  });

  it("brew's desc rules: no article, no period, at most 80 characters", () => {
    expect(caskDesc("A markdown editor that turns text and data into beautiful documents.")).toBe("Markdown editor that turns text and data into beautiful documents");
    expect(caskDesc("the " + "word ".repeat(30)).length).toBeLessThanOrEqual(80);
  });

  it("ids per store, from the repo and Tauri's product name", () => {
    const m = meta();
    expect([m.caskName, m.wingetId, m.flatpakId, m.aurName]).toEqual(["lumen-md", "Talstilkol.Lumen", "io.github.talstilkol.Lumen", "lumen-md-bin"]);
    expect(m.download("x.deb")).toBe("https://github.com/talstilkol/lumen-md/releases/download/v0.1.0/x.deb");
    expect(() => packagingMeta({ pkg, tauri, version: "1.0.0", repo: null })).toThrow(/owner\/name/);
  });
});

describe("Homebrew cask", () => {
  it("both architectures: arch + two hashes, and it passes the checks (and ruby -c when installed)", () => {
    const r = homebrewCask(meta(), sumsFor("0.1.0"));
    const text = r.files["homebrew/lumen-md.rb"];
    expect(text).toContain(`sha256 arm:   "${hex("a")}",`);
    expect(text).toContain("Lumen_#{version}_#{arch}.dmg");
    expect(checkCask(text)).toEqual([]);
  });

  it("one architecture: one hash, no arch; none: skipped", () => {
    const r = homebrewCask(meta(), sumsFor("0.1.0", ["macArm"]));
    expect(r.files["homebrew/lumen-md.rb"]).not.toContain("arch arm:");
    expect(r.note).toMatch(/one architecture/);
    expect(checkCask(r.files["homebrew/lumen-md.rb"])).toEqual([]);
    expect(homebrewCask(meta(), sumsFor("0.1.0", ["deb"])).skipped).toMatch(/not in SHA256SUMS/);
  });

  it("the check catches a bad hash, an article in desc, and stanza order", () => {
    const good = homebrewCask(meta(), sumsFor("0.1.0")).files["homebrew/lumen-md.rb"] as string;
    expect(checkCask(good.replace(hex("a"), "abc"))).toContain("cask: bad sha256 abc");
    expect(checkCask(good.replace('desc "Markdown', 'desc "A markdown'))).toContain("cask: desc starts with an article");
    const swapped = good.replace(/(  name "Lumen"\n)(  desc "[^"]*"\n)/, "$2$1");
    expect(checkCask(swapped)).toContain("cask: stanzas are out of brew style's order");
  });
});

describe("winget", () => {
  it("three manifests that pass the official 1.6.0 schemas", () => {
    const r = wingetManifests(meta(), sumsFor("0.1.0"));
    expect(Object.keys(r.files)).toEqual([
      "winget/manifests/t/Talstilkol/Lumen/0.1.0/Talstilkol.Lumen.yaml",
      "winget/manifests/t/Talstilkol/Lumen/0.1.0/Talstilkol.Lumen.installer.yaml",
      "winget/manifests/t/Talstilkol/Lumen/0.1.0/Talstilkol.Lumen.locale.en-US.yaml",
    ]);
    expect(checkWinget(r.objects)).toEqual([]);
    expect(r.objects.installer.Installers.map((i: { InstallerType: string }) => i.InstallerType)).toEqual(["nullsoft", "wix"]);
    expect(r.objects.installer.Installers[0].InstallerSha256).toBe(hex("C"));
  });

  it("the schema check catches what winget-pkgs validation would", () => {
    const o = wingetObjects(meta(), sumsFor("0.1.0"));
    o.installer.Installers[0].InstallerSha256 = "123";
    o.installer.Installers[0].InstallerType = "zipx";
    o.defaultLocale.ShortDescription = "";
    const problems = checkWinget(o);
    expect(problems.some((p: string) => p.includes("InstallerSha256"))).toBe(true);
    expect(problems.some((p: string) => p.includes("InstallerType"))).toBe(true);
    expect(problems.some((p: string) => p.includes("ShortDescription"))).toBe(true);
    const o2 = wingetObjects(meta(), sumsFor("0.1.0"));
    o2.version.PackageVersion = "9.9.9";
    expect(checkWinget(o2)).toContain("winget: the files disagree on identifier/version: Talstilkol.Lumen@9.9.9, Talstilkol.Lumen@0.1.0");
  });

  it("YAML: every string quoted, lists of maps indented as winget's files are", () => {
    expect(toYaml({ A: "x: y", B: [{ C: "1", D: 2 }], E: ["t"] })).toBe('A: "x: y"\nB:\n- C: "1"\n  D: 2\nE:\n- "t"');
  });
});

describe("Flathub", () => {
  it("manifest + metainfo from the .deb, passing the checks", () => {
    const r = flatpakManifest(meta(), sumsFor("0.1.0"), { date: new Date("2026-11-10") });
    const xml = r.files["flatpak/io.github.talstilkol.Lumen.metainfo.xml"];
    expect(checkFlatpak(r.manifest, xml)).toEqual([]);
    expect(xml).toContain('<release version="0.1.0" date="2026-11-10">');
    expect(r.manifest.modules[0].sources[0].sha256).toBe(hex("e"));
  });

  it("the check catches a broad permission, a missing hash and a broken metainfo", () => {
    const r = flatpakManifest(meta(), sumsFor("0.1.0"));
    const xml = r.files["flatpak/io.github.talstilkol.Lumen.metainfo.xml"] as string;
    const m = structuredClone(r.manifest);
    m["finish-args"].push("--filesystem=home");
    delete m.modules[0].sources[0].sha256;
    const p = checkFlatpak(m, xml.replace("<content_rating type=\"oars-1.1\"/>", "").replace("</description>", ""));
    expect(p).toContain("flatpak: Flathub rejects --filesystem=home without a reason");
    expect(p.some((x: string) => /needs a sha256/.test(x))).toBe(true);
    expect(p).toContain("metainfo: missing <content_rating>");
    expect(p.some((x: string) => /closes the wrong element|is not closed/.test(x))).toBe(true);
  });
});

describe("AUR", () => {
  it("PKGBUILD + .SRCINFO that agree (and bash -n when installed)", () => {
    const r = aurPackage(meta(), sumsFor("0.1.0"));
    expect(checkAur(r.files["aur/lumen-md-bin/PKGBUILD"], r.files["aur/lumen-md-bin/.SRCINFO"])).toEqual([]);
  });

  it("a pre-release: pacman's pkgver without a hyphen, the URLs with the real version", () => {
    const r = aurPackage(meta("0.2.0-beta.1"), sumsFor("0.2.0-beta.1"));
    const b = r.files["aur/lumen-md-bin/PKGBUILD"] as string;
    expect(b).toContain("pkgver=0.2.0_beta.1\n");
    expect(b).toContain("_ver=0.2.0-beta.1\n");
    expect(b).toContain("releases/download/v${_ver}/Lumen_${_ver}_amd64.deb");
    expect(checkAur(b, r.files["aur/lumen-md-bin/.SRCINFO"])).toEqual([]);
  });

  it("the check catches a .SRCINFO that drifted", () => {
    const r = aurPackage(meta(), sumsFor("0.1.0"));
    expect(checkAur(r.files["aur/lumen-md-bin/PKGBUILD"], (r.files["aur/lumen-md-bin/.SRCINFO"] as string).replace(hex("e"), hex("f")))).toContain(".SRCINFO: sha256sums_x86_64 differs from the PKGBUILD");
    expect(aurPackage({ ...meta(), licenseSha256: null }, sumsFor("0.1.0")).skipped).toMatch(/LICENSE/);
  });
});

describe("release.mjs packages", () => {
  it("writes every format from release/SHA256SUMS, checked, and refuses without SHA256SUMS", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-packages-"));
    try {
      const run = () => spawnSync(process.execPath, [join(ROOT, "scripts/release.mjs"), "packages", "--dir", dir, "--repo", "talstilkol/lumen-md"], { cwd: ROOT, encoding: "utf8" });
      const missing = run();
      expect(missing.status).toBe(1);
      expect(missing.stderr).toMatch(/SHA256SUMS is missing/);
      writeFileSync(join(dir, "SHA256SUMS"), [...sumsFor(pkg.version)].map(([f, h]) => `${h}  ${f}`).join("\n") + "\n");
      const ok = run();
      expect(ok.stderr).toBe("");
      expect(ok.status).toBe(0);
      expect(ok.stdout).toMatch(/homebrew\s+written/);
      expect(ok.stdout).toMatch(/aur\s+written/);
      for (const f of ["homebrew/lumen-md.rb", "flatpak/io.github.talstilkol.Lumen.json", "aur/lumen-md-bin/PKGBUILD", `winget/manifests/t/Talstilkol/Lumen/${pkg.version}/Talstilkol.Lumen.installer.yaml`]) expect(existsSync(join(dir, "packages", f)), f).toBe(true);
      const lic = allPackages(meta(pkg.version), sumsFor(pkg.version)).report.map((r: { status: string }) => r.status);
      expect(lic).toEqual(["written", "written", "written", "written"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the vendored winget schemas carry their MIT licence and source", () => {
    expect(readFileSync(join(ROOT, "scripts/vendor/winget-schemas/LICENSE"), "utf8")).toContain("Copyright (c) Microsoft Corporation");
    expect(readFileSync(join(ROOT, "scripts/vendor/winget-schemas/SOURCE.md"), "utf8")).toContain("7de3b02def71f06e43cda719d52bc379c00e9021");
  });
});

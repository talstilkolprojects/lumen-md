/**
 * Plan 13.4 — the release pipeline: semver from Conventional Commits, the
 * changelog, every manifest bumped in lock-step, notes, signed checksums,
 * and a local script that runs every step without GitHub Actions.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bumpManifests,
  changelogSection,
  insertChangelog,
  nextVersion,
  parseCommits,
  parseVersion,
  releaseNotes,
  sha256sums,
  tagOf,
  verifySums,
  // @ts-expect-error — plain .mjs helpers without types
} from "../../scripts/lib/release.mjs";

const root = join(__dirname, "..", "..");
const log = (...rows: [string, string, string?][]) => rows.map(([h, s, b = ""]) => `${h}\x1f${s}\x1f${b}\x1e`).join("\n");

describe("next version (13.4.1)", () => {
  it("reads Conventional Commits, and drops [skip ci] from subjects", () => {
    const c = parseCommits(log(["a1", "feat(canvas): JSON Canvas import [skip ci]"], ["b2", "fix: no crash"], ["c3", "refactor!: new store"], ["d4", "chore: tidy", "BREAKING CHANGE: config moved"], ["e5", "Merge branch x"]));
    expect(c).toEqual([
      { hash: "a1", type: "feat", scope: "canvas", breaking: false, subject: "JSON Canvas import" },
      { hash: "b2", type: "fix", scope: null, breaking: false, subject: "no crash" },
      { hash: "c3", type: "refactor", scope: null, breaking: true, subject: "new store" },
      { hash: "d4", type: "chore", scope: null, breaking: true, subject: "tidy" },
      { hash: "e5", type: "other", scope: null, breaking: false, subject: "Merge branch x" },
    ]);
  });

  it("feat → minor, fix/perf → patch, breaking → major (minor before 1.0), nothing → null", () => {
    const c = (s: string) => parseCommits(log(["h", s]));
    expect(nextVersion("1.2.3", c("fix: x"))).toBe("1.2.4");
    expect(nextVersion("1.2.3", c("perf: x"))).toBe("1.2.4");
    expect(nextVersion("1.2.3", c("feat: x"))).toBe("1.3.0");
    expect(nextVersion("1.2.3", c("feat!: x"))).toBe("2.0.0");
    expect(nextVersion("0.1.0", c("feat!: x"))).toBe("0.2.0");
    expect(nextVersion("0.1.0", c("feat: x"))).toBe("0.2.0");
    expect(nextVersion("1.2.3", c("docs: x"))).toBeNull();
    expect(nextVersion("2.0.0-rc.2", c("fix: x"))).toBe("2.0.0");
    expect(() => parseVersion("1.2")).toThrow();
    expect(tagOf("1.2.3")).toBe("v1.2.3");
  });
});

describe("changelog and notes (13.4.1)", () => {
  const commits = parseCommits(log(["abcdef1234", "feat(publish): own site"], ["1234567abc", "fix(ui): focus"], ["9999999999", "feat!: drop tldraw"], ["8888888888", "chore: bump"]));

  it("groups a version's commits under Keep a Changelog headings, chores left out", () => {
    const s = changelogSection("0.2.0", commits, { date: new Date("2026-11-10T12:00:00Z"), repo: "o/r" });
    expect(s).toBe(
      [
        "## [0.2.0] - 2026-11-10",
        "",
        "### ⚠ Breaking changes",
        "",
        "- drop tldraw ([9999999](https://github.com/o/r/commit/9999999999))",
        "",
        "### Added",
        "",
        "- **publish:** own site ([abcdef1](https://github.com/o/r/commit/abcdef1234))",
        "",
        "### Fixed",
        "",
        "- **ui:** focus ([1234567](https://github.com/o/r/commit/1234567abc))",
        "",
      ].join("\n"),
    );
  });

  it("goes under [Unreleased], above the previous version; its notes come back out", () => {
    const before = "# Changelog\n\nintro\n\n## [Unreleased]\n\n- wip\n\n## [0.1.0] - 2026-01-01\n\n- first\n";
    const s = changelogSection("0.2.0", commits, { date: new Date("2026-11-10T00:00:00Z") });
    const after = insertChangelog(before, s);
    expect(after.indexOf("## [Unreleased]")).toBeLessThan(after.indexOf("## [0.2.0]"));
    expect(after.indexOf("## [0.2.0]")).toBeLessThan(after.indexOf("## [0.1.0]"));
    expect(after).toContain("- wip");
    expect(releaseNotes(after, "v0.2.0")).toContain("- **publish:** own site");
    expect(releaseNotes(after, "0.2.0")).not.toContain("first");
    expect(releaseNotes(after, "0.1.0")).toBe("- first\n");
    expect(releaseNotes(after, "9.9.9")).toBeNull();
    // The repo's own CHANGELOG.md has an [Unreleased] block: the new version lands after it.
    const real = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    const next = insertChangelog(real, s);
    expect(next.startsWith(real.slice(0, real.indexOf("## [Unreleased]")))).toBe(true);
    expect(releaseNotes(next, "0.2.0")).toContain("own site");
  });
});

describe("every manifest in lock-step (13.4.1)", () => {
  it("package.json, package-lock.json, tauri.conf.json, Cargo.toml and the iOS project — and nothing else changes", () => {
    const paths = ["package.json", "package-lock.json", "src-tauri/tauri.conf.json", "src-tauri/Cargo.toml", "ios/App/App.xcodeproj/project.pbxproj"];
    const files = Object.fromEntries(paths.map((p) => [p, readFileSync(join(root, p), "utf8")]));
    const out = bumpManifests(files, "0.2.0");
    expect(Object.keys(out).sort()).toEqual([...paths].sort());
    expect(JSON.parse(out["package.json"]).version).toBe("0.2.0");
    const lock = JSON.parse(out["package-lock.json"]);
    expect([lock.version, lock.packages[""].version]).toEqual(["0.2.0", "0.2.0"]);
    expect(JSON.parse(out["src-tauri/tauri.conf.json"]).version).toBe("0.2.0");
    expect(out["src-tauri/Cargo.toml"]).toMatch(/^\[package\]\nname = "lumen"\nversion = "0\.2\.0"/);
    expect(out["ios/App/App.xcodeproj/project.pbxproj"].match(/MARKETING_VERSION = 0\.2\.0;/g)).toHaveLength(2);
    expect(out["ios/App/App.xcodeproj/project.pbxproj"]).toMatch(/CURRENT_PROJECT_VERSION = 2;/);
    // Only the version lines differ: formatting, dependency versions and other entries stay.
    for (const p of paths) {
      const a = files[p].split("\n");
      const b = out[p].split("\n");
      expect(b.length, p).toBe(a.length);
      const changed = a.filter((line, i) => line !== b[i]);
      expect(changed.every((l) => /version|VERSION/.test(l)), `${p}: ${changed.join(" | ")}`).toBe(true);
    }
    // Dependencies' versions in the lockfile are untouched.
    expect(lock.packages["node_modules/react"]?.version).toBe(JSON.parse(files["package-lock.json"]).packages["node_modules/react"]?.version);
  });
});

describe("checksums (13.4.2)", () => {
  it("SHA256SUMS in sha256sum's format, verified file by file", () => {
    const entries = [
      { name: "lumen-web-v0.2.0.tgz", data: Buffer.from("web") },
      { name: "Lumen_0.2.0_x64.dmg", data: Buffer.from("dmg") },
    ];
    const sums = sha256sums(entries);
    expect(sums.split("\n").filter(Boolean)).toHaveLength(2);
    expect(sums).toMatch(/^[0-9a-f]{64} {2}Lumen_0\.2\.0_x64\.dmg\n[0-9a-f]{64} {2}lumen-web-v0\.2\.0\.tgz\n$/);
    expect(verifySums(sums, entries)).toEqual([]);
    // One file tampered with, the other missing: both reported.
    expect(verifySums(sums, [{ ...entries[0], data: Buffer.from("tampered") }])).toEqual(["Lumen_0.2.0_x64.dmg", "lumen-web-v0.2.0.tgz"]);
  });
});

describe("the local pipeline (13.4) — no GitHub Actions needed", () => {
  it("plan → prepare --commit --tag in a scratch repository: versions bumped, changelog written, tagged", () => {
    const d = mkdtempSync(join(tmpdir(), "lumen-release-"));
    const sh = (...a: string[]) => execFileSync("git", a, { cwd: d, encoding: "utf8" });
    sh("init", "-q");
    sh("config", "user.email", "t@example.com");
    sh("config", "user.name", "t");
    mkdirSync(join(d, "src-tauri"));
    writeFileSync(join(d, "package.json"), JSON.stringify({ name: "x", version: "0.1.0" }, null, 2) + "\n");
    writeFileSync(join(d, "src-tauri/tauri.conf.json"), JSON.stringify({ version: "0.1.0" }, null, 2) + "\n");
    writeFileSync(join(d, "src-tauri/Cargo.toml"), '[package]\nname = "lumen"\nversion = "0.1.0"\n\n[dependencies]\nserde = { version = "1" }\n');
    writeFileSync(join(d, "CHANGELOG.md"), "# Changelog\n\n## [Unreleased]\n");
    sh("add", "-A");
    sh("commit", "-qm", "chore: init");
    sh("tag", "-a", "v0.1.0", "-m", "v0.1.0");
    writeFileSync(join(d, "a.txt"), "a");
    sh("add", "-A");
    sh("commit", "-qm", "feat(site): publish [skip ci]");
    const script = join(root, "scripts", "release.mjs");
    const plan = execFileSync("node", [script, "plan"], { cwd: d, encoding: "utf8" });
    expect(plan).toContain("next: 0.2.0 (v0.2.0)");
    execFileSync("node", [script, "prepare", "--commit", "--tag"], { cwd: d, encoding: "utf8" });
    expect(JSON.parse(readFileSync(join(d, "package.json"), "utf8")).version).toBe("0.2.0");
    expect(readFileSync(join(d, "src-tauri/Cargo.toml"), "utf8")).toContain('version = "0.2.0"\n\n[dependencies]\nserde = { version = "1" }');
    expect(readFileSync(join(d, "CHANGELOG.md"), "utf8")).toMatch(/## \[0\.2\.0\] - \d{4}-\d\d-\d\d\n\n### Added\n\n- \*\*site:\*\* publish\n/);
    expect(sh("describe", "--tags").trim()).toBe("v0.2.0");
    expect(sh("log", "-1", "--format=%s").trim()).toBe("chore(release): 0.2.0");
    expect(execFileSync("node", [script, "notes", "0.2.0"], { cwd: d, encoding: "utf8" })).toBe("### Added\n\n- **site:** publish\n");
    // Nothing more to release right after a release.
    expect(execFileSync("node", [script, "plan"], { cwd: d, encoding: "utf8" })).toContain("nothing to release");
  });

  it("verify: a release folder passes, a tampered file fails", () => {
    const d = mkdtempSync(join(tmpdir(), "lumen-rel-out-"));
    writeFileSync(join(d, "a.tgz"), "a");
    writeFileSync(join(d, "SHA256SUMS"), sha256sums([{ name: "a.tgz", data: Buffer.from("a") }]));
    const script = join(root, "scripts", "release.mjs");
    expect(execFileSync("node", [script, "verify", d], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).toContain("checksums OK");
    writeFileSync(join(d, "a.tgz"), "b");
    expect(() => execFileSync("node", [script, "verify", d], { stdio: "ignore" })).toThrow();
  });

  it("the workflow is kept, runs on a tag, and uses the script's notes", () => {
    const wf = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");
    expect(wf).toMatch(/tags: \["v\*"\]/);
    expect(wf).toContain("node scripts/release.mjs notes");
    expect(wf).toContain("node scripts/release.mjs build");
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.scripts.release).toBe("node scripts/release.mjs");
  });
});

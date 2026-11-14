/**
 * The translation files' layout (plan 0.3): one sorted JSON file per
 * language and domain, so parallel branches that add strings do not
 * conflict. The merge tests run the real scripts in throwaway git repos.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DOMAINS,
  KEYS_DIR,
  LOCALES_DIR,
  ROOT,
  domainOf,
  listLocales,
  readLocale,
} from "../../scripts/lib/i18n-files.mjs";

describe("i18n layout", () => {
  it("has a folder per language and no old single-file bundles", () => {
    expect(listLocales()).toEqual(["ar", "de", "en", "fr", "he", "ja", "ru", "zh-CN"]);
    expect(readdirSync(LOCALES_DIR).filter((n) => n.endsWith(".json"))).toEqual([]);
    expect(existsSync(join(ROOT, "i18n", "keys.json"))).toBe(false);
    expect(readFileSync(join(ROOT, "src", "i18n", "index.ts"), "utf8")).not.toMatch(/const en:\s*Strings\s*=\s*\{/);
  });

  it("keeps every key in its domain's file, sorted", () => {
    for (const lang of listLocales()) {
      for (const name of readdirSync(join(LOCALES_DIR, lang))) {
        const domain = name.replace(/\.json$/, "");
        expect(Object.keys(DOMAINS), `${lang}/${name}`).toContain(domain);
        const keys = Object.keys(JSON.parse(readFileSync(join(LOCALES_DIR, lang, name), "utf8")) as object);
        expect(keys.filter((k) => domainOf(k) !== domain), `${lang}/${name}: keys of another domain`).toEqual([]);
        expect(keys, `${lang}/${name} is not sorted`).toEqual([...keys].sort());
      }
    }
  });

  it("puts a key by its first segment, unknown ones in common", () => {
    expect(domainOf("cmd.view.zen")).toBe("cmd");
    expect(domainOf("ai.toast.x")).toBe("ai");
    expect(domainOf("canvas.close")).toBe("canvas");
    expect(domainOf("themeSettings.title")).toBe("settings");
    expect(domainOf("brandNewFeature.title")).toBe("common");
  });

  it("is what i18n-split and extract-i18n-keys would write (CI gate)", () => {
    for (const script of ["scripts/i18n-split.mjs", "scripts/extract-i18n-keys.mjs"]) {
      const r = spawnSync(process.execPath, [script, "--check"], { cwd: ROOT, encoding: "utf8" });
      expect(r.status, `${script} --check: ${r.stderr}`).toBe(0);
    }
    expect(readdirSync(KEYS_DIR).sort()).toEqual(
      Object.keys(DOMAINS)
        .map((d) => `${d}.json`)
        .sort(),
    );
  });
});

// ── Parallel lanes, merged in a scratch git repository ──────────────────────

let repo = "";
function git(...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=lane", "-c", "user.email=lane@example.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
}
function node(script: string, ...args: string[]) {
  return spawnSync(process.execPath, [join(repo, script), ...args], { cwd: repo, encoding: "utf8" });
}
/** Add a key the way a lane does: into the domain file, then normalise with the scripts. */
function addKey(key: string, en: string, he: string): void {
  for (const [lang, value] of [["en", en], ["he", he]] as const) {
    const file = join(repo, "src/i18n/locales", lang, `${domainOf(key)}.json`);
    const map = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    map[key] = value; // appended out of order on purpose: the script sorts
    writeFileSync(file, JSON.stringify(map, null, 2) + "\n");
  }
  expect(node("scripts/i18n-split.mjs").status).toBe(0);
  expect(node("scripts/extract-i18n-keys.mjs").status).toBe(0);
}
function lane(branch: string, key: string): void {
  git("checkout", "-q", "-b", branch, "base");
  addKey(key, `English ${key}`, `עברית ${key}`);
  git("add", "-A");
  git("commit", "-q", "-m", `add ${key}`);
}
function mergeClean(into: string, from: string) {
  git("checkout", "-q", into);
  const r = spawnSync("git", ["-c", "user.name=lane", "-c", "user.email=lane@example.invalid", "merge", "--no-edit", from], {
    cwd: repo,
    encoding: "utf8",
  });
  const conflicts = git("diff", "--name-only", "--diff-filter=U").trim();
  return { status: r.status, conflicts, out: r.stdout + r.stderr };
}

describe("two lanes adding strings", () => {
  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "lumen-i18n-lanes-"));
    for (const p of ["src/i18n", "i18n", "scripts/lib", "scripts/i18n-split.mjs", "scripts/extract-i18n-keys.mjs"]) {
      cpSync(join(ROOT, p), join(repo, p), { recursive: true });
    }
    git("init", "-q", "-b", "base");
    git("add", "-A");
    git("commit", "-q", "-m", "base");
  });
  afterAll(() => {
    if (repo) rmSync(repo, { recursive: true, force: true });
  });

  it("in different domains merge with zero conflicts", () => {
    lane("lane-ai", "ai.lane.summarise");
    lane("lane-canvas", "canvas.lane.snap");
    const r = mergeClean("lane-ai", "lane-canvas");
    expect(r.conflicts, r.out).toBe("");
    expect(r.status, r.out).toBe(0);
    // Both strings survived, and the merged tree needs no fixing.
    expect(readLocale("en", join(repo, "src/i18n/locales"))).toMatchObject({
      "ai.lane.summarise": "English ai.lane.summarise",
      "canvas.lane.snap": "English canvas.lane.snap",
    });
    expect(node("scripts/i18n-split.mjs", "--check").status).toBe(0);
    expect(node("scripts/extract-i18n-keys.mjs", "--check").status).toBe(0);
  });

  it("in one domain, at different places, merge with zero conflicts too", () => {
    lane("lane-cmd-a", "cmd.aaLane.first");
    lane("lane-cmd-z", "cmd.view.zzLane");
    const r = mergeClean("lane-cmd-a", "lane-cmd-z");
    expect(r.conflicts, r.out).toBe("");
    expect(r.status, r.out).toBe(0);
    expect(node("scripts/i18n-split.mjs", "--check").status).toBe(0);
  });

  it("--absorb re-applies an old-layout branch's strings after a rebase", () => {
    // A branch from before the split: one en bundle inline in index.ts, one he.json.
    git("checkout", "-q", "-b", "old-base", "base");
    const en = readLocale("en", join(repo, "src/i18n/locales"));
    const he = readLocale("he", join(repo, "src/i18n/locales"));
    const index = join(repo, "src/i18n/index.ts");
    const newIndex = readFileSync(index, "utf8");
    const oldIndex = (map: Record<string, string>) =>
      newIndex.replace(
        /^\/\/ English, the fallback[\s\S]*?^const en: Strings = .*\n/m,
        `const en: Strings = {\n${Object.entries(map).map(([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)},`).join("\n")}\n};\n`,
      );
    writeFileSync(index, oldIndex(en));
    rmSync(join(repo, "src/i18n/locales/en"), { recursive: true });
    rmSync(join(repo, "src/i18n/locales/he"), { recursive: true });
    writeFileSync(join(repo, "src/i18n/locales/he.json"), JSON.stringify(he, null, 2) + "\n");
    git("add", "-A");
    git("commit", "-q", "-m", "old layout");
    git("checkout", "-q", "-b", "old-lane", "old-base");
    writeFileSync(index, oldIndex({ ...en, "toast.oldLane": "Old lane" }));
    writeFileSync(join(repo, "src/i18n/locales/he.json"), JSON.stringify({ ...he, "toast.oldLane": "נתיב ישן" }, null, 2) + "\n");
    git("commit", "-q", "-am", "old lane adds a toast");
    const oldTip = git("rev-parse", "HEAD").trim();
    // The base moved to the new layout (and gained a string of its own).
    git("checkout", "-q", "-b", "new-base", "old-base");
    expect(node("scripts/i18n-split.mjs").status).toBe(0);
    git("add", "-A");
    git("commit", "-q", "-m", "split");
    addKey("files.baseMoved", "Base", "בסיס");
    git("add", "-A");
    git("commit", "-q", "-m", "base adds a string");
    // The lane rebased, taking the base's side of every i18n file, then absorbs its own strings.
    git("checkout", "-q", "-b", "rebased", "new-base");
    const r = node("scripts/i18n-split.mjs", "--absorb", oldTip);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("en: +1 ~0 -0");
    const after = readLocale("en", join(repo, "src/i18n/locales"));
    expect(after["toast.oldLane"]).toBe("Old lane");
    expect(after["files.baseMoved"]).toBe("Base");
    expect(readLocale("he", join(repo, "src/i18n/locales"))["toast.oldLane"]).toBe("נתיב ישן");
    expect(Object.keys(after).length).toBe(Object.keys(en).length + 2);
  });
});

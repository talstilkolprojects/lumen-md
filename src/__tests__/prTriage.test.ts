/**
 * Plan W6.21 — `node scripts/pr-triage.mjs`: every open PR in one category
 * (in main, in a train, superseded, dependabot, a train, still needed), on
 * planted data and on a throwaway git repository with a real history.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs module without type declarations
import { classify, closeComment, counts, ownerCommands, supersededNumbers, taskIds } from "../../scripts/lib/prTriage.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { END, gitOracle, renderSection, spliceSection, START } from "../../scripts/pr-triage.mjs";

type Pr = { number: number; title: string; body?: string; user?: string; head: string; sha: string; base: string };
type Row = { number: number; category: string; why: string; trains: string[]; by: number | null };

const pr = (number: number, sha: string, extra: Partial<Pr> = {}): Pr => ({ number, title: `feat: ${number}`, body: "", user: "talstilkol", head: `feat/${number}`, sha, base: "main", ...extra });

describe("pr-triage rules", () => {
  it("reads plan task ids from a title, not version numbers", () => {
    expect([...taskIds("feat(x): thing (plan 4.19) and W6.21 [skip ci]")]).toEqual(["4.19", "W6.21"]);
    expect([...taskIds("chore(tauri): Bump tauri from 2.12.4 to 2.12.5")]).toEqual([]);
  });

  it("finds 'Supersedes #N', not 'replaces #N's filter'", () => {
    expect([...supersededNumbers("Supersedes #12 and #13.\nReplaces #40, #41")]).toEqual([12, 13, 40, 41]);
    expect([...supersededNumbers("this replaces #232's filter function; instead of #240")]).toEqual([]);
  });

  it("puts each PR in the first category that fits, and errs towards needed", () => {
    // a ⊂ main; b ⊂ train-2 only; c ⊂ later PR 9 of the same task; d explicit; e nothing.
    const anc: Record<string, string[]> = { a: ["main", "verify/train", "verify/train-2"], b: ["verify/train-2"], c: ["s9"], d: [], e: [], t: [], s9: [], dep: ["main"] };
    const contains = (sha: string, ref: string) => sha === ref || (anc[sha] ?? []).includes(ref);
    const prs = [
      pr(1, "a"),
      pr(2, "b"),
      pr(3, "c", { title: "feat: part one (plan 4.19)" }),
      pr(4, "d"),
      pr(5, "e"),
      pr(6, "t", { head: "verify/train-2", base: "verify/train" }),
      pr(7, "dep", { user: "dependabot[bot]", head: "dependabot/npm/x" }),
      pr(8, "s8", { body: "Supersedes #4." }),
      pr(9, "s9", { title: "feat: part two (plan 4.19)" }),
    ];
    const rows = classify(prs, { contains, trains: ["verify/train", "verify/train-2"] }) as Row[];
    const cat = Object.fromEntries(rows.map((r) => [r.number, r.category]));
    expect(cat).toEqual({ 1: "in-main", 2: "in-train", 3: "superseded", 4: "superseded", 5: "needed", 6: "train", 7: "dependabot", 8: "needed", 9: "needed" });
    expect(rows[1]).toMatchObject({ trains: ["verify/train-2"], why: "head b is in verify/train-2 (#6)" });
    expect(rows[2]).toMatchObject({ by: 9 });
    expect(rows[3]).toMatchObject({ by: 8, why: "#8 says it supersedes this PR" });
    expect(counts(rows)).toEqual({ "in-main": 1, "in-train": 1, superseded: 2, dependabot: 1, train: 1, needed: 3 });
  });

  it("owner commands close only while the head is in main, never delete a branch, and comment in English and Hebrew", () => {
    const rows = [
      { number: 1, category: "in-main", why: "", trains: [], by: null },
      { number: 2, category: "in-train", why: "", trains: ["verify/train-2"], by: null },
      { number: 3, category: "superseded", why: "#9 (same task 4.19) contains every commit of this PR", trains: [], by: 9 },
      { number: 5, category: "needed", why: "", trains: [], by: null },
    ];
    const cmds = ownerCommands(rows, "o/r");
    expect(cmds["in-main"]).toContain("for n in 1; do");
    expect(cmds["in-train"]).toContain("for n in 2; do");
    expect(cmds["in-train"]).toContain('git merge-base --is-ancestor "$sha" origin/main || { echo "#$n: not in main yet, kept"; continue; }');
    expect(cmds.superseded).toMatch(/^gh pr close 3 -R o\/r --comment 'Superseded by #9/);
    expect(Object.values(cmds).join("\n")).not.toMatch(/delete-branch|#5\b|\b5;/);
    expect(closeComment(rows[0], { mainSha: "0123456789abcdef" })).toMatch(/in main \(main at 012345678\)[\s\S]*הענף נשמר 30 יום/);
    expect(closeComment(rows[3])).toBeNull();
  });

  it("writes the generated part between its markers and nowhere else", () => {
    const rows = [{ number: 1, category: "in-main", why: "", trains: [], by: null, title: "x" }];
    const section = renderSection(rows, { lang: "he", repo: "o/r", generatedAt: "2026-11-12 20:00 UTC", mainSha: "abc", trains: ["verify/train"] });
    expect(section.startsWith(START) && section.endsWith(END)).toBe(true);
    expect(section).toContain("| `in-main` | 1 | כבר ב-main: לסגור עכשיו |");
    const page = `intro\n${START}\nold\n${END}\noutro\n`;
    expect(spliceSection(page, section)).toBe(`intro\n${section}\noutro\n`);
    expect(() => spliceSection("no markers", section)).toThrow(/markers/);
  });
});

describe("pr-triage on a real history", () => {
  it("answers is-ancestor from git: a rebased copy is not contained, a missing train is skipped", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-prtriage-"));
    const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" }).trim();
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.org");
      git("config", "user.name", "T");
      const commit = (f: string) => {
        writeFileSync(join(dir, f), f);
        git("add", f);
        git("commit", "-q", "-m", f);
        return git("rev-parse", "HEAD");
      };
      const base = commit("base");
      git("checkout", "-q", "-b", "feat");
      const feat = commit("feat");
      git("checkout", "-q", "-b", "train");
      const train = commit("train");
      git("checkout", "-q", "main");
      commit("main-only");
      git("cherry-pick", feat); // the same change, a different commit
      const picked = git("rev-parse", "HEAD");
      git("update-ref", "refs/remotes/origin/main", picked);
      git("update-ref", "refs/remotes/origin/verify/train", train);
      const o = gitOracle(dir, [], ["verify/train", "verify/train-3"], { fetch: false });
      expect(o.trains).toEqual(["verify/train"]);
      expect(o.mainSha).toBe(picked);
      expect(o.contains(base, "main")).toBe(true);
      expect(o.contains(feat, "main")).toBe(false);
      expect(o.contains(feat, "verify/train")).toBe(true);
      expect(o.contains(feat, train)).toBe(true);
      expect(o.contains("0".repeat(40), "main")).toBe(false);
      const rows = classify(
        [pr(1, base), pr(2, feat)],
        { contains: o.contains, trains: o.trains },
      ) as Row[];
      expect(rows.map((r) => r.category)).toEqual(["in-main", "in-train"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

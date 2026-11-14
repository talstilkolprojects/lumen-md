/**
 * Plan W6.22 — the stack limit: every new PR on main or a train, a stack
 * depth of at most 1, and pr:check's drift rules for each new PR, measured
 * over all open PRs by scripts/stack-limit.mjs. The drift test runs real
 * git in a throwaway repository.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs module without type declarations
import { MAX_STACK_DEPTH, RULE_SINCE, onTrunkOrTrain, stackDepths, stackReport } from "../../scripts/lib/trainBase.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { chainText, driftOf, fromRest, parseArgs, run } from "../../scripts/stack-limit.mjs";

type Pr = { number: number; head: string; base: string; created_at?: string };
const NEW = "2026-11-13T10:00:00Z";
const OLD = "2026-10-20T10:00:00Z";

const prs: Pr[] = [
  { number: 1, head: "feat/a", base: "verify/train-4", created_at: NEW },
  { number: 2, head: "fix/b", base: "main", created_at: NEW },
  { number: 3, head: "feat/c", base: "feat/a", created_at: NEW }, // on #1: depth 2
  { number: 4, head: "feat/d", base: "feat/c", created_at: NEW }, // on #3: depth 3
  { number: 5, head: "docs/e", base: "chore/dod", created_at: NEW }, // a branch with no PR: depth 2
  { number: 6, head: "old/f", base: "old/g", created_at: OLD },
  { number: 7, head: "old/g", base: "old/f", created_at: OLD }, // a loop of bases
  { number: 8, head: "old/h", base: "verify/train", created_at: OLD }, // an older train still counts as "verify/*"
];

describe("the stack limit (W6.22)", () => {
  it("the limit is depth 1 from the day the rule started", () => {
    expect(MAX_STACK_DEPTH).toBe(1);
    expect(RULE_SINCE).toBe("2026-11-12");
    expect(onTrunkOrTrain("main")).toBe(true);
    expect(onTrunkOrTrain("verify/train")).toBe(true);
    expect(onTrunkOrTrain("verify/train-12")).toBe(true);
    expect(onTrunkOrTrain("verify/train-bisect-1")).toBe(false);
    expect(onTrunkOrTrain("chore/dod")).toBe(false);
  });

  it("depth: 1 on main or a train, one more per PR underneath, 2 on a branch that has no PR, and a loop ends", () => {
    const d = stackDepths(prs);
    expect(d.get(1)).toEqual({ depth: 1, chain: [1], root: "verify/train-4" });
    expect(d.get(2)).toEqual({ depth: 1, chain: [2], root: "main" });
    expect(d.get(3)).toEqual({ depth: 2, chain: [1, 3], root: "verify/train-4" });
    expect(d.get(4)).toEqual({ depth: 3, chain: [1, 3, 4], root: "verify/train-4" });
    expect(d.get(5)).toEqual({ depth: 2, chain: [5], root: "chore/dod" });
    expect(d.get(6)!.depth).toBeLessThanOrEqual(3);
    expect(d.get(7)!.depth).toBeLessThanOrEqual(3);
    expect(d.get(8)!.depth).toBe(1);
  });

  it("the report judges only the new PRs, and counts the old ones", () => {
    const r = stackReport(prs, { since: "2026-11-12" });
    expect(r).toMatchObject({ open: 8, recent: 5, recentOnTrain: 2, maxDepth: 3, ok: false });
    expect(r.legacyMaxDepth).toBeGreaterThanOrEqual(2);
    expect(r.offTrain.map((x: Pr) => x.number)).toEqual([3, 4, 5]);
    expect(r.tooDeep.map((x: Pr) => x.number)).toEqual([3, 4, 5]);
    expect(stackReport(prs.filter((p) => [1, 2, 8].includes(p.number)))).toMatchObject({ recent: 2, recentOnTrain: 2, maxDepth: 1, ok: true });
  });

  it("reads the REST list; Dependabot and forks are left out", () => {
    const repo = { full_name: "o/r" };
    const rest = [
      { number: 9, title: "t", created_at: NEW, user: { login: "claude" }, head: { ref: "feat/x", repo }, base: { ref: "main", repo } },
      { number: 10, title: "bump", created_at: NEW, user: { login: "dependabot[bot]" }, head: { ref: "dependabot/npm/x", repo }, base: { ref: "main", repo } },
      { number: 11, title: "fork", created_at: NEW, user: { login: "someone" }, head: { ref: "main", repo: { full_name: "someone/r" } }, base: { ref: "main", repo } },
    ];
    expect(fromRest(rest)).toEqual([{ number: 9, head: "feat/x", base: "main", created_at: NEW, title: "t" }]);
  });

  it("prints a long stack by its bottom and its top three", () => {
    expect(chainText([1, 3])).toBe("#1 → #3");
    expect(chainText([137, 138, 139, 140, 141, 265, 618])).toBe("#137 → … → #141 → #265 → #618");
  });

  it("run: the counts, one line per stack too deep, exit status in `ok`", () => {
    const lines: string[] = [];
    const repo = { full_name: "o/r" };
    const rest = prs.map((p) => ({ number: p.number, title: `#${p.number}`, created_at: p.created_at, user: { login: "claude" }, head: { ref: p.head, repo }, base: { ref: p.base, repo } }));
    const api = (path: string) => (path.includes("page=1") ? rest : []);
    const r = run({ ...parseArgs([]), since: "2026-11-12" }, { log: (s: string) => lines.push(s), api, git: () => "" });
    expect(r.ok).toBe(false);
    const out = lines.join("\n");
    expect(out).toContain("8 open PRs, 5 opened since 2026-11-12");
    expect(out).toContain("✗ 2/5 new PRs (40%) are on main or a verify/train (target 100%)");
    expect(out).toContain("✗ Deepest new stack: 3 (limit 1)");
    expect(out).toMatch(/✗ #4 feat\/d on feat\/c: depth 3 \(#1 → #3 → #4, from verify\/train-4\)\. Restack: node scripts\/restack\.mjs --pr 4/);
  });

  it("drift: pr:check's rules against the train — up to date, behind, too old, not fetched", () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-limit-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", env }).trim();
      const commit = (file: string, when: string) => {
        writeFileSync(join(dir, file), file);
        git("add", file);
        execFileSync("git", ["commit", "-q", "-m", file], { cwd: dir, env: { ...env, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when } });
        return git("rev-parse", "HEAD");
      };
      git("init", "-q", "-b", "main");
      const base = commit("a", "2026-11-01T00:00:00Z");
      const t1 = commit("b", "2026-11-13T00:00:00Z");
      git("update-ref", "refs/remotes/origin/verify/train-4", t1);
      git("switch", "-q", "-c", "fresh", t1);
      git("update-ref", "refs/remotes/origin/fresh", commit("c", "2026-11-14T00:00:00Z"));
      git("switch", "-q", "-c", "stale", base);
      git("update-ref", "refs/remotes/origin/stale", commit("d", "2026-11-02T00:00:00Z"));
      const now = Date.parse("2026-11-14T12:00:00Z");
      const fresh = driftOf(git, { head: "fresh", train: "verify/train-4", remote: "origin", now });
      expect(fresh.map((r: { status: string }) => r.status)).toEqual(["ok"]);
      const stale = driftOf(git, { head: "stale", train: "verify/train-4", remote: "origin", now });
      expect(stale.map((r: { status: string }) => r.status)).toEqual(["fail", "warn"]);
      expect(stale[0].line).toMatch(/13 days old \(limit 7\)/);
      expect(stale[1].line).toMatch(/^1 commit behind `verify\/train-4`/);
      expect(driftOf(git, { head: "nowhere", train: "verify/train-4", remote: "origin", now })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

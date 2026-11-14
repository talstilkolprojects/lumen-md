/** 0.13 — the handoff document: PR stack, worktrees, and a check that every name in it exists. */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs helper without types
import { parseWorktrees, prTree, missingRefs, renderHandoff } from "../../scripts/lib/handoff.mjs";

const prs = [
  { number: 196, head: "fix/abort-all", base: "fix/honest-small", title: "abort", ci: "success", ciSha: "3ef33e7b", unanswered: 0 },
  { number: 194, head: "fix/codex-backlog", base: "feat/pwa-real", title: "codex | fixes", ci: null, unanswered: 2 },
  { number: 195, head: "fix/honest-small", base: "fix/codex-backlog", title: "small", ci: "failure", unanswered: 1 },
  { number: 206, head: "fix/review-194-r2", base: "fix/codex-backlog", title: "r2", ci: "success", unanswered: 0 },
];

describe("handoff", () => {
  it("parses git worktree --porcelain, detached heads included", () => {
    const text = "worktree /a\nHEAD 1234567890abcdef\nbranch refs/heads/fix/x\n\nworktree /b\nHEAD abcdef1234567890\ndetached\n";
    expect(parseWorktrees(text)).toEqual([
      { path: "/a", head: "12345678", branch: "fix/x" },
      { path: "/b", head: "abcdef12", branch: null },
    ]);
  });

  it("shows the PRs as a stack: children under the PR whose head is their base, siblings in number order", () => {
    expect(prTree(prs).map((l: { depth: number; pr: { number: number } }) => [l.depth, l.pr.number])).toEqual([
      [0, 194],
      [1, 195],
      [2, 196],
      [1, 206],
    ]);
  });

  it("lists every branch or worktree it names that does not exist", () => {
    const problems = missingRefs({ prs, worktrees: [{ path: "/w", branch: "gone/branch", head: "x" }], branches: ["fix/abort-all", "fix/codex-backlog", "fix/honest-small"] });
    expect(problems).toEqual(["PR #206: branch fix/review-194-r2 is not here (git fetch?)", "worktree /w: branch gone/branch is gone"]);
  });

  it("renders the task, the stack with CI marks, escaped titles and the checks", () => {
    const md = renderHandoff({ now: "2026-10-18T05:00:00Z", repo: "o/r", task: "0.13", next: "open the PR", prs, worktrees: [{ path: "/w", branch: "fix/x", head: "abc" }], problems: [] });
    expect(md).toContain("- **Current task:** 0.13");
    expect(md).toContain("| #194 | `fix/codex-backlog` → `feat/pwa-real` | ⏳ | 2 | codex \\| fixes |");
    expect(md).toContain("| ↳ ↳ #196 |");
    expect(md).toContain("❌");
    expect(md).toContain("Every branch and worktree named above exists.");
    const bad = renderHandoff({ now: "t", repo: "o/r", task: null, next: null, prs: [], worktrees: [], problems: ["x is gone"] });
    expect(bad).toContain("- ⚠️ x is gone");
    expect(bad).toContain("- **Current task:** —");
  });
});

describe("handoff review fixes", () => {
  it("a fork PR's head is not a local or origin branch, and is shown with its owner", () => {
    const fork = { number: 300, head: "patch-1", headRepo: "someone/r", base: "main", title: "fork", ci: undefined, unanswered: 0 };
    const deleted = { number: 301, head: "patch-2", headRepo: null, base: "main", title: "gone fork", ci: undefined, unanswered: 0 };
    const own = { number: 302, head: "fix/x", headRepo: "o/r", base: "main", title: "own", ci: undefined, unanswered: 0 };
    // A deleted fork's head exists nowhere: that is a problem, not a live fork (W1.32, #211).
    expect(missingRefs({ prs: [fork, deleted, own], worktrees: [], branches: [], repo: "o/r" })).toEqual([
      "PR #301: its fork was deleted, so branch patch-2 exists nowhere (close or recreate the PR)",
      "PR #302: branch fix/x is not here (git fetch?)",
    ]);
    const md = renderHandoff({ now: "t", repo: "o/r", task: null, next: null, prs: [fork, deleted], worktrees: [], problems: [] });
    expect(md).toContain("`someone:patch-1` → `main`");
    expect(md).toContain("`(deleted fork):patch-2` → `main`");
  });

  it("PRs based on each other's heads (a cycle) are still listed (W1.32, #211)", () => {
    const pr = (number: number, head: string, base: string) => ({ number, head, headRepo: "o/r", base, title: `t${number}` });
    const tree = prTree([pr(5, "x", "y"), pr(6, "y", "x"), pr(7, "z", "main")]);
    expect(tree.map((l: { depth: number; pr: { number: number } }) => [l.pr.number, l.depth])).toEqual([[7, 0], [5, 0], [6, 1]]);
  });

  it("escapes | in branch names as in titles, so the table keeps its columns (W1.32, #211)", () => {
    const md = renderHandoff({ now: "t", repo: "o/r", task: null, next: null, prs: [{ number: 8, head: "feature/a|b", headRepo: "o/r", base: "main|x", title: "a | b", ci: "success", unanswered: 0 }], worktrees: [], problems: [] });
    expect(md).toContain("| #8 | `feature/a\\|b` → `main\\|x` | ✅ | 0 | a \\| b |");
  });

  it("a worktree whose directory is gone (prunable) is a problem even though its branch exists", () => {
    const text = "worktree /a\nHEAD 1234567890abcdef\nbranch refs/heads/fix/x\nprunable gitdir file points to non-existent location\n\nworktree /b\nHEAD abcdef1234567890\nbranch refs/heads/fix/y\n";
    const wts = parseWorktrees(text);
    expect(wts[0]).toEqual({ path: "/a", head: "12345678", branch: "fix/x", prunable: "gitdir file points to non-existent location" });
    expect(wts[1].prunable).toBeUndefined();
    expect(parseWorktrees("worktree /u\nHEAD 1234567890abcdef\nbranch refs/heads/u\nlocked on a USB disk\n")[0].locked).toBe("on a USB disk");
    expect(missingRefs({ prs: [], worktrees: wts, branches: ["fix/x", "fix/y"], repo: "o/r" })).toEqual([
      "worktree /a: the directory is gone (gitdir file points to non-existent location); git worktree prune",
    ]);
    expect(renderHandoff({ now: "t", repo: "o/r", task: null, next: null, prs: [], worktrees: wts, problems: [] })).toContain("| `/a` (directory gone) | `fix/x` |");
  });

  it("runs from a checkout whose path has a space, and reports a deleted worktree directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-handoff-"));
    try {
      writeFileSync(join(dir, "gitconfig"), "");
      const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const work = join(dir, "lumen md");
      execFileSync("git", ["init", "-q", "-b", "main", work], { env });
      const g = (...a: string[]) => execFileSync("git", a, { cwd: work, env, encoding: "utf8" });
      g("remote", "add", "origin", "https://github.com/o/r.git");
      mkdirSync(join(work, "scripts/lib"), { recursive: true });
      const repo = resolve(__dirname, "../..");
      cpSync(join(repo, "scripts/handoff.mjs"), join(work, "scripts/handoff.mjs"));
      cpSync(join(repo, "scripts/lib/handoff.mjs"), join(work, "scripts/lib/handoff.mjs"));
      g("add", ".");
      g("commit", "-q", "-m", "base");
      g("worktree", "add", "-q", "-b", "fix/w", join(dir, "w"));
      rmSync(join(dir, "w"), { recursive: true, force: true });
      // A locked worktree on an unmounted disk: git says "locked", never "prunable".
      g("worktree", "add", "-q", "-b", "fix/locked", join(dir, "usb"));
      g("worktree", "lock", "--reason", "on a USB disk", join(dir, "usb"));
      rmSync(join(dir, "usb"), { recursive: true, force: true });
      const r = spawnSync(process.execPath, [join(work, "scripts/handoff.mjs"), "--no-github", "--stdout"], { cwd: dir, env, encoding: "utf8" });
      expect(r.stderr).not.toMatch(/ENOENT|no such file/i);
      expect(r.stdout).toContain("# Handoff — o/r");
      expect(r.stdout).toContain(`worktree ${join(dir, "w")}: the directory is gone`);
      expect(r.stdout).toContain(`worktree ${join(dir, "usb")}: the directory is gone (locked, and its directory is missing)`);
      expect(r.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lets --stdout flush: no process.exit() after writing the document", () => {
    const src = readFileSync(resolve(__dirname, "../../scripts/handoff.mjs"), "utf8");
    const after = src.slice(src.indexOf("process.stdout.write(md)"));
    expect(after).not.toMatch(/process\.exit\(/);
    expect(after).toMatch(/process\.exitCode = problems\.length \? 1 : 0/);
  });

  it("reads every page of review comments without `gh api --paginate`", () => {
    const comments = Array.from({ length: 120 }, (_, i) => ({ id: i + 1, in_reply_to_id: null }));
    const res = handoffWithFakeGh({ pulls: [{ number: 7, title: "t", head: { ref: "main", repo: { full_name: "o/r" } }, base: { ref: "main" } }], comments, runs: { workflow_runs: [] }, ciRuns: { workflow_runs: [] } });
    expect(res.stderr).toBe("");
    expect(res.stdout).toMatch(/\| #7 \| `main` → `main` \| — \| 120 \|/);
  });

  it("reads past the thirtieth page, and finds CI behind newer runs of other workflows (W1.32, #211)", () => {
    const comments = Array.from({ length: 3050 }, (_, i) => ({ id: i + 1, in_reply_to_id: null }));
    // The newest runs of the branch are all Tauri (one per label event); CI is only in the CI workflow's own list.
    const tauri = Array.from({ length: 10 }, (_, i) => ({ name: "Tauri", status: "completed", conclusion: "success", head_sha: "t".repeat(40), id: i }));
    const ci = { name: "CI", status: "completed", conclusion: "failure", head_sha: "c0ffee00".repeat(5), id: 99, head_repository: { full_name: "o/r" } };
    const res = handoffWithFakeGh({ pulls: [{ number: 7, title: "t", head: { ref: "main", repo: { full_name: "o/r" } }, base: { ref: "main" } }], comments, runs: { workflow_runs: tauri }, ciRuns: { workflow_runs: [ci] } });
    expect(res.stderr).toBe("");
    expect(res.stdout).toMatch(/\| #7 \| `main` → `main` \| ❌ `c0ffee00` \| 3050 \|/);
  });
});

/** scripts/handoff.mjs --stdout in a throw-away repository, against a fake gh that pages like the API. */
function handoffWithFakeGh(routes: unknown) {
  const dir = mkdtempSync(join(tmpdir(), "lumen-handoff-gh-"));
  try {
    writeFileSync(join(dir, "gitconfig"), "");
    const env = { ...process.env, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
    const work = join(dir, "repo");
    execFileSync("git", ["init", "-q", "-b", "main", work], { env });
    const g = (...a: string[]) => execFileSync("git", a, { cwd: work, env, encoding: "utf8" });
    g("remote", "add", "origin", "https://github.com/o/r.git");
    mkdirSync(join(work, "scripts/lib"), { recursive: true });
    const repo = resolve(__dirname, "../..");
    cpSync(join(repo, "scripts/handoff.mjs"), join(work, "scripts/handoff.mjs"));
    cpSync(join(repo, "scripts/lib/handoff.mjs"), join(work, "scripts/lib/handoff.mjs"));
    g("add", ".");
    g("commit", "-q", "-m", "base");
    // A fake gh that pages by per_page/page like the API, and (like an API
    // proxy that refuses repositories/<id> Link URLs) never follows --paginate.
    writeFileSync(join(dir, "routes.json"), JSON.stringify(routes));
    mkdirSync(join(dir, "bin"));
    writeFileSync(
      join(dir, "bin", "gh"),
      `#!/usr/bin/env node
const r = JSON.parse(require("fs").readFileSync(${JSON.stringify(join(dir, "routes.json"))}, "utf8"));
const route = process.argv[process.argv.length - 1];
const q = new URLSearchParams(route.split("?")[1] || "");
const page = (list) => { const per = Number(q.get("per_page") || 30), p = Number(q.get("page") || 1); return list.slice((p - 1) * per, p * per); };
const body = route.includes("/comments") ? page(r.comments) : route.includes("/pulls?") ? page(r.pulls) : route.includes("/workflows/ci.yml/runs") ? r.ciRuns : r.runs;
process.stdout.write(JSON.stringify(body));
`,
    );
    chmodSync(join(dir, "bin", "gh"), 0o755);
    return spawnSync(process.execPath, [join(work, "scripts/handoff.mjs"), "--stdout"], { cwd: dir, env: { ...env, PATH: `${join(dir, "bin")}:${process.env.PATH}` }, encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

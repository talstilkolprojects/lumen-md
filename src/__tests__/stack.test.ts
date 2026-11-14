// @vitest-environment node
/**
 * Stacked PRs (task 0.12): the chain building of scripts/lib/stack.mjs on
 * fixture PR JSON, and `scripts/stack.mjs restack` (the gh-stack fallback)
 * on a throw-away git repository. No network: the PRs come from --prs.
 */
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import prsFixture from "./fixtures/stack/prs.json";
import {
  buildForest,
  ciState,
  descendants,
  findNode,
  flatten,
  formatChain,
  mapLimit,
  pushCommands,
  restackPlan,
  rootOf,
  size,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/lib/stack.mjs";

interface Node {
  number: number;
  head: string;
  base: string;
  headSha: string;
  parent: Node | null;
  children: Node[];
}
const repo = resolve(__dirname, "../..");
const nums = (ns: Node[]) => ns.map((n) => n.number);

describe("buildForest", () => {
  const forest = buildForest(prsFixture);

  it("links each PR to the open PR whose head is its base, bottom to top", () => {
    expect(nums(forest.roots)).toEqual([1, 5, 6, 7, 8]);
    const a = findNode(forest, "a");
    expect(size(a)).toBe(4);
    expect(flatten(a).map((r: { node: Node; depth: number }) => [r.node.number, r.depth])).toEqual([
      [1, 0],
      [2, 0],
      [3, 1],
      [4, 1],
    ]);
    expect(nums(descendants(a))).toEqual([2, 3, 4]);
    expect(rootOf(findNode(forest, "#4")).number).toBe(1);
  });

  it("never stacks on a fork's branch, and keeps PRs on a vanished base as roots", () => {
    expect(findNode(forest, "y").parent).toBeNull();
    expect(findNode(forest, 8).parent).toBeNull();
    expect(findNode(forest, "nope")).toBeNull();
  });

  it("breaks a cycle at its lowest-numbered PR", () => {
    const pr = (number: number, head: string, base: string) => ({ number, head: { ref: head, sha: head }, base: { ref: base } });
    const f = buildForest([pr(12, "q", "p"), pr(11, "p", "q"), pr(13, "r", "q")]);
    expect(nums(f.roots)).toEqual([11]);
    expect(flatten(f.roots[0]).map((r: { node: Node }) => r.node.number)).toEqual([11, 12, 13]);
  });

  it("finds the chain-carrying (oldest) PR by its head branch, whatever the API order", () => {
    const pr = (number: number, head: string, base: string) => ({ number, head: { ref: head, sha: head }, base: { ref: base } });
    const f = buildForest([pr(31, "b", "release"), pr(30, "b", "main"), pr(32, "c", "b")]);
    expect(findNode(f, "b").number).toBe(30);
    expect(restackPlan(f, "b").steps.map((s: { number: number }) => s.number)).toEqual([32]);
  });

  it("uses the oldest of two open PRs from one branch as the parent", () => {
    const pr = (number: number, head: string, base: string) => ({ number, head: { ref: head, sha: head }, base: { ref: base } });
    const f = buildForest([pr(21, "b", "main"), pr(20, "b", "release"), pr(22, "c", "b")]);
    expect(findNode(f, "c").parent.number).toBe(20);
  });
});

describe("listing", () => {
  it("formats a chain with CI marks, forks indented, draft and GitHub stack position", () => {
    const forest = buildForest(prsFixture);
    const ci = new Map([
      [1, { state: "success", stale: false }],
      [2, { state: "failure", stale: true }],
      [3, { state: "in_progress", stale: false }],
    ]);
    const text = formatChain(findNode(forest, "a"), ci);
    const lines = text.split("\n");
    expect(lines[0]).toBe("Chain of 4 PRs on main: #1 (bottom) … #4 (top)");
    expect(lines[1]).toMatch(/^ {2}#1 +a +← main +aaaaaaaa +✓ success$/);
    expect(lines[2]).toMatch(/#2 +b .*✗ failure \(older commit\) +draft$/);
    expect(lines[3]).toMatch(/^ {2}#3 {6}c /); // a fork: indented under b
    expect(lines[4]).toMatch(/\[stack 7 4\/4\]$/);
  });

  it("reads the newest workflow run of a head", () => {
    expect(ciState({ workflow_runs: [{ status: "completed", conclusion: "success", head_sha: "s1" }] }, "s1")).toMatchObject({ state: "success", stale: false });
    expect(ciState({ workflow_runs: [{ status: "in_progress", conclusion: null, head_sha: "s0" }] }, "s1")).toMatchObject({ state: "in_progress", stale: true });
    expect(ciState({ workflow_runs: [] }, "s1").state).toBe("none");
  });

  it("maps with bounded concurrency, keeping order", async () => {
    let inFlight = 0;
    let peak = 0;
    const out = await mapLimit([5, 1, 4, 2, 3], 2, async (x: number) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, x));
      inFlight--;
      return x * 10;
    });
    expect(out).toEqual([50, 10, 40, 20, 30]);
    expect(peak).toBe(2);
  });
});

describe("restack plan", () => {
  it("rebases every descendant onto its parent, parents first", () => {
    const { start, steps } = restackPlan(buildForest(prsFixture), "a");
    expect(start.number).toBe(1);
    expect(steps).toEqual([
      { branch: "b", parent: "a", number: 2, remoteSha: "bbbbbbbb1" },
      { branch: "c", parent: "b", number: 3, remoteSha: "cccccccc1" },
      { branch: "d", parent: "b", number: 4, remoteSha: "dddddddd1" },
    ]);
    expect(restackPlan(buildForest(prsFixture), "c").steps).toEqual([]);
    expect(() => restackPlan(buildForest(prsFixture), "nope")).toThrow(/no open PR/);
  });

  it("leaves a fork's PR on a stack branch out of the plan (its head is not a local branch)", () => {
    const pr = (number: number, head: string, base: string, headRepo = "o/r") => ({ number, head: { ref: head, sha: `${head}1`, repo: { full_name: headRepo } }, base: { ref: base, repo: { full_name: "o/r" } } });
    const f = buildForest([pr(1, "a", "main"), pr(2, "b", "a"), pr(3, "c", "b"), pr(4, "c", "b", "someone/r")]);
    const { steps, foreign } = restackPlan(f, "a");
    expect(steps.map((s: { number: number }) => s.number)).toEqual([2, 3]);
    expect(foreign).toEqual([{ branch: "c", parent: "b", number: 4, repo: "someone/r" }]);
  });

  it("leases each push on the sha GitHub has", () => {
    expect(pushCommands([{ branch: "b", remoteSha: "bbbb" }, { branch: "c", remoteSha: "" }], "origin")).toEqual([
      "git push --force-with-lease=b:bbbb origin b",
      "git push --force-with-lease origin c",
    ]);
  });
});

describe("scripts/stack.mjs restack (fallback, local repo)", () => {
  // A private git config: no hooks, signing or global settings leak in.
  const env = (dir: string) => ({
    ...process.env,
    GIT_CONFIG_GLOBAL: join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "t",
    GIT_AUTHOR_EMAIL: "t@example.com",
    GIT_COMMITTER_NAME: "t",
    GIT_COMMITTER_EMAIL: "t@example.com",
    LUMEN_STACK_NO_GH_STACK: "1",
  });

  function setup({ conflict = false, staleTracking = false } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "lumen-stack-"));
    writeFileSync(join(dir, "gitconfig"), "");
    const work = join(dir, "repo");
    const e = env(dir);
    const g = (...a: string[]) => execFileSync("git", a, { cwd: work, env: e, encoding: "utf8" }).trim();
    execFileSync("git", ["init", "-q", "-b", "main", work], { env: e });
    const commit = (file: string, text: string, msg: string) => {
      writeFileSync(join(work, file), text);
      g("add", file);
      g("commit", "-q", "-m", msg);
    };
    commit("base.txt", "base\n", "base");
    g("checkout", "-q", "-b", "a");
    commit("a.txt", "a1\n", "a1");
    const a1 = g("rev-parse", "a");
    // a got a second commit on GitHub after this clone last fetched it: origin/a is stale.
    if (staleTracking) commit("a.txt", "a1b\n", "a1b");
    g("checkout", "-q", "-b", "b");
    commit("b.txt", "b\n", "b");
    // b also edits a's line: replaying it on the amended a conflicts.
    if (conflict) commit("a.txt", "a1 and b\n", "b touches a");
    g("checkout", "-q", "-b", "c");
    commit("c.txt", "c\n", "c");
    const old = { a: g("rev-parse", "a"), b: g("rev-parse", "b"), c: g("rev-parse", "c") };
    // c lives in a second worktree, as branches here often do.
    g("checkout", "-q", "main");
    g("worktree", "add", "-q", join(dir, "wt-c"), "c");
    if (staleTracking) g("update-ref", "refs/remotes/origin/a", a1);
    // Change the bottom PR: amend a's commit.
    g("checkout", "-q", "a");
    writeFileSync(join(work, "a.txt"), "a2\n");
    g("commit", "-q", "-a", "--amend", "-m", "a2");
    g("checkout", "-q", "main");
    const pr = (number: number, head: string, base: string, sha: string) => ({ number, head: { ref: head, sha }, base: { ref: base } });
    const prs = join(dir, "prs.json");
    writeFileSync(prs, JSON.stringify([pr(1, "a", "main", old.a), pr(2, "b", "a", old.b), pr(3, "c", "b", old.c)]));
    const run = (...a: string[]) => spawnSync(process.execPath, [join(repo, "scripts/stack.mjs"), "restack", "a", "--prs", prs, ...a], { cwd: work, env: e, encoding: "utf8" });
    // Any branch, any env (e.g. a fake gh on PATH).
    const runOn = (branch: string, extraEnv: Record<string, string | undefined>, ...a: string[]) =>
      spawnSync(process.execPath, [join(repo, "scripts/stack.mjs"), "restack", branch, "--prs", prs, ...a], { cwd: work, env: { ...e, ...extraEnv }, encoding: "utf8" });
    return { dir, work, g, old, run, runOn };
  }

  it("--dry-run prints the plan and changes nothing", () => {
    const { dir, g, old, run } = setup();
    try {
      const r = run("--dry-run");
      expect(r.status).toBe(0);
      expect(r.stdout).toContain(`#2 git rebase --onto a ${old.a} b   # old base: PR #1 head on GitHub`);
      expect(r.stdout).toContain(`#3 git -C ${join(dir, "wt-c")} rebase --onto b ${old.b}   # old base: old tip of b`);
      expect(g("rev-parse", "b")).toBe(old.b);
      expect(g("rev-parse", "c")).toBe(old.c);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rebases the PRs above, in their own worktrees, and only prints the pushes", () => {
    const { dir, g, old, run } = setup();
    try {
      const r = run();
      expect(r.stderr).not.toMatch(/^stack:/m);
      expect(r.status).toBe(0);
      const isAncestor = (x: string, y: string) => spawnSync("git", ["merge-base", "--is-ancestor", x, y], { cwd: join(dir, "repo") }).status === 0;
      expect(isAncestor("a", "b")).toBe(true);
      expect(isAncestor("b", "c")).toBe(true);
      expect(isAncestor(old.a, "c")).toBe(false); // the amended-away commit is gone
      expect(g("log", "--format=%s", "main..c").split("\n")).toEqual(["c", "b", "a2"]);
      expect(g("symbolic-ref", "--short", "HEAD")).toBe("main");
      expect(r.stdout).toContain("Push when ready (not run; pass --push to run them):");
      expect(r.stdout).toContain(`git push --force-with-lease=a:${old.a} origin a`);
      expect(r.stdout).toContain(`git push --force-with-lease=b:${old.b} origin b`);
      expect(r.stdout).toContain(`git push --force-with-lease=c:${old.c} origin c`);
      // A second run has nothing left to rebase.
      const again = run();
      expect(again.stdout).toContain("#2 b: already on a");
      expect(again.stdout).toContain("#3 c: already on b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("stops on a conflict with the commands that are left, in the worktree that owns each branch", () => {
    const { dir, old, run } = setup({ conflict: true });
    try {
      const r = run();
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("stack: the rebase of b stopped (conflict?)");
      expect(r.stderr).toContain("git rebase --continue");
      // c is checked out in wt-c: `git rebase … c` from here would be refused.
      expect(r.stderr).toContain(`git -C ${join(dir, "wt-c")} rebase --onto b ${old.b}\n`);
      expect(r.stderr).not.toContain(`git rebase --onto b ${old.b} c`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("takes the old base closest to the child when origin/<parent> is stale", () => {
    const { dir, g, old, run } = setup({ staleTracking: true });
    try {
      const plan = run("--dry-run");
      expect(plan.stdout).toContain(`#2 git rebase --onto a ${old.a} b   # old base: PR #1 head on GitHub`);
      const r = run();
      expect(r.status).toBe(0);
      // a1b was amended into a2: it is not replayed onto a as if it were b's work.
      expect(g("log", "--format=%s", "main..b").split("\n")).toEqual(["b", "a2", "a1"]);
      expect(g("log", "--format=%s", "main..c").split("\n")).toEqual(["c", "b", "a2", "a1"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("checks every worktree it will rebase in before moving any branch", () => {
    const { dir, g, old, run } = setup();
    try {
      writeFileSync(join(dir, "wt-c", "c.txt"), "dirty\n");
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`stack: nothing was rebased. c is checked out in ${join(dir, "wt-c")} with uncommitted changes`);
      // b comes before c in the plan and is untouched.
      expect(g("rev-parse", "b")).toBe(old.b);
      expect(g("rev-parse", "c")).toBe(old.c);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("counts untracked files: one a later layer would overwrite stops the run before anything moves", () => {
    const { dir, g, old, run } = setup();
    try {
      // a's newest version adds extra.txt; wt-c has an untracked extra.txt that c's rebase would overwrite.
      g("checkout", "-q", "a");
      writeFileSync(join(dir, "repo", "extra.txt"), "from a\n");
      g("add", "extra.txt");
      g("commit", "-q", "--amend", "-m", "a2");
      g("checkout", "-q", "main");
      writeFileSync(join(dir, "wt-c", "extra.txt"), "mine, untracked\n");
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`stack: nothing was rebased. c is checked out in ${join(dir, "wt-c")} with uncommitted changes or untracked files (?? extra.txt)`);
      expect(g("rev-parse", "b")).toBe(old.b);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to force-push a branch that is behind, or diverged from, a GitHub head it never had", () => {
    const { dir, g, old, run } = setup();
    try {
      const pr = (number: number, head: string, base: string, sha: string) => ({ number, head: { ref: head, sha }, base: { ref: base } });
      const prs = (aHead: string) => writeFileSync(join(dir, "prs.json"), JSON.stringify([pr(1, "a", "main", aHead), pr(2, "b", "a", old.b), pr(3, "c", "b", old.c)]));
      // GitHub has one more commit on top of the local a (pushed from elsewhere, fetched here).
      const ahead = g("commit-tree", "a^{tree}", "-p", "a", "-m", "remote only");
      prs(ahead);
      let r = run("--push");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`stack: nothing was rebased.\n  a is behind #1's head on GitHub (${ahead.slice(0, 8)}): a force-push would delete the commits only GitHub has.`);
      expect(g("rev-parse", "b")).toBe(old.b);
      // GitHub moved on from the version that was amended here: diverged, and that head was never a's tip.
      const other = g("commit-tree", `${old.a}^{tree}`, "-p", old.a, "-m", "someone else's fix");
      prs(other);
      r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`a has diverged from #1's head on GitHub (${other.slice(0, 8)}), which was never its tip here`);
      expect(r.stdout).not.toContain("git push");
      expect(g("rev-parse", "b")).toBe(old.b);
      // The amend itself (GitHub has the pre-amend tip, which a's reflog holds) is still fine.
      prs(old.a);
      expect(run("--dry-run").status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a moving parent amended after its child branched: the child's old base comes from the child", () => {
    const { dir, g, old, run } = setup();
    try {
      // b is amended too (after c was made from the old b), then a's restack moves both.
      g("checkout", "-q", "b");
      writeFileSync(join(dir, "repo", "b.txt"), "b2\n");
      g("commit", "-q", "-a", "--amend", "-m", "b2");
      g("checkout", "-q", "main");
      const plan = run("--dry-run");
      expect(plan.stdout).toContain(`#3 git -C ${join(dir, "wt-c")} rebase --onto b ${old.b}   # old base: PR #2 head on GitHub`);
      const r = run();
      expect(r.status).toBe(0);
      expect(g("log", "--format=%s", "main..c").split("\n")).toEqual(["c", "b2", "a2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a layer amended here but still on its parent is pushed with the layers rebased above it (W1.32, #201)", () => {
    const { dir, g, old, run } = setup();
    try {
      expect(run().status).toBe(0);
      // b is amended after the restack; c still sits on the b before the amend.
      g("checkout", "-q", "b");
      writeFileSync(join(dir, "repo", "b.txt"), "b3\n");
      g("commit", "-q", "-a", "--amend", "-m", "b3");
      g("checkout", "-q", "main");
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("#2 b: already on a (changed here since its PR head: pushed with the rest)");
      expect(g("log", "--format=%s", "main..c").split("\n")).toEqual(["c", "b3", "a2"]);
      const pushes = r.stdout.split("Push when ready")[1] ?? "";
      expect(pushes).toContain(`git push --force-with-lease=b:${old.b} origin b`);
      expect(pushes).toContain(`git push --force-with-lease=c:${old.c} origin c`);
      expect(pushes.indexOf("origin b")).toBeLessThan(pushes.indexOf("origin c"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an amended top branch is still pushed when nothing is stacked on it", () => {
    const { dir, g, old, runOn } = setup();
    try {
      execFileSync("git", ["-C", join(dir, "wt-c"), "commit", "-q", "--amend", "-m", "c2"], { env: { ...process.env, ...env(dir) } });
      const r = runOn("c", {});
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Nothing is stacked on c (#3)");
      expect(r.stdout).toContain(`git push --force-with-lease=c:${old.c} origin c`);
      expect(g("log", "--format=%s", "-1", "c")).toBe("c2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gh stack: gets the same --remote as the push; --old-base is honoured by the fallback, not dropped", () => {
    const { dir, g, old, runOn } = setup();
    try {
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(dir, "gh.log")}"\nexit 0\n`);
      chmodSync(join(bin, "gh"), 0o755);
      const ghEnv = { PATH: `${bin}:${process.env.PATH}`, LUMEN_STACK_NO_GH_STACK: "" };
      const r = runOn("a", ghEnv, "--remote", "upstream");
      expect(r.status).toBe(0);
      expect(readFileSync(join(dir, "gh.log"), "utf8")).toContain("stack rebase --upstack --remote upstream a");
      // The printed push names the same remote (W1.32, #201).
      expect(r.stdout).toContain("To push: gh stack push --remote upstream");
      writeFileSync(join(dir, "gh.log"), "");
      const withBase = runOn("a", ghEnv, "--old-base", old.a);
      expect(withBase.status).toBe(0);
      expect(withBase.stdout).toContain("--old-base: gh stack has no equivalent; using git rebase --onto.");
      expect(readFileSync(join(dir, "gh.log"), "utf8")).not.toContain("stack rebase");
      expect(g("log", "--format=%s", "main..b").split("\n")).toEqual(["b", "a2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("gh stack is not used when the PRs above fork (its stacks are linear)", () => {
    const { dir, g, old, runOn } = setup();
    try {
      g("branch", "d", old.b);
      const pr = (number: number, head: string, base: string, sha: string) => ({ number, head: { ref: head, sha }, base: { ref: base } });
      writeFileSync(join(dir, "prs.json"), JSON.stringify([pr(1, "a", "main", old.a), pr(2, "b", "a", old.b), pr(3, "c", "b", old.c), pr(4, "d", "b", old.b)]));
      const bin = join(dir, "bin");
      mkdirSync(bin);
      writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${join(dir, "gh.log")}"\nexit 0\n`);
      chmodSync(join(bin, "gh"), 0o755);
      const r = runOn("a", { PATH: `${bin}:${process.env.PATH}`, LUMEN_STACK_NO_GH_STACK: "" });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("b has more than one PR on top; gh stack stacks are linear, so using git rebase --onto.");
      expect(readFileSync(join(dir, "gh.log"), "utf8")).not.toContain("stack rebase");
      expect(g("log", "--format=%s", "main..d").split("\n")).toEqual(["b", "a2"]);
      expect(g("log", "--format=%s", "main..c").split("\n")).toEqual(["c", "b", "a2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--push on a top PR whose branch is not local is an error, not a silent success", () => {
    const { dir, old, runOn } = setup();
    try {
      const pr = (number: number, head: string, base: string, sha: string) => ({ number, head: { ref: head, sha }, base: { ref: base } });
      writeFileSync(join(dir, "prs.json"), JSON.stringify([pr(1, "a", "main", old.a), pr(9, "remote-only", "a", "f".repeat(40))]));
      const r = runOn("remote-only", {}, "--push");
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("stack: --push: branch remote-only is not local");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not rebase a local branch that shares a fork PR's head name", () => {
    const { dir, g, old, run } = setup();
    try {
      g("branch", "x", old.b);
      const pr = (number: number, head: string, base: string, sha: string, headRepo = "o/r") => ({ number, head: { ref: head, sha, repo: { full_name: headRepo } }, base: { ref: base, repo: { full_name: "o/r" } } });
      writeFileSync(join(dir, "prs.json"), JSON.stringify([pr(1, "a", "main", old.a), pr(2, "b", "a", old.b), pr(3, "c", "b", old.c), pr(4, "x", "b", "f0f0f0f0", "someone/r")]));
      const r = run();
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("#4 x (from someone/r): a fork's PR on b, not restacked here");
      expect(r.stdout).not.toMatch(/--force-with-lease\S* origin x/);
      expect(g("rev-parse", "x")).toBe(old.b);
      expect(g("log", "--format=%s", "main..c").split("\n")).toEqual(["c", "b", "a2"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

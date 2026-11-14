/**
 * Plan W6.22 — no stacks: every PR on the train head or main, a drift
 * check, an age limit, and scripts/restack.mjs, which prints the commands
 * that move a stacked PR onto the train. The restack test runs the printed
 * git commands in a throwaway repository with a real remote.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs module without type declarations
import { baseVerdict, branchName, currentTrain, driftVerdicts, restackCommands, trainNumber, worst } from "../../scripts/lib/trainBase.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { parseArgs, run } from "../../scripts/restack.mjs";

describe("the current train", () => {
  it("is the highest-numbered verify/train(-N); probes and bisects don't count", () => {
    expect(trainNumber("verify/train")).toBe(1);
    expect(trainNumber("verify/train-12")).toBe(12);
    expect(trainNumber("verify/train-bisect-1")).toBeNull();
    expect(currentTrain(["verify/e2e-probe", "verify/train", "verify/train-bisect-1", "verify/train-2", "verify/chore-dod"])).toBe("verify/train-2");
    expect(currentTrain(["verify/train-10", "verify/train-9"])).toBe("verify/train-10");
    expect(currentTrain(["main"])).toBeNull();
    expect(branchName("origin/verify/train-2")).toBe("verify/train-2");
    expect(branchName("refs/remotes/origin/main")).toBe("main");
  });
});

describe("the base rule", () => {
  it("the train or main is fine; a feature branch or an older train warns with the restack command", () => {
    expect(baseVerdict("verify/train-2", "verify/train-2")).toEqual({ status: "ok", line: "The base `verify/train-2` is the current train." });
    expect(baseVerdict("main", "verify/train-2").status).toBe("ok");
    const feat = baseVerdict("feat/e2ee-sync-core", "verify/train-2");
    expect(feat.status).toBe("warn");
    expect(feat.line).toContain("`node scripts/restack.mjs --branch <this branch> --base feat/e2ee-sync-core`");
    expect(baseVerdict("verify/train", "verify/train-2").line).toContain("(an older train; the current one is `verify/train-2`)");
    expect(baseVerdict("feat/x", null).line).toContain("is not `main`");
  });

  it("drift warns, an old merge base and a criss-cross fail", () => {
    expect(driftVerdicts({ base: "verify/train-2", behind: 0, ageDays: 1.5, mergeBases: 1 })).toEqual([{ status: "ok", line: "Up to date with `verify/train-2`; the merge base with `verify/train-2` is 1 day old (limit 7)." }]);
    const rows = driftVerdicts({ base: "verify/train-2", behind: 12, ageDays: 9.2, mergeBases: 2 });
    expect(rows.map((r: { status: string }) => r.status)).toEqual(["fail", "fail", "warn"]);
    expect(rows[1].line).toBe("The merge base with `verify/train-2` is 9 days old (limit 7). Merge or restack onto the head of `verify/train-2`.");
    expect(rows[2].line).toBe("12 commits behind `verify/train-2`. Merge or restack onto its head before the train.");
    expect(worst(rows)).toBe("fail");
    expect(worst([{ status: "ok" }, { status: "warn" }])).toBe("warn");
    expect(driftVerdicts({ base: "main", behind: 0, ageDays: 8, mergeBases: 1, maxAgeDays: 14 })[0].status).toBe("ok");
  });

  it("the restack plan: own commits onto the train, into a new branch, no force-push; blocked when the base isn't in the train", () => {
    const p = restackCommands({ branch: "feat/b", oldBase: "feat/a", train: "verify/train-2", pr: 42, ownCommits: 3, merges: 1, alreadyInTrain: 1 });
    expect(p.blocked).toBe(false);
    expect(p.target).toBe("restack/feat/b");
    expect(p.notes).toEqual(["3 own commits (`feat/a..feat/b`), 1 already in the train by patch (git skips them).", "1 merge commit among them: `--rebase-merges` keeps them."]);
    expect(p.commands.slice(0, 3)).toEqual(["git fetch origin verify/train-2 feat/a feat/b", "git switch -c restack/feat/b origin/feat/b", "git rebase --rebase-merges --onto origin/verify/train-2 origin/feat/a restack/feat/b"]);
    expect(p.commands.join("\n")).not.toMatch(/--force|-f\b|pulls\/\d+.*base/);
    expect(p.commands.at(-1)).toContain('"Supersedes #42"');
    const b = restackCommands({ branch: "feat/b", oldBase: "feat/a", train: "verify/train-2", parentInTrain: false });
    expect(b).toMatchObject({ blocked: true, commands: [] });
    expect(b.notes[0]).toContain("Restack `feat/a` first");
  });
});

/** origin (bare) + a clone with main, the train, feat/a on the train and feat/b stacked on feat/a. */
function remoteRepo() {
  const root = mkdtempSync(join(tmpdir(), "lumen-restack-"));
  const origin = join(root, "origin.git");
  const dir = join(root, "work");
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, dir);
  const git = (...a: string[]) => sh(dir, ...a);
  git("config", "user.email", "t@example.org");
  git("config", "user.name", "T");
  const commit = (file: string, text: string, msg: string) => {
    writeFileSync(join(dir, file), text);
    git("add", "-A");
    git("commit", "-q", "-m", msg);
  };
  commit("a.txt", "base\n", "base [skip ci]");
  git("push", "-q", "origin", "HEAD:main");
  git("switch", "-q", "-c", "verify/train-2");
  commit("t.txt", "train\n", "train merge [skip ci]");
  git("push", "-q", "origin", "verify/train-2");
  git("switch", "-q", "-c", "feat/a");
  commit("fa.txt", "a\n", "feat: a [skip ci]");
  git("push", "-q", "origin", "feat/a");
  git("switch", "-q", "-c", "feat/b");
  commit("fb.txt", "b1\n", "feat: b1 [skip ci]");
  commit("fb2.txt", "b2\n", "feat: b2 [skip ci]");
  git("push", "-q", "origin", "feat/b");
  return { root, dir, git, commit, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("scripts/restack.mjs", () => {
  it("blocked while the base is not in the train; once it is, the printed commands put only b's commits on the train head", () => {
    const r = remoteRepo();
    try {
      const out: string[] = [];
      const c1 = run(parseArgs(["--cwd", r.dir, "--branch", "feat/b", "--base", "feat/a"]), (l: string) => out.push(l));
      expect(c1).toEqual({ move: 0, blocked: 1, ok: 0, missing: 0 });
      expect(out[0]).toContain("Restack onto verify/train-2 (dry run: nothing is changed).");
      expect(out[0]).toContain("✗ feat/b (base feat/a) → verify/train-2: blocked.");
      // feat/a lands in the train (a merge), and the train moves on.
      r.git("switch", "-q", "verify/train-2");
      r.git("merge", "-q", "--no-ff", "-m", "Merge feat/a [skip ci]", "feat/a");
      r.commit("t2.txt", "more\n", "train: more [skip ci]");
      r.git("push", "-q", "origin", "verify/train-2");
      r.git("fetch", "-q", "origin");
      const before = r.git("rev-parse", "origin/feat/b");
      const lines: string[] = [];
      const c2 = run(parseArgs(["--cwd", r.dir, "--branch", "feat/b", "--base", "feat/a"]), (l: string) => lines.push(l));
      expect(c2).toEqual({ move: 1, blocked: 0, ok: 0, missing: 0 });
      const text = lines.join("\n");
      expect(text).toContain("→ feat/b (base feat/a) → verify/train-2: into restack/feat/b.");
      expect(text).toContain("2 own commits (`feat/a..feat/b`).");
      // The dry run changed nothing.
      expect(r.git("rev-parse", "origin/feat/b")).toBe(before);
      expect(r.git("branch", "--list", "restack/*")).toBe("");
      // Run the git commands it printed (not pr:check, the push or the PR note).
      const cmds = text.split("\n").map((l) => l.trim()).filter((l) => /^git (fetch|switch|rebase) /.test(l));
      expect(cmds).toHaveLength(3);
      for (const c of cmds) r.git(...c.split(" ").slice(1));
      expect(r.git("rev-parse", "HEAD~2")).toBe(r.git("rev-parse", "origin/verify/train-2"));
      expect(r.git("log", "--format=%s", "origin/verify/train-2..HEAD").split("\n")).toEqual(["feat: b2 [skip ci]", "feat: b1 [skip ci]"]);
      // The original branch is untouched: nothing to force-push.
      expect(r.git("rev-parse", "origin/feat/b")).toBe(before);
    } finally {
      r.done();
    }
  });

  it("--all walks the open PRs parents first and skips those already on the train or main", () => {
    const r = remoteRepo();
    try {
      const pr = (number: number, head: string, base: string) => ({ number, head: { ref: head, sha: "", repo: { full_name: "o/r" } }, base: { ref: base, repo: { full_name: "o/r" } }, user: { login: "claude" } });
      writeFileSync(join(r.dir, "prs.json"), JSON.stringify([pr(11, "feat/b", "feat/a"), pr(10, "feat/a", "verify/train-2"), pr(12, "fix/c", "main"), { ...pr(13, "dep/x", "feat/a"), user: { login: "dependabot[bot]" } }]));
      const lines: string[] = [];
      const c = run(parseArgs(["--cwd", r.dir, "--all", "--prs", "prs.json"]), (l: string) => lines.push(l));
      expect(c).toEqual({ move: 0, blocked: 1, ok: 0, missing: 0 });
      expect(lines.join("\n")).toContain("✗ #11 feat/b (base feat/a) → verify/train-2: blocked.");
      expect(lines.join("\n")).toContain("1 PR: 0 to restack, 1 blocked on their base");
    } finally {
      r.done();
    }
  });

  it("names the refs to fetch when they are missing", () => {
    const r = remoteRepo();
    try {
      const lines: string[] = [];
      const c = run(parseArgs(["--cwd", r.dir, "--branch", "feat/zzz", "--base", "feat/a"]), (l: string) => lines.push(l));
      expect(c.missing).toBe(1);
      expect(lines.join("\n")).toContain("git fetch origin feat/zzz");
    } finally {
      r.done();
    }
  });
});

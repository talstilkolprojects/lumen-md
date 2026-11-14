/** W8.10 — a lane resumed from its STATE.md redoes no finished work and pushes nothing twice. */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  checkState,
  MAX_STATE_AGE_MIN,
  parseBranches,
  parsePushes,
  parseUpdated,
  renderBranches,
  resumeAction,
  resumePrompt,
  // @ts-expect-error — plain .mjs helper without types
} from "../../scripts/lib/lane-state.mjs";

const STATE = `# Lane V state

## Branches

| branch | worktree | base | pushed | pr |
| --- | --- | --- | --- | --- |
| chore/lockfile-drift | /home/claude/w-v-drift | verify/train | \`3208e8f6bf\` | #530 |
| docs/lane-state | /home/claude/w-v-state | verify/train | — | — |

## Next

push docs/lane-state once
`;

type Row = { branch: string; worktree: string; base: string; pushed: string | null; pr: number | null };
const A = "3208e8f6bf1111111111111111111111111111aa";
const B = "4e118263952222222222222222222222222222bb";

describe("parseBranches", () => {
  it("reads the Branches table: a dash is never pushed, #N is a PR", () => {
    expect(parseBranches(STATE)).toEqual([
      { branch: "chore/lockfile-drift", worktree: "/home/claude/w-v-drift", base: "verify/train", pushed: "3208e8f6bf", pr: 530 },
      { branch: "docs/lane-state", worktree: "/home/claude/w-v-state", base: "verify/train", pushed: null, pr: null },
    ]);
  });

  it("a STATE.md without the table has no rows", () => {
    expect(parseBranches("# x\n\n## Next\n| a | b | c | d | e |\n")).toEqual([]);
  });

  it("renders a table that parses back to the same rows", () => {
    const rows = parseBranches(STATE) as Row[];
    expect(parseBranches(`## Branches\n\n${renderBranches(rows)}\n`)).toEqual(rows);
  });
});

describe("resumeAction", () => {
  const [pushed, fresh] = parseBranches(STATE) as Row[];

  it("a branch whose head origin already has is never pushed again", () => {
    expect(resumeAction(pushed, { local: A, remote: A, prs: [530], ahead: 0, behind: 0 }).action).toBe("nothing");
  });

  it("pushed with no PR: open the PR, do not push", () => {
    expect(resumeAction({ ...pushed, pr: null }, { local: A, remote: A, prs: [], ahead: 0, behind: 0 }).action).toBe("open-pr");
  });

  it("commits origin lacks: push once; a branch not on origin yet too", () => {
    expect(resumeAction(pushed, { local: B, remote: A, prs: [530], ahead: 2, behind: 0 }).action).toBe("push");
    expect(resumeAction(fresh, { local: B, remote: null, prs: [], ahead: null, behind: null }).action).toBe("push");
  });

  it("the push went through but STATE.md was not updated before the stop: record it, push nothing", () => {
    const r = resumeAction(pushed, { local: B, remote: B, prs: [530], ahead: 0, behind: 0 });
    expect(r.action).toBe("record");
    expect(r.why).toContain("4e11826395");
  });

  it("origin moved on (another session pushed): a person merges, nothing is forced", () => {
    expect(resumeAction(pushed, { local: A, remote: B, prs: [530], ahead: 0, behind: 3 }).action).toBe("look");
    expect(resumeAction(pushed, { local: A, remote: B, prs: [530], ahead: 1, behind: 1 }).action).toBe("look");
  });

  it("a missing worktree, or a recorded push origin does not have, is looked at before anything runs", () => {
    expect(resumeAction(pushed, { local: null, remote: A, prs: [], ahead: null, behind: null }).action).toBe("look");
    expect(resumeAction(pushed, { local: A, remote: null, prs: [], ahead: null, behind: null }).action).toBe("look");
  });
});

describe("checking STATE.md itself (W8.10: written every hour, nothing pushed twice)", () => {
  const NOW = Date.parse("2026-11-14T22:55:00Z");
  const file = (updated: string, pushes: string, base = "verify/train-4") => `# Lane C2 state

Updated: ${updated} (00:55 Israel) · session x

## Branches

| branch | worktree | base | pushed | pr |
| --- | --- | --- | --- | --- |
| docs/complete-t4 | /w | ${base} | 6d09bb12d7 | #622 |
| verify/train-4 | /t | chore/dod | — | — |

## Pushes

${pushes}

## Next

done
`;
  const ONE = "- 2026-11-14T22:2xZ docs/complete-t4 6d09bb12d7 (once)";

  it("reads the Updated time in both spellings, and the Pushes log", () => {
    expect(parseUpdated("Updated: 2026-11-14T22:55Z (x)")).toBe(NOW);
    expect(parseUpdated("Updated: 2026-11-14 22:55 UTC")).toBe(NOW);
    expect(parseUpdated("Updated: <UTC time>")).toBeNull();
    expect(parsePushes(file("2026-11-14T22:55Z", `${ONE}\n- 2026-11-14T23:1xZ chore/stack-limit \`a26175b20d\` (once)\nprose, not a push`), ["docs/complete-t4"])).toEqual([
      { branch: "docs/complete-t4", sha: "6d09bb12d7", line: ONE },
      { branch: "chore/stack-limit", sha: "a26175b20d", line: "- 2026-11-14T23:1xZ chore/stack-limit `a26175b20d` (once)" },
    ]);
  });

  it("a current file with one push per branch passes; a train's own row is not judged by its base", () => {
    expect(checkState(file("2026-11-14T22:55Z", ONE), { now: NOW })).toEqual([]);
  });

  it("older than an hour, or without an Updated line, fails", () => {
    const late = NOW + (MAX_STATE_AGE_MIN + 5) * 60000;
    expect(checkState(file("2026-11-14T22:55Z", ONE), { now: late })).toEqual([{ level: "fail", line: "written 65 min ago (the lane writes it at least every 60 min): update it" }]);
    expect(checkState(file("<UTC time>", ONE), { now: NOW })[0].level).toBe("fail");
  });

  it("the same sha pushed twice on a branch fails: a resumed lane pushed again", () => {
    const twice = `${ONE}\n- 2026-11-14T23:40Z docs/complete-t4 6d09bb12d7 (after resume)`;
    const p = checkState(file("2026-11-14T22:55Z", twice), { now: NOW });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatchObject({ level: "fail" });
    expect(p[0].line).toMatch(/^docs\/complete-t4: 6d09bb12d7 was pushed twice/);
  });

  it("more than one push and a fix, a pushed head missing from the log, and a stacked base warn", () => {
    const three = `${ONE}\n- t docs/complete-t4 1111111aaa (fix)\n- t docs/complete-t4 2222222bbb (fix 2)`;
    expect(checkState(file("2026-11-14T22:55Z", three), { now: NOW }).map((x: { level: string; line: string }) => x.line)).toEqual(["docs/complete-t4: 3 pushes (one, plus at most one fix push)"]);
    expect(checkState(file("2026-11-14T22:55Z", "none yet"), { now: NOW })).toEqual([{ level: "warn", line: "docs/complete-t4: pushed 6d09bb12d7 is not in the Pushes log: add the line" }]);
    expect(checkState(file("2026-11-14T22:55Z", ONE, "feat/a"), { now: NOW })).toEqual([{ level: "warn", line: "docs/complete-t4: base feat/a is neither main nor a train (W6.22: every PR on the train head)" }]);
  });

  it("one resume instruction per lane, naming its file and the check", () => {
    const p = resumePrompt({ lane: "C2", state: "/s/lanes/C2/STATE.md" });
    expect(p).toMatch(/^You are lane C2 of lumen-md, resuming after a stop\./);
    expect(p).toContain("node scripts/lane-state.mjs resume /s/lanes/C2/STATE.md");
    expect(p).toContain("node scripts/lane-state.mjs check /s/lanes/C2/STATE.md");
    expect(p).toContain("ONE push");
  });
});

describe("lane-state.mjs resume on a real repository", () => {
  it("one worktree holding several branches: each branch is judged by its own head, not the checkout", () => {
    const dir = mkdtempSync(join(tmpdir(), "lane-state-"));
    try {
      const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
      const remote = join(dir, "remote.git");
      const work = join(dir, "work");
      const git = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", env }).trim();
      git(dir, "init", "-q", "--bare", "-b", "main", remote);
      git(dir, "init", "-q", "-b", "main", work);
      git(work, "remote", "add", "origin", remote);
      const commit = (name: string) => {
        writeFileSync(join(work, name), name);
        git(work, "add", name);
        git(work, "commit", "-q", "-m", name);
        return git(work, "rev-parse", "HEAD");
      };
      commit("base");
      git(work, "switch", "-q", "-c", "lane/a");
      const a = commit("a");
      git(work, "switch", "-q", "-c", "lane/b", "main");
      const b = commit("b");
      git(work, "push", "-q", "origin", "lane/a", "lane/b");
      const state = join(dir, "STATE.md");
      writeFileSync(state, `## Branches\n\n| branch | worktree | base | pushed | pr |\n| --- | --- | --- | --- | --- |\n| lane/a | ${work} | main | ${a.slice(0, 10)} | #1 |\n| lane/b | ${work} | main | ${b.slice(0, 10)} | #2 |\n`);
      const script = resolve(__dirname, "..", "..", "scripts", "lane-state.mjs");
      const out = execFileSync(process.execPath, [script, "resume", state, "--no-github"], { cwd: work, encoding: "utf8", env });
      expect(out).toMatch(/^nothing {2}lane\/a: pushed /m);
      expect(out).toMatch(/^nothing {2}lane\/b: pushed /m);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

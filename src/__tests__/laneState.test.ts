/** W8.10 — a lane resumed from its STATE.md redoes no finished work and pushes nothing twice. */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs helper without types
import { parseBranches, renderBranches, resumeAction } from "../../scripts/lib/lane-state.mjs";

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

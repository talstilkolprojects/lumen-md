/**
 * W10.F7 (audit W4.1, W1.1, W6.42): npm run train:missing — every open PR
 * whose head is not in the train has a decision, or the run fails.
 * Ancestry is real git in a throwaway repository with a remote; the pulls
 * listing is sample REST pages (made up, in GitHub's shape) — the only
 * part that would need the network.
 * @vitest-environment node
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs script without type declarations
import { DECISIONS_FILE, ancestry, checkDecisions, classify, openPulls, report, run } from "../../scripts/train-missing.mjs";

const ROOT = resolve(__dirname, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "train-missing-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

type Pull = { number: number; title: string; head: { sha: string }; base: { ref: string } };
const pull = (number: number, sha: string, base = "verify/train-4"): Pull => ({ number, title: `PR ${number}`, head: { sha }, base: { ref: base } });

/** A repo with a remote: verify/train-4 has a, b; feature x (merged) and y (not) branch from it. */
function repo() {
  const dir = join(tmp, `r${Math.random().toString(36).slice(2)}`);
  const remote = `${dir}-remote.git`;
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  execFileSync("git", ["init", "-q", "--bare", remote]);
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  const commit = (f: string) => {
    writeFileSync(join(dir, f), f);
    git("add", f);
    git("commit", "-q", "-m", f);
    return git("rev-parse", "HEAD");
  };
  commit("a");
  git("checkout", "-q", "-b", "feat/x");
  const x = commit("x");
  git("checkout", "-q", "main");
  git("merge", "-q", "--no-ff", "-m", "Merge #1", "feat/x");
  git("checkout", "-q", "-b", "feat/y");
  const y = commit("y");
  git("checkout", "-q", "main");
  const train = commit("b");
  git("remote", "add", "origin", remote);
  git("push", "-q", "origin", "main:verify/train-4", "main:verify/train-3", "feat/y");
  git("fetch", "-q", "origin");
  return { dir, git, x, y, train };
}

describe("the decisions file", () => {
  it("refuses an unknown decision, no reason, no head, 'in' without via, 'replaced' without by, a PR twice", () => {
    const ok = { pr: 5, head: "0123456789ab", decision: "rejected", reason: "carries the taken domain (owner's rule)" };
    expect(checkDecisions({ decisions: [ok] })).toEqual([]);
    const bad = checkDecisions({
      decisions: [
        { ...ok, decision: "later" },
        { ...ok, pr: 6, reason: "" },
        { ...ok, pr: 7, head: "xyz" },
        { ...ok, pr: 8, decision: "in" },
        { ...ok, pr: 9, decision: "replaced" },
        { ...ok, pr: 9 },
      ],
    });
    expect(bad).toEqual([
      'decisions[0] (#5): decision "later" is not one of in, rejected, replaced',
      "decisions[1] (#6): no reason (at least a sentence)",
      "decisions[2] (#7): head is not a commit sha (10 to 40 hex)",
      'decisions[3] (#8): "in" names the task or PR that brings it (via)',
      'decisions[4] (#9): "replaced" names what replaces it (by)',
      "decisions[5] (#9): #9 is decided twice",
    ]);
    expect(checkDecisions({})).toEqual(["the file has no `decisions` list"]);
  });
});

describe("classify", () => {
  const inTrain = (sha: string) => sha.startsWith("aaaa");
  const pulls = [pull(1, "aaaa000001"), pull(2, "bbbb000002"), pull(3, "cccc000003"), pull(4, "dddd000004")];
  const file = {
    decisions: [
      { pr: 2, head: "bbbb000002", decision: "in", via: "W10.F4", reason: "the move-safety fixes go to train 6" },
      { pr: 3, head: "cccc0000ff", decision: "rejected", reason: "an older head, decided before it moved" },
      { pr: 99, head: "eeee000099", decision: "replaced", by: "#2", reason: "closed since, its decision can go" },
    ],
  };

  it("in the train, decided, stale when the PR moved, undecided, and decisions for closed PRs", () => {
    const v = classify(pulls, file, inTrain);
    expect(v.inTrain.map((r: { pr: number }) => r.pr)).toEqual([1]);
    expect(v.decided.map((r: { pr: number; decision: string }) => [r.pr, r.decision])).toEqual([[2, "in"]]);
    expect(v.stale.map((r: { pr: number }) => r.pr)).toEqual([3]);
    expect(v.undecided.map((r: { pr: number }) => r.pr)).toEqual([4]);
    expect(v.gone).toEqual([99]);
    expect(v.ok).toBe(false);
    const lines: string[] = report(v, "verify/train-4");
    expect(lines[0]).toBe("train:missing against verify/train-4: 1 open PR heads in the train, 1 outside it with a decision, 1 stale, 1 undecided.");
    expect(lines.some((l) => l.startsWith("✗ #3 moved to cccc000003 since the decision \"rejected\" about cccc0000ff"))).toBe(true);
    expect(lines.some((l) => l.startsWith("✗ #4 (verify/train-4) dddd000004: no decision"))).toBe(true);
  });

  it("passes once every head outside the train has a current decision", () => {
    const all = { decisions: [...file.decisions.slice(0, 1), { pr: 3, head: "cccc000003", decision: "rejected", reason: "re-decided for the new head" }, { pr: 4, head: "dddd000004", decision: "replaced", by: "#2", reason: "the same fix, carried by #2" }] };
    const v = classify(pulls, all, inTrain);
    expect(v.ok).toBe(true);
    expect(report(v, "t").at(-1)).toBe("✓ every open PR head is in the train or decided.");
  });
});

describe("openPulls", () => {
  it("reads every page of 100 until a short one", () => {
    const pages: Record<number, Pull[]> = {
      1: Array.from({ length: 100 }, (_, i) => pull(i + 1, `aaaa${i}`)),
      2: Array.from({ length: 100 }, (_, i) => pull(i + 101, `aaaa${i}`)),
      3: [pull(201, "ffff")],
    };
    const asked: string[] = [];
    const api = (path: string) => {
      asked.push(path);
      return pages[Number(/[?&]page=(\d+)/.exec(path)![1])] ?? [];
    };
    expect(openPulls(api, "o/r")).toHaveLength(201);
    expect(asked).toEqual([1, 2, 3].map((p) => `repos/o/r/pulls?state=open&per_page=100&page=${p}`));
    expect(() => openPulls(() => ({ message: "Bad credentials" }), "o/r")).toThrow(/not a list/);
  });
});

describe("run, with real git", () => {
  it("a merged PR's head is in the train; an unmerged one fails the run until it has a decision", () => {
    const r = repo();
    const pulls = [pull(1, r.x), pull(2, r.y)];
    const api = (path: string) => {
      if (path.includes("/pulls?")) return path.endsWith("page=1") ? pulls : [];
      throw new Error(`unexpected ${path}`);
    };
    mkdirSync(join(r.dir, "plan"), { recursive: true });
    writeFileSync(join(r.dir, DECISIONS_FILE), JSON.stringify({ decisions: [] }));
    const git = (...a: string[]) => r.git(...a);
    const first = run({ cwd: r.dir, api, git });
    expect(first.train).toBe("verify/train-4");
    expect(first.trainHead).toBe(r.train);
    expect(first.inTrain.map((x: { pr: number }) => x.pr)).toEqual([1]);
    expect(first.undecided.map((x: { pr: number }) => x.pr)).toEqual([2]);
    expect(first.ok).toBe(false);
    writeFileSync(join(r.dir, DECISIONS_FILE), JSON.stringify({ decisions: [{ pr: 2, head: r.y, decision: "in", via: "train 5", reason: "goes into the next train" }] }));
    expect(run({ cwd: r.dir, api, git }).ok).toBe(true);
  });

  it("a head git does not have is answered by the compare API (behind or identical = in the train)", () => {
    const r = repo();
    const asked: string[] = [];
    const api = (path: string) => {
      asked.push(path);
      return { status: path.endsWith("...feedfacefeedfacefeedfacefeedfacefeedface") ? "behind" : "diverged" };
    };
    const is = ancestry({ git: r.git, api, repo: "o/r", trainHead: r.train });
    expect(is(r.x)).toBe(true);
    expect(is(r.y)).toBe(false);
    expect(asked).toEqual([]);
    expect(is("feedfacefeedfacefeedfacefeedfacefeedface")).toBe(true);
    expect(is("0000000000000000000000000000000000000001")).toBe(false);
    expect(asked).toEqual([`repos/o/r/compare/${r.train}...feedfacefeedfacefeedfacefeedfacefeedface`, `repos/o/r/compare/${r.train}...0000000000000000000000000000000000000001`]);
  });
});

describe("the repo's decisions file", () => {
  it("is valid, and every decision names a head", () => {
    const file = JSON.parse(readFileSync(join(ROOT, DECISIONS_FILE), "utf8"));
    expect(checkDecisions(file)).toEqual([]);
    expect(file.decisions.length).toBeGreaterThan(0);
  });
});

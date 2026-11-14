/**
 * Plan W6.42 — the train procedure: the conflict resolver promoted from
 * lanes T/T2 (scripts/train/lib.mjs, resolve.mjs, port.mjs), the build
 * (`npm run train:build`) with its ledger trailers, and `npm run train:status`.
 * The git tests build real conflicts in throwaway repositories.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import {
  buildUnion,
  contained,
  lineDiff,
  merge3,
  mergeImportHunk,
  mergeJsonText,
  parseDiff3,
  parseMerge,
  parseUnified,
  portHunks,
  searchUnion,
  simplifyHunks,
  trailerLine,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/train/lib.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { diff3, resolveConflicts } from "../../scripts/train/resolve.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { loadTs, syntaxErrors } from "../../scripts/train/ts.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { parseArgs, parseRange, queueOf, run } from "../../scripts/train/build.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { gather, ledgerOf, median, nextCut, previousTrain, report, tally } from "../../scripts/train/status.mjs";

const ts = loadTs();

describe("the resolver's rules (lib.mjs)", () => {
  it("merge3: per key, arrays as a union, a delete against a change is a problem", () => {
    const problems: string[] = [];
    const out = merge3({ a: 1, b: [1], c: 1, d: 1 }, { a: 2, b: [1, 2], c: 1, d: 1, o: true }, { a: 1, b: [1, 3], c: 3, t: true }, "", problems);
    expect(out).toEqual({ a: 2, b: [1, 2, 3], c: 3, o: true, t: true });
    expect(problems).toEqual([]);
    const p2: string[] = [];
    merge3({ k: 1 }, { k: 2 }, {}, "", p2);
    expect(p2).toEqual([".k deleted by theirs, changed by ours"]);
    const p3: string[] = [];
    expect(merge3({ v: "1" }, { v: "2" }, { v: "3" }, "", p3)).toEqual({ v: "3" });
    expect(p3).toEqual(['.v: "2" vs "3" (took theirs)']);
  });

  it("mergeJsonText keeps ours' indentation and final newline", () => {
    const r = mergeJsonText('{"a":1}', '{\n    "a": 1,\n    "o": 1\n}\n', '{"a":1,"t":1}');
    expect(r.text).toBe('{\n    "a": 1,\n    "o": 1,\n    "t": 1\n}\n');
  });

  it("contained: theirs' change already in ours", () => {
    const base = "a\nb\nc\n";
    expect(contained(base, "a\nb\nX = 1\nc\nmore\n", "a\nb\nX = 1\nc\n")).toBe(true);
    expect(contained(base, "a\nb\nc\n", "a\nb\nY = 2\nc\n")).toBe(false);
    expect(contained("keep\nold line here\n", "keep\n", "keep\n")).toBe(true);
    expect(lineDiff("a\nb\nc", "a\nx\nc")).toEqual({ added: ["x"], removed: ["b"] });
  });

  it("imports merge per module, removals respected", () => {
    const merged = mergeImportHunk({
      O: ['import { a, b } from "./m";', 'import { x } from "./gone";'],
      B: ['import { a } from "./m";', 'import { x } from "./gone";'],
      T: ['import { a, c } from "./m";', 'import type { T } from "./types";'],
    });
    expect(merged).toEqual(['import { a, b, c } from "./m";', 'import type { T } from "./types";']);
    expect(mergeImportHunk({ O: ["const a = 1;"], B: [], T: ['import { b } from "./b";'] })).toBeNull();
  });

  it("additions on both sides become ours + theirs; a joint is searched until the code parses", () => {
    const base = 'export const list = [\n  "a",\n];\n';
    const ours = 'export const list = [\n  "a",\n];\nexport function one() {\n  return 1;\n}\n';
    const theirs = 'export const list = [\n  "a",\n];\nexport function two() {\n  return 2;\n}\n';
    const segs = parseDiff3(diff3(ours, base, theirs));
    expect(simplifyHunks(segs)).toBe(true);
    const u = searchUnion(segs, { isCode: true, valid: (t: string) => !syntaxErrors(ts, "x.ts", t).length });
    expect(u.text).toContain("export function one()");
    expect(u.text).toContain("export function two()");
    expect(syntaxErrors(ts, "x.ts", u.text)).toEqual([]);
    // Two functions that end on the same "}" need the joint: the brace goes back between them.
    const b2 = "function a() {\n  x();\n}\n";
    const o2 = "function a() {\n  x();\n}\nfunction b() {\n  y();\n}\n";
    const t2 = "function a() {\n  x();\n}\nfunction c() {\n  z();\n}\n";
    const s2 = parseDiff3(diff3(o2, b2, t2));
    simplifyHunks(s2);
    const u2 = searchUnion(s2, { isCode: true, valid: (t: string) => !syntaxErrors(ts, "x.ts", t).length });
    expect(syntaxErrors(ts, "x.ts", u2.text)).toEqual([]);
    expect((u2.text.match(/function [abc]\(/g) ?? []).length).toBe(3);
    expect(buildUnion([["a"], { O: ["o"], B: [], T: ["t"] }, ["z"]]).text).toBe("a\no\nt\nz");
  });

  it("portHunks: theirs' hunk applied where ours moved the code, re-indented", () => {
    const hunks = parseUnified("@@ -1,3 +1,3 @@\n function go() {\n-  return 1;\n+  return 2;\n }\n");
    const texts = new Map([["src/old.ts", "// moved to src/new.ts\n"]]);
    const r = portHunks("src/old.ts", hunks, texts, ["src/new.ts"], (f: string) => (f === "src/new.ts" ? "export class X {\n    function go() {\n      return 1;\n    }\n}\n" : null));
    expect(r.left).toEqual([]);
    expect(r.moved).toEqual([{ to: "src/new.ts" }]);
    expect(r.texts.get("src/new.ts")).toBe("export class X {\n    function go() {\n      return 2;\n    }\n}\n");
    const miss = portHunks("src/old.ts", hunks, texts, [], () => null);
    expect(miss.left[0]).toMatch(/^a hunk not found/);
  });

  it("the ledger trailer round-trips", () => {
    expect(trailerLine("manual", ["a.ts", "b.json"])).toBe("Train-Resolution: manual (a.ts, b.json)");
    expect(parseMerge("Merge #464 feat/x [skip ci]", "Train-Resolution: manual (a.ts, b.json)\n")).toEqual({ pr: 464, branch: "feat/x", resolution: "manual", files: ["a.ts", "b.json"] });
    expect(parseMerge("Merge #12 fix/y [skip ci]")).toEqual({ pr: 12, branch: "fix/y", resolution: "unknown", files: [] });
    expect(parseMerge("feat: not a merge [skip ci]")).toBeNull();
  });
});

/** A bare origin and a clone with main and verify/train-2. `write` makes a branch off a ref with files. */
function trainRepo() {
  const root = mkdtempSync(join(tmpdir(), "lumen-trainb-"));
  const origin = join(root, "origin.git");
  const dir = join(root, "work");
  const sh = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  sh(root, "init", "-q", "--bare", "-b", "main", origin);
  sh(root, "clone", "-q", origin, dir);
  const git = (...a: string[]) => sh(dir, ...a);
  git("config", "user.email", "t@example.org");
  git("config", "user.name", "T");
  const put = (files: Record<string, string>) => {
    for (const [f, t] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), t);
    }
  };
  put({
    "src/util.ts": "export const one = 1;\n",
    "src/conf.json": '{\n  "a": 1\n}\n',
    "src/shared.ts": "export function f() {\n  return 1;\n}\n",
  });
  git("add", "-A");
  git("commit", "-q", "-m", "base [skip ci]");
  git("push", "-q", "origin", "HEAD:main");
  git("push", "-q", "origin", "HEAD:refs/heads/verify/train-2");
  const branch = (name: string, files: Record<string, string>) => {
    git("switch", "-q", "-c", name, "origin/verify/train-2");
    put(files);
    git("add", "-A");
    git("commit", "-q", "-m", `${name} [skip ci]`);
    git("push", "-q", "origin", name);
    git("switch", "-q", "--detach", "origin/verify/train-2");
  };
  return { root, dir, git, put, branch, done: () => rmSync(root, { recursive: true, force: true }) };
}

describe("resolveConflicts on a real merge", () => {
  it("JSON per key, code additions as a union; a shared-line edit is left MANUAL with diff3 markers", () => {
    const r = trainRepo();
    try {
      r.branch("feat/a", { "src/conf.json": '{\n  "a": 1,\n  "x": 1\n}\n', "src/util.ts": "export const one = 1;\nexport const two = 2;\n", "src/shared.ts": "export function f() {\n  return 2;\n}\n" });
      r.branch("feat/b", { "src/conf.json": '{\n  "a": 1,\n  "y": 1\n}\n', "src/util.ts": "export const one = 1;\nexport const three = 3;\n", "src/shared.ts": "export function f() {\n  return 3;\n}\n" });
      r.git("switch", "-q", "-c", "verify/train-3", "origin/verify/train-2");
      r.git("merge", "-q", "--no-ff", "-m", "a", "origin/feat/a");
      expect(spawnSync("git", ["merge", "-q", "--no-ff", "-m", "b", "origin/feat/b"], { cwd: r.dir }).status).not.toBe(0);
      const res = resolveConflicts(r.dir, ts);
      expect(res.lines).toContain("json src/conf.json");
      expect(res.lines).toContain("union src/util.ts");
      expect(res.lines.find((l: string) => l.startsWith("MANUAL src/shared.ts"))).toBeTruthy();
      expect(res.ok).toBe(false);
      expect(JSON.parse(readFileSync(join(r.dir, "src/conf.json"), "utf8"))).toEqual({ a: 1, x: 1, y: 1 });
      expect(readFileSync(join(r.dir, "src/util.ts"), "utf8")).toBe("export const one = 1;\nexport const two = 2;\nexport const three = 3;\n");
      expect(readFileSync(join(r.dir, "src/shared.ts"), "utf8")).toContain("||||||| base");
      expect(r.git("diff", "--name-only", "--diff-filter=U")).toBe("src/shared.ts");
    } finally {
      r.done();
    }
  });
});

describe("npm run train:build and train:status", () => {
  it("merges in order, resolves what it can, stops for a person, continues, and records the ledger", () => {
    const r = trainRepo();
    try {
      r.branch("feat/clean", { "src/clean.ts": "export const c = 1;\n" });
      r.branch("feat/a", { "src/util.ts": "export const one = 1;\nexport const two = 2;\n", "src/shared.ts": "export function f() {\n  return 2;\n}\n" });
      r.branch("feat/b", { "src/util.ts": "export const one = 1;\nexport const three = 3;\n" });
      r.branch("feat/c", { "src/shared.ts": "export function f() {\n  return 3;\n}\n" });
      writeFileSync(join(r.dir, "..", "list.txt"), "13 feat/c\n10 feat/clean\n11 feat/a\n12 feat/b\n109 old/domain\n");
      const out: string[] = [];
      const args = ["--cwd", r.dir, "--train", "verify/train-3", "--onto", "origin/verify/train-2", "--list", join(r.dir, "..", "list.txt")];
      const dry = run(parseArgs([...args, "--dry-run"]), (l: string) => out.push(l));
      expect(dry.queue.map((q: { number: number }) => q.number)).toEqual([10, 11, 12, 13]);
      expect(out[0]).toBe("Train verify/train-3 onto origin/verify/train-2: 4 PRs (#10 #11 #12 #13)");
      expect(r.git("rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD"); // the dry run switched nothing
      const first = run(parseArgs(args), (l: string) => out.push(l));
      expect(first.stopped).toMatchObject({ number: 13, branch: "feat/c", files: ["src/shared.ts"] });
      expect(out).toContain("✓ #10 feat/clean");
      expect(out).toContain("✓ #12 feat/b (resolved: src/util.ts)");
      // A person resolves it: both returns are wrong, the owner picks 3.
      writeFileSync(join(r.dir, "src/shared.ts"), "export function f() {\n  return 3;\n}\n");
      r.git("add", "src/shared.ts");
      const second = run(parseArgs(["--cwd", r.dir, "--continue"]), (l: string) => out.push(l));
      expect(second.stopped).toBeNull();
      expect(out.at(-1)).toContain("4 merged (2 clean, 1 by the resolver, 1 by hand), 0 already in, 0 missing. Hand resolutions: 1 (weekly target ≤ 10).");
      const subjects = r.git("log", "--first-parent", "--format=%s", "origin/verify/train-2..HEAD").split("\n");
      expect(subjects).toEqual(["Merge #13 feat/c [skip ci]", "Merge #12 feat/b [skip ci]", "Merge #11 feat/a [skip ci]", "Merge #10 feat/clean [skip ci]"]);
      const ledger = ledgerOf(r.git("log", "--first-parent", "--format=%s%x1f%b%x1e", "origin/verify/train-2..HEAD"));
      expect(tally(ledger)).toEqual({ clean: 2, auto: 1, manual: 1, unknown: 0 });
      expect(ledger.find((m: { pr: number }) => m.pr === 13).files).toEqual(["src/shared.ts"]);
      // A second run skips what is in.
      const again = run(parseArgs(args), () => {});
      expect(again.log.map((x: { result: string }) => x.result)).toEqual(["skip", "skip", "skip", "skip"]);
      // train:status on the pushed train.
      r.git("push", "-q", "origin", "verify/train-3");
      r.git("fetch", "-q", "origin");
      const f = gather({ cwd: r.dir, noApi: true, now: Date.now() });
      expect(f.train).toBe("verify/train-3");
      expect(f.since).toBe("verify/train-2");
      const rep = report(f);
      expect(rep.counts).toEqual({ clean: 2, auto: 1, manual: 1, unknown: 0 });
      expect(rep.lines[1]).toBe("Ledger (since verify/train-2): 4 PRs merged: 2 clean, 1 by the resolver, 1 by hand.");
    } finally {
      r.done();
    }
  });

  it("refuses a weekly train over 15 PRs unless --max says so", () => {
    const r = trainRepo();
    try {
      writeFileSync(join(r.dir, "..", "big.txt"), Array.from({ length: 16 }, (_, i) => `${200 + i} feat/x${i}`).join("\n"));
      const args = ["--cwd", r.dir, "--train", "verify/train-3", "--onto", "origin/verify/train-2", "--list", join(r.dir, "..", "big.txt"), "--dry-run"];
      expect(() => run(parseArgs(args), () => {})).toThrow("16 PRs is more than 15 (a weekly train holds ≤ 15); pass --max 16 for a catch-up train");
      expect(run(parseArgs([...args, "--max", "16"]), () => {}).queue).toHaveLength(16);
    } finally {
      r.done();
    }
  });
});

describe("helpers", () => {
  it("ranges, the queue, the previous train, the next cut, the median", () => {
    expect(parseRange("464-466,470")).toEqual([464, 465, 466, 470]);
    expect(() => parseRange("x")).toThrow("not a PR number or range: x");
    expect(queueOf([{ number: 3 }, { number: 109 }, { number: 1 }, { number: 3 }, { number: 2 }], [2]).map((q: { number: number }) => q.number)).toEqual([1, 3]);
    expect(previousTrain("verify/train-3", ["verify/train", "verify/train-2"])).toBe("verify/train-2");
    expect(previousTrain("verify/train-2", ["verify/train"])).toBe("verify/train");
    expect(previousTrain("verify/train", ["verify/train-2"])).toBeNull();
    expect(nextCut(new Date("2026-11-12T10:00:00Z"))).toBe("2026-11-15");
    expect(nextCut(new Date("2026-11-15T23:00:00Z"))).toBe("2026-11-15");
    expect(median([5, 1, 3])).toBe(3);
    expect(median([])).toBeNull();
  });

  it("the report warns over 10 hand resolutions, over 15 PRs, and when main is older than a week", () => {
    const now = Date.parse("2026-11-12T12:00:00Z");
    const merges = Array.from({ length: 16 }, (_, i) => ({ pr: i, branch: "b", resolution: i < 11 ? "manual" : "clean", files: [] }));
    const rep = report({ train: "verify/train-3", head: "a".repeat(40), headDate: "2026-11-12T10:00:00Z", ahead: 40, main: "b".repeat(40), mainDate: "2026-10-17T10:00:00Z", merges, nightly: false, vercel: "success", queue: { waiting: [501], inTrainAges: [2, 3, 30] }, now, since: "verify/train-2" });
    expect(rep.warnings).toEqual([
      "11 hand resolutions: the weekly target is ≤ 10. Smaller trains, and every PR on the train head (W6.22).",
      "16 PRs in one train: a weekly train holds ≤ 15.",
      "main hasn't moved for 26 days: promote a train that passes its gates.",
    ]);
    expect(rep.lines).toContain("  ✓ Vercel");
    expect(rep.lines).toContain("Open PRs in the train: 3, median age 3 days (target ≤ 7 to main).");
  });
});

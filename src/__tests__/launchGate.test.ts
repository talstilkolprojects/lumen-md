/**
 * Plan W11.L1 — `npm run launch:gate -- M0` reads docs/launch/milestones.json
 * and the receipts, and a criterion without a valid receipt never counts as
 * passed. The CLI runs for real on throwaway git checkouts.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
// @ts-expect-error — plain .mjs helpers without types
import { evaluate, milestoneProblems, receiptProblems } from "../../scripts/lib/launchGate.mjs";

const repo = resolve(".");
const script = join(repo, "scripts/launch-gate.mjs");
const real = JSON.parse(readFileSync(join(repo, "docs/launch/milestones.json"), "utf8"));
const git = (cwd: string, ...a: string[]) => execFileSync("git", ["-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { encoding: "utf8" }).trim();
const gate = (root: string, ...a: string[]) => spawnSync(process.execPath, [script, ...a, "--root", root], { encoding: "utf8", env: { ...process.env, LAUNCH_GATE_TODAY: "2026-12-01" } });

/** A checkout with the real milestones.json and the files its test receipts name. */
function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "launch-gate-"));
  mkdirSync(join(dir, "docs/launch"), { recursive: true });
  cpSync(join(repo, "docs/launch/milestones.json"), join(dir, "docs/launch/milestones.json"));
  for (const m of real.milestones) for (const c of m.criteria) for (const f of c.receipt.tests ?? []) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), "// stand-in for the test file\n");
  }
  git(dir, "init", "-q");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base");
  return { dir, sha: git(dir, "rev-parse", "HEAD") };
}
function receiptFor(c: { id: string; receipt: { kind: string; tests?: string[]; runs?: string[]; facts?: string[] } }, sha: string) {
  const base = { criterion: c.id, kind: c.receipt.kind, result: "pass", date: "2026-11-30", by: "test", commit: sha };
  if (c.receipt.kind === "test") return { ...base, tests: c.receipt.tests!.map((file) => ({ file, passed: 5, total: 5, command: `npx vitest run ${file}` })) };
  if (c.receipt.kind === "run") return { ...base, runs: c.receipt.runs!.map((name) => ({ name, result: "pass", evidence: `reports/${name}.json` })) };
  return { ...base, facts: Object.fromEntries(c.receipt.facts!.map((f) => [f, "recorded"])) };
}
function writeAll(dir: string, sha: string, skip?: string) {
  const m0 = real.milestones.find((m: { id: string }) => m.id === "M0");
  for (const c of m0.criteria) {
    if (c.id === skip) continue;
    const p = join(dir, "docs/launch/receipts/M0", `${c.id}.json`);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify(receiptFor(c, sha)));
  }
  return m0;
}

describe("milestones.json", () => {
  it("is well formed: M0 is complete, every criterion maps to a plan acceptance and a receipt kind", () => {
    expect(milestoneProblems(real)).toEqual([]);
    const m0 = real.milestones.find((m: { id: string }) => m.id === "M0");
    expect(m0.criteria.map((c: { id: string }) => c.id)).toEqual(["no-simulated-plugin-install", "no-unearned-verified-badge", "e2ee-off-and-labelled", "ttfv-e2e-three-browsers", "beta1-signed-and-updates"]);
    expect(gate(repo, "--check").status).toBe(0);
  });

  it("rejects a criterion that names no plan acceptance or no receipt", () => {
    const bad = structuredClone(real);
    delete bad.milestones[0].criteria[0].source.acceptance;
    bad.milestones[0].criteria[1].receipt = {};
    const p = milestoneProblems(bad);
    expect(p.some((x: string) => x.includes("source.acceptance"))).toBe(true);
    expect(p.some((x: string) => x.includes("receipt.kind"))).toBe(true);
  });
});

describe("launch:gate -- M0", () => {
  it("fails in this repository today: no criterion has a receipt yet", () => {
    const r = gate(repo, "M0");
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/FAIL M0: 0\/5 criteria/);
    expect(r.stdout).toContain("no receipt");
  });

  it("passes only with a valid receipt for every criterion", () => {
    const { dir, sha } = checkout();
    try {
      writeAll(dir, sha);
      const ok = gate(dir, "M0");
      expect(ok.stdout).toMatch(/PASS M0: 5\/5/);
      expect(ok.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails when one receipt is missing, and names it", () => {
    const { dir, sha } = checkout();
    try {
      writeAll(dir, sha, "e2ee-off-and-labelled");
      const r = gate(dir, "M0", "--json");
      expect(r.status).toBe(1);
      const out = JSON.parse(r.stdout);
      expect(out.passed).toBe(4);
      expect(out.criteria.find((c: { id: string }) => c.id === "e2ee-off-and-labelled")).toMatchObject({ pass: false, problems: ["no receipt"] });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a receipt for a commit the repository does not have", () => {
    const { dir } = checkout();
    try {
      writeAll(dir, "0123456789abcdef0123456789abcdef01234567");
      const r = gate(dir, "M0");
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("is not in this repository");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails on a receipt that does not parse", () => {
    const { dir, sha } = checkout();
    try {
      writeAll(dir, sha);
      writeFileSync(join(dir, "docs/launch/receipts/M0/beta1-signed-and-updates.json"), "{ not json");
      const r = gate(dir, "M0");
      expect(r.status).toBe(1);
      expect(r.stdout).toContain("does not parse");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an unknown milestone is a usage error, not a pass", () => {
    expect(gate(repo, "M9").status).toBe(2);
    expect(gate(repo).status).toBe(2);
  });
});

describe("a criterion without a valid receipt is not a pass", () => {
  const c = real.milestones[0].criteria[0];
  const ctx = { today: "2026-12-01" };
  const good = { criterion: c.id, kind: "test", result: "pass", date: "2026-11-30", by: "x", commit: "abc1234", tests: [{ file: c.receipt.tests[0], passed: 3, total: 3, command: "npx vitest run" }] };
  it.each([
    ["no receipt", null, "no receipt"],
    ["result fail", { ...good, result: "fail" }, 'not "pass"'],
    ["wrong criterion", { ...good, criterion: "other" }, "not no-simulated-plugin-install"],
    ["wrong kind", { ...good, kind: "owner" }, "needs test"],
    ["future date", { ...good, date: "2027-01-01" }, "after today"],
    ["no commit", { ...good, commit: "" }, "commit it ran on"],
    ["no runner", { ...good, by: " " }, "`by`"],
    ["11 of 12", { ...good, tests: [{ ...good.tests[0], passed: 11, total: 12 }] }, "11/12 passed"],
    ["zero tests", { ...good, tests: [{ ...good.tests[0], passed: 0, total: 0 }] }, "no tests counted"],
    ["test missing", { ...good, tests: [] }, "no result for"],
    ["no command", { ...good, tests: [{ ...good.tests[0], command: "" }] }, "the command"],
  ] as [string, unknown, string][])("%s", (_n: string, receipt: unknown, why: string) => {
    const p = receiptProblems(c, receipt, ctx);
    expect(p.length).toBeGreaterThan(0);
    expect(p.join("\n")).toContain(why);
  });
  it("the same receipt, valid, passes", () => expect(receiptProblems(c, good, ctx)).toEqual([]));
  it("a test file that is not in the checkout fails", () => expect(receiptProblems(c, good, { ...ctx, fileExists: () => false }).join()).toContain("does not exist"));
  it("an owner receipt needs every fact, and false is not a fact", () => {
    const o = real.milestones[0].criteria.find((x: { receipt: { kind: string } }) => x.receipt.kind === "owner");
    const r = { criterion: o.id, kind: "owner", result: "pass", date: "2026-11-30", by: "Tal", commit: "abc1234", facts: { version: "0.2.0-beta.1", releaseVerify: "ok", installedOn: "macOS", autoUpdatedTo: false } };
    expect(receiptProblems(o, r, ctx)).toEqual(["the fact autoUpdatedTo is not recorded"]);
  });
  it("a run receipt needs every run green with evidence", () => {
    const o = real.milestones[0].criteria.find((x: { receipt: { kind: string } }) => x.receipt.kind === "run");
    const r = { criterion: o.id, kind: "run", result: "pass", date: "2026-11-30", by: "Tal", commit: "abc1234", runs: [{ name: "ttfv-chromium", result: "pass", evidence: "a" }, { name: "ttfv-firefox", result: "fail", evidence: "b" }, { name: "ttfv-webkit", result: "pass", evidence: "" }] };
    const p = receiptProblems(o, r, ctx);
    expect(p).toEqual(['the run ttfv-firefox: "fail", not "pass"', "the run ttfv-webkit: no evidence (a log, a report or an artifact path)"]);
  });
  it("a milestone after another needs that one green too", () => {
    const two = { milestones: [real.milestones[0], { id: "M1", title: { en: "x", he: "x" }, after: "M0", criteria: [{ ...c, id: "solo" }] }] };
    const r = evaluate(two, "M1", { ...ctx, readReceipt: (m: string, id: string) => (m === "M1" ? { ...good, criterion: id } : null) });
    expect(r.criteria[0].pass).toBe(true);
    expect(r.pass).toBe(false);
    expect(r.before).toEqual({ id: "M0", pass: false });
  });
});

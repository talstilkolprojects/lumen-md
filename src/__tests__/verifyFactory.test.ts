// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  MUST_RUN_VITEST,
  clip,
  diffFailures,
  extraSteps,
  genericSteps,
  groupSteps,
  hostSteps,
  morningReport,
  nightName,
  parseLsRemote,
  planNight,
  receiptPath,
  statusesFor,
  suiteVerdicts,
  summarizePlaywright,
  summarizeVitest,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/factory/lib.mjs";

type Step = { id: string; group: string; status: number | string; cmd?: string[]; parallel?: boolean };
const sha = (c: string) => c.repeat(40);
const ok = (id: string, group: string, status: number | string = 0): Step => ({ id, group, status });
const pw = (unexpected: number, failed: string[] = []) => ({ expected: 10, unexpected, flaky: 0, skipped: 0, failed });
const vit = (files: string[], bad: string[] = []) => ({
  files: files.length,
  tests: files.length * 2,
  passed: files.length * 2 - bad.length,
  failed: bad.length,
  failedFiles: bad,
  ran: files.map((file) => ({ file, ok: !bad.includes(file) })),
});

describe("verification factory (plan W6.5)", () => {
  it("reads the verify/* heads from git ls-remote", () => {
    const text = `${sha("b")}\trefs/heads/verify/train-2\n${sha("a")}\trefs/heads/verify/train\nnot a line\n${sha("c")}\trefs/tags/x`;
    expect(parseLsRemote(text)).toEqual([
      { branch: "verify/train", sha: sha("a") },
      { branch: "verify/train-2", sha: sha("b") },
    ]);
  });

  it("runs the trains first, gives unchanged heads a heartbeat, and keeps the limit", () => {
    const heads = [
      { branch: "verify/e2e-probe-1", sha: sha("1") },
      { branch: "verify/train-2", sha: sha("2") },
      { branch: "verify/train", sha: sha("3") },
      { branch: "verify/chore-dod", sha: sha("4") },
    ];
    const n = planNight(heads, { done: new Set([sha("3")]), max: 2 });
    expect(n.run.map((h: { branch: string }) => h.branch)).toEqual(["verify/train-2", "verify/chore-dod"]);
    expect(n.heartbeat.map((h: { branch: string }) => h.branch)).toEqual(["verify/train"]);
    expect(n.later.map((h: { branch: string }) => h.branch)).toEqual(["verify/e2e-probe-1"]);
    expect(planNight(heads, { done: new Set([sha("3")]), max: 9, rerun: true }).heartbeat).toEqual([]);
    expect(planNight(heads, { only: ["verify/train"] }).run).toHaveLength(1);
  });

  it("the generic plan covers the whole vitest suite in 2 shards and every spec in 3 browsers × 4 shards", () => {
    const steps = genericSteps();
    expect(steps.filter((s: Step) => s.group === "vitest")).toHaveLength(2);
    for (const b of ["chromium", "firefox", "webkit"]) expect(steps.filter((s: Step) => s.id.startsWith(`e2e-${b}-`))).toHaveLength(4);
    expect(steps.find((s: Step) => s.id === "e2e-webkit-3of4")?.cmd).toEqual(["npx", "playwright", "test", "--project=webkit", "--shard=3/4", "--workers=1", "--reporter=line,json"]);
    // No --exclude anywhere: the nightly run leaves nothing out.
    expect(steps.some((s: Step) => (s.cmd ?? []).some((a) => a.startsWith("--exclude")))).toBe(false);
  });

  it("adds the drill, cargo check, and mutation on Sundays only, when the commit has them", () => {
    const sunday = new Date("2026-11-15T01:00:00Z");
    const thursday = new Date("2026-11-12T01:00:00Z");
    const scripts = { "drill:data-safety": "x", "test:mutation": "y" };
    expect(extraSteps({ scripts, hasCargo: true, date: sunday }).map((s: Step) => s.id)).toEqual(["drill-data-safety", "cargo-check", "mutation"]);
    expect(extraSteps({ scripts, hasCargo: false, date: thursday }).map((s: Step) => s.id)).toEqual(["drill-data-safety"]);
    expect(extraSteps({})).toEqual([]);
  });

  it("orders groups and leaves the Vercel settings check to a machine with a Vercel token", () => {
    const steps = [ok("v", "vercel"), ok("e", "e2e"), ok("x", "custom"), ok("b", "build"), ok("t", "vitest")];
    expect(groupSteps(steps).map(([g]: [string]) => g)).toEqual(["build", "vitest", "e2e", "vercel", "custom"]);
    expect(hostSteps(steps).map((s: Step) => s.id)).toEqual(["e", "x", "b", "t"]);
  });

  it("summarises Playwright and vitest JSON reports", () => {
    const report = {
      stats: { expected: 3, unexpected: 1, flaky: 1, skipped: 2 },
      suites: [{ file: "rtl.spec.ts", specs: [], suites: [{ specs: [{ title: "mirrors", file: "rtl.spec.ts", tests: [{ status: "unexpected" }, { status: "expected" }] }] }] }],
    };
    expect(summarizePlaywright(report)).toEqual({ expected: 3, unexpected: 1, flaky: 1, skipped: 2, failed: ["e2e/rtl.spec.ts › mirrors"] });
    expect(summarizePlaywright(null)).toBeNull();
    const v = summarizeVitest({ numTotalTests: 5, numPassedTests: 4, numFailedTests: 1, testResults: [{ name: "/lumen/src/a.test.ts", status: "passed" }, { name: "/lumen/src/b.test.ts", status: "failed" }] });
    expect(v).toMatchObject({ files: 2, tests: 5, failed: 1, failedFiles: ["src/b.test.ts"] });
  });

  it("a suite passes only when every shard exited 0, every shard report exists, and the must-run suites ran", () => {
    const steps = [ok("build", "build"), ok("vitest-1of2", "vitest"), ok("vitest-2of2", "vitest"), ok("e2e-webkit-1of2", "e2e"), ok("e2e-webkit-2of2", "e2e", 1), ok("e2e-chromium-1of1", "e2e")];
    const all = vit([...MUST_RUN_VITEST, "src/__tests__/x.test.ts"]);
    const r = suiteVerdicts(steps, { vitest: [all, vit([])], e2e: { "e2e-webkit-1of2": pw(0), "e2e-webkit-2of2": pw(1, ["e2e/a.spec.ts › t"]), "e2e-chromium-1of1": pw(0) } });
    expect(r.suites.vitest.ok).toBe(true);
    expect(r.suites["e2e webkit"]).toEqual({ ok: false, detail: "20 passed, 1 failed, 0 flaky" });
    expect(r.suites["e2e chromium"].ok).toBe(true);
    // A must-run suite that did not run fails vitest, even with a green total (weakness E65).
    const missing = suiteVerdicts(steps.slice(0, 3), { vitest: [vit(MUST_RUN_VITEST.slice(1)), vit([])] });
    expect(missing.suites.vitest.ok).toBe(false);
    expect(missing.suites.vitest.detail).toMatch(/did not run: src\/__tests__\/e2eeUi\.test\.tsx/);
    // A shard that exited 0 but left no report is not a pass.
    const noReport = suiteVerdicts([ok("e2e-firefox-1of1", "e2e")], { e2e: {} });
    expect(noReport.suites["e2e firefox"].ok).toBe(false);
  });

  it("posts one status per suite and one for the run, within GitHub's 140 characters", () => {
    const report = { minutes: 51, suites: { vitest: { ok: true, detail: "x".repeat(300) }, "e2e webkit": { ok: false, detail: "1 failed" } } };
    const st = statusesFor(report, "https://example.com/r");
    expect(st.map((s: { context: string; state: string }) => `${s.context}=${s.state}`)).toEqual(["lumen/factory: vitest=success", "lumen/factory: e2e webkit=failure", "lumen/factory=failure"]);
    expect(st.every((s: { description: string }) => s.description.length <= 140)).toBe(true);
    expect(statusesFor({ suites: {} }, "u").pop()).toMatchObject({ state: "failure", description: "no suite ran" });
    expect(clip("abc", 2)).toBe("a…");
  });

  it("names receipts by commit and never overwrites a night", () => {
    expect(receiptPath(sha("a"), "full", "2026-11-13T01:17:00.123Z")).toBe(`commits/${sha("a")}/full-2026-11-13T01-17-00-123Z.json`);
    const taken = new Set(["nights/2026-11-13.json", "nights/2026-11-13-2.json"]);
    expect(nightName("2026-11-13", (p: string) => taken.has(p))).toEqual({ json: "nights/2026-11-13-3.json", md: "nights/2026-11-13-3.md" });
  });

  it("the morning report says what failed, from which PR, and what changed since the last report", () => {
    const prev = { commit: { sha: sha("p"), branch: "verify/train" }, failures: { "e2e webkit": ["e2e/a.spec.ts › old"] } };
    const ran = [{ commit: { sha: sha("n"), branch: "verify/train" }, minutes: 48, suites: { "e2e webkit": { ok: false, detail: "1 failed" } }, failures: { "e2e webkit": ["e2e/b.spec.ts › new"] } }];
    const md = morningReport({ date: "2026-11-13", ran, heartbeat: [{ branch: "verify/train-2", sha: sha("2"), receipt: "commits/x/full.json" }], prs: { "e2e/b.spec.ts": 470 }, previous: { "verify/train": prev } });
    expect(md).toContain("e2e webkit: e2e/b.spec.ts › new — last changed in #470");
    expect(md).toContain("1 newly failing, 1 fixed");
    expect(md).toContain("- fixed: e2e/a.spec.ts › old");
    expect(md).toContain("verify/train-2 @ `222222222`: covered by commits/x/full.json");
    expect(diffFailures(undefined, ran[0])).toEqual({ newlyFailing: ["e2e/b.spec.ts › new"], fixed: [] });
  });
});

/**
 * Classification logic of scripts/ci-doctor.mjs (scripts/lib/ci-doctor.mjs),
 * driven by trimmed real API responses in fixtures/ci-doctor/: the jobs of a
 * CI run whose chromium and firefox e2e jobs failed, and their check-run
 * annotations (Playwright's GitHub reporter).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  classify,
  errorLine,
  failedSteps,
  failureItems,
  isDeterministicStep,
  nextAction,
  observe,
  parseAnnotations,
  sameTest,
  sameTestSetup,
  testKey,
  // @ts-expect-error — plain .mjs helper without type declarations
} from "../../scripts/lib/ci-doctor.mjs";

type Step = { number: number; name: string; status: string; conclusion: string | null };
type Job = { id: number; name: string; status: string; conclusion: string | null; steps: Step[] };
type Item = { kind: string; job: string; step: string | null; key: string; title?: string; path?: string; line?: number; message?: string };

const fixture = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "ci-doctor", name), "utf8"));
const jobs: Job[] = fixture("jobs-e2e-failed.json").jobs;
const job = (name: string) => jobs.find((j) => j.name === name)!;
const chromium = parseAnnotations(fixture("annotations-e2e-chromium.json"));
const firefox = parseAnnotations(fixture("annotations-e2e-firefox.json"));

/** A peer's copy of a job, with its conclusion and (optionally) one step's. */
function peerJob(name: string, conclusion: string, stepOverride?: [string, string]): Job {
  const j = structuredClone(job(name));
  j.conclusion = conclusion;
  j.steps = j.steps.map((s) => ({ ...s, conclusion: stepOverride && s.name === stepOverride[0] ? stepOverride[1] : s.conclusion === "failure" ? conclusion : s.conclusion }));
  return j;
}

const ZIP = "[chromium] › e2e/data-safety.spec.ts › the whole vault exports as a zip";
const RUBY = "[chromium] › e2e/live-exec.spec.ts › live-ruby executes real Ruby via ruby.wasm in a sandboxed worker";

describe("testKey / sameTest", () => {
  it("drops file:line:col and the reporter's box rules", () => {
    expect(testKey("[chromium] › e2e/data-safety.spec.ts:202:1 › the whole vault exports as a zip ─────")).toBe(ZIP);
    expect(testKey("  src/__tests__/a.test.tsx:12 › x  ")).toBe("src/__tests__/a.test.tsx › x");
  });
  it("matches a title cut at its first comma with the full name", () => {
    const cut = "[firefox] › e2e/s.spec.ts › Template Gallery — opens";
    expect(sameTest(cut, `${cut}, lists templates, screenshot`)).toBe(true);
    expect(sameTest(`${cut}, lists templates`, cut)).toBe(true);
    expect(sameTest(cut, `${cut}ed twice`)).toBe(false);
    expect(sameTest("[firefox]", "[firefox] › anything")).toBe(false);
  });
});

describe("parseAnnotations", () => {
  it("keeps the failed test, drops the one that passed on retry and the runner's own lines", () => {
    expect(chromium.tests.map((t: Item) => t.key)).toEqual([ZIP]);
    expect(chromium.flaky).toEqual([RUBY]);
    expect(chromium.tests[0]).toMatchObject({ path: "e2e/data-safety.spec.ts", line: 213 });
    expect(chromium.tests[0].message).toMatch(/^TimeoutError: page\.waitForEvent: Timeout 15000ms exceeded/);
  });
  it("restores a title GitHub cut at a comma from the run summary", () => {
    expect(firefox.tests.map((t: Item) => t.title)).toEqual([
      "[firefox] › e2e/screenshots-and-galleries.spec.ts:155:1 › Template Gallery — opens, lists templates, screenshot",
    ]);
    expect(firefox.tests[0].message).toBe("Error: expect(locator).toBeVisible() failed");
  });
  it("is empty for a job with only runner annotations", () => {
    const p = parseAnnotations([{ path: ".github", annotation_level: "failure", title: "", message: "Process completed with exit code 1." }]);
    expect(p).toEqual({ tests: [], other: [], flaky: [], summaryFailed: [], summary: false });
  });
});

describe("errorLine", () => {
  it("prefers the error over the test header and retry rules", () => {
    expect(errorLine("  1) [x] › a.spec.ts › t ───\n\n    Retry #1 ────\n    Error: boom\n    at foo")).toBe("Error: boom");
    expect(errorLine("  2) [x] › t\n    Test timeout of 240000ms exceeded.")).toBe("Test timeout of 240000ms exceeded.");
    expect(errorLine("")).toBe("");
  });
});

describe("annotations that are not tests", () => {
  // setup-node's tsc problem matcher annotates the source file, not a test.
  const tsc = { annotation_level: "failure", path: "src/ai/llm.ts", start_line: 12, title: "", message: "TS2322: Type 'string' is not assignable to type 'number'." };
  const vitest = { annotation_level: "failure", path: "src/__tests__/llm.test.ts", start_line: 40, title: "llm > retries", message: "AssertionError: expected 1 to be 2" };
  const job = (step: string) => ({ id: 1, name: "typecheck • test • build", status: "completed", conclusion: "failure", steps: [{ number: 1, name: step, status: "completed", conclusion: "failure" }] });
  it("a compiler diagnostic from a failed Typecheck is the step, not a test", () => {
    const parsed = parseAnnotations([tsc]);
    expect(parsed.tests).toEqual([]);
    expect(failureItems(job("Typecheck"), parsed)).toEqual([{ kind: "step", job: "typecheck • test • build", step: "Typecheck", key: "Typecheck" }]);
    expect(nextAction(failureItems(job("Typecheck"), parsed)[0], "real", { id: 1 })).toContain("npx tsc --noEmit -p .");
  });
  it("test-shaped annotations are tests; others only when a test step failed", () => {
    expect(parseAnnotations([vitest]).tests.map((t: { path: string }) => t.path)).toEqual(["src/__tests__/llm.test.ts"]);
    const items = failureItems(job("Test"), parseAnnotations([tsc, vitest]));
    expect(items.map((i: Item) => [i.kind, i.path])).toEqual([
      ["test", "src/__tests__/llm.test.ts"],
      ["test", "src/ai/llm.ts"],
    ]);
  });
  it("a compiler diagnostic in a test file from a failed Typecheck is still the step", () => {
    const tscInTest = { annotation_level: "failure", path: "src/__tests__/llm.test.ts", start_line: 3, title: "", message: "TS2345: Argument of type 'string' is not assignable" };
    expect(failureItems(job("Typecheck"), parseAnnotations([tscInTest]))).toEqual([{ kind: "step", job: "typecheck • test • build", step: "Typecheck", key: "Typecheck" }]);
    expect(failureItems(job("Test"), parseAnnotations([tscInTest]))[0].kind).toBe("test");
  });
  it("a cache or artifact step that failed on the same commit elsewhere is flaky, not real", () => {
    const restore: Item = { kind: "step", job: "typecheck • test • build", step: "Restore main's bundle sizes", key: "Restore main's bundle sizes" };
    expect(classify(restore, [{ outcome: "passed", distance: 0, sameSha: true, branch: "feat/y" }]).verdict).toBe("flaky");
  });
});

describe("failureItems", () => {
  it("one item per failing test, carrying the failed step", () => {
    const items = failureItems(job("e2e (chromium)"), chromium);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "test", job: "e2e (chromium)", step: "Run E2E (chromium)", key: ZIP });
  });
  it("falls back to the failed steps when no test is named", () => {
    const j = peerJob("typecheck • test • build", "failure", ["Bundle-size budget", "failure"]);
    expect(failedSteps(j).map((s: Step) => s.name)).toEqual(["Bundle-size budget"]);
    expect(failureItems(j, { tests: [], flaky: [] })).toEqual([
      { kind: "step", job: "typecheck • test • build", step: "Bundle-size budget", key: "Bundle-size budget" },
    ]);
  });
});

describe("observe", () => {
  const item: Item = failureItems(job("e2e (chromium)"), chromium)[0];
  it("a green peer job passed the test", () => {
    expect(observe(item, peerJob("e2e (chromium)", "success"), { tests: [], flaky: [] })).toBe("passed");
  });
  it("a green peer job that retried the test makes it flaky", () => {
    expect(observe(item, peerJob("e2e (chromium)", "success"), { tests: [], flaky: [ZIP] })).toBe("flaky");
  });
  it("a red peer job with the same test failed it", () => {
    expect(observe(item, peerJob("e2e (chromium)", "failure"), chromium)).toBe("failed");
  });
  it("a red peer job failing on other tests in the same step passed it", () => {
    expect(observe(item, peerJob("e2e (chromium)", "failure"), firefox)).toBe("passed");
  });
  it("a peer whose test step failed without reporting anything says nothing", () => {
    // Playwright crashed in "Run E2E": no failures, no run summary.
    expect(observe(item, peerJob("e2e (chromium)", "failure"), parseAnnotations([]))).toBeNull();
    expect(observe(item, peerJob("e2e (chromium)", "failure"), parseAnnotations([{ path: ".github", annotation_level: "failure", title: "", message: "Process completed with exit code 1." }]))).toBeNull();
    // A run summary that does not list this test: it passed there.
    const summaryOnly = parseAnnotations([{ path: ".github", annotation_level: "notice", title: "🎭 Playwright Run Summary", message: "  1 failed\n    [chromium] › e2e/other.spec.ts:3:1 › other\n  40 passed (1.2m)" }]);
    expect(summaryOnly.summary).toBe(true);
    expect(observe(item, peerJob("e2e (chromium)", "failure"), summaryOnly)).toBe("passed");
  });
  it("a peer that failed before the tests ran, was skipped, or is missing says nothing", () => {
    const early = peerJob("e2e (chromium)", "failure", ["Run E2E (chromium)", "skipped"]);
    early.steps = early.steps.map((s) => (s.name === "Run npm ci || npm install" ? { ...s, conclusion: "failure" } : s));
    expect(failedSteps(early).map((s: Step) => s.name)).toEqual(["Run npm ci || npm install"]);
    expect(observe(item, early, { tests: [], flaky: [] })).toBeNull();
    expect(observe(item, peerJob("e2e (chromium)", "skipped"), null)).toBeNull();
    expect(observe(item, undefined, null)).toBeNull();
  });
  it("a green peer says nothing about a test that may not exist there", () => {
    const absent = { testPresent: false };
    expect(observe(item, peerJob("e2e (chromium)", "success"), { tests: [], flaky: [] }, absent)).toBeNull();
    expect(observe(item, peerJob("e2e (chromium)", "failure"), firefox, absent)).toBeNull();
    // Named in the peer's annotations: it was there.
    expect(observe(item, peerJob("e2e (chromium)", "success"), { tests: [], flaky: [ZIP] }, absent)).toBe("flaky");
    expect(observe(item, peerJob("e2e (chromium)", "failure"), chromium, absent)).toBe("failed");
  });
  it("step items compare the step itself", () => {
    const step: Item = { kind: "step", job: "typecheck • test • build", step: "Bundle-size budget", key: "Bundle-size budget" };
    expect(observe(step, peerJob("typecheck • test • build", "success"), null)).toBe("passed");
    expect(observe(step, peerJob("typecheck • test • build", "failure", ["Bundle-size budget", "failure"]), null)).toBe("failed");
  });
});

describe("classify", () => {
  const test: Item = { kind: "test", job: "e2e (chromium)", step: "Run E2E (chromium)", key: ZIP };
  const budget: Item = { kind: "step", job: "typecheck • test • build", step: "Bundle-size budget", key: "Bundle-size budget" };
  const o = (outcome: string | null, distance: number | null, branch = "feat/x", sameSha = false) => ({ outcome, distance, branch, sameSha });

  it("fails at every similar commit → real", () => {
    const c = classify(test, [o("failed", 3, "a"), o("failed", 7, "b"), o("passed", 90, "far")]);
    expect(c).toMatchObject({ verdict: "real", failed: 2, passed: 0 });
    expect(c.why).toMatch(/failed consistently: 2\/2/);
  });
  it("passes at similar commits, fails only here → flake suspect", () => {
    expect(classify(test, [o("passed", 2, "a"), o("passed", 12, "b"), o(null, 1)]).verdict).toBe("flake?");
  });
  it("both passes and fails nearby → flaky", () => {
    expect(classify(test, [o("passed", 2), o("failed", 4)]).verdict).toBe("flaky");
  });
  it("retried into a pass elsewhere → flaky", () => {
    expect(classify(test, [o("flaky", 5, "a"), o("failed", 4)]).verdict).toBe("flaky");
  });
  it("the same commit passed on another branch → flaky", () => {
    const c = classify(test, [o("passed", 0, "push-run", true), o("failed", 0, "pr-run", true)]);
    expect(c.verdict).toBe("flaky");
    expect(c.why).toMatch(/same commit passed on push-run/);
  });
  it("green only where the test may not exist → unknown, and says why", () => {
    const c = classify(test, [{ outcome: null, unproven: true, distance: 3, branch: "feat/y" }]);
    expect(c.verdict).toBe("unknown");
    expect(c.why).toMatch(/file differs there/);
  });
  it("nothing comparable → unknown", () => {
    expect(classify(test, []).verdict).toBe("unknown");
    expect(classify(test, [o("passed", 200), o("failed", null)]).why).toMatch(/2 further away/);
    expect(classify(test, [o("passed", 31)], { maxDistance: 30 }).verdict).toBe("unknown");
    expect(classify(test, [o("passed", 31)], { maxDistance: 40 }).verdict).toBe("flake?");
  });
  it("a deterministic check with nothing to compare is still real, not unknown (W1.32, #204)", () => {
    expect(classify(budget, [])).toMatchObject({ verdict: "real" });
    expect(classify(budget, [o("passed", 200)]).why).toMatch(/no run at a similar commit/);
  });
  it("a deterministic check is never flaky", () => {
    expect(classify(budget, [o("passed", 2, "a")])).toMatchObject({ verdict: "real" });
    expect(classify(budget, [o("passed", 2, "a")]).why).toMatch(/this branch's change/);
    expect(classify(budget, [o("failed", 2, "a"), o("failed", 3, "b")]).why).toMatch(/shared base/);
    expect(classify(budget, [o("passed", 0, "a", true), o("failed", 3, "b")]).verdict).toBe("real");
  });
});

describe("sameTestSetup (W1.32, #204)", () => {
  const side = (...files: string[]) => ({ n: files.length, files });
  it("the test file and every file that selects tests must be unchanged on both sides", () => {
    expect(sameTestSetup("e2e/a.spec.ts", side("src/x.ts"), side("README.md"))).toBe(true);
    expect(sameTestSetup("e2e/a.spec.ts", side("e2e/a.spec.ts"), side())).toBe(false);
    for (const f of ["playwright.config.ts", "vite.config.ts", "vitest.config.mts", ".github/workflows/ci.yml"]) {
      expect(sameTestSetup("e2e/a.spec.ts", side(), side(f)), f).toBe(false);
    }
    expect(sameTestSetup("e2e/a.spec.ts", side("e2e/playwright.config.ts.md"), side())).toBe(true);
  });
  it("proves nothing without a path, a comparison, or with a truncated (300-file) list", () => {
    expect(sameTestSetup(undefined, side(), side())).toBe(false);
    expect(sameTestSetup("e2e/a.spec.ts", null, side())).toBe(false);
    expect(sameTestSetup("e2e/a.spec.ts", { n: 300, files: [] }, side())).toBe(false);
  });
});

describe("isDeterministicStep", () => {
  it.each([
    ["Typecheck", true],
    ["Code hygiene (no `as any` / console.log in production src)", true],
    ["Bundle-size budget", true],
    ["i18n drift gate", true],
    ["Build", true],
    ["Test", false],
    ["Run E2E (chromium)", false],
    ["Run E2E against prod bundle", false],
    ["Install", false],
    // Cache / artifact steps talk to a service, whatever they are named after.
    ["Restore main's bundle sizes", false],
    ["Save bundle sizes (main)", false],
    ["Upload bundle-size change", false],
    ["Install Playwright browsers (chromium only — saves ~6 min)", false],
    ["Build production bundle", true],
  ])("%s → %s", (name, want) => {
    expect(isDeterministicStep(name)).toBe(want);
  });
});

describe("nextAction", () => {
  const run = { id: 39083856886 };
  const e2e: Item = { ...failureItems(job("e2e (chromium)"), chromium)[0] };
  it("flaky e2e → rerun, then the flake hunter on that spec and browser", () => {
    expect(nextAction(e2e, "flaky", run)).toBe(
      "gh run rerun 39083856886 --failed; then make it stable: npm run e2e:flake -- e2e/data-safety.spec.ts --times 10 --project chromium",
    );
  });
  it("suspected flake → one rerun, then the local repro", () => {
    expect(nextAction(e2e, "flake?", run)).toMatch(/--failed once; if it fails again it is real — reproduce with: npx playwright test e2e\/data-safety\.spec\.ts --project=chromium$/);
  });
  it("real step → the local command for that ci.yml step", () => {
    expect(nextAction({ kind: "step", job: "typecheck • test • build", step: "Bundle-size budget", key: "" }, "real", run)).toBe(
      "reproduce and fix locally: npm run build && npm run budget",
    );
    expect(nextAction({ kind: "step", job: "typecheck • test • build", step: "i18n drift gate", key: "" }, "real", run)).toMatch(/npm run i18n:check$/);
  });
  it("e2e in the production-build job reproduces against dist", () => {
    expect(nextAction({ ...e2e, job: "e2e against production build" }, "real", run)).toMatch(/PLAYWRIGHT_BASE_URL=http:\/\/localhost:5180 npx playwright test e2e\/data-safety\.spec\.ts/);
  });
  it("vitest failures → vitest on that file", () => {
    expect(nextAction({ kind: "test", job: "typecheck • test • build", step: "Test", key: "k", path: "src/__tests__/a.test.ts" }, "real", run)).toBe(
      "reproduce and fix locally: npx vitest run src/__tests__/a.test.ts",
    );
  });
});

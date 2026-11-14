/**
 * W1.35: the Vercel build is the gate. A preview runs every check; a
 * production build only builds; the deploy config calls the script.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { GATES, GATE_EXTRA, PREVIEW_GATES, PRODUCTION_GATES, gatesFor, vitestSummary } from "../../scripts/vercel-build.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { E2E_SPECS, FIREFOX_SPECS, boxMinutes, e2eRuns } from "../../scripts/e2e-gate.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { failureLines } from "../../scripts/e2e-report.mjs";

const ROOT = resolve(__dirname, "..", "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };

describe("scripts/vercel-build.mjs", () => {
  it("runs every gate on a preview, and only build + budget in production", () => {
    expect(gatesFor({ VERCEL_ENV: "preview" })).toEqual(["lockfile", "build", "budget", "secrets", "manifest", "vitest", "e2e", "i18n:check", "hygiene", "docs:sync", "docs:complete", "licenses", "mutation"]);
    expect(gatesFor({ VERCEL_ENV: "production" })).toEqual(["build", "budget", "manifest"]);
    // Not on Vercel: a local run reproduces a preview build.
    expect(gatesFor({})).toEqual(PREVIEW_GATES);
    expect(gatesFor({ VERCEL_ENV: "preview" }, ["--production"])).toEqual(PRODUCTION_GATES);
    // A probe branch's e2e-only build: the specs without vitest.
    expect(gatesFor({ VERCEL_ENV: "preview" }, ["--e2e-only"])).toEqual(["build", "e2e"]);
  });

  it("every gate is an npm script that exists", () => {
    for (const gate of PREVIEW_GATES) {
      const args = GATES[gate] as string[];
      const script = args[args.length - 1];
      expect(pkg.scripts[script], gate).toBeDefined();
    }
  });

  it("a failed vitest run ends with one block naming every failing file (W1.1)", () => {
    expect(GATE_EXTRA.vitest).toContain("--reporter=json");
    const lines = vitestSummary({
      numFailedTestSuites: 2,
      numTotalTestSuites: 3,
      numFailedTests: 1,
      numPassedTests: 9,
      numTotalTests: 10,
      testResults: [
        { name: "/vercel/path0/src/__tests__/a.test.ts", status: "failed", assertionResults: [{ fullName: "a works", status: "failed", failureMessages: ["\u001b[31mAssertionError: expected 1 to be 2\u001b[39m\n    at x"] }] },
        { name: "/vercel/path0/src/__tests__/b.test.ts", status: "failed", message: "Error: Failed to load url ./missing\n stack", assertionResults: [] },
        { name: "/vercel/path0/src/__tests__/c.test.ts", status: "passed", assertionResults: [] },
      ],
    }) as string[];
    expect(lines[0]).toBe("✗ vitest summary: files 2 failed / 3; tests 1 failed, 9 passed / 10");
    expect(lines).toContain("  src/__tests__/a.test.ts: 1 failed");
    expect(lines).toContain("      AssertionError: expected 1 to be 2");
    expect(lines).toContain("  src/__tests__/b.test.ts: the file failed to run");
    expect(lines.join("\n")).not.toContain("c.test.ts");
    expect(vitestSummary(null)).toBeNull();
  });

  it("the upload keeps what the gates read: e2e specs, docs, native configs (W1.1)", () => {
    const ignore = readFileSync(resolve(ROOT, ".vercelignore"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    for (const tree of ["e2e", "docs", "src-tauri", "ios", "android"]) expect(ignore, tree).not.toContain(tree);
  });

  it("the e2e gate's time box ends by minute 38 of the build (Vercel stops at 45)", () => {
    const t0 = 1_000_000_000_000;
    const min = 60_000;
    expect(boxMinutes({}, t0)).toBe(8); // not inside vercel-build: the default box
    expect(boxMinutes({ LUMEN_BUILD_STARTED: String(t0) }, t0 + 5 * min)).toBe(8);
    expect(boxMinutes({ LUMEN_BUILD_STARTED: String(t0) }, t0 + 32.5 * min)).toBe(5);
    expect(boxMinutes({ LUMEN_BUILD_STARTED: String(t0) }, t0 + 40 * min)).toBe(0);
    expect(GATES.e2e).toEqual(["run", "-s", "e2e:gate"]);
    // The whole chromium project took 29.7 min on the build machine; the gate runs the specs that fit.
    // W6.30: axe and the aria snapshots on the Hebrew flows join the smoke spec.
    expect(E2E_SPECS).toEqual(["e2e/smoke.spec.ts", "e2e/a11y-hebrew-gate.spec.ts", "e2e/aria-hebrew.spec.ts"]);
    for (const f of E2E_SPECS) expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    // Firefox runs the smoke spec too; WebKit cannot run on the build image (glibc 2.34).
    expect(FIREFOX_SPECS).toEqual(["e2e/smoke.spec.ts"]);
    expect(e2eRuns().map((r: { project: string }) => r.project)).toEqual(["chromium", "firefox"]);
    expect(e2eRuns(["e2e/a.spec.ts"], []).map((r: { project: string }) => r.project)).toEqual(["chromium"]);
    expect(PREVIEW_GATES.indexOf("e2e")).toBe(PREVIEW_GATES.indexOf("vitest") + 1);
  });

  it("a failed e2e test ends the log as one block: place, title, error, page snapshot", () => {
    const lines = failureLines([
      { where: "e2e/a.spec.ts:9", title: "opens › and closes", status: "failed", error: "\u001b[31mError: expected\u001b[39m\nmore", context: "- button \"Save\"" },
      { where: "e2e/b.spec.ts:3", title: "waits", status: "timedOut", error: "Test timeout of 30000ms exceeded.", context: "" },
    ]) as string[];
    expect(lines).toEqual([
      "✗ e2e/a.spec.ts:9 › opens › and closes",
      "    Error: expected",
      "    more",
      "    page:",
      '      - button "Save"',
      "✗ e2e/b.spec.ts:3 › waits (timed out)",
      "    Test timeout of 30000ms exceeded.",
    ]);
  });

  it("deploy/vercel.base.json builds through it", () => {
    const base = JSON.parse(readFileSync(resolve(ROOT, "deploy/vercel.base.json"), "utf8")) as { buildCommand?: string };
    expect(base.buildCommand).toBe("node scripts/vercel-build.mjs");
  });
});

/** 0.14 — `npm run ci:local` runs what CI runs; --changed narrows it to what the diff can break. */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs helper without types
import { planSteps, e2eSpecs, i18nDrift, summary, coverageGate, hookPlan, buildState, argErrors, isAppCode, COVERAGE_MIN, HOOK_MARK, STEP_IDS, dynamicImportTargets } from "../../scripts/lib/ciLocal.mjs";

type Step = { id: string; cmd: string[]; skipReason?: string; coverageMin?: number };
const pkg = { scripts: { hygiene: "x", budget: "x", licenses: "x" } };
const exists = (p: string) => p !== "scripts/headers.mjs";
const plan = (changed: string[] | null, flags: Record<string, unknown> = {}) => planSteps({ pkg, exists, changed, flags }) as Step[];
const byId = (steps: Step[]) => Object.fromEntries(steps.map((s) => [s.id, s]));

describe("ci:local steps", () => {
  it("a full run has every CI step; tools this branch lacks are 'not here', not failures", () => {
    const s = byId(plan(null));
    expect(Object.keys(s)).toEqual(["typecheck", "hygiene", "lint", "i18n", "licenses", "headers", "test", "build", "budget", "e2e"]);
    for (const id of ["typecheck", "hygiene", "i18n", "licenses", "test", "build", "budget", "e2e"]) expect(s[id].skipReason, id).toBeUndefined();
    expect(s.lint.skipReason).toMatch(/not here/);
    expect(s.headers.skipReason).toMatch(/not here/);
    expect(s.test.cmd).toEqual(["npx", "vitest", "run"]);
  });

  it("--coverage, --skip and --only", () => {
    expect(byId(plan(null, { coverage: true })).test.cmd).toContain("--coverage");
    expect(byId(plan(null, { skip: ["e2e", "build"] })).e2e.skipReason).toMatch(/--skip/);
    const only = byId(plan(null, { only: ["typecheck"] }));
    expect(only.typecheck.skipReason).toBeUndefined();
    expect(only.test.skipReason).toBe("not selected");
  });

  it("--changed runs the tests related to the changed code files", () => {
    const s = byId(plan(["src/ai/tts.ts", "docs/a.md"]));
    expect(s.test.cmd).toEqual(["npx", "vitest", "related", "--run", "--passWithNoTests", "src/ai/tts.ts"]);
    expect(s.build.skipReason).toBeUndefined();
  });

  it("a docs-only diff skips tests, build and e2e but still type-checks", () => {
    const s = byId(plan(["docs/a.md", "MASTER_PLAN.md"]));
    expect(s.typecheck.skipReason).toBeUndefined();
    expect(s.test.skipReason).toMatch(/no unit-test inputs/);
    for (const id of ["build", "budget", "e2e"]) expect(s[id].skipReason, id).toMatch(/no app code/);
  });

  it("e2e: a full run passes no spec list; --changed runs smoke plus changed specs", () => {
    const all = ["e2e/smoke.spec.ts", "e2e/rtl.spec.ts", "e2e/ai-cancel.spec.ts"];
    expect(e2eSpecs(null, all)).toEqual([]);
    expect(e2eSpecs(["e2e/rtl.spec.ts", "src/x.ts"], all)).toEqual(["e2e/smoke.spec.ts", "e2e/rtl.spec.ts"]);
  });

  it("the i18n drift gate matches CI (≤ 10 keys) and the summary marks each step", () => {
    expect(i18nDrift(1411, 1401).ok).toBe(true);
    expect(i18nDrift(1411, 1400)).toEqual({ diff: 11, ok: false });
    const out = summary([
      { title: "TypeScript", status: "pass", ms: 1200 },
      { title: "ESLint", status: "skip", reason: "not here" },
      { title: "Vitest", status: "fail", ms: 3000 },
    ]);
    expect(out).toMatch(/✓ TypeScript\s+1\.2s/);
    expect(out).toMatch(/– ESLint\s+not here/);
    expect(out).toMatch(/✗ Vitest/);
  });
});

describe("ci:local review fixes", () => {
  it("--coverage enforces CI's 65% lines gate on the full run", () => {
    expect(COVERAGE_MIN).toBe(65);
    expect(byId(plan(null, { coverage: true })).test.coverageMin).toBe(65);
    expect(byId(plan(null)).test.coverageMin).toBeUndefined();
    // vitest related measures a slice: no gate there.
    expect(byId(plan(["src/ai/tts.ts"], { coverage: true })).test.coverageMin).toBeUndefined();
    const summaryOf = (pct: number) => JSON.stringify({ total: { lines: { pct } } });
    expect(coverageGate(summaryOf(66.7))).toMatchObject({ ok: true, pct: 66.7 });
    expect(coverageGate(summaryOf(65))).toMatchObject({ ok: true });
    expect(coverageGate(summaryOf(64.9))).toEqual({ ok: false, pct: 64.9, message: "Lines coverage 64.9% < 65% gate" });
    expect(coverageGate(null).ok).toBe(false);
    expect(coverageGate("{}").ok).toBe(false);
  });

  it("a deleted file still counts as a change; a deleted code file runs the full suite", () => {
    const gone = (p: string) => !["src/old.ts", "public/icon.svg"].includes(p) && exists(p);
    const s = byId(planSteps({ pkg, exists: gone, changed: ["src/old.ts"], flags: {} }) as Step[]);
    for (const id of ["build", "budget", "e2e"]) expect(s[id].skipReason, id).toBeUndefined();
    expect(s.test.cmd).toEqual(["npx", "vitest", "run"]);
    const pub = byId(planSteps({ pkg, exists: gone, changed: ["public/icon.svg"], flags: {} }) as Step[]);
    for (const id of ["build", "budget", "e2e"]) expect(pub[id].skipReason, id).toBeUndefined();
  });

  it("a changed module that something loads with a dynamic import runs the full suite (W1.32, #210)", () => {
    const targets = dynamicImportTargets([
      { path: "src/App.tsx", text: 'const Gallery = lazy(() => import("./ui/PluginGallery"));' },
      { path: "src/__tests__/x.test.ts", text: 'await import(/* reload */ "../ai/mt/index.ts");\nimport { y } from "../static/y";' },
    ]);
    expect([...targets].sort()).toEqual(["src/ai/mt", "src/ui/PluginGallery"]);
    const lazy = byId(planSteps({ pkg, exists, changed: ["src/ui/PluginGallery.tsx"], dynamicTargets: targets, flags: {} }) as Step[]);
    expect(lazy.test.cmd).toEqual(["npx", "vitest", "run"]);
    const viaIndex = byId(planSteps({ pkg, exists, changed: ["src/ai/mt/index.ts"], dynamicTargets: targets, flags: {} }) as Step[]);
    expect(viaIndex.test.cmd).toEqual(["npx", "vitest", "run"]);
    // A module only imported statically keeps the related run.
    const plain = byId(planSteps({ pkg, exists, changed: ["src/static/y.ts"], dynamicTargets: targets, flags: {} }) as Step[]);
    expect(plain.test.cmd).toEqual(["npx", "vitest", "related", "--run", "--passWithNoTests", "src/static/y.ts"]);
  });

  it("every root HTML entry is app code (playground-runner.html, livejs-runner.html)", () => {
    for (const f of ["playground-runner.html", "livejs-runner.html", "index.html"]) {
      expect(isAppCode(f), f).toBe(true);
      const s = byId(plan([f]));
      for (const id of ["build", "budget", "e2e"]) expect(s[id].skipReason, `${f} ${id}`).toBeUndefined();
    }
    expect(isAppCode("docs/a.html")).toBe(false);
  });

  it("budget and e2e use this run's build: build first when there is none, fail when it failed", () => {
    expect(buildState([])).toBe("none"); // --only e2e / --only budget: never trust an old dist/
    expect(buildState([{ id: "build", status: "skip" }])).toBe("none");
    expect(buildState([{ id: "build", status: "fail" }])).toBe("failed");
    expect(buildState([{ id: "typecheck", status: "pass" }, { id: "build", status: "pass" }])).toBe("fresh");
    // The budget no longer needs a dist/ to exist (it builds first).
    const noDist = (p: string) => p !== "dist" && exists(p);
    expect(byId(planSteps({ pkg, exists: noDist, changed: null, flags: { only: ["budget"] } }) as Step[]).budget.skipReason).toBeUndefined();
  });

  it("--install-hook never replaces someone else's pre-push hook silently", () => {
    expect(hookPlan(null).action).toBe("write");
    expect(hookPlan(null).content).toContain(HOOK_MARK);
    expect(hookPlan(hookPlan(null).content).action).toBe("write"); // reinstalling ours
    expect(hookPlan("#!/bin/sh\nnpx lint-staged\n").action).toBe("refuse");
    expect(hookPlan("#!/bin/sh\nnpx lint-staged\n", { force: true }).action).toBe("backup");
  });

  it("a non-code app input (a locale, public/_headers) runs the full suite; e2e specs are not vitest inputs", () => {
    for (const f of ["src/i18n/locales/he/cmd.json", "public/_headers", "playground-runner.html"]) {
      const t = byId(plan([f])).test;
      expect([f, t.cmd]).toEqual([f, ["npx", "vitest", "run"]]);
      expect(t.skipReason).toBeUndefined();
    }
    // An e2e-only diff: no unit tests to relate (and no failing `vitest related`), e2e still runs.
    const e2e = byId(plan(["e2e/rtl.spec.ts"]));
    expect(e2e.test.skipReason).toMatch(/no unit-test inputs/);
    expect(e2e.e2e.skipReason).toBeUndefined();
    expect(byId(plan(["e2e/rtl.spec.ts", "src/ai/tts.ts"])).test.cmd).toEqual(["npx", "vitest", "related", "--run", "--passWithNoTests", "src/ai/tts.ts"]);
  });

  it("the PostCSS / Tailwind configs are app code; a changed e2e helper runs every spec", () => {
    expect(isAppCode("postcss.config.js")).toBe(true);
    expect(byId(plan(["postcss.config.js"])).build.skipReason).toBeUndefined();
    const all = ["e2e/smoke.spec.ts", "e2e/error-paths.spec.ts", "e2e/rtl.spec.ts"];
    expect(e2eSpecs(["e2e/_clear-state.ts"], all)).toEqual([]); // [] = the full suite
    expect(e2eSpecs(["e2e/rtl.spec.ts"], all)).toEqual(["e2e/smoke.spec.ts", "e2e/rtl.spec.ts"]);
  });

  it("rejects unknown flags and step ids instead of passing without the requested checks", () => {
    expect(argErrors(["--changed", "--base", "origin/main", "--only", "typecheck,test", "--coverage", "--bail"])).toEqual([]);
    expect(argErrors(["--covrage"])).toEqual(['unknown argument "--covrage"']);
    expect(argErrors(["--only", "tests"])[0]).toMatch(/--only: unknown step "tests"/);
    expect(argErrors(["--skip"])).toEqual(["--skip needs a value"]);
    expect(STEP_IDS).toEqual(plan(null).map((s) => s.id));
  });
});

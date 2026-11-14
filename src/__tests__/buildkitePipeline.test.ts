// @vitest-environment node
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import {
  JOBS,
  NOT_GATES,
  OVERRIDES,
  STATUS_PREFIX,
  VITEST_INCLUDE,
  buildPipeline,
  buildRequest,
  escapeDollars,
  gateCoverage,
  gateKeys,
  globRegExp,
  jobScript,
  mergeCheck,
  pipelineRules,
  planShards,
  planTriggers,
  receiptReport,
  stripSkip,
  substitute,
  toYaml,
  // @ts-expect-error — plain .mjs module without type declarations
} from "../../scripts/buildkite/lib.mjs";

type Ci = { jobs: Record<string, { steps: { name?: string; run?: string }[]; strategy?: { matrix?: Record<string, string[]> } }> };
type Step = { key: string; command: string; agents: { queue: string }; notify?: unknown[]; if?: string; parallelism?: number; soft_fail?: boolean; retry?: unknown; depends_on?: unknown };
type Shard = { index: number; files: string[]; ms: number };

const ci = (): Ci => parse(readFileSync(".github/workflows/ci.yml", "utf8"), { uniqueKeys: false }) as Ci;
const committed = () => parse(readFileSync(".buildkite/pipeline.yml", "utf8")) as { steps: Step[]; notify: unknown[] };
const sha = (c: string) => c.repeat(40);

describe("Buildkite pipeline against ci.yml (plan W7.21)", () => {
  it("runs every ci.yml gate, and leaves out only steps named in NOT_GATES", () => {
    const r = gateCoverage(ci());
    expect(r.problems).toEqual([]);
    expect(r.mapped.length).toBeGreaterThanOrEqual(30);
    for (const id of ["check › Typecheck", "check › Bundle-size budget", "check › i18n drift gate", "lint › ESLint", "licenses › Licence gate"]) expect(r.mapped.map((m: { id: string }) => m.id)).toContain(id);
  });

  it("the committed .buildkite/pipeline.yml is what ci.yml gives (npm run ci:pipeline -- --write)", () => {
    expect(committed()).toEqual(parse(toYaml(buildPipeline(ci()))));
  });

  it("keeps its own rules: no soft_fail, no retry on a test failure, a status per gate, WebKit on the Mac", () => {
    expect(pipelineRules(committed())).toEqual([]);
    const steps = committed().steps;
    const webkit = steps.find((s) => s.key === "e2e-webkit");
    expect(webkit?.agents.queue).toBe("mac");
    expect(webkit?.if).toBeUndefined();
    for (const b of ["chromium", "firefox", "webkit"]) expect(steps.map((s) => s.key)).toContain(`e2e-${b}`);
    expect(steps.find((s) => s.key === "vitest")?.parallelism).toBe(4);
    expect(committed().notify).toEqual([{ github_commit_status: { context: STATUS_PREFIX } }]);
  });

  it("a gate added to or renamed in ci.yml, or a new browser, fails the check", () => {
    const added = ci();
    added.jobs.check.steps.push({ name: "New gate", run: "npm run new-gate" });
    expect(gateCoverage(added).problems.join("\n")).toContain("New gate");
    const renamed = ci();
    const tc = renamed.jobs.check.steps.find((s) => s.name === "Typecheck");
    if (tc) tc.name = "Types";
    expect(gateCoverage(renamed).problems.join("\n")).toContain('has no step "Typecheck"');
    const browsers = ci();
    browsers.jobs.e2e.strategy?.matrix?.browser.push("msedge");
    expect(gateCoverage(browsers).problems.join("\n")).toContain("browser=msedge has no pipeline job");
  });

  it("breaking a rule is caught: soft_fail, a retry on exit 1, WebKit on Linux, a gate the receipt does not wait for", () => {
    const p = buildPipeline(ci());
    const by = (k: string) => p.steps.find((s: Step) => s.key === k);
    by("lint").soft_fail = true;
    by("static").retry = { automatic: [{ exit_status: 1, limit: 2 }] };
    by("e2e-webkit").agents = { queue: "linux" };
    by("receipt").depends_on = [];
    const problems = pipelineRules(p).join("\n");
    expect(problems).toContain("soft_fail");
    expect(problems).toContain("automatic retry on exit 1");
    expect(problems).toContain("e2e-webkit must run on the Mac");
    expect(problems).toContain("receipt does not wait for static");
  });

  it("copies ci.yml's run text, with matrix values, env overrides and escaped $", () => {
    const job = JOBS.find((j: { key: string }) => j.key === "e2e-firefox");
    const script = jobScript(job, ci());
    expect(script).toContain('if [ "firefox" = firefox ]; then');
    expect(script).toContain("LIBGL_ALWAYS_SOFTWARE=1");
    expect(script).not.toContain("${{");
    const build = jobScript(JOBS.find((j: { key: string }) => j.key === "build"), ci());
    expect(build).toContain("npm run budget -- --json bundle-sizes.json");
    expect(escapeDollars('a=$(x) "$b"')).toBe('a=$$(x) "$$b"');
    expect(() => substitute("${{ github.token }}", {}, "t")).toThrow(/GitHub expression/);
    expect(substitute("--project=${{ matrix.browser }}", { browser: "webkit" })).toBe("--project=webkit");
  });

  it("every gate has a commit status and the receipt waits for all of them", () => {
    const p = buildPipeline(ci());
    const keys = gateKeys(p);
    for (const k of ["static", "lint", "licenses", "build", "vitest", "vitest-merge", "e2e-chromium", "e2e-firefox", "e2e-webkit"]) expect(keys).toContain(k);
    const receipt = p.steps.find((s: Step) => s.key === "receipt");
    expect(receipt.depends_on.map((d: { step: string }) => d.step).sort()).toEqual([...keys].sort());
  });

  it("the drift step runs scripts/i18n-drift.mjs (counts the lazy English), pinned to the ci.yml text it replaces", () => {
    const script = jobScript(JOBS.find((j: { key: string }) => j.key === "static"), ci());
    expect(script).toContain("node scripts/i18n-drift.mjs");
    expect(script).toContain("node scripts/i18n-split.mjs --check");
    expect(script).not.toContain("count() {");
    expect(OVERRIDES["check › i18n drift gate"].reason).toMatch(/stricter/);
    const changed = ci();
    const step = changed.jobs.check.steps.find((s) => s.name === "i18n drift gate");
    if (step) step.run = `${step.run}\necho more`;
    expect(() => jobScript(JOBS.find((j: { key: string }) => j.key === "static"), changed)).toThrow(/changed this step since its override was reviewed/);
  });

  it("NOT_GATES has a reason for each entry", () => {
    for (const [k, v] of Object.entries(NOT_GATES as Record<string, string>)) expect(`${k}: ${v}`.length).toBeGreaterThan(k.length + 10);
  });

  it("VITEST_INCLUDE matches vite.config.ts", () => {
    const vite = readFileSync("vite.config.ts", "utf8");
    for (const g of VITEST_INCLUDE as string[]) expect(vite).toContain(`"${g}"`);
    const re = globRegExp("src/__tests__/**/*.test.{ts,tsx}");
    expect(re.test("src/__tests__/a.test.ts")).toBe(true);
    expect(re.test("src/__tests__/x/y/a.test.tsx")).toBe(true);
    expect(re.test("src/__tests__/a.spec.ts")).toBe(false);
  });
});

describe("vitest shards by time", () => {
  it("packs by measured time: the spread between the longest and shortest shard stays under 25%", () => {
    const files = Array.from({ length: 60 }, (_, i) => `src/__tests__/f${String(i).padStart(2, "0")}.test.ts`);
    const timings = Object.fromEntries(files.map((f, i) => [f, i < 3 ? 40_000 : 1_000 + ((i * 37) % 900)]));
    const plan = planShards(files, 4, { timings });
    expect(plan.basis).toBe("timings");
    expect(plan.spread).toBeLessThanOrEqual(0.25);
    expect(plan.shards.flatMap((s: Shard) => s.files).sort()).toEqual([...files].sort());
  });

  it("keeps a.test.ts and a.test.tsx in one shard (vitest's file arguments are substring filters)", () => {
    const plan = planShards(["src/__tests__/a.test.ts", "src/__tests__/a.test.tsx", "src/__tests__/b.test.ts", "src/__tests__/c.test.ts"], 3, {});
    const where = (f: string) => plan.shards.findIndex((s: Shard) => s.files.includes(f));
    expect(where("src/__tests__/a.test.ts")).toBe(where("src/__tests__/a.test.tsx"));
  });

  it("the merged run must cover the plan: a missing file, a file run twice and a failed must-run suite fail", () => {
    const plan = { shards: [{ index: 0, files: ["a.test.ts", "m.test.ts"], ms: 2 }, { index: 1, files: ["b.test.ts"], ms: 1 }] };
    const res = (names: string[], status = "passed") => ({ numTotalTests: names.length, numFailedTests: 0, success: true, testResults: names.map((n) => ({ name: `/r/${n}`, status, startTime: 0, endTime: 10 })) });
    expect(mergeCheck(plan, res(["a.test.ts", "m.test.ts", "b.test.ts"]), "/r/", ["m.test.ts"]).ok).toBe(true);
    expect(mergeCheck(plan, res(["a.test.ts", "m.test.ts"]), "/r/", []).problems.join()).toContain("did not run: b.test.ts");
    expect(mergeCheck(plan, res(["a.test.ts", "a.test.ts", "m.test.ts", "b.test.ts"]), "/r/", []).problems.join()).toContain("more than one shard");
    expect(mergeCheck(plan, res(["a.test.ts", "b.test.ts"]), "/r/", ["m.test.ts"]).problems.join()).toContain("m.test.ts did not run");
  });
});

describe("triggering builds through the API", () => {
  const pr = (n: number, c: string, updated: string, repo = "talstilkol/lumen-md") => ({ number: n, state: "open", title: `fix: x ${n} [skip ci]`, updated_at: updated, labels: [{ name: "lighthouse" }], head: { sha: sha(c), ref: `b/${n}`, repo: { full_name: repo } }, base: { ref: "main" } });

  it("drops every Buildkite skip marker from the message", () => {
    expect(stripSkip("feat: a [skip ci] b [CI SKIP] [skip-ci] [ci-skip]")).toBe("feat: a b");
    const req = buildRequest(pr(7, "a", "2026-11-14"));
    expect(req.message).toBe("#7 fix: x 7");
    expect(req).toMatchObject({ commit: sha("a"), branch: "b/7", pull_request_id: 7, pull_request_base_branch: "main", pull_request_labels: ["lighthouse"] });
  });

  it("builds new same-repository heads only, newest first, at most max", () => {
    const prs = [pr(1, "1", "2026-11-01"), pr(2, "2", "2026-11-14T02"), pr(3, "3", "2026-11-14T03", "x/fork"), pr(4, "4", "2026-11-14T04"), pr(5, "5", "2026-11-14T05")];
    const { todo } = planTriggers(prs, { built: new Set([sha("5")]), since: "2026-11-10", max: 4 });
    expect(todo.map((p: { number: number }) => p.number)).toEqual([4, 2]);
    expect(planTriggers(prs, { since: "2026-11-10", max: 1 }).todo.map((p: { number: number }) => p.number)).toEqual([5]);
    expect(planTriggers(prs, { since: "2026-11-10", backfill: 1, max: 9 }).todo.map((p: { number: number }) => p.number)).toEqual([5, 4, 2, 1]);
  });
});

describe("the receipt", () => {
  it("is a factory-shaped full receipt; an unknown outcome is never a pass", () => {
    const r = receiptReport({
      commit: { sha: sha("c"), branch: "b", pr: 1, dirty: false },
      build: { system: "buildkite", number: 3, url: null, pipeline: "lumen-md" },
      outcomes: { build: "passed", vitest: "passed", "vitest-merge": "passed", "e2e-chromium": "passed", "e2e-firefox": "passed", "e2e-webkit": "passed", lint: "unknown" },
      vitest: { ok: true, tests: 10, failed: 0, files: 2, spread: 0.1, mustRun: [], shardMs: [1, 1], problems: [] },
      machine: {},
      startedAt: "2026-11-14T10:00:00Z",
      finishedAt: "2026-11-14T10:24:00Z",
    });
    expect(r.kind).toBe("full");
    expect(r.minutes).toBe(24);
    for (const k of ["build", "vitest", "e2e chromium", "e2e firefox", "e2e webkit"]) expect(r.suites[k].ok).toBe(true);
    expect(r.suites.lint.ok).toBe(false);
    const noSummary = receiptReport({ commit: {}, build: {}, outcomes: { vitest: "passed", "vitest-merge": "passed" }, machine: {} });
    expect(noSummary.suites.vitest.ok).toBe(false);
  });
});

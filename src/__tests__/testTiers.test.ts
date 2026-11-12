/**
 * W6.8: the Vercel preview is a fast gate under 38 minutes, and what it
 * leaves out runs every night. These tests pin that nothing falls out of
 * both: a suite moved off the gate is in the nightly run, the nightly run
 * covers every vitest file and every e2e spec, and the gate's own lists
 * name files that exist.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { E2E_BROWSERS, E2E_COLLAB_PORT, E2E_COLLAB_WS, E2E_FAST, E2E_FIREFOX_FAST, E2E_SHARDS, GATE_BUDGET_MIN, VITEST_NIGHTLY_ONLY, VITEST_SHARDS } from "../../scripts/test-tiers.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { budgetVerdict, quotaFromCpuMax, slowestFiles, usableCpus, vitestArgs } from "../../scripts/vercel-build.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { GROUPS, fullSteps, runPlan } from "../../scripts/nightly/plan.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { parseShard, shardPort } from "../../scripts/nightly/e2e-shard.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { EXPECTED_COMMAND, ignoreStepVerdict, readProject } from "../../scripts/check-vercel-ignore.mjs";

const ROOT = resolve(__dirname, "..", "..");
const read = (f: string) => readFileSync(resolve(ROOT, f), "utf8");
type Step = { id: string; group: string; cmd: string[]; parallel?: boolean; env?: Record<string, string> };

describe("the gate's lists (scripts/test-tiers.mjs)", () => {
  it("every nightly-only vitest file exists, is a suite vitest collects, and declares a long timeout of its own", () => {
    expect(VITEST_NIGHTLY_ONLY.length).toBeGreaterThan(0);
    for (const f of VITEST_NIGHTLY_ONLY as string[]) {
      expect(existsSync(resolve(ROOT, f)), f).toBe(true);
      expect(f, f).toMatch(/^src\/__tests__\/.+\.test\.tsx?$/);
      // Only slow suites move: each sets a timeout of 15 s or more somewhere.
      const longest = Math.max(0, ...[...read(f).matchAll(/(\d[\d_]{4,})\)/g)].map((m) => Number(m[1].replace(/_/g, ""))));
      expect(longest, f).toBeGreaterThanOrEqual(15_000);
    }
  });

  it("keeps the vault, sync, encryption and history correctness suites in the gate", () => {
    for (const f of VITEST_NIGHTLY_ONLY as string[]) expect(f, f).not.toMatch(/vault|sync|e2ee|encrypt|keyring|history|dataSafety|trash/i);
  });

  it("every fast e2e spec exists and is a spec of the e2e folder; smoke leads, firefox runs smoke", () => {
    for (const f of [...E2E_FAST, ...E2E_FIREFOX_FAST] as string[]) expect(existsSync(resolve(ROOT, f)), f).toBe(true);
    expect(E2E_FAST[0]).toBe("e2e/smoke.spec.ts");
    expect(new Set(E2E_FAST).size).toBe(E2E_FAST.length);
    expect(E2E_FIREFOX_FAST).toEqual(["e2e/smoke.spec.ts"]);
  });

  it("the gate's vitest run leaves out exactly the nightly-only files, one worker per usable CPU", () => {
    const args = vitestArgs({}, 2) as string[];
    expect(args[0]).toBe("--maxWorkers=2");
    expect(args.filter((a) => a.startsWith("--exclude=")).map((a) => a.slice("--exclude=".length))).toEqual(VITEST_NIGHTLY_ONLY);
    expect(args.some((a) => a.startsWith("--shard"))).toBe(false);
    expect(vitestArgs({ LUMEN_VITEST_SHARD: "2/3" }, 1)).toContain("--shard=2/3");
    expect(vitestArgs({ LUMEN_VITEST_SHARD: "all" }, 1).some((a: string) => a.startsWith("--shard"))).toBe(false);
  });
});

describe("the nightly run covers everything (scripts/nightly/plan.mjs)", () => {
  const steps = fullSteps() as Step[];

  it("runs the whole vitest suite in shards 1..n, with nothing excluded", () => {
    const vitest = steps.filter((s) => s.group === "vitest");
    expect(vitest.map((s) => s.cmd.find((a) => a.startsWith("--shard="))).sort()).toEqual(Array.from({ length: VITEST_SHARDS }, (_, i) => `--shard=${i + 1}/${VITEST_SHARDS}`).sort());
    for (const s of vitest) {
      expect(s.cmd.slice(0, 3)).toEqual(["npx", "vitest", "run"]);
      expect(s.cmd.some((a) => a.startsWith("--exclude") || a.endsWith(".test.ts"))).toBe(false);
    }
  });

  it("runs every e2e spec on chromium, firefox and webkit, shards 1..n each, with no file or grep filter", () => {
    expect(E2E_BROWSERS).toEqual(["chromium", "firefox", "webkit"]);
    for (const browser of E2E_BROWSERS as string[]) {
      const mine = steps.filter((s) => s.group === "e2e" && s.cmd[2] === browser);
      expect(mine.map((s) => s.cmd[3]).sort(), browser).toEqual(Array.from({ length: E2E_SHARDS }, (_, i) => `${i + 1}/${E2E_SHARDS}`).sort());
      for (const s of mine) expect(s.cmd).toEqual(["node", "scripts/nightly/e2e-shard.mjs", browser, s.cmd[3]]);
    }
    // e2e-shard.mjs adds only the project, the shard, the workers and the reporters.
    const shard = read("scripts/nightly/e2e-shard.mjs");
    expect(shard).not.toMatch(/--grep|\.spec\.ts"/);
  });

  it("every e2e spec is either in the fast gate or only in the nightly run, and the whole folder runs nightly", () => {
    const specs = readdirSync(resolve(ROOT, "e2e")).filter((f) => f.endsWith(".spec.ts")).map((f) => `e2e/${f}`);
    expect(specs.length).toBeGreaterThan(50);
    for (const f of E2E_FAST as string[]) expect(specs, f).toContain(f);
  });

  it("the timing budgets moved to the perf project, which runs nightly against the production build", () => {
    expect(steps.find((s) => s.id === "perf-e2e")?.cmd).toEqual(["node", "scripts/nightly/e2e-shard.mjs", "perf", "1/1"]);
    const perf = read("e2e/perf-vault.spec.ts");
    expect(perf).toMatch(/test\("a 10,000-note vault[^"]*", \{ tag: "@nightly" \}/);
    expect(read("playwright.config.ts")).toMatch(/name: "perf", grep: NIGHTLY/);
  });

  it("builds once for the e2e shards, with the test hook and the collab origin, and checks the Ignored Build Step", () => {
    expect(steps[0]).toMatchObject({ id: "build", env: { VITE_E2E: "1", VITE_CSP_CONNECT_EXTRA: E2E_COLLAB_WS } });
    expect(steps.find((s) => s.id === "vercel-ignore-step")?.cmd).toEqual(["node", "scripts/check-vercel-ignore.mjs"]);
    expect(GROUPS).toEqual(["build", "vitest", "e2e", "perf", "vercel"]);
  });

  it("parallel shards get their own preview ports", () => {
    const ports = new Set<number>();
    for (const b of [...E2E_BROWSERS, "perf"] as string[]) for (let i = 1; i <= E2E_SHARDS; i++) ports.add(shardPort(b, i));
    expect(ports.size).toBe((E2E_BROWSERS.length + 1) * E2E_SHARDS);
    expect([...ports].every((p) => p !== 4173 && p !== 5173 && p !== E2E_COLLAB_PORT)).toBe(true);
    expect(parseShard("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShard("5/4")).toBeNull();
    expect(parseShard("0/4")).toBeNull();
  });

  it("runs the groups in order, a group's parallel steps side by side up to the job count", async () => {
    const log: string[] = [];
    let live = 0;
    let peak = 0;
    const fake = async (s: Step) => {
      live++;
      peak = Math.max(peak, live);
      log.push(s.group);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return { id: s.id, status: "ok", minutes: 0 };
    };
    const r = await runPlan(steps, { jobs: 3, run: fake });
    expect(r).toHaveLength(steps.length);
    expect(peak).toBe(3);
    const firstOf = (g: string) => log.indexOf(g);
    expect(firstOf("build")).toBeLessThan(firstOf("vitest"));
    expect(log.lastIndexOf("vitest")).toBeLessThan(firstOf("e2e"));
    expect(log.lastIndexOf("e2e")).toBeLessThan(firstOf("perf"));
  });
});

describe("the 38-minute budget and the receipt (scripts/vercel-build.mjs)", () => {
  it("fails a build past GATE_BUDGET_MIN and passes one inside it", () => {
    expect(GATE_BUDGET_MIN).toBe(38);
    const min = 60_000;
    expect(budgetVerdict(0, 37.9 * min)).toBeNull();
    expect(budgetVerdict(0, 38.5 * min)).toMatch(/38\.5 min, over the 38-minute budget/);
  });

  it("reads the CPU quota from cgroup v2 and v1, not the host's core count", () => {
    expect(quotaFromCpuMax("200000 100000")).toBe(2);
    expect(quotaFromCpuMax("150000 100000")).toBe(2);
    expect(quotaFromCpuMax("max 100000")).toBeNull();
    expect(quotaFromCpuMax("")).toBeNull();
    const files: Record<string, string> = { "/sys/fs/cgroup/cpu.max": "200000 100000\n" };
    const reader = (f: string) => {
      if (f in files) return files[f];
      throw new Error("ENOENT");
    };
    expect(usableCpus(reader, 32)).toEqual({ cpus: 2, os: 32, quota: 2 });
    expect(usableCpus(() => "max 100000", 4)).toEqual({ cpus: 4, os: 4, quota: null });
    const v1: Record<string, string> = { "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "400000", "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000" };
    expect(usableCpus((f: string) => {
      if (f in v1) return v1[f];
      throw new Error("ENOENT");
    }, 16)).toEqual({ cpus: 4, os: 16, quota: 4 });
  });

  it("names the slowest vitest files, slowest first", () => {
    const report = {
      testResults: [
        { name: "/vercel/path0/src/__tests__/a.test.ts", startTime: 0, endTime: 1500 },
        { name: "/vercel/path0/src/__tests__/b.test.ts", startTime: 0, endTime: 9000 },
        { name: "/vercel/path0/src/__tests__/c.test.ts" },
      ],
    };
    expect(slowestFiles(report, 5)).toEqual([
      { file: "src/__tests__/b.test.ts", seconds: 9 },
      { file: "src/__tests__/a.test.ts", seconds: 1.5 },
    ]);
    expect(slowestFiles(null)).toEqual([]);
  });

  it("an e2e build's page may reach the loopback collab server; the spec, Playwright's dev server and the build agree", () => {
    expect(E2E_COLLAB_WS).toBe(`ws://127.0.0.1:${E2E_COLLAB_PORT}`);
    expect(read("e2e/collab-persist.spec.ts")).toMatch(/PORT: String\(E2E_COLLAB_PORT\)/);
    expect(read("playwright.config.ts")).toMatch(/VITE_CSP_CONNECT_EXTRA: \[process\.env\.VITE_CSP_CONNECT_EXTRA, E2E_COLLAB_WS\]/);
    const build = read("scripts/vercel-build.mjs");
    // Only inside the e2e branch: a production build (no e2e gate) never adds it.
    expect(build).toMatch(/if \(gates\.includes\("e2e"\)\) \{\n\s+process\.env\.VITE_E2E \?\?= "1";[\s\S]{0,400}E2E_COLLAB_WS/);
  });
});

describe("W6.10: the Ignored Build Step check (scripts/check-vercel-ignore.mjs)", () => {
  it("passes only on our skip script", () => {
    expect(EXPECTED_COMMAND).toBe("bash scripts/vercel-ignore.sh");
    expect(ignoreStepVerdict({ commandForIgnoringBuildStep: "bash scripts/vercel-ignore.sh" }).ok).toBe(true);
    expect(ignoreStepVerdict({ commandForIgnoringBuildStep: " bash scripts/vercel-ignore.sh\n" }).ok).toBe(true);
    expect(ignoreStepVerdict({}).ok).toBe(false);
    expect(ignoreStepVerdict({ commandForIgnoringBuildStep: null }).line).toMatch(/not set/);
    const other = ignoreStepVerdict({ commandForIgnoringBuildStep: "exit 1" });
    expect(other.ok).toBe(false);
    expect(other.line).toContain("`exit 1`");
    // The skip script the setting must call exists.
    expect(existsSync(resolve(ROOT, "scripts/vercel-ignore.sh"))).toBe(true);
  });

  it("reads the project with a GET and the token, and reports an API error as an error", async () => {
    const calls: Array<{ url: string; init: { headers: Record<string, string>; method?: string } }> = [];
    const ok = async (url: string, init: { headers: Record<string, string>; method?: string }) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ commandForIgnoringBuildStep: "bash scripts/vercel-ignore.sh" }) };
    };
    const project = await readProject({ token: "t0k", projectId: "prj_1", teamId: "team_1", fetchImpl: ok });
    expect(ignoreStepVerdict(project).ok).toBe(true);
    expect(calls[0].url).toBe("https://api.vercel.com/v9/projects/prj_1?teamId=team_1");
    expect(calls[0].init.headers.Authorization).toBe("Bearer t0k");
    expect("method" in calls[0].init).toBe(false); // GET: the check never changes the project
    const denied = async () => ({ ok: false, status: 403, json: async () => ({}) });
    await expect(readProject({ token: "x", fetchImpl: denied })).rejects.toThrow("HTTP 403");
  });
});

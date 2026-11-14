#!/usr/bin/env node
/**
 * `npm run perf:responsiveness` (plan W6.45): INP and keypress → paint in both
 * editors on a 10,000-note vault (e2e/inp-devices.spec.ts), a +10 % gate per
 * environment, and a sealed lumen-metric receipt the area board scores.
 *
 *   node scripts/perf/responsiveness.mjs                 measure (inp-desktop, inp-phone) against
 *                                                        dist/ (vite preview), then gate, then receipt
 *   node scripts/perf/responsiveness.mjs measure [--project inp-desktop]
 *   node scripts/perf/responsiveness.mjs gate [--update] each run vs reports/perf/baselines/<env>.json;
 *                                                        no baseline yet → this run becomes it (commit it)
 *   node scripts/perf/responsiveness.mjs receipt [--seal] [--out <file>]
 *   node scripts/perf/responsiveness.mjs browserstack [--dry-run]
 *                                                        the same spec on real phones (PERF_PLATFORMS)
 *
 * Runs: reports/perf/responsiveness/<env>.json. The receipt goes to
 * reports/metrics/ with the nightly key's PUBLIC_KEY.pem next to it, so
 * `node scripts/plan/areas.mjs --metrics reports/metrics` counts it.
 */
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PERF_PLATFORMS, budgetMisses, compareRuns, metricReceipt } from "./responsivenessLib.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const RUNS = join(ROOT, "reports", "perf", "responsiveness");
export const BASELINES = join(ROOT, "reports", "perf", "baselines");
const SPEC = "e2e/inp-devices.spec.ts";
const PORT = Number(process.env.LUMEN_PERF_PORT ?? 4191);

export function readRuns(dir = RUNS) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")))
    .filter((r) => r.format === "lumen-responsiveness");
}

/** Gate every run against its environment's baseline. → { ok, lines, created } */
export function gate({ runs = readRuns(), baselines = BASELINES, update = false } = {}) {
  const lines = [];
  const created = [];
  let ok = true;
  for (const run of runs) {
    const file = join(baselines, `${run.env}.json`);
    for (const m of budgetMisses(run)) lines.push(`  budget (${run.env}): ${m}`);
    if (update || !existsSync(file)) {
      mkdirSync(baselines, { recursive: true });
      writeFileSync(file, JSON.stringify(run, null, 2) + "\n");
      created.push(file);
      lines.push(`${run.env}: ${update ? "baseline updated" : "no baseline yet: this run is now the baseline"} (${file.slice(ROOT.length + 1)}; commit it)`);
      continue;
    }
    let c;
    try {
      c = compareRuns(JSON.parse(readFileSync(file, "utf8")), run);
    } catch (e) {
      // why: a run that cannot be compared (another setup than its baseline) fails, and the other environments are still gated
      lines.push(`✗ ${run.env}: ${e instanceof Error ? e.message : e}`);
      ok = false;
      continue;
    }
    for (const r of c.rows) {
      const pct = `${r.change >= 0 ? "+" : ""}${(r.change * 100).toFixed(1)} %`;
      lines.push(`${r.regressed ? "✗" : "✓"} ${run.env} ${r.metric.padEnd(22)} ${r.baseline.toFixed(1).padStart(7)} → ${r.latest.toFixed(1).padStart(7)} ms  ${pct}`);
    }
    for (const m of c.missing) lines.push(`✗ ${run.env} ${m}: in the baseline, not measured in this run`);
    if (!c.ok) ok = false;
  }
  if (!runs.length) {
    lines.push("no runs in reports/perf/responsiveness/ (run `measure` first)");
    ok = false;
  }
  return { ok, lines, created };
}

async function waitFor(url, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* why: not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function measure(projects) {
  let server = null;
  const env = { ...process.env };
  if (!env.PLAYWRIGHT_BASE_URL) {
    if (!existsSync(join(ROOT, "dist", "index.html"))) {
      console.error("perf:responsiveness: no dist/ (npm run build first), or set PLAYWRIGHT_BASE_URL");
      return 2;
    }
    server = spawn("npx", ["vite", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
    env.PLAYWRIGHT_BASE_URL = `http://127.0.0.1:${PORT}`;
    if (!(await waitFor(env.PLAYWRIGHT_BASE_URL))) {
      server.kill();
      console.error("perf:responsiveness: vite preview did not start");
      return 2;
    }
  }
  const r = spawnSync("npx", ["playwright", "test", SPEC, ...projects.map((p) => `--project=${p}`)], { cwd: ROOT, stdio: "inherit", env });
  server?.kill();
  return r.status ?? 1;
}

function receipt({ seal: doSeal, out }) {
  const runs = readRuns();
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() || null;
  let rec = metricReceipt(runs, { sha, command: "npm run perf:responsiveness" });
  const file = out ? resolve(out) : join(ROOT, "reports", "metrics", `responsiveness-${(sha ?? "local").slice(0, 12)}.json`);
  mkdirSync(dirname(file), { recursive: true });
  if (doSeal) {
    return import("../nightly/receipt.mjs").then(({ loadOrCreateKey, seal }) => {
      const { privateKeyPem, publicKeyPem } = loadOrCreateKey();
      rec = seal(rec, privateKeyPem);
      writeFileSync(join(dirname(file), "PUBLIC_KEY.pem"), publicKeyPem);
      writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
      console.log(`receipt: ${file} (sealed, key ${rec.receipt.key}) ${JSON.stringify(rec.metrics)}`);
      return 0;
    });
  }
  writeFileSync(file, JSON.stringify(rec, null, 2) + "\n");
  console.log(`receipt: ${file} (not sealed) ${JSON.stringify(rec.metrics)}`);
  return 0;
}

/** browserstack.yml for the phones: both are real devices, named by deviceName. */
export function perfBrowserstackYml({ build, platforms = PERF_PLATFORMS }) {
  const q = (s) => JSON.stringify(String(s));
  return [
    "# Written by scripts/perf/responsiveness.mjs (plan W6.45); credentials come from the environment.",
    `projectName: ${q("lumen-md")}`,
    `buildName: ${q(build)}`,
    "browserstackLocal: true",
    "parallelsPerPlatform: 1",
    "testObservability: false",
    "platforms:",
    ...platforms.flatMap((p) => [`  - deviceName: ${q(p.deviceName)}`, `    osVersion: ${q(p.osVersion)}`, `    browserName: ${q(p.browserName)}`]),
  ].join("\n") + "\n";
}

function browserstack(dryRun) {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout.trim() || "local";
  const build = `lumen-md perf ${sha.slice(0, 12)} ${new Date().toISOString().slice(0, 16)}`;
  const sdk = process.env.LUMEN_BS_SDK || "browserstack-node-sdk";
  const cmds = [
    ["npx", ["vite", "build", "--outDir", ".factory/dist-safari"], {}],
    ["npx", ["-y", sdk, "playwright", "test", "-c", ".factory/playwright.browserstack.config.mjs", SPEC, "--grep", "@responsiveness"], {}],
  ];
  if (dryRun) {
    process.stdout.write(perfBrowserstackYml({ build }));
    for (const [c, a] of cmds) console.log(`${c} ${a.join(" ")}`);
    return 0;
  }
  if (!process.env.BROWSERSTACK_USERNAME || !process.env.BROWSERSTACK_ACCESS_KEY) {
    console.error("✗ perf browserstack: BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY are not set (docs: contributing/promotion)");
    return 2;
  }
  mkdirSync(join(ROOT, ".factory"), { recursive: true });
  // The same Playwright config as the Safari run (#510): vite preview of .factory/dist-safari, tunnelled by BrowserStack Local.
  copyFileSync(join(ROOT, "scripts/safari/playwright.browserstack.config.mjs"), join(ROOT, ".factory/playwright.browserstack.config.mjs"));
  writeFileSync(join(ROOT, "browserstack.yml"), perfBrowserstackYml({ build }));
  for (const [c, a, e] of cmds) {
    const r = spawnSync(c, a, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...e } });
    if (r.status !== 0) return r.status ?? 1;
  }
  return 0;
}

async function main(argv) {
  const cmd = argv[0] && !argv[0].startsWith("--") ? argv[0] : "all";
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const projects = (opt("project") ?? "inp-desktop,inp-phone").split(",");
  const runGate = () => {
    const g = gate({ update: argv.includes("--update") });
    console.log(g.lines.join("\n"));
    if (!g.ok) console.error(`perf:responsiveness: a metric is ${100 * 0.1} % or more slower than its baseline, or missing`);
    return g.ok ? 0 : 1;
  };
  if (cmd === "measure") return measure(projects);
  if (cmd === "gate") return runGate();
  if (cmd === "receipt") return receipt({ seal: argv.includes("--seal"), out: opt("out") });
  if (cmd === "browserstack") return browserstack(argv.includes("--dry-run"));
  if (cmd === "all") {
    const m = await measure(projects);
    const g = runGate();
    await receipt({ seal: argv.includes("--seal") || !!process.env.LUMEN_NIGHTLY_KEY, out: opt("out") });
    return m || g;
  }
  console.error(`unknown command "${cmd}"`);
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}

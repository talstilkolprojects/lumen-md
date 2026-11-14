#!/usr/bin/env node
/**
 * `npm run perf:gate` (plan 8.3): the Lighthouse gate without Lighthouse.
 * LHCI is not in the lockfile, so the same numbers are measured with
 * Playwright and the browser's own PerformanceObserver entries: FCP, LCP,
 * CLS, TBT and TTI. Desktop and a throttled phone (Pixel 7, CPU 4×, slow
 * 4G), `runs` cold loads each (5), the median run (Lighthouse's
 * `median-run`, not the optimistic default), thresholds from
 * perf-gate.config.json. No GitHub Actions: run it locally against
 * `vite preview`, or against a preview deployment's URL.
 *
 *   npm run build && npm run perf:gate                 # serves dist/ with vite preview
 *   npm run perf:gate -- --url https://<preview>.vercel.app
 *   npm run perf:gate -- --profiles desktop --runs 3 --out perf-gate.md
 *
 * Exit 1 when an `error` threshold fails; `warn` is reported only.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { COLLECTOR, evaluate, failed, markdown, medianRun, metricsOf } from "./lib/perfGate.mjs";

const ROOT = resolve(import.meta.dirname ?? new URL(".", import.meta.url).pathname, "..");

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const runs = opt("--runs") ? Number(opt("--runs")) : undefined;
  if (runs !== undefined && !(Number.isInteger(runs) && runs > 0)) throw new Error("--runs: a positive integer");
  return { url: opt("--url"), profiles: opt("--profiles")?.split(","), runs, out: opt("--out"), json: opt("--json"), config: opt("--config") ?? join(ROOT, "perf-gate.config.json"), port: Number(opt("--port") ?? 4173), quietMs: Number(opt("--quiet-ms") ?? 3000) };
}

/** `vite preview` of dist/ on a free port; → { url, close }. */
async function preview(port) {
  if (!existsSync(join(ROOT, "dist", "index.html"))) throw new Error("dist/ is not built: run `npm run build` first, or pass --url");
  const bin = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  const child = spawn(process.execPath, [bin, "preview", "--host", "127.0.0.1", "--port", String(port), "--strictPort"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 200; i++) {
    if (child.exitCode != null) throw new Error(`vite preview exited (${child.exitCode})`);
    try {
      if ((await fetch(url)).ok) return { url, close: () => child.kill() };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  child.kill();
  throw new Error("vite preview did not answer within 20 s");
}

/** One cold load (fresh context: no cache, no storage) → metrics. */
async function load(browser, devices, url, profile, quietMs) {
  const base = profile.device ? devices[profile.device] : { viewport: profile.viewport };
  const context = await browser.newContext({ ...base, serviceWorkers: "block" });
  await context.addInitScript({ content: COLLECTOR });
  // Skip the first-run tour, as e2e/ does: it is not what a returning user loads.
  await context.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  if (profile.cpuSlowdown > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: profile.cpuSlowdown });
  if (profile.network) {
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: profile.network.latencyMs, downloadThroughput: (profile.network.downloadKbps * 1024) / 8, uploadThroughput: (profile.network.uploadKbps * 1024) / 8 });
  }
  try {
    await page.goto(url, { waitUntil: "load", timeout: 120_000 });
    // The app is ready when the editor takes input.
    const ready = await page
      .waitForFunction(() => {
        const el = document.querySelector(".cm-content");
        return el && el.isContentEditable ? performance.now() : 0;
      }, null, { polling: "raf", timeout: 60_000 })
      .then((h) => h.jsonValue())
      .catch(() => null);
    // A quiet window: no long task for quietMs (TTI's definition, Lighthouse uses 5 s).
    await page.waitForFunction(
      (q) => {
        const t = window.__perf.longTasks;
        const last = t.length ? t[t.length - 1][0] + t[t.length - 1][1] : 0;
        return performance.now() - Math.max(last, window.__perf.fcp ?? 0) >= q;
      },
      quietMs,
      { polling: 250, timeout: 60_000 },
    );
    const { buf, dcl } = await page.evaluate(() => ({ buf: window.__perf, dcl: performance.getEntriesByType("navigation")[0]?.domContentLoadedEventEnd ?? null }));
    return metricsOf(buf, { domContentLoaded: dcl, ready });
  } finally {
    await context.close();
  }
}

export async function runGate(opts) {
  const config = JSON.parse(readFileSync(opts.config, "utf8"));
  const runs = opts.runs ?? config.runs;
  const names = opts.profiles ?? Object.keys(config.profiles);
  for (const n of names) if (!config.profiles[n]) throw new Error(`no profile ${n} in ${opts.config}`);
  const server = opts.url ? { url: opts.url, close: () => {} } : await preview(opts.port);
  let pw;
  try {
    pw = await import("@playwright/test");
  } catch {
    pw = await import("playwright");
  }
  const browser = await pw.chromium.launch();
  const profiles = [];
  try {
    for (const name of names) {
      const profile = config.profiles[name];
      const all = [];
      for (let i = 0; i < runs; i++) all.push(await load(browser, pw.devices, server.url, profile, opts.quietMs));
      const median = medianRun(all);
      profiles.push({ name, runs: all, median, results: evaluate(median, profile.assert) });
    }
  } finally {
    await browser.close();
    server.close();
  }
  return { url: server.url, runs, profiles, failed: profiles.some((p) => !p.median || failed(p.results)) };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = await runGate(opts);
  const md = markdown(r.profiles, r);
  console.log(md);
  if (opts.out) writeFileSync(opts.out, md + "\n");
  if (opts.json) writeFileSync(opts.json, JSON.stringify(r, null, 2) + "\n");
  console.log(r.failed ? "perf gate: FAIL" : "perf gate: ok");
  process.exit(r.failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

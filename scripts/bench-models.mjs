#!/usr/bin/env node
/**
 * `npm run bench:models` (plan 7.8): every local engine on its golden set,
 * in a real browser, through the app's own code (the transformers.js
 * worker, tesseract.js) — WebGPU where the browser has it. Time, memory
 * and quality per engine and device; with --write, into
 * models/registry.json (`measured.<device>` of each model).
 *
 *   npm run bench:models                              # every engine, WebGPU, dev split
 *   npm run bench:models -- --engines bge-rerank,e5 --backends webgpu,wasm
 *   npm run bench:models -- --split test --dir <test split> --write
 *
 * Options
 *   --engines a,b      engines from src/bench/engines (default: all)
 *   --backends …       webgpu (default) and/or wasm (WebGPU hidden from the page)
 *   --split dev|test   golden split (default dev); test needs --dir (built in CI)
 *   --limit N          first N items per part (a smoke run: never written)
 *   --write            update models/registry.json
 *   --out FILE         the numbers (default eval/results/bench-models-<date>.json)
 *   --url URL          use a running dev server instead of starting Vite
 *   --headless         default: a window (GPUs are more reliable headed)
 *   --channel chrome   use installed Chrome instead of Playwright's Chromium
 *   --no-prime         measure the first load (cold cache: download included)
 *
 * Only numbers leave the page: no item, input or output is printed or
 * written (the test split is held out).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { incompleteParts, loadSet } from "./lib/golden.mjs";
import { GOLDEN, ROOT } from "./golden/common.mjs";
import { percentile, round } from "./bench/metrics.mjs";
import { applyMeasurements, isSoftwareAdapter } from "./bench/registry.mjs";
import { sampleMemory } from "./bench/memory.mjs";
import { TASKS } from "./bench/tasks.mjs";

export function parseArgs(argv) {
  const has = (n) => argv.includes(n);
  const opt = (n) => (has(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const list = (v) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : null);
  const backends = list(opt("--backends")) ?? ["webgpu"];
  for (const b of backends) if (b !== "webgpu" && b !== "wasm") throw new Error(`--backends: ${b} (webgpu or wasm)`);
  const split = opt("--split") ?? "dev";
  if (split !== "dev" && split !== "test") throw new Error(`--split: ${split}`);
  if (split === "test" && !opt("--dir")) throw new Error("--split test needs --dir <test split>");
  const limit = opt("--limit") ? Number(opt("--limit")) : null;
  if (limit != null && !(Number.isInteger(limit) && limit > 0)) throw new Error("--limit: a positive integer");
  return {
    engines: list(opt("--engines")),
    backends,
    split,
    dir: opt("--dir"),
    limit,
    write: has("--write"),
    out: opt("--out"),
    url: opt("--url"),
    headless: has("--headless"),
    channel: opt("--channel"),
    prime: !has("--no-prime"),
  };
}

/** The browser flags that turn WebGPU on where Chromium keeps it behind a flag (Linux). */
export const CHROMIUM_ARGS = ["--enable-unsafe-webgpu", "--enable-features=Vulkan,WebGPU", "--ignore-gpu-blocklist", "--enable-gpu-rasterization"];

async function startVite() {
  for (const s of ["copy-ort.mjs", "copy-tesseract.mjs"]) execFileSync(process.execPath, [join(ROOT, "scripts", s)], { stdio: "ignore", cwd: ROOT });
  const { createServer } = await import("vite");
  const server = await createServer({ root: ROOT, logLevel: "error", server: { host: "127.0.0.1", port: 5190, strictPort: false } });
  await server.listen();
  return { url: server.resolvedUrls.local[0].replace(/\/$/, ""), close: () => server.close() };
}

async function openPage(browser, url, backend) {
  const context = await browser.newContext();
  // WebAssembly: the page sees no WebGPU, so the app picks wasm as it would on such a device.
  if (backend === "wasm") await context.addInitScript(() => Object.defineProperty(Navigator.prototype, "gpu", { get: () => undefined, configurable: true }));
  const page = await context.newPage();
  const ready = async () => {
    await page.goto(`${url}/bench/models.html`);
    await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 120_000 });
  };
  await ready();
  return { page, context, reload: ready };
}

/** One engine on one backend → a result row (numbers only). */
async function measure({ browser, url, pid, id, backend, opts }) {
  const probe = await openPage(browser, url, backend);
  const meta = await probe.page.evaluate((e) => window.lumenBench.describe(e), id);
  const env = await probe.page.evaluate(() => window.lumenBench.env());
  const at = new Date().toISOString().slice(0, 10);
  const row = { engine: id, label: meta.label, set: meta.set, models: meta.models, backend, split: opts.split, at, limited: !!opts.limit, status: "measured", device: null, items: 0 };
  try {
    if (backend === "wasm" && env.webgpu) return { ...row, status: "error", error: "WebGPU was not hidden from the page" };
    const task = TASKS[meta.set];
    if (!task) return { ...row, status: "no-task", note: `scripts/bench/tasks.mjs has no task for ${meta.set}` };
    const { manifest, problems } = (() => {
      try {
        return { manifest: JSON.parse(readFileSync(join(GOLDEN, meta.set, "manifest.json"), "utf8")), problems: [] };
      } catch (e) {
        return { manifest: null, problems: [String(e.message)] };
      }
    })();
    if (!manifest) return { ...row, status: "error", error: problems[0] };
    let { items, corpus } = loadSet(GOLDEN, meta.set, { split: opts.split, testDir: opts.dir });
    if (!items.length) return { ...row, status: "not-built", note: `${meta.set} has no ${opts.split} items here` };
    const missing = opts.split === "test" ? incompleteParts(manifest, items) : [];
    if (opts.limit) {
      const per = new Map();
      items = items.filter((it) => (per.set(it.part, (per.get(it.part) ?? 0) + 1), per.get(it.part) <= opts.limit));
    }
    const payload = task.payload({ items, corpus });
    if (opts.prime) {
      // Download and compile once (the browser caches the weights), then measure on a fresh page.
      await probe.page.evaluate(([e, p]) => window.lumenBench.run(e, p), [id, { shared: payload.shared, items: payload.items.slice(0, 1) }]);
      await probe.reload();
    }
    const mem = sampleMemory(pid);
    const r = await probe.page.evaluate(([e, p]) => window.lumenBench.run(e, p), [id, payload]);
    const m = mem.stop();
    if (r.error) return { ...row, status: "error", device: r.device, error: r.error };
    const quality = task.score(items, r.outputs);
    return {
      ...row,
      status: missing.length ? "partial" : "measured",
      note: missing.length ? `parts below their size: ${missing.map((x) => `${x.part} ${x.have}/${x.want}`).join(", ")}` : undefined,
      device: r.device,
      model: r.model,
      items: items.length,
      loadMs: r.loadMs,
      prepareMs: r.prepareMs,
      p50Ms: percentile(r.itemMs, 50),
      p95Ms: percentile(r.itemMs, 95),
      totalMs: round(r.itemMs.reduce((a, b) => a + b, 0), 1),
      rssPeakMB: m.peakMB,
      rssDeltaMB: m.peakMB != null && m.baselineMB != null ? round(m.peakMB - m.baselineMB, 1) : null,
      jsHeapPeakMB: r.jsHeapPeakMB,
      quality,
      env,
    };
  } finally {
    await probe.context.close();
  }
}

export function table(rows) {
  const head = "| Engine | Device | Set | Items | Load ms | p50 ms | p95 ms | RSS peak MB | Quality | Status |";
  const lines = [head, "|---|---|---|---|---|---|---|---|---|---|"];
  for (const r of rows) {
    const q = r.quality ? Object.entries(r.quality).map(([k, v]) => `${k} ${v}`).join(", ") : "";
    lines.push(`| ${r.engine} | ${r.device ?? `(${r.backend})`} | ${r.set} | ${r.items || ""} | ${r.loadMs ?? ""} | ${r.p50Ms ?? ""} | ${r.p95Ms ?? ""} | ${r.rssPeakMB ?? ""} | ${q} | ${r.status}${r.error ? `: ${r.error}` : r.note ? `: ${r.note}` : ""} |`);
  }
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const server = opts.url ? { url: opts.url.replace(/\/$/, ""), close: async () => {} } : await startVite();
  let pw;
  try {
    pw = await import("@playwright/test");
  } catch {
    pw = await import("playwright");
  }
  const bs = await pw.chromium.launchServer({ headless: opts.headless, channel: opts.channel, args: CHROMIUM_ARGS });
  const browser = await pw.chromium.connect(bs.wsEndpoint());
  const rows = [];
  let env = null;
  try {
    const first = await openPage(browser, server.url, "webgpu");
    const all = await first.page.evaluate(() => window.lumenBench.engines());
    env = await first.page.evaluate(() => window.lumenBench.env());
    await first.context.close();
    const ids = opts.engines ?? all;
    for (const id of ids) if (!all.includes(id)) throw new Error(`no engine "${id}" (have: ${all.join(", ")})`);
    if (opts.backends.includes("webgpu") && !env.webgpu) console.warn("WebGPU is not available in this browser: WebGPU runs will fall back and will not be written.");
    if (opts.backends.includes("webgpu") && isSoftwareAdapter(env)) console.warn("WebGPU runs on SwiftShader (no GPU): those numbers will not be written. Run headed on a machine with a GPU.");
    for (const id of ids) {
      for (const backend of opts.backends) {
        process.stdout.write(`${id} on ${backend}… `);
        const r = await measure({ browser, url: server.url, pid: bs.process()?.pid, id, backend, opts }).catch((e) => ({ engine: id, backend, set: "?", models: [], status: "error", error: String(e.message).split("\n")[0].slice(0, 200) }));
        console.log(r.status);
        rows.push(r);
      }
    }
  } finally {
    await browser.close().catch(() => {});
    await bs.close().catch(() => {});
    await server.close();
  }

  const md = table(rows);
  console.log(`\n${md}\n`);
  const out = opts.out ?? join(ROOT, "eval", "results", `bench-models-${new Date().toISOString().slice(0, 10)}.json`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), split: opts.split, env, rows: rows.map(({ env: _e, ...r }) => r) }, null, 2) + "\n");
  console.log(`numbers → ${out}`);
  if (opts.write) {
    const path = join(ROOT, "models", "registry.json");
    const { registry, written, skipped } = applyMeasurements(JSON.parse(readFileSync(path, "utf8")), rows, env ?? {});
    writeFileSync(path, JSON.stringify(registry, null, 2) + "\n");
    for (const w of written) console.log(`registry: ${w.model} measured.${w.device} (${w.engine})`);
    for (const s of skipped) console.log(`registry: not written — ${s.engine} on ${s.backend}: ${s.reason}`);
  }
  process.exit(rows.some((r) => r.status === "error") ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();

#!/usr/bin/env node
/**
 * Browser smoke test of the converted models (plan 6.0): every model loads
 * in transformers.js 4.3 in headless Chromium, from local files only, and
 * answers one inference (scripts/models/smoke.html does the work).
 *
 *   node scripts/models/smoke.mjs --models <dir with one folder per model id> \
 *     [--ids a,b] [--out smoke-results.json]
 *
 * q8 must pass for every model (exit 1 otherwise). q4f16 is tried too and
 * reported: its fp16 parts are meant for WebGPU, which a GPU-less CI runner
 * does not have, so a wasm failure there is information, not a failure.
 * PW_CHROMIUM overrides the browser binary (local runs).
 */
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TARGETS = JSON.parse(readFileSync(join(ROOT, "models", "convert-targets.json"), "utf8"));
const NPM = new Set(["@huggingface/transformers", "onnxruntime-web", "onnxruntime-common"]);
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".wasm": "application/wasm", ".txt": "text/plain" };

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  return out;
}

/** A path under `base`, or null when the request tries to leave it. */
function inside(base, rel) {
  const p = normalize(join(base, rel));
  return p === base || p.startsWith(base + sep) ? p : null;
}

export function startServer(modelsDir) {
  const server = createServer((req, res) => {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    let file = null;
    if (url === "/" || url === "/smoke.html") file = join(ROOT, "scripts", "models", "smoke.html");
    else if (url.startsWith("/models/")) file = inside(resolve(modelsDir), url.slice("/models/".length));
    else if (url.startsWith("/npm/")) {
      const rest = url.slice(5);
      const pkg = [...NPM].find((p) => rest === p || rest.startsWith(p + "/"));
      if (pkg) file = inside(join(ROOT, "node_modules", pkg), rest.slice(pkg.length + 1));
    }
    if (!file || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Content-Length": statSync(file).size,
      // Cross-origin isolation lets ONNX Runtime use its threaded wasm.
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    });
    createReadStream(file).pipe(res);
  });
  return new Promise((ok) => server.listen(0, "127.0.0.1", () => ok(server)));
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.models) {
    console.error("usage: smoke.mjs --models <dir> [--ids a,b] [--out results.json]");
    process.exit(2);
  }
  const wanted = a.ids ? String(a.ids).split(",") : TARGETS.models.map((m) => m.id);
  const targets = TARGETS.models.filter((m) => wanted.includes(m.id) && existsSync(join(a.models, m.id)));
  const missing = wanted.filter((id) => !targets.some((m) => m.id === id));
  const server = await startServer(a.models);
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error(`  [page] ${m.text().slice(0, 300)}`);
  });
  await page.goto(`${base}/smoke.html`);
  await page.waitForFunction(() => window.smokeReady === true, null, { timeout: 60_000 });

  const results = [];
  for (const t of targets) {
    for (const dtype of TARGETS.keep) {
      const r = await page.evaluate(([target, d]) => window.runSmoke(target, d), [t, dtype]);
      const required = dtype === "q8";
      results.push({ id: t.id, dtype, required, ...r });
      const line = `${r.ok ? "✓" : required ? "✗" : "~"} ${t.id} ${dtype} (${r.ms} ms): ${r.ok ? r.output : r.error ?? r.output}`;
      console.log(line);
      if (process.env.GITHUB_ACTIONS) {
        const level = r.ok ? "notice" : required ? "error" : "warning";
        console.log(`::${level} title=smoke ${t.id} ${dtype}::${(r.ok ? r.output : r.error ?? r.output ?? "").replace(/\r?\n/g, " ").slice(0, 900)}`);
      }
    }
  }
  await browser.close();
  server.close();
  for (const id of missing) {
    results.push({ id, dtype: "q8", required: true, ok: false, error: "no model folder (conversion or mirror download failed)" });
    console.log(`✗ ${id}: no model folder`);
    if (process.env.GITHUB_ACTIONS) console.log(`::error title=smoke ${id}::no model folder (conversion or mirror download failed)`);
  }
  if (a.out) writeFileSync(a.out, JSON.stringify(results, null, 2) + "\n");
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results.map((r) => `| ${r.id} | ${r.dtype} | ${r.ok ? "✅" : r.required ? "❌" : "⚠️"} | ${r.ms ?? ""} | ${String(r.ok ? r.output : r.error ?? "").replace(/\|/g, "\\|").slice(0, 160)} |`);
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, ["### transformers.js 4.3 smoke test (headless Chromium, wasm)", "", "| model | dtype | result | ms | output |", "|---|---|---|---|---|", ...rows, ""].join("\n"), { flag: "a" });
  }
  const failed = results.filter((r) => r.required && !r.ok);
  process.exit(failed.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

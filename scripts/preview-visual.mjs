#!/usr/bin/env node
/**
 * Local preview + visual regression (MASTER_PLAN v3, T24).
 *
 * Builds nothing by itself: point it at a running app (default: a
 * `vite preview` it starts on dist/, so run `npm run build` first) and it
 * screenshots every main surface in English (LTR) and Hebrew (RTL), in the
 * dark and the light theme, into visual-results/<run>/ with an index.html
 * to look through. No Vercel preview needed.
 *
 *   npm run build && npm run preview:visual
 *   npm run preview:visual -- --url http://localhost:5173          # dev server
 *   npm run preview:visual -- --baseline visual-results/<older-run> # diff
 *   npm run preview:visual -- --only palette,wysiwyg --browser /path/to/chrome
 *
 * With --baseline every shot is compared pixel by pixel (in a browser
 * canvas, no extra dependency); shots that differ by more than
 * --threshold (default 0.5 %) are listed and outlined in the index, and
 * the exit code is 1. Each shot is also checked for horizontal overflow
 * (the page wider than the viewport), the commonest RTL layout bug.
 */

import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return dflt;
  const a = args[i];
  return a.includes("=") ? a.slice(a.indexOf("=") + 1) : args[i + 1];
};
let url = opt("url", null);
const baseline = opt("baseline", null);
const threshold = Number(opt("threshold", "0.5"));
const only = opt("only", null)?.split(",").map((s) => s.trim());
const executablePath = opt("browser", process.env.PREVIEW_VISUAL_BROWSER || undefined);
const viewport = { width: 1280, height: 800 };

/** Surfaces: how to reach each one from a fresh page. */
const SURFACES = [
  { id: "split", open: async (p) => p.keyboard.press("Meta+2"), ready: ".prose-lumen h1" },
  { id: "source", open: async (p) => p.keyboard.press("Meta+1"), ready: ".cm-content" },
  { id: "preview", open: async (p) => p.keyboard.press("Meta+3"), ready: ".prose-lumen h1" },
  { id: "wysiwyg", open: async (p) => p.keyboard.press("Meta+4"), ready: ".ProseMirror" },
  { id: "palette", open: async (p) => p.keyboard.press("Meta+K"), ready: '[role="dialog"][aria-modal="true"] input' },
  { id: "shortcuts", open: async (p) => p.keyboard.press("Meta+/"), ready: '[role="dialog"][aria-label="Keyboard Shortcuts"]' },
  { id: "plugins", open: (p) => runCommand(p, "view.plugins"), ready: '[data-testid="plugin-card"]' },
  { id: "templates", open: (p) => runCommand(p, "templates.open"), ready: '[data-testid="template-card"]' },
  { id: "ai-settings", open: (p) => p.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-ai-settings"))), ready: '[data-testid="exec-status-ollama"]' },
  { id: "ai-doctor", open: (p) => p.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-ai-doctor"))), ready: '[data-testid="doctor-summary"]' },
].filter((s) => !only || only.includes(s.id));

const VARIANTS = [
  { id: "en-dark", locale: "en", theme: "dark" },
  { id: "en-light", locale: "en", theme: "light" },
  { id: "he-dark", locale: "he", theme: "dark" },
  { id: "he-light", locale: "he", theme: "light" },
];

function runCommand(page, id) {
  return page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
}

async function startPreview() {
  if (!existsSync("dist/index.html")) {
    console.error("dist/ is missing: run `npm run build` first, or pass --url.");
    process.exit(2);
  }
  const port = 4180;
  const child = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore" });
  const target = `http://localhost:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(target)).ok) return { child, target };
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill();
  throw new Error("vite preview did not start");
}

/** Fraction of differing pixels between two PNG files, computed in the browser. */
async function diffRatio(page, a, b) {
  const toData = (f) => `data:image/png;base64,${readFileSync(f).toString("base64")}`;
  return page.evaluate(
    async ([x, y]) => {
      const load = (src) => new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = src; });
      const [ia, ib] = await Promise.all([load(x), load(y)]);
      if (ia.width !== ib.width || ia.height !== ib.height) return 1;
      const c = (img) => { const cv = new OffscreenCanvas(img.width, img.height); const ctx = cv.getContext("2d"); ctx.drawImage(img, 0, 0); return ctx.getImageData(0, 0, img.width, img.height).data; };
      const da = c(ia), db = c(ib);
      let diff = 0;
      for (let i = 0; i < da.length; i += 4) {
        if (Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]) > 24) diff++;
      }
      return diff / (da.length / 4);
    },
    [toData(a), toData(b)],
  );
}

const run = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outDir = resolve("visual-results", run);
mkdirSync(outDir, { recursive: true });

let preview = null;
if (!url) {
  preview = await startPreview();
  url = preview.target;
}

const browser = await chromium.launch(executablePath ? { executablePath } : {});
const results = [];
try {
  for (const v of VARIANTS) {
    for (const s of SURFACES) {
      const ctx = await browser.newContext({ viewport, colorScheme: v.theme, reducedMotion: "reduce" });
      const page = await ctx.newPage();
      await page.addInitScript(({ locale, theme }) => {
        localStorage.clear();
        localStorage.setItem("lumen-tour-done", "1");
        localStorage.setItem("lumen-md", JSON.stringify({ state: { locale, theme }, version: 0 }));
      }, v);
      const file = `${s.id}--${v.id}.png`;
      const rec = { surface: s.id, variant: v.id, file, ok: true, note: "" };
      try {
        await page.goto(url);
        await page.locator(".cm-content, .ProseMirror").first().waitFor({ timeout: 20_000 });
        await s.open(page);
        await page.locator(s.ready).first().waitFor({ state: "visible", timeout: 20_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        await page.evaluate(() => document.fonts?.ready);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) rec.note = `horizontal overflow ${overflow}px`;
        const dir = await page.evaluate(() => document.documentElement.dir || "ltr");
        if ((v.locale === "he") !== (dir === "rtl")) {
          rec.ok = false;
          rec.note = `html dir=${dir}`;
        }
        await page.screenshot({ path: join(outDir, file), animations: "disabled", caret: "hide" });
        if (baseline) {
          const prev = resolve(baseline, file);
          if (!existsSync(prev)) rec.note = (rec.note ? rec.note + "; " : "") + "no baseline";
          else {
            const r = await diffRatio(page, prev, join(outDir, file));
            rec.diff = r;
            if (r * 100 > threshold) {
              rec.ok = false;
              rec.note = (rec.note ? rec.note + "; " : "") + `differs ${(r * 100).toFixed(2)}%`;
            }
          }
        }
      } catch (e) {
        rec.ok = false;
        rec.note = (e.message || String(e)).split("\n")[0];
      }
      results.push(rec);
      console.log(`${rec.ok ? (rec.note ? "!" : "✓") : "✗"} ${s.id.padEnd(12)} ${v.id.padEnd(9)} ${rec.note}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
  preview?.child.kill();
}

const cell = (r) => `<figure class="${r.ok ? (r.note ? "warn" : "") : "bad"}"><a href="${r.file}"><img loading="lazy" src="${r.file}" alt="${r.surface} ${r.variant}"></a><figcaption>${r.surface} · ${r.variant}${r.note ? ` — ${r.note}` : ""}</figcaption></figure>`;
const page = `<!doctype html><meta charset="utf-8"><title>Lumen visual preview ${run}</title>
<style>body{font:14px system-ui;margin:16px;background:#111;color:#eee}h1{font-size:18px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
figure{margin:0;border:2px solid #333;border-radius:6px;overflow:hidden}figure.bad{border-color:#e55}figure.warn{border-color:#d9a400}
img{width:100%;display:block}figcaption{padding:4px 8px;font-size:12px}</style>
<h1>Lumen — ${results.length} shots · ${results.filter((r) => !r.ok).length} failing · ${url}${baseline ? ` · baseline ${baseline}` : ""}</h1>
<div class="grid">${results.map(cell).join("")}</div>`;
writeFileSync(join(outDir, "index.html"), page);
writeFileSync(join(outDir, "results.json"), JSON.stringify(results, null, 2));
console.log(`\n${outDir}/index.html`);
process.exit(results.some((r) => !r.ok) ? 1 : 0);

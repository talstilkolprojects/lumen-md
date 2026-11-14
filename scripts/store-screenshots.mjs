#!/usr/bin/env node
/**
 * Store screenshots (plan 13.7): every scene of store/screenshots.json on
 * every device, in Hebrew and English, from a running build.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   node scripts/store-screenshots.mjs --base http://localhost:4173 [--device iphone-6.9] [--locale he]
 *
 * Output: store/screenshots/<device>/<locale>/NN-<scene>.png, at the exact
 * pixel size each store asks for (checked after capture). The notes are the
 * made-up seed in the JSON, written into the browser's storage before the
 * app loads. Never point this at a profile with real notes: it uses a fresh
 * browser context every time.
 */
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { plan } from "./lib/screenshots.mjs";

const args = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const base = opt("--base") ?? "http://localhost:4173";
const cfg = JSON.parse(readFileSync("store/screenshots.json", "utf8"));
const shots = plan(cfg, { device: opt("--device"), locale: opt("--locale") });

const { chromium } = await import("playwright");
const browser = await chromium.launch();
let failed = 0;
for (const s of shots) {
  const dev = cfg.devices[s.device];
  const ctx = await browser.newContext({ viewport: { width: dev.viewport[0], height: dev.viewport[1] }, deviceScaleFactor: dev.scale, isMobile: dev.mobile, hasTouch: dev.mobile, locale: s.locale === "he" ? "he-IL" : "en-US", colorScheme: s.theme });
  const page = await ctx.newPage();
  await page.addInitScript(
    ({ locale, theme, mode }) => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale, theme, mode, showWorkspace: true }, version: 0 }));
    },
    { locale: s.locale, theme: s.theme, mode: s.mode },
  );
  await page.goto(base + "/");
  // The seed, in the browser's own file storage, then a reload so the app reads it.
  await page.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for (const [name, text] of Object.entries(files)) {
      const h = await root.getFileHandle(name, { create: true });
      const w = await h.createWritable();
      await w.write(text);
      await w.close();
    }
  }, s.seed);
  await page.goto(base + (s.url ?? "/"));
  await page.waitForLoadState("networkidle");
  if (s.open) await page.evaluate((path) => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } })), s.open);
  if (s.command) await page.evaluate((id) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id } })), s.command);
  if (s.keys) await page.keyboard.press(s.keys);
  if (s.type) await page.keyboard.type(s.type, { delay: 30 });
  await page.waitForTimeout(800);
  const dir = join("store", "screenshots", s.device, s.locale);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, s.file);
  const png = await page.screenshot({ path: file });
  // PNG size from the IHDR chunk.
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  const ok = w === dev.pixels[0] && h === dev.pixels[1];
  if (!ok) failed++;
  console.log(`${ok ? "✓" : "✖"} ${file} ${w}×${h}${ok ? "" : ` (want ${dev.pixels.join("×")})`}`);
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);

import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodePng, encodeGif } from "../../scripts/lib/gif.mjs";
import { FLOWS, type FlowCtx } from "./flows";

/**
 * Records the docs GIFs (plan W4.34), in Hebrew:
 *
 *   npm run docs:gifs                          # all 30 → docs/public/gifs/<id>.gif + index.json
 *   npm run docs:gifs -- --grep palette        # one
 *
 * Runs with playwright.gifs.config.ts (Chromium, 960×600, one worker, the
 * dev server like the e2e tests). Frames are screenshots taken where the
 * flow calls shot(); scripts/lib/gif.mjs encodes them — no ffmpeg needed.
 */

const OUT = join(process.cwd(), "docs", "public", "gifs");

async function hebrew(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("עברית");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText("עברית", { timeout: 8000 });
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await hebrew(page);
});

test.afterAll(() => {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, "index.json"), JSON.stringify({ gifs: FLOWS.map((f) => ({ id: f.id, file: `${f.id}.gif`, title: f.title, page: f.page })) }, null, 2) + "\n");
});

for (const flow of FLOWS) {
  test(`${flow.id}: ${flow.title.en}`, async ({ page }) => {
    const frames: { width: number; height: number; rgba: Uint8Array; delayMs: number }[] = [];
    const editor = page.locator(".cm-content").first();
    const ctx: FlowCtx = {
      page,
      shot: async (hold = 700) => {
        frames.push({ ...decodePng(await page.screenshot({ animations: "disabled", caret: "initial" })), delayMs: hold });
      },
      command: (id) => page.evaluate((cmd) => void window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id),
      palette: async (query) => {
        await page.keyboard.press("ControlOrMeta+k");
        const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
        await palette.waitFor({ timeout: 8000 });
        await ctx.shot(500);
        await palette.locator("input").first().pressSequentially(query, { delay: 90 });
      },
      note: async (text) => {
        await editor.click();
        await editor.fill(text);
        await page.keyboard.press("ControlOrMeta+End");
      },
      typeSlowly: async (text) => {
        const chunks = text.match(/[^\n]*\n?/g)!.filter(Boolean);
        for (const c of chunks) {
          await page.keyboard.type(c, { delay: 35 });
          await ctx.shot(350);
        }
      },
    };
    await flow.run(ctx);
    expect(frames.length).toBeGreaterThan(1);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${flow.id}.gif`), encodeGif(frames));
  });
}

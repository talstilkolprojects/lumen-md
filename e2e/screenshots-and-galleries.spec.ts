import { test, expect } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import path from "node:path";

/**
 * M6 + plugin/template gallery closure.
 *
 * Two purposes:
 *   1. Take real preview screenshots for Mermaid + WYSIWYG + RTL + PageView
 *      and save them under `test-results/screenshots/`. M6 in the original
 *      plan asked for human eyeball verification; this captures the artifact
 *      so a reviewer can do that.
 *   2. Drive the Plugin Gallery and Template Gallery to actually mount and
 *      render their lists — closing the gap where earlier rounds only
 *      confirmed the palette command fires.
 */

const OUT_DIR = path.join(process.cwd(), "test-results", "screenshots");

test.beforeAll(async () => {
  await mkdir(OUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page
    .locator("header")
    .first()
    .waitFor({ state: "visible", timeout: 5000 });
});

test("M6 — capture Mermaid screenshot", async ({ page }) => {
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```mermaid\ngraph LR; A --> B; B --> C; C --> D\n```\n",
  );
  const svg = page
    .locator(".chart-block svg, .mermaid-block svg")
    .first();
  await expect(svg).toBeVisible({ timeout: 8_000 });
  await page.screenshot({
    path: path.join(OUT_DIR, "mermaid.png"),
    fullPage: true,
  });
});

test("M6 — capture WYSIWYG screenshot", async ({ page }) => {
  await page.keyboard.press("Meta+4");
  await expect(page.locator(".ProseMirror").first()).toBeVisible({
    timeout: 8_000,
  });
  await page.locator(".ProseMirror").first().click();
  await page.keyboard.type("hello WYSIWYG");
  await page.screenshot({
    path: path.join(OUT_DIR, "wysiwyg.png"),
    fullPage: true,
  });
});

test("M6 — capture RTL screenshot", async ({ page }) => {
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"][aria-modal="true"]')
    .filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("עברית");
  // Anchor the readiness wait on the selected listbox option (the
  // palette's aria-selected="true" element) — that's the deterministic
  // signal that the filter settled. Round-23 deflake.
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/עברית/, { timeout: 8000 });
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl", {
    timeout: 5000,
  });
  await page.screenshot({
    path: path.join(OUT_DIR, "rtl.png"),
    fullPage: true,
  });
});

test("M6 — capture PageView screenshot", async ({ page }) => {
  // PageView is lazy-loaded; firefox on slow CI needs the extra budget.
  test.setTimeout(60_000);
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"][aria-modal="true"]')
    .filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Page View");
  // Round-23 deflake: anchor on the selected listbox option so we
  // know the filter pass settled before pressing Enter.
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Page View/i, { timeout: 8000 });
  await page.keyboard.press("Enter");
  // PageView is lazy-loaded — firefox on CI's slow Linux runner can
  // take 10+ seconds to fetch & mount the chunk. 8s was tight even
  // on the macOS reference; 15s gives realistic headroom.
  await expect(
    page.locator('button[aria-label="Previous page"]'),
  ).toBeVisible({ timeout: 15_000 });
  await page.screenshot({
    path: path.join(OUT_DIR, "page-view.png"),
    fullPage: true,
  });
});

test("Plugin Gallery — opens, lists at least one plugin, screenshot", async ({
  page,
}) => {
  // Opening the gallery used to throw "Rendered more hooks than during
  // the previous render" (a hook below the early return); the old test
  // ended in `expect(true)` and never saw it. A page error fails the test.
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"][aria-modal="true"]')
    .filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Plugin Gallery");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Plugin Gallery/i, { timeout: 8000 });
  await page.keyboard.press("Enter");

  // The gallery is its own dialog, labelled by its title; the bundled
  // community plugins render without waiting for the registry fetch.
  const gallery = page.locator('[role="dialog"][aria-labelledby="plugin-gallery-title"]');
  await expect(gallery).toBeVisible({ timeout: 10_000 });
  await expect(gallery.getByTestId("plugin-card").first()).toBeVisible({ timeout: 10_000 });
  expect(await gallery.getByTestId("plugin-card").count()).toBeGreaterThan(0);
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: path.join(OUT_DIR, "plugin-gallery.png"),
    fullPage: true,
  });

  // And it closes again.
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden({ timeout: 5000 });
  expect(pageErrors).toEqual([]);
});

test("Template Gallery — opens, lists templates, screenshot", async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"][aria-modal="true"]')
    .filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Template");
  // Same deflake pattern: anchor on the selected listbox option. "Template"
  // also matches every "Templates: …" starter, so name the one Enter runs.
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Browse template gallery/i, { timeout: 8000 });
  await page.keyboard.press("Enter");

  // By its accessible name: the first dialog that is not the palette could
  // be any other panel in the DOM.
  const gallery = page.getByRole("dialog", { name: "Template gallery" });
  // The gallery is a lazy chunk (opens on first use) — give a cold CI runner time.
  await expect(gallery).toBeVisible({ timeout: 20_000 });
  // Without a marketplace backend the gallery falls back to the static
  // registry served from public/templates, so rows always render.
  await expect(gallery.getByTestId("template-card").first()).toBeVisible({ timeout: 10_000 });
  expect(pageErrors).toEqual([]);

  await page.screenshot({
    path: path.join(OUT_DIR, "template-gallery.png"),
    fullPage: true,
  });
});

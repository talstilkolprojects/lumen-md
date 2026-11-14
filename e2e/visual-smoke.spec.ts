import { test, expect } from "@playwright/test";

/**
 * Visual smoke for the four high-risk surfaces from Round-4 master plan M6:
 *   - Mermaid block renders an SVG (not just chrome).
 *   - WYSIWYG mode shows a ProseMirror editor and accepts text.
 *   - RTL locale flips toolbar mirroring (html dir + computed dir on body).
 *   - PageView shows page-style pagination (a `.page` element).
 *
 * Each test captures a screenshot on failure so a human can eyeball
 * what the page actually rendered. The asserts are coarse (visibility +
 * shape, not pixel diffs) because we just want a "the surface mounts and
 * looks plausibly correct" smoke gate.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page.locator("header").first().waitFor({ state: "visible", timeout: 5000 });
});

test("Mermaid block renders inline SVG inside the preview", async ({ page }) => {
  // Mermaid is a ~2.7 MB lazy vendor chunk. Firefox on Linux CI takes
  // 10-15 s to fetch + parse + render the first time. Both the inner
  // waitFor AND the global per-test timeout need headroom.
  test.setTimeout(60_000);
  // Split mode so we see both source and preview at once.
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("```mermaid\ngraph LR; A --> B; B --> C\n```\n");
  const svg = page.locator(".chart-block svg, .mermaid-block svg").first();
  await expect(svg).toBeVisible({ timeout: 30_000 });
  // SVG sub-elements (`<g>`, `<path>`) are considered "hidden" by
  // Playwright's isVisible heuristic because they have no intrinsic
  // box even when rendered. Counting them is enough proof of structure.
  const groupCount = await svg.locator("g").count();
  expect(groupCount).toBeGreaterThan(0);
  // M6-followup: structural size assertion. The earlier audit found
  // a CSS regression that collapsed the mermaid block to ~24×24 px;
  // the existing assertions (svg visible, has child `g`) couldn't see
  // that. Pin the bounding box so a future flex/grid mistake fails
  // here loudly instead of producing an unreadable diagram.
  const box = await svg.boundingBox();
  expect(box, "Mermaid SVG must have a bounding box").not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(200);
  // 60 still catches the ~24 px collapse this guards against; SVG-text
  // labels (fb72bbb) render a tighter LR flowchart in WebKit (~79 px).
  expect(box!.height).toBeGreaterThanOrEqual(60);
});

/**
 * M6 follow-up 1 — pixel-diff regression for Mermaid. The bounding-box
 * assertion above catches the "collapsed to 24×24" bug; this catches
 * subtler layout/theme regressions (wrapped labels, lost edge styling,
 * wrong theme colours).
 *
 * Only the SVG element is captured (not the "Rendered in N ms" status
 * row, which varies run to run). Chromium only: font rasterisation
 * differs per engine and OS, and one stable baseline beats three flaky
 * ones. Baselines are per-platform (`…-chromium-linux.png`).
 *
 * The chromium-linux baseline is committed. First-run guard for any
 * other platform: when no baseline exists, the test writes one and passes
 * with an annotation instead of failing. Commit it (or regenerate with
 * `npx playwright test e2e/visual-smoke.spec.ts --project=chromium
 * --update-snapshots`) — see CONTRIBUTING.md.
 */
test("Mermaid block matches the pixel baseline", async ({ page, browserName }, testInfo) => {
  // skip-reason: the pixel baseline is one engine's rendering; fonts and anti-aliasing differ per engine | task: 0.5 | until: 2027-05-12
  test.skip(browserName !== "chromium", "pixel baseline is chromium-only");
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.keyboard.press("Meta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("```mermaid\ngraph LR; A --> B; B --> C\n```\n");
  const svg = page.locator(".mermaid-block svg").first();
  await expect(svg).toBeVisible({ timeout: 30_000 });
  // Let web fonts settle so text metrics are final before capture.
  await page.evaluate(() => document.fonts.ready);

  const name = "mermaid-flowchart.png";
  const baseline = testInfo.snapshotPath(name, { kind: "screenshot" });
  const { existsSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  if (!existsSync(baseline) && testInfo.config.updateSnapshots !== "all") {
    mkdirSync(dirname(baseline), { recursive: true });
    await svg.screenshot({ path: baseline, animations: "disabled" });
    testInfo.annotations.push({
      type: "baseline-created",
      description: `No committed baseline — wrote ${baseline}. Commit it to enable the pixel diff.`,
    });
    return;
  }
  await expect(svg).toHaveScreenshot(name, {
    animations: "disabled",
    // Anti-aliasing noise across GPU/driver versions stays well under 1 %;
    // a real regression (wrapped labels, collapsed nodes) moves > 10 %.
    maxDiffPixelRatio: 0.02,
  });
});

test("WYSIWYG mode mounts ProseMirror and accepts typed input", async ({ page }) => {
  await page.keyboard.press("Meta+4");
  const pm = page.locator(".ProseMirror").first();
  await expect(pm).toBeVisible({ timeout: 8_000 });
  await pm.click();
  await page.keyboard.type("hello-wysiwyg");
  await expect(pm).toContainText("hello-wysiwyg");
});

test("RTL locale flips html[dir] to rtl", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  // Open palette and search for the Hebrew language toggle.
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"]')
    .filter({ has: page.getByPlaceholder(/Type a command/i) });
  await palette.waitFor({ timeout: 8000 });
  // `fill` is more reliable than `keyboard.type` for non-ASCII strings
  // and for focus consistency across Playwright versions.
  await palette.locator("input").first().fill("עברית");
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/עברית/, { timeout: 8000 });
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 5000 });
});

test("PageView mode renders pagination chrome (page nav buttons)", async ({ page }) => {
  // PageView is mounted via the command palette ("Page View" command).
  await page.keyboard.press("Meta+K");
  const palette = page
    .locator('[role="dialog"]')
    .filter({ has: page.getByPlaceholder(/Type a command/i) });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Page View");
  // Wait for the palette's filter to settle: the highlighted option
  // (aria-selected=true) must match what we typed.
  await expect(
    palette.locator('[role="option"][aria-selected="true"]'),
  ).toContainText(/Page View/i, { timeout: 8000 });
  await page.keyboard.press("Enter");
  // PageView renders Previous/Next nav buttons with aria-labels — those
  // are the stable identifiers across re-renders and locales.
  await expect(
    page.locator('button[aria-label="Previous page"]'),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.locator('button[aria-label="Next page"]'),
  ).toBeVisible({ timeout: 8_000 });
});

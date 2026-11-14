import { test, expect } from "@playwright/test";

/**
 * Hardening smoke for dynamic blocks: HTML preview is sanitized, Live JS runs
 * via the worker path, and SVG blocks are rendered with status output.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page.keyboard.press("Meta+2");
});

test("security-critical dynamic blocks stay functional with safe status output", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```html\n" +
      "<div>safe</div><script>console.log(1)</script>\n" +
      "```\n\n" +
      "```live-js\n" +
      "console.log('js-ok');\n" +
      "console.log(3 + 4);\n" +
      "```\n\n" +
      "```svg\n" +
      "<svg><circle cx=\"25\" cy=\"25\" r=\"20\" /></svg>\n" +
      "```\n",
  );

  await expect(page.locator("text=Some HTML content was sanitized before preview for safety.")).toBeVisible({
    timeout: 8_000,
  });

  // live-js never runs on open (T48): the first run is a click on Run.
  await expect(page.locator("text=JS run: Not run yet")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.locator("text=JS run: Completed")).toBeVisible({ timeout: 8_000 });
  await expect(page.locator("text=/\\[log\\] js-ok/")).toBeVisible({ timeout: 8_000 });
  // The literal "SVG" matches the source code, the preview's raw
  // text node, AND the status pill — the bare `text=SVG` was a
  // strict-mode violation. Anchor to the chart-block header's lang
  // chip and status text inside the rendered block instead.
  await expect(
    page.locator(".chart-block-header span", { hasText: /^SVG$/ }),
  ).toBeVisible({ timeout: 8_000 });
  await expect(
    page.locator(".chart-block-header span", { hasText: /^Rendered/ }),
  ).toBeVisible({ timeout: 8_000 });
});


test("Live JS block surfaces error state on runtime exception", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```live-js\n" +
      "throw new Error(\"security-workflow\");\n" +
      "```\n",
  );

  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.locator("text=JS run: Runtime error")).toBeVisible({ timeout: 8_000 });
});

test("live-js code runs sandboxed: no app origin, storage or network (T48)", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    "```live-js\n" +
      "console.log('origin', String(self.location.href).includes(" + JSON.stringify(new URL(page.url()).host) + ") ? 'app' : 'isolated');\n" +
      "console.log('idb', typeof indexedDB, 'fetch', typeof fetch, 'xhr', typeof XMLHttpRequest, 'ws', typeof WebSocket);\n" +
      "```\n",
  );
  await expect(page.locator("text=JS run: Not run yet")).toBeVisible({ timeout: 8_000 });
  await page.getByRole("button", { name: "Run", exact: true }).first().click();
  await expect(page.locator("text=JS run: Completed")).toBeVisible({ timeout: 8_000 });
  await expect(page.locator("text=/\\[log\\] origin isolated/")).toBeVisible();
  await expect(page.locator("text=/\\[log\\] idb undefined fetch undefined xhr undefined ws undefined/")).toBeVisible();
  // The runner is a sandboxed iframe without same-origin powers.
  const sandbox = await page.locator("iframe[data-livejs-runner]").first().getAttribute("sandbox");
  expect(sandbox).toBe("allow-scripts");
});

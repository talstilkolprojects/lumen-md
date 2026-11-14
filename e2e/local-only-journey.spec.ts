import { test, expect, type Request } from "@playwright/test";

/**
 * 2.4 — a full session under the local-only policy sends nothing off this
 * device: every request the page (and its workers) makes goes to this
 * origin or stays in memory (data:, blob:). The journey covers typing,
 * Markdown + math + Mermaid rendering, every view mode, the privacy
 * ledger, the palette, the Hebrew UI (RTL) and Find & Replace.
 */
test("local-only journey: 0 requests leave the device", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? "http://localhost").origin;
  const offDevice: string[] = [];
  const watch = (r: Request) => {
    const u = r.url();
    if (u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("about:")) return;
    try {
      if (new URL(u).origin === origin) return;
    } catch {
      /* not a URL: report it */
    }
    offDevice.push(`${r.method()} ${u}`);
  };
  page.on("request", watch);
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => {
    if (!/Storage is disabled inside 'data:'|sandboxed and lacks the 'allow-same-origin'|allow-scripts/i.test(e.message)) pageErrors.push(e.message);
  });

  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("Welcome to", { timeout: 15_000 });

  // Type, render: a heading, a table, math, Mermaid, a wikilink, Hebrew.
  await page.keyboard.press("Meta+2");
  await editor.click();
  await editor.fill(
    "# סקירה רבעונית\n\nשורה בעברית with English.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n$$E = mc^2$$\n\n```mermaid\ngraph LR; A --> B\n```\n\n[[Welcome]]\n",
  );
  await expect(page.locator(".markdown-preview h1, [data-preview-root] h1").first()).toBeVisible({ timeout: 8000 });
  await expect(page.locator(".chart-block svg, .mermaid-block svg").first()).toBeVisible({ timeout: 10_000 });

  // Every view mode.
  for (const key of ["Meta+1", "Meta+3", "Meta+4", "Meta+2"]) await page.keyboard.press(key);
  await expect(page.locator(".cm-content").first()).toBeVisible();

  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  const run = async (query: string, pattern: RegExp) => {
    await page.keyboard.press("Meta+K");
    await palette.waitFor({ timeout: 8000 });
    await palette.locator("input").first().fill(query);
    await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(pattern, { timeout: 8000 });
    await page.keyboard.press("Enter");
  };

  // The privacy ledger opens and lists nothing that left.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "ai.privacyLedger" } })));
  const ledger = page.locator('[role="dialog"][aria-label="Privacy ledger"]');
  await expect(ledger).toBeVisible({ timeout: 5000 });
  await expect(ledger.locator('[data-testid="privacy-row"][data-decision="allowed"]')).toHaveCount(0);
  await page.keyboard.press("Escape");

  // Hebrew UI and RTL, then Find & Replace in Hebrew.
  await run("עברית", /עברית/);
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 5000 });
  await run("חיפוש והחלפה", /חיפוש והחלפה/);
  await expect(page.locator('button[aria-label="סגור חיפוש והחלפה"]')).toBeVisible({ timeout: 3000 });

  // Let lazy chunks, fonts and workers settle, then check.
  await page.waitForLoadState("networkidle").catch(() => {});
  expect(offDevice, "requests that left the device").toEqual([]);
  expect(pageErrors).toEqual([]);
});

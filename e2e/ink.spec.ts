import { test, expect, type Page } from "@playwright/test";

/**
 * Handwriting in a note (plan W5.27): the palette command opens the pad,
 * a stroke drawn on it lands in the note as an inline `<svg data-lumen-ink>`
 * HTML block, the preview draws it on the right of a Hebrew note, and with
 * the cursor inside the block the same command edits it (an emptied ink is
 * removed). In Chromium the stroke is drawn with a pen with pressure
 * (trusted input through CDP); other engines draw with the mouse.
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

async function draw(page: Page, browserName: string) {
  const surface = page.getByTestId("ink-surface");
  await expect(surface).toBeVisible({ timeout: 10_000 });
  const box = (await surface.boundingBox())!;
  const x0 = box.x + 60;
  const y0 = box.y + 80;
  if (browserName === "chromium") {
    const cdp = await page.context().newCDPSession(page);
    const send = (type: string, x: number, y: number, force: number) =>
      cdp.send("Input.dispatchMouseEvent", { type: type as "mouseMoved", x, y, button: "left", buttons: type === "mouseReleased" ? 0 : 1, clickCount: 1, pointerType: "pen", force });
    await send("mousePressed", x0, y0, 0.2);
    for (let i = 1; i <= 30; i++) await send("mouseMoved", x0 + i * 6, y0 + Math.sin(i / 3) * 12, 0.2 + i / 40);
    await send("mouseReleased", x0 + 180, y0, 0);
  } else {
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(x0 + i * 6, y0 + Math.sin(i / 3) * 12);
    await page.mouse.up();
  }
  await expect(page.locator("[data-ink-stroke]")).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("draw → the note holds an SVG ink block → the preview shows it at the start edge of a Hebrew note → edit → remove", async ({ page, browserName }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("שיעור ראשון\n\n");
  await page.keyboard.press("ControlOrMeta+End");

  await run(page, "insert.ink");
  await draw(page, browserName);
  await page.getByTestId("ink-pad").getByRole("button", { name: "Insert" }).click();
  await expect(page.getByTestId("ink-pad")).toHaveCount(0);

  // The Markdown: an HTML block with the samples, after a blank line.
  await expect(editor).toContainText('data-lumen-ink="1"');
  await expect(editor).toContainText('data-ink-dir="rtl"');
  await expect(editor).toContainText("data-ink-pts=");

  // The preview draws it, on the right (the start edge of a Hebrew note).
  const ink = page.locator("[data-preview-root] svg[data-lumen-ink]");
  await expect(ink).toBeVisible({ timeout: 10_000 });
  await expect(ink.locator("path")).toHaveCount(1);
  const root = (await page.locator("[data-preview-root] .prose-lumen").boundingBox())!;
  const svg = (await ink.boundingBox())!;
  expect(Math.abs(root.x + root.width - (svg.x + svg.width))).toBeLessThan(40);

  // Double-click in the preview opens the same ink; clearing it removes the block.
  await ink.dblclick();
  await expect(page.locator("[data-ink-stroke]")).toHaveCount(1);
  await page.getByTestId("ink-pad").getByRole("button", { name: "Clear" }).click();
  await page.getByTestId("ink-pad").getByRole("button", { name: "Save" }).click();
  await expect(editor).not.toContainText("data-lumen-ink");
  await expect(editor).toContainText("שיעור ראשון");
});

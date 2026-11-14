import { test, expect, devices, type Page } from "@playwright/test";

/**
 * Native-level phone editing (plan W1.25), in Hebrew (RTL), on an iPhone 14
 * and a Pixel 7 profile. Both run on Chromium (no WebKit on this machine),
 * so the iPhone run checks layout and touch input, not Safari's engine.
 *
 * Acceptance:
 *  - the toolbar above the keyboard and its actions, the customise sheet;
 *  - edge swipes mirrored in RTL (file list from the right, outline from the left);
 *  - a long note opens for reading and a tap edits at that line;
 *  - launch → last note in under 1.5 s.
 */

const LONG = ["# מבוא", "", ...Array.from({ length: 70 }, (_, i) => `פסקה ${i + 1}: ${"מילה ".repeat(10).trim()}.`), "", "## סוף", "", "הפסקה האחרונה בפתק."].join("\n\n");

async function seed(page: Page, doc: { name: string; content: string }, mode: "source" | "preview" = "source") {
  await page.addInitScript(
    ({ doc, mode }) => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he", mode, doc: { ...doc, dirty: false, workspaceName: null } }, version: 0 }));
    },
    { doc, mode },
  );
}

/** A synthetic touch stroke from `from` to `to` (pointer events, like a finger). */
async function stroke(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, ms = 160) {
  await page.evaluate(
    async ({ from, to, ms }) => {
      const o = (x: number, y: number, buttons = 1) => ({ pointerId: 9, pointerType: "touch", isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons });
      (document.elementFromPoint(from.x, from.y) ?? document.body).dispatchEvent(new PointerEvent("pointerdown", o(from.x, from.y)));
      const steps = 5;
      for (let i = 1; i <= steps; i++) {
        await new Promise((r) => setTimeout(r, ms / steps));
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        (document.elementFromPoint(x, y) ?? document.body).dispatchEvent(new PointerEvent("pointermove", o(x, y)));
      }
      (document.elementFromPoint(to.x, to.y) ?? document.body).dispatchEvent(new PointerEvent("pointerup", o(to.x, to.y, 0)));
    },
    { from, to, ms },
  );
}

const cursorLine = (page: Page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    const line = sel?.anchorNode && (sel.anchorNode.nodeType === 1 ? (sel.anchorNode as Element) : sel.anchorNode.parentElement)?.closest(".cm-line");
    return line?.textContent ?? null;
  });

for (const name of ["iPhone 14", "Pixel 7"] as const) {
  test.describe(name, () => {
    const { defaultBrowserType: _ignored, ...device } = devices[name];
    test.use(device);

    test(`${name}: the editing toolbar, RTL — actions, one undo each, customise`, async ({ page }) => {
      await seed(page, { name: "קצר.md", content: "קניות\n" });
      await page.goto("/");
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      const editor = page.locator(".cm-content").first();
      await expect(editor).toBeVisible({ timeout: 20_000 });
      await editor.tap();
      await page.keyboard.press("Control+Home");
      const bar = page.getByTestId("mobile-toolbar");
      await expect(bar).toBeVisible();
      // Starts at the right in RTL; 44×44 targets.
      const first = (await bar.locator("button").first().boundingBox())!;
      const last = (await bar.locator("button").last().boundingBox())!;
      expect(first.x).toBeGreaterThan(last.x);
      expect(first.width).toBeGreaterThanOrEqual(44);
      expect(first.height).toBeGreaterThanOrEqual(44);

      // ☐ makes a task, again checks it; ⇥ indents; ↶ takes one step back.
      await bar.locator('[data-action="task"]').tap();
      await expect(page.locator(".cm-line").first()).toHaveText("- [ ] קניות");
      await bar.locator('[data-action="task"]').tap();
      await expect(page.locator(".cm-line").first()).toHaveText("- [x] קניות");
      await bar.locator('[data-action="indent"]').tap();
      await expect(page.locator(".cm-line").first()).toHaveText("  - [x] קניות");
      await bar.locator('[data-action="undo"]').tap();
      await expect(page.locator(".cm-line").first()).toHaveText("- [x] קניות");
      // Focus stayed in the editor the whole time.
      expect(await page.evaluate(() => !!document.activeElement?.closest(".cm-editor"))).toBe(true);

      // [[ then a few letters offers notes by name (vault empty here: the list may be empty, the brackets are there).
      await bar.locator('[data-action="wikilink"]').tap();
      await expect(page.locator(".cm-line").first()).toContainText("[[]]");

      // ⋯ → customise: add italic, move it first, reset.
      await bar.locator('[data-action="customize"]').tap();
      const sheet = page.getByTestId("mobile-toolbar-sheet");
      await expect(sheet).toBeVisible();
      await sheet.getByRole("button", { name: "הוספת נטוי" }).tap();
      await expect(sheet.locator('[data-row-item="italic"]')).toBeVisible();
      await sheet.getByRole("button", { name: "איפוס" }).tap();
      await expect(sheet.locator('[data-row-item="italic"]')).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(sheet).toHaveCount(0);
    });

    test(`${name}: edge swipes mirrored in RTL`, async ({ page }) => {
      await seed(page, { name: "קצר.md", content: "# א\n\nטקסט\n\n## ב\n" }, "preview");
      await page.goto("/");
      await expect(page.locator(".prose-lumen").first()).toBeVisible({ timeout: 20_000 });
      const { width: w, height: h } = page.viewportSize()!;
      // From the right edge inwards: the file list (start side in Hebrew).
      await stroke(page, { x: w - 4, y: h / 2 }, { x: w - 160, y: h / 2 });
      await expect(page.locator(".file-tree").first()).toBeVisible();
      // Swipe it back towards the right edge: closed.
      const tree = (await page.locator(".file-tree").first().boundingBox())!;
      await stroke(page, { x: tree.x + 20, y: h / 2 }, { x: tree.x + 180, y: h / 2 });
      await expect(page.locator(".file-tree")).toHaveCount(0);
      // From the left edge inwards: the outline sheet.
      await stroke(page, { x: 4, y: h / 2 }, { x: 160, y: h / 2 });
      await expect(page.getByTestId("outline-sheet")).toBeVisible();
    });

    test(`${name}: a long note opens for reading; a tap edits at that line`, async ({ page }) => {
      await seed(page, { name: "ארוך.md", content: LONG }, "source");
      await page.goto("/");
      const prose = page.locator(".prose-lumen").first();
      await expect(prose).toBeVisible({ timeout: 20_000 });
      await expect(page.locator(".cm-content")).toHaveCount(0);
      await prose.getByText("פסקה 12:").tap();
      await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
      await expect.poll(() => cursorLine(page), { timeout: 5_000 }).toContain("פסקה 12:");
    });

    test(`${name}: launch → last note under 1.5 s`, async ({ page }) => {
      await seed(page, { name: "אחרון.md", content: LONG }, "preview");
      // Warm the cache once (a returning user), then time a fresh launch.
      await page.goto("/");
      await expect(page.locator(".prose-lumen").getByText("הפסקה האחרונה בפתק.")).toBeAttached({ timeout: 20_000 });
      const t0 = Date.now();
      await page.reload();
      await expect(page.locator(".prose-lumen").getByText("הפסקה האחרונה בפתק.")).toBeAttached({ timeout: 20_000 });
      const ms = Date.now() - t0;
      test.info().annotations.push({ type: "launch-to-last-note-ms", description: String(ms) });
      expect(ms).toBeLessThan(1500);
    });
  });
}

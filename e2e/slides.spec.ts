import { test, expect, type Page } from "@playwright/test";
import { SLIDE_GOLDEN } from "../src/__tests__/fixtures/slideNotes";

/**
 * Plan W2.17 — slides from a note. Acceptance:
 *  - the golden notes become the right slides (unit test: slidesDeck.test.ts;
 *    here the first golden end to end through the real renderer);
 *  - a slide change takes < 50 ms (measured by the presentation itself);
 *  - the PDF is right in Hebrew: one page per slide, right-to-left, the
 *    text as text (a print-media screenshot against its baseline, made once
 *    with --update-snapshots and checked by eye).
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

async function typeNote(page: Page, md: string) {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText(md);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("a Hebrew note presents as RTL slides; ← moves forward; every change under 50 ms; notes stay off the slide", async ({ page }) => {
  const g = SLIDE_GOLDEN.find((x) => x.id === "he-notes")!;
  await typeNote(page, `${SLIDE_GOLDEN[0].md}\n\n---\n\n${g.md}`);
  await page.keyboard.press("ControlOrMeta+Home");
  await run(page, "view.present");
  const slides = page.getByTestId("slides");
  await expect(slides).toBeVisible();
  await expect(slides).toHaveAttribute("dir", "rtl");
  await expect(slides).toHaveAttribute("data-count", "5");
  await expect(page.getByTestId("slide").and(page.locator(":not([hidden])"))).toContainText("תוכנית הרבעון");
  const times: number[] = [];
  for (let i = 1; i < 5; i++) {
    await page.keyboard.press("ArrowLeft");
    await expect(slides).toHaveAttribute("data-index", String(i));
    times.push(Number(await slides.getAttribute("data-switch-ms")));
  }
  console.log(`slide changes (ms): ${times.join(", ")}`);
  expect(Math.max(...times)).toBeLessThan(50);
  await expect(page.getByTestId("slide").nth(3)).not.toContainText("לדבר לאט");
  await page.keyboard.press("ArrowRight");
  await expect(slides).toHaveAttribute("data-index", "3");
  await page.keyboard.press("Escape");
  await expect(slides).toBeHidden();
});

test("PDF: one landscape page per slide, Hebrew right to left", async ({ page }) => {
  await typeNote(page, SLIDE_GOLDEN[0].md);
  await run(page, "view.present");
  await expect(page.getByTestId("slides")).toBeVisible();
  await page.evaluate(() => document.documentElement.classList.add("lumen-printing-slides"));
  await page.emulateMedia({ media: "print" });
  const pages = await page.locator(".lumen-slide").evaluateAll((els) => els.map((e) => ({ display: getComputedStyle(e).display, dir: e.getAttribute("dir"), align: getComputedStyle(e).direction })));
  expect(pages).toEqual([
    { display: "flex", dir: "rtl", align: "rtl" },
    { display: "flex", dir: "rtl", align: "rtl" },
    { display: "flex", dir: "rtl", align: "rtl" },
  ]);
  await expect(page).toHaveScreenshot("slides-print-he.png", { fullPage: true, maxDiffPixelRatio: 0.005 });
  const pdf = await page.pdf({ preferCSSPageSize: true });
  const pageCount = (pdf.toString("latin1").match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  expect(pageCount).toBe(3);
});

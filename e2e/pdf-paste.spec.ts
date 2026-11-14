import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan W5.5 in the real app: pasting Hebrew copied from a PDF (visual
 * order) offers "Looks reversed — fix?" with a preview; "Fix" puts it in
 * reading order as one change that a single undo reverts; correct Hebrew
 * gets no offer. Lines come from the committed corpus (printed to PDF by
 * Chromium, read back with pdf.js: scripts/gen-pdf-paste-corpus.mjs).
 */

const CORPUS = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__tests__", "fixtures", "pdf-paste", "corpus.json"), "utf8")).items as Array<{ id: string; logical: string; visual: string }>;
const SAMPLE = CORPUS.find((c) => c.id === "pdf-039")!; // Latin with a bracketed year, a number and a full stop

type View = { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void };

function edit(page: Page, insert: string, userEvent: "input" | "input.paste"): Promise<void> {
  return page.evaluate(
    ({ insert, userEvent }) => {
      const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
      const view = el?.cmTile?.root?.view;
      view?.dispatch({ changes: { from: view.state.doc.length, insert }, userEvent });
    },
    { insert, userEvent },
  );
}

const text = (page: Page) => page.evaluate(() => (document.querySelector(".cm-content") as HTMLElement & { cmTile?: { root?: { view?: View } } }).cmTile?.root?.view?.state.doc.toString() ?? "");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await page.keyboard.press("Meta+1");
  await page.locator(".cm-content").first().click();
  await page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "" } });
  });
});

test("a reversed paste is offered the fix, and one undo brings the original back", async ({ page }) => {
  await edit(page, SAMPLE.visual, "input.paste");
  const offer = page.getByRole("status").filter({ hasText: /Looks reversed/i });
  await expect(offer).toBeVisible();
  await expect(offer).toContainText(SAMPLE.logical.slice(0, 30));
  await offer.getByRole("button", { name: /^Fix$/ }).click();
  await expect.poll(() => text(page)).toBe(SAMPLE.logical);
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => text(page)).toBe(SAMPLE.visual);
});

test("correct Hebrew gets no offer", async ({ page }) => {
  await edit(page, SAMPLE.logical, "input.paste");
  // The paste has been handled (and judged) once its text is in the note.
  await expect.poll(() => text(page)).toBe(SAMPLE.logical);
  await expect(page.getByRole("status").filter({ hasText: /Looks reversed/i })).toHaveCount(0);
  expect(await text(page)).toBe(SAMPLE.logical);
});

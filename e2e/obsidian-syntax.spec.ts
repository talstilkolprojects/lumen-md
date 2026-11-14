import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W1.3 — Obsidian callouts and highlights in Hebrew (RTL), in the
 * source editor, the preview and WYSIWYG; the file is never rewritten by
 * opening it, and an edit in WYSIWYG keeps the callout and highlight syntax.
 */

const NOTE = [
  "> [!warning] שימו לב",
  "> הטקסט הזה בעברית עם ==🔴 הדגשה אדומה== באמצע.",
  "",
  "פסקה עם ==הדגשה== ו-%%הערה פרטית%% בסוף.",
  "",
].join("\n");

type View = { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void; focus(): void };

async function load(page: Page, text: string): Promise<void> {
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.evaluate((t) => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, userEvent: "input" });
  }, text);
  await expect.poll(() => source(page)).toBe(text);
}

function source(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    return el?.cmTile?.root?.view?.state.doc.toString() ?? "";
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 20_000 });
});

test("source editor marks the callout head, the highlights and the comment", async ({ page }) => {
  await load(page, NOTE);
  const cm = page.locator(".cm-content").first();
  await expect(cm.locator(".cm-obs-callout")).toHaveCount(1);
  await expect(cm.locator(".cm-obs-highlight")).toHaveCount(2);
  await expect(cm.locator(".cm-obs-highlight.hl-red")).toHaveCount(1);
  await expect(cm.locator(".cm-obs-comment")).toHaveCount(1);
  // The Hebrew callout body reads right to left.
  expect(await cm.locator(".cm-line").nth(1).evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
});

test("preview draws an RTL callout and coloured highlights, and hides the comment", async ({ page }) => {
  await load(page, NOTE);
  await page.keyboard.press("Meta+3");
  const pv = page.locator("[data-preview-root]").first();
  const callout = pv.locator(".callout.callout-warning");
  await expect(callout).toHaveCount(1, { timeout: 10_000 });
  await expect(callout).toHaveAttribute("dir", "rtl");
  await expect(callout.locator(".callout-title")).toHaveText("שימו לב");
  await expect(pv.locator("mark.obsidian-highlight")).toHaveCount(2);
  await expect(pv.locator("mark.hl-red")).toHaveText(" הדגשה אדומה");
  await expect(pv).not.toContainText("הערה פרטית");
  // The callout's start edge is on the right in RTL.
  const box = await callout.boundingBox();
  const border = await callout.evaluate((el) => getComputedStyle(el).borderRightWidth);
  expect(box).not.toBeNull();
  expect(border).toBe("4px");
});

test("WYSIWYG shows the callout and highlights and keeps their syntax after an edit", async ({ page }) => {
  await load(page, NOTE);
  await page.keyboard.press("Meta+4");
  const pm = page.locator(".ProseMirror").first();
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await expect(pm.locator("blockquote.callout.callout-warning")).toHaveCount(1, { timeout: 10_000 });
  await expect(pm.locator("mark.obsidian-highlight")).toHaveCount(2);
  await expect(pm.locator("mark.hl-red")).toHaveCount(1);
  await expect(pm.locator(".obs-comment")).toHaveCount(1);
  // Type at the end of the last paragraph, then go back to the source.
  await pm.locator("p").last().click();
  await page.keyboard.press("End");
  await page.keyboard.type(" עוד");
  // The edit is in the editor before the mode switch (which saves the pending WYSIWYG edits).
  await expect(pm.locator("p").last()).toContainText("עוד");
  await page.keyboard.press("Meta+1");
  await expect
    .poll(() => source(page))
    .toBe(NOTE.replace("בסוף.\n", "בסוף. עוד\n"));
});

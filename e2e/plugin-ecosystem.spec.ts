import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W4.32: each of the ten registry plugins goes install → use → remove
 * in the real app: the gallery's permission screen, the plugin running in
 * its QuickJS worker with the granted capabilities, its command changing
 * the note, its panel or its rendered block, and "Remove" taking its
 * commands (and what it stored) away again.
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
const editor = (page: Page) => page.locator(".cm-content").first();
const editorText = (page: Page) => editor(page).evaluate((el) => [...el.querySelectorAll(".cm-line")].map((l) => l.textContent ?? "").join("\n"));

async function setNote(page: Page, text: string, selectAll = false) {
  await editor(page).click();
  await editor(page).fill(text);
  if (selectAll) await page.keyboard.press("ControlOrMeta+a");
}

async function openGallery(page: Page) {
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Plugin Gallery");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Plugin Gallery/i, { timeout: 8000 });
  await page.keyboard.press("Enter");
  const gallery = page.locator('[role="dialog"][aria-labelledby="plugin-gallery-title"]');
  await expect(gallery.getByTestId("sandboxed-plugin-card").first()).toBeVisible({ timeout: 15_000 });
  return gallery;
}

async function install(page: Page, id: string) {
  const gallery = await openGallery(page);
  const card = gallery.locator(`[data-testid="sandboxed-plugin-card"][data-plugin="${id}"]`);
  await card.getByRole("button", { name: /Install/ }).click();
  await page.getByTestId("plugin-install-dialog").getByRole("button", { name: "Install and allow" }).click();
  await expect(card.getByTestId("plugin-installed")).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(gallery).toBeHidden();
}

async function remove(page: Page, id: string, command: string) {
  const gallery = await openGallery(page);
  const card = gallery.locator(`[data-testid="sandboxed-plugin-card"][data-plugin="${id}"]`);
  await card.getByRole("button", { name: "Remove" }).click();
  await expect(card.getByRole("button", { name: /Install/ })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  // Its command is gone: running it changes nothing.
  const before = await editorText(page);
  await run(page, `plugin:${id}:${command}`);
  await expect.poll(() => editorText(page)).toBe(before);
}

const panel = (page: Page, id: string) => page.locator(`[data-plugin-panel="${id}"]`);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(editor(page)).toBeVisible({ timeout: 15_000 });
});

test("sort-lines: install → sort the selection (Hebrew letters) → remove", async ({ page }) => {
  await install(page, "lumen.sort-lines");
  await setNote(page, "תפוח\nאגס\nענב", true);
  await run(page, "plugin:lumen.sort-lines:sort-asc");
  await expect.poll(() => editorText(page)).toBe("אגס\nענב\nתפוח");
  await remove(page, "lumen.sort-lines", "reverse");
});

test("linter: install → tidy the note → remove", async ({ page }) => {
  await install(page, "lumen.linter");
  await setNote(page, "#Title\ntext   ");
  await run(page, "plugin:lumen.linter:lint");
  await expect.poll(() => editorText(page)).toBe("# Title\n\ntext\n");
  await remove(page, "lumen.linter", "lint");
});

test("table-format: install → line up a table → remove", async ({ page }) => {
  await install(page, "lumen.table-format");
  await setNote(page, "|שם|n|\n|-|-:|\n|אבג|1|");
  await run(page, "plugin:lumen.table-format:format");
  await expect.poll(() => editorText(page)).toBe("| שם  |   n |\n| --- | --: |\n| אבג |   1 |");
  await remove(page, "lumen.table-format", "format");
});

test("natural-dates: install → 'מחר' becomes a date link → remove", async ({ page }) => {
  await install(page, "lumen.natural-dates");
  await setNote(page, "מחר", true);
  await run(page, "plugin:lumen.natural-dates:convert");
  await expect.poll(() => editorText(page)).toMatch(/^\[\[\d{4}-\d{2}-\d{2}\]\]$/);
  await remove(page, "lumen.natural-dates", "today");
});

test("kanban: install → a ```kanban block draws as columns → remove", async ({ page }) => {
  await install(page, "lumen.kanban");
  await setNote(page, "```kanban\n## לעשות\n- סיכום\n## בוצע\n- [x] תרגיל\n```\n");
  const block = page.locator('[data-plugin-block="kanban"][data-plugin-id="lumen.kanban"]');
  await expect(block).toContainText("לעשות (1)", { timeout: 15_000 });
  await expect(block).toContainText("בוצע (1)");
  await remove(page, "lumen.kanban", "new");
});

test("flashcards: install → review a card → remove", async ({ page }) => {
  await install(page, "lumen.flashcards");
  await setNote(page, "dog :: כלב\n");
  await run(page, "plugin:lumen.flashcards:review");
  await expect(panel(page, "lumen.flashcards")).toContainText("dog", { timeout: 10_000 });
  await panel(page, "lumen.flashcards").getByRole("button", { name: /Show answer/ }).click();
  await expect(panel(page, "lumen.flashcards")).toContainText("כלב");
  await panel(page, "lumen.flashcards").getByRole("button", { name: /Good/ }).click();
  await expect(panel(page, "lumen.flashcards")).toContainText("Done: 1 reviewed");
  await remove(page, "lumen.flashcards", "review");
  await expect(panel(page, "lumen.flashcards")).toHaveCount(0);
});

test("calendar: install → the month panel → remove", async ({ page }) => {
  await install(page, "lumen.calendar");
  await run(page, "plugin:lumen.calendar:show");
  await expect(panel(page, "lumen.calendar")).toContainText(/\d{4} · /, { timeout: 10_000 });
  await remove(page, "lumen.calendar", "show");
});

test("tags: install → the vault's tags panel → remove", async ({ page }) => {
  await install(page, "lumen.tags");
  await run(page, "plugin:lumen.tags:show");
  await expect(panel(page, "lumen.tags")).toContainText(/tags · /, { timeout: 15_000 });
  await remove(page, "lumen.tags", "show");
});

test("templates: install → the template chooser (empty vault: the hint) → remove", async ({ page }) => {
  await install(page, "lumen.templates");
  await run(page, "plugin:lumen.templates:insert");
  await expect(panel(page, "lumen.templates")).toContainText("No templates in", { timeout: 10_000 });
  await remove(page, "lumen.templates", "insert");
});

test("note-refactor: install → asks for a selection → remove", async ({ page }) => {
  await install(page, "lumen.note-refactor");
  await setNote(page, "abc");
  await run(page, "plugin:lumen.note-refactor:extract");
  await expect(page.getByText(/Select the text to move first/)).toBeVisible({ timeout: 10_000 });
  await remove(page, "lumen.note-refactor", "split");
});

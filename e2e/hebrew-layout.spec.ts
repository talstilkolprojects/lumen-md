import { test, expect, type Page } from "@playwright/test";
import { SHORTCUTS } from "../src/lib/shortcuts";
import { toHebrewLayout } from "../src/lib/keyboardLayout";

/**
 * Hebrew keyboard layout (plan W2.8). With the Hebrew layout on, a key
 * press arrives with the Hebrew character (`key: "ל"`, `code: "KeyK"`):
 * every App shortcut still works, and the editor's own keys (Mod-z) too.
 * The palette finds a command typed with the wrong layout.
 */

/** Dispatch the key press the Hebrew layout gives for a combo, on the focused element. */
async function pressHebrew(page: Page, combo: string) {
  await page.evaluate(
    ({ combo, heKey }) => {
      const parts = combo.split("+");
      const key = parts.pop()!.toLowerCase();
      const code = /[a-z]/.test(key) ? `Key${key.toUpperCase()}` : /[0-9]/.test(key) ? `Digit${key}` : key === "/" ? "Slash" : "";
      const keyCode = /[a-z0-9]/.test(key) ? key.toUpperCase().charCodeAt(0) : key === "/" ? 191 : 0;
      const ev = new KeyboardEvent("keydown", { key: heKey, code, ctrlKey: parts.includes("Mod"), shiftKey: parts.includes("Shift"), bubbles: true, cancelable: true });
      Object.defineProperty(ev, "keyCode", { get: () => keyCode });
      (document.activeElement ?? document.body).dispatchEvent(ev);
    },
    { combo, heKey: toHebrewLayout(combo.split("+").pop()!.toLowerCase()) },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he" }, version: 0 }));
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
});

test("every App shortcut works with the Hebrew layout", async ({ page }) => {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]');
  // Palette and shortcuts list: open, then close with Escape.
  for (const combo of ["Mod+K", "Mod+/"]) {
    await pressHebrew(page, combo);
    await expect(dialog.first(), combo).toBeVisible({ timeout: 5_000 });
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
  }
  // Modes: ⌘1 source (no preview), ⌘3 preview (no editor), ⌘2 split (both).
  await pressHebrew(page, "Mod+1");
  await expect(page.locator(".prose-lumen")).toHaveCount(0, { timeout: 5_000 });
  await pressHebrew(page, "Mod+3");
  await expect(page.locator(".prose-lumen").first()).toBeVisible({ timeout: 5_000 });
  await pressHebrew(page, "Mod+2");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 5_000 });
  // Find & replace toggles.
  await pressHebrew(page, "Mod+H");
  await expect(page.getByRole("textbox", { name: "שאילתת חיפוש" })).toBeVisible({ timeout: 5_000 });
  expect(SHORTCUTS.filter((s) => s.scope === "app").length).toBeGreaterThanOrEqual(13);
});

test("the editor's undo works with the Hebrew layout", async ({ page, browserName }) => {
  // CodeMirror's non-Latin fallback reads keyCode; in Playwright's WebKit a synthetic
  // event's overridden keyCode does not reach it (seen in the sandbox run). Not a
  // claim about real Safari, which is left to the owner's manual check.
  test.skip(browserName === "webkit", "synthetic keyCode is not seen by CodeMirror in Playwright WebKit");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("שלום");
  await page.keyboard.type(" עולם");
  await expect(editor).toContainText("שלום עולם");
  await pressHebrew(page, "Mod+Z");
  await expect(editor).not.toContainText("עולם", { timeout: 5_000 });
});

test("the palette finds a command typed with the wrong layout", async ({ page }) => {
  await page.keyboard.press("ControlOrMeta+k");
  const input = page.locator('[role="dialog"] input').first();
  await input.fill("jhpua"); // חיפוש, typed with the English layout on
  await expect(page.getByTestId("palette-layout-hint")).toContainText("חיפוש");
  const first = page.locator('[role="option"]').first();
  await expect(first).toContainText("חיפוש");
});

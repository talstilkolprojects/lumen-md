import { test, expect } from "@playwright/test";

/**
 * Plan W2.7 — meeting speakers. Renaming a speaker once changes every line
 * of the transcript (W2.7.3), through the palette and the app's own
 * dialogs; and the meeting-recording command is in the palette. (Who spoke
 * when needs the pinned diarization models and the DER on the golden
 * recordings is scored by scripts/meetings/der.mjs, not here.)
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("rename a speaker once: every label of the transcript changes, the other speaker's stay", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("**S1:** שלום לכולם.\n**S2:** נתחיל בתקציב.\n**S1:** מסכים.\n**S1:** תודה.");
  await expect(editor).toContainText("נתחיל בתקציב.");

  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("Rename a speaker");
  await page.keyboard.press("Enter");

  const pick = page.getByRole("combobox", { name: "Which speaker do you want to rename?" });
  await expect(pick).toBeVisible();
  await pick.selectOption("S1");
  await pick.press("Enter");

  const name = page.getByRole("textbox", { name: "New name for S1" });
  await expect(name).toBeVisible();
  await name.fill("Dana");
  await name.press("Enter");

  await expect(editor).not.toContainText("S1");
  await expect.poll(async () => ((await editor.textContent()) ?? "").split("Dana").length - 1).toBe(3);
  await expect(editor).toContainText("S2");
});

test("the meeting recording command is in the palette", async ({ page }) => {
  await page.keyboard.press("Meta+K");
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.type("Transcribe a meeting recording");
  await expect(page.getByRole("option", { name: /Transcribe a meeting recording/ })).toBeVisible();
});

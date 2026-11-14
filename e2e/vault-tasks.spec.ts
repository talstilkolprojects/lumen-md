import { test, expect } from "@playwright/test";

/**
 * Plan 4.13 — a ```tasks``` block lists tasks from other notes in the vault,
 * and ticking one updates the note it lives in.
 */
test("a tasks block gathers tasks from the vault and ticking one writes it back", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const ok = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("Projects", { create: true });
      const fh = await dir.getFileHandle("Home.md", { create: true });
      const w = await (fh as unknown as { createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write("# Bills\n- [ ] pay rent ⏫ 📅 2026-01-02\n- [x] paid gas ✅ 2026-01-01\n- [ ] לשלם ארנונה 📅 2026-01-03\n");
      await w.close();
      return true;
    } catch {
      return false;
    }
  });
  test.skip(!ok, "OPFS writes are unavailable in this engine's test context");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-workspace-changed")));

  await page.keyboard.press("ControlOrMeta+2");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill("# Dashboard\n\n```tasks\nnot done\nsort by due\n```\n");
  const block = page.getByTestId("tasks-block");
  await expect(block).toBeVisible({ timeout: 20_000 });
  const rows = block.getByTestId("task-row");
  await expect(rows).toHaveCount(2, { timeout: 20_000 });
  await expect(rows.nth(0)).toContainText("pay rent");
  await expect(rows.nth(1)).toContainText("לשלם ארנונה");

  await rows.nth(0).getByRole("checkbox").click();
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const root = await navigator.storage.getDirectory();
          const f = await (await (await root.getDirectoryHandle("Projects")).getFileHandle("Home.md")).getFile();
          return f.text();
        }),
      { timeout: 10_000 },
    )
    .toMatch(/- \[x\] pay rent ⏫ 📅 2026-01-02 ✅ \d{4}-\d{2}-\d{2}\n/);
  await expect(rows).toHaveCount(1, { timeout: 10_000 });
});

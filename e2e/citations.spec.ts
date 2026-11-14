import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";

/**
 * Plan W2.16 — citations: from the shortcut to a citation in < 3
 * keystrokes, and the preview formats [@key] with a reference list (the
 * Israeli APA puts Hebrew sources first). The library is a .bib in the vault.
 */

const BIB = "@book{austen1813,\n  author = {Austen, Jane},\n  title = {Pride and Prejudice},\n  year = {1813},\n  publisher = {T. Egerton}\n}\n\n@book{darshan2022,\n  author = {דרשן, דוד},\n  title = {ילד אמיץ, ילד רגיש},\n  year = {2022},\n  publisher = {פסיכולוגיה לעם הוצאה לאור}\n}\n";

async function putFile(page: Page, name: string, text: string): Promise<boolean> {
  return page.evaluate(
    async ({ name, text }) => {
      try {
        const fh = await (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable !== "function") return false;
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
        window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { kind: "structure" } }));
        return true;
      } catch {
        return false;
      }
    },
    { name, text },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.setItem("lumen.cite.recent", JSON.stringify(["austen1813"]));
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("shortcut + Enter inserts [@key]; the preview formats it with the references", async ({ page, browserName }) => {
  vaultOrSkip(await putFile(page, "refs.bib", BIB), browserName);
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("---\ncitation-style: il\n---\nכפי שנכתב [@darshan2022, עמ׳ 4] וגם ");
  // The whole citation: the shortcut, then one key.
  await page.keyboard.press("ControlOrMeta+Alt+KeyC");
  await expect(page.getByTestId("cite-dialog")).toBeVisible();
  await expect(page.getByTestId("cite-item").first()).toHaveAttribute("data-key", "austen1813");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("cite-dialog")).toBeHidden();
  await expect(editor).toContainText("וגם [@austen1813]");

  await page.keyboard.press("ControlOrMeta+3");
  const preview = page.locator(".markdown-body, .preview, [data-testid='preview']").first();
  await expect(preview).toContainText("(דרשן, 2022, עמ׳ 4)", { timeout: 10_000 });
  await expect(preview).toContainText("(Austen, 1813)");
  await expect(preview).toContainText("מקורות בעברית");
  await expect(preview).toContainText("דרשן, ד׳ (2022). ילד אמיץ, ילד רגיש.");
  await expect(preview).toContainText("Austen, J. (1813). Pride and prejudice.");
});

import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 4.12 — daily notes: ⌥⌘D (Ctrl+Alt+D) creates and opens
 * journal/<today>.md from the template; pressing it again opens the same
 * note — no second file, no second tab. The calendar marks the day.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

/**
 * Can this engine write OPFS files at all here? Playwright's WebKit runs in
 * an ephemeral context, where WebKit may refuse OPFS writes; the vault can't
 * work there, so the vault tests skip (and say why) instead of failing.
 */
async function opfsWritable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
      if (typeof h.createWritable === "function") {
        const w = await h.createWritable();
        await w.write("x");
        await w.close();
      } else {
        const src =
          "self.onmessage=async()=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('__probe',{create:true});const a=await f.createSyncAccessHandle();a.write(new Uint8Array([120]),{at:0});a.flush();a.close();postMessage(true)}catch(e){postMessage(false)}}";
        const ok = await new Promise<boolean>((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
          w.onmessage = (e) => res(e.data === true);
          w.onerror = () => res(false);
          w.postMessage(0);
          setTimeout(() => res(false), 5000);
        });
        if (!ok) return false;
      }
      await root.removeEntry("__probe");
      return true;
    } catch {
      return false;
    }
  });
}

const todayIso = (page: Page) =>
  page.evaluate(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  });

/**
 * The file names in the vault's journal/ folder (empty when there is none).
 * Chromium writes through a temporary `<name>.crswap` sibling while a
 * createWritable() stream is open; that is the engine's, not a second note.
 */
const journalFiles = (page: Page) =>
  page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("journal");
      const names: string[] = [];
      for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) {
        if (!name.endsWith(".crswap")) names.push(name);
      }
      return names.sort();
    } catch {
      return [] as string[];
    }
  });

test("today's note is created, opened, and not duplicated when opened again", async ({ page }) => {
  test.skip(!(await opfsWritable(page)), "this engine refuses OPFS writes here, so there is no vault to keep daily notes in");
  const today = await todayIso(page);
  expect(await journalFiles(page)).toEqual([]);

  await page.keyboard.press("ControlOrMeta+Alt+KeyD");
  const editor = page.locator(".cm-content").first();
  await expect.poll(() => journalFiles(page), { timeout: 10_000 }).toEqual([`${today}.md`]);
  // The default template: "# {{title}}" then "{{weekday}} · {{hebrewDate}}".
  await expect(editor).toContainText(/\d{4}/, { timeout: 10_000 });
  await expect(editor).toContainText("·");
  await expect(editor).not.toContainText("Welcome to");
  await expect(editor).not.toContainText("{{");
  const tabs = page.locator(`.doc-tabs [data-tab-index]`).filter({ hasText: `${today}.md` });
  await expect(tabs).toHaveCount(1);

  // Type something, then open today's note again: same note, edits kept.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("first entry");
  await page.keyboard.press("ControlOrMeta+Alt+KeyD");
  await expect(editor).toContainText("first entry");
  await expect.poll(() => journalFiles(page), { timeout: 5_000 }).toEqual([`${today}.md`]);
  await expect(tabs).toHaveCount(1);

  // The calendar (from the command palette) marks the day; a click opens the same note.
  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.locator('[role="dialog"]').filter({ has: page.locator("input") });
  await expect(palette).toBeVisible();
  await palette.locator("input").first().fill("calendar");
  await page.keyboard.press("Enter");
  const cal = page.getByTestId("calendar");
  await expect(cal).toBeVisible({ timeout: 5000 });
  await expect(cal.locator(`[data-date="${today}"]`)).toHaveAttribute("data-has-note", "true", { timeout: 5000 });
  await expect(cal.locator(`[data-date="${today}"]`)).toHaveAttribute("aria-current", "date");
  await cal.locator(`[data-date="${today}"]`).click();
  await expect(editor).toContainText("first entry");
  await expect(tabs).toHaveCount(1);
  await expect.poll(() => journalFiles(page), { timeout: 5_000 }).toEqual([`${today}.md`]);
});

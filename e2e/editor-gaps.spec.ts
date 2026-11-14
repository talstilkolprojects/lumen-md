import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";

/**
 * Editor gaps against Obsidian 1.12 and Heptabase (plan W7.3), each in an
 * RTL (Hebrew UI) and an LTR (English UI) run, on chromium and firefox:
 *  1. a double-click on an image's resize edge takes the size off;
 *  2. deleting a note offers the attachments only it links to, and one Undo
 *     brings both back; an attachment another note links to is never offered;
 *  3. a copy puts text/plain Markdown and text/html with dir on the clipboard;
 *  4. the backlinks list searches, sorts and folds.
 */

/** A 40×20 PNG, so the preview has a real image to measure. */
const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAIAAABwJOjsAAAAJElEQVR4nO3NMQ0AAAwEofdvupVxCwk7uy3RrGKxWCwWi8WJB336HQ594lo5AAAAAElFTkSuQmCC";

async function seed(page: Page, files: Record<string, string>, binary: Record<string, string> = {}): Promise<boolean> {
  return page.evaluate(async ({ files, binary }) => {
    try {
      const root = await navigator.storage.getDirectory();
      const put = async (path: string, data: string | Uint8Array) => {
        const parts = path.split("/");
        let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const fh = (await dir.getFileHandle(parts[parts.length - 1], { create: true })) as unknown as {
          createWritable?: () => Promise<{ write(d: string | Uint8Array): Promise<void>; close(): Promise<void> }>;
        };
        if (typeof fh.createWritable !== "function") throw new Error("no createWritable");
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
      };
      for (const [p, d] of Object.entries(files)) await put(p, d);
      for (const [p, b64] of Object.entries(binary)) await put(p, Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      return true;
    } catch {
      return false;
    }
  }, { files, binary });
}

async function exists(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (path) => {
    let dir = await navigator.storage.getDirectory();
    const parts = path.split("/");
    try {
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p);
      await dir.getFileHandle(parts[parts.length - 1]);
      return true;
    } catch {
      return false;
    }
  }, path);
}

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

async function openNote(page: Page, name: string, text: string) {
  const tree = page.locator("aside.file-tree");
  if (!(await tree.isVisible())) await run(page, "view.workspace");
  await tree.locator(".file-tree-name", { hasText: name }).first().click();
  await expect(page.locator(".cm-content").first()).toContainText(text, { timeout: 10_000 });
}

for (const locale of ["he", "en"] as const) {
  test.describe(`${locale === "he" ? "RTL" : "LTR"} (${locale})`, () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript((locale) => {
        localStorage.setItem("lumen-tour-done", "1");
        localStorage.removeItem("lumen.attachmentCleanup");
        localStorage.setItem("lumen-md", JSON.stringify({ state: { locale, mode: "split", showWorkspace: true }, version: 0 }));
      }, locale);
      await page.goto("/");
      await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
    });

    test("1. double-click on the image edge resets its size", async ({ page, browserName }) => {
      vaultOrSkip(await seed(page, { "img.md": "שלום\n\n![[pic.png|120]]\n" }, { "pic.png": PNG_B64 }), browserName);
      await openNote(page, "img.md", "pic.png|120");
      const img = page.locator("[data-preview-root] img[data-md-offset]").first();
      await expect(img).toBeVisible({ timeout: 10_000 });
      const box = (await img.boundingBox())!;
      const rtl = await img.evaluate((el) => getComputedStyle(el).direction === "rtl");
      // The inline-end edge: the left one in RTL, the right one in LTR.
      await page.mouse.dblclick(rtl ? box.x + 2 : box.x + box.width - 2, box.y + box.height / 2);
      await expect(page.locator(".cm-content").first()).toContainText("![[pic.png]]", { timeout: 5_000 });
      await expect(page.locator(".cm-content").first()).not.toContainText("pic.png|120");
    });

    test("2. deleting a note offers only its own attachments, and Undo restores both", async ({ page, browserName }) => {
      vaultOrSkip(
        await seed(
          page,
          { "מחיקה.md": "![[only.png]] ![[shared.png]]\n", "other.md": "![[shared.png]]\n" },
          { "only.png": PNG_B64, "shared.png": PNG_B64 },
        ),
        browserName,
      );
      const tree = page.locator("aside.file-tree");
      if (!(await tree.isVisible())) await run(page, "view.workspace");
      const row = tree.locator(".file-tree-item", { has: page.locator(".file-tree-name", { hasText: "מחיקה.md" }) });
      await expect(row).toBeVisible({ timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: /delete|מחיקה|מחק/i }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("only.png", { timeout: 10_000 });
      await expect(dialog).not.toContainText("shared.png");
      await dialog.locator("select").selectOption("trash");
      await dialog.getByRole("button").filter({ hasText: /^(OK|אישור)$/ }).click();
      await expect.poll(() => exists(page, "only.png"), { timeout: 10_000 }).toBe(false);
      expect(await exists(page, "מחיקה.md")).toBe(false);
      expect(await exists(page, "shared.png")).toBe(true);
      // One Undo brings back the note and its attachment.
      await page.locator("body").click({ position: { x: 1, y: 1 } });
      await page.keyboard.press("ControlOrMeta+z");
      await expect.poll(async () => (await exists(page, "only.png")) && (await exists(page, "מחיקה.md")), { timeout: 10_000 }).toBe(true);
    });

    test("3. a copy carries Markdown and HTML with the direction", async ({ page }) => {
      const editor = page.locator(".cm-content").first();
      await editor.click();
      await editor.fill("# כותרת\n\n**מודגש** ו-*נטוי*\n\nEnglish **bold** line");
      await editor.press("ControlOrMeta+a");
      const data = await page.evaluate(() => {
        const dt = new DataTransfer();
        const el = document.querySelector(".cm-content") as HTMLElement;
        el.dispatchEvent(new ClipboardEvent("copy", { clipboardData: dt, bubbles: true, cancelable: true }));
        return { plain: dt.getData("text/plain"), html: dt.getData("text/html") };
      });
      expect(data.plain).toContain("**מודגש**");
      expect(data.html).toContain('<h1 dir="rtl">כותרת</h1>');
      expect(data.html).toContain("<strong>מודגש</strong>");
      expect(data.html).toContain('<p dir="ltr">English <strong>bold</strong> line</p>');
    });

    test("4. backlinks: search, sort by modified, fold", async ({ page, browserName }) => {
      vaultOrSkip(
        await seed(page, { "יעד.md": "# יעד\n", "Alpha.md": "one [[יעד]] and two [[יעד]]\n", "בית.md": "קישור [[יעד]] בבית\n" }),
        browserName,
      );
      await openNote(page, "יעד.md", "# יעד");
      if (!(await page.locator(".backlinks-panel").isVisible())) await run(page, "view.backlinks");
      const groups = page.locator(".backlinks-panel [data-testid=backlink-group]");
      await expect(groups).toHaveCount(2, { timeout: 10_000 });
      await page.getByTestId("backlinks-search").fill("בבית");
      await expect(groups).toHaveCount(1);
      await expect(groups.first()).toContainText("בית");
      await page.getByTestId("backlinks-search").fill("");
      await page.getByTestId("backlinks-sort").selectOption("modified");
      await expect(groups).toHaveCount(2);
      const header = groups.first().getByRole("button").first();
      await expect(header).toHaveAttribute("aria-expanded", "true");
      await header.click();
      await expect(header).toHaveAttribute("aria-expanded", "false");
    });
  });
}

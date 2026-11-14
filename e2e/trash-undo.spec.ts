import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 3.1: Ctrl+Z / ⌘Z outside the editor restores the last delete from the
 * file tree, newest first; inside the editor it stays the editor's undo.
 * Deleting a folder first writes the unsaved edits of every open tab inside
 * it, so the restore brings back the latest text, an inactive tab's included.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

/** Write files into the vault (OPFS) the way the app does: createWritable, or a worker's sync handle (WebKit). */
async function writeVault(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (entries) => {
    try {
      const root = await navigator.storage.getDirectory();
      for (const [path, text] of entries) {
        const parts = path.split("/");
        let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable === "function") {
          const w = await h.createWritable();
          await w.write(text);
          await w.close();
          continue;
        }
        const src =
          "self.onmessage=async(e)=>{try{const ps=e.data.path.split('/');let d=await navigator.storage.getDirectory();for(const p of ps.slice(0,-1))d=await d.getDirectoryHandle(p,{create:true});const f=await d.getFileHandle(ps[ps.length-1],{create:true});const a=await f.createSyncAccessHandle();const b=new TextEncoder().encode(e.data.text);a.truncate(0);a.write(b,{at:0});a.flush();a.close();postMessage(true)}catch(err){postMessage(false)}}";
        const ok = await new Promise<boolean>((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
          w.onmessage = (e) => res(e.data === true);
          w.onerror = () => res(false);
          w.postMessage({ path, text });
          setTimeout(() => res(false), 5000);
        });
        if (!ok) return false;
      }
      return true;
    } catch {
      return false;
    }
  }, Object.entries(files));
}

async function readVault(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    try {
      const parts = p.split("/");
      let dir = await navigator.storage.getDirectory();
      for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d);
      return await (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
    } catch {
      return null;
    }
  }, path);
}

test("Ctrl+Z outside the editor restores deletes newest first, with every open tab's latest edits", async ({ page }) => {
  const seeded = await writeVault(page, { "other.md": "Other note", "proj/a.md": "A saved", "proj/b.md": "B saved" });
  test.skip(!seeded, "OPFS writes are unavailable in this engine's test context");

  // proj/b.md is the open note; proj/a.md is an inactive tab holding an edit
  // the debounced autosave never wrote (the user switched tabs within 600 ms).
  // The app persists its tabs, so a reload resumes exactly that session.
  await page.evaluate(() => {
    const raw = localStorage.getItem("lumen-md");
    const persisted = raw ? (JSON.parse(raw) as { state: Record<string, unknown>; version?: number }) : { state: {}, version: 0 };
    persisted.state = {
      ...persisted.state,
      mode: "source",
      showWorkspace: true,
      doc: { name: "proj/b.md", content: "B saved", dirty: false, workspaceName: "proj/b.md" },
      openTabs: [
        { id: "proj/a.md", name: "proj/a.md", content: "A unsaved edit", workspaceName: "proj/a.md", dirty: true },
        { id: "proj/b.md", name: "proj/b.md", content: "B saved", workspaceName: "proj/b.md", dirty: false },
      ],
    };
    localStorage.setItem("lumen-md", JSON.stringify(persisted));
  });
  await page.reload();
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("B saved", { timeout: 15_000 });
  const tree = page.locator("aside.file-tree");
  const exact = (n: string) => new RegExp(`^${n.replace(".", "\\.")}$`);
  const name = (n: string) => tree.locator(".file-tree-name", { hasText: exact(n) });
  const row = (n: string) => tree.locator(".file-tree-item", { has: page.locator(".file-tree-name", { hasText: exact(n) }) });
  await expect(name("proj")).toBeVisible({ timeout: 10_000 });
  await expect(name("other.md")).toBeVisible();

  // Delete 1: other.md.
  await row("other.md").hover();
  await row("other.md").getByRole("button", { name: /delete/i }).click();
  await expect(name("other.md")).toHaveCount(0, { timeout: 10_000 });

  // Edit the open note, then delete 2: its folder, right away.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(" + typed");
  await expect(editor).toContainText("B saved + typed");
  await row("proj").hover();
  await row("proj").getByRole("button", { name: /delete/i }).click();
  await expect(name("proj")).toHaveCount(0, { timeout: 10_000 });

  // In the editor, Ctrl+Z is the editor's own undo and restores nothing.
  await editor.click();
  await page.keyboard.type("xyz");
  await expect(editor).toContainText("xyz");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(editor).not.toContainText("xyz");

  // Outside the editor (the tree's header): the newest delete comes back first.
  await tree.locator(".file-tree-header span").first().click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(name("proj")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("status").filter({ hasText: "Restored to proj" })).toBeVisible({ timeout: 5000 });
  expect(await readVault(page, "proj/a.md")).toBe("A unsaved edit");
  expect(await readVault(page, "proj/b.md")).toBe("B saved + typed");

  // The next Ctrl+Z restores the delete before it. (Had the editor's Ctrl+Z
  // popped an entry, the stack would be empty now and nothing would return.)
  await page.keyboard.press("ControlOrMeta+z");
  await expect(name("other.md")).toBeVisible({ timeout: 10_000 });
  expect(await readVault(page, "other.md")).toBe("Other note");

  // And the restored notes open with their latest text.
  await name("a.md").click();
  await expect(editor).toContainText("A unsaved edit", { timeout: 10_000 });
  await name("b.md").click();
  await expect(editor).toContainText("B saved + typed", { timeout: 10_000 });
});

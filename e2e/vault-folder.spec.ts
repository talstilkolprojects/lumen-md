import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 4.2 — the vault in a real folder (Chromium's showDirectoryPicker).
 * Playwright cannot click through the native picker, so the picker is
 * mocked with a real directory handle: the app's OPFS is rooted in one OPFS
 * subfolder and the "picked" folder is another — two real
 * FileSystemDirectoryHandles, the same API a folder on disk has.
 */
const PICKED = "picked-folder";

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "showDirectoryPicker is Chromium-only");
  await page.addInitScript((picked) => {
    localStorage.setItem("lumen-tour-done", "1");
    const storage = navigator.storage as StorageManager & { getDirectory: () => Promise<FileSystemDirectoryHandle> };
    const real = storage.getDirectory.bind(storage);
    const sub = async (name: string) => (await real()).getDirectoryHandle(name, { create: true });
    // The app's vault ("OPFS") lives in one subfolder, the picked folder in another.
    storage.getDirectory = () => sub("app-vault");
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = () => sub(picked);
  }, PICKED);
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** Every file under an OPFS subfolder, as path → bytes. */
function snapshot(page: Page, folder: string): Promise<Record<string, number[]>> {
  return page.evaluate(async (name) => {
    const realRoot = await (Object.getPrototypeOf(navigator.storage) as { getDirectory: () => Promise<FileSystemDirectoryHandle> }).getDirectory.call(navigator.storage);
    const out: Record<string, number[]> = {};
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [n, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const p = prefix ? `${prefix}/${n}` : n;
        if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, p);
        else out[p] = [...new Uint8Array(await (await (h as FileSystemFileHandle).getFile()).arrayBuffer())];
      }
    }
    await walk(await realRoot.getDirectoryHandle(name), "");
    return out;
  }, folder);
}

async function typeNote(page: Page, text: string) {
  await page.keyboard.press("Meta+1");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+a");
  await editor.fill(text);
}

/** Save the open note into the vault as a new file. */
async function saveNote(page: Page, text: string) {
  await typeNote(page, text);
  await run(page, "file.saveToWorkspace");
}

test("moving the vault into a folder copies it byte for byte, then saves land in the folder", async ({ page }) => {
  const note = "# שלום מהתיקייה\n\nnotes in a real folder";
  await saveNote(page, note);
  await expect(page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 10_000 });
  // An attachment with every byte value, in a nested folder. (ASCII names:
  // Playwright's Chromium crashes on non-ASCII OPFS names in its in-memory
  // incognito file system; Hebrew names are covered by the contract tests.)
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("projects", { create: true });
    const w = await (await dir.getFileHandle("lumen-asset-all.bin", { create: true })).createWritable();
    await w.write(new Uint8Array(Array.from({ length: 256 }, (_, i) => i)));
    await w.close();
  });

  await run(page, "vault.toFolder");
  await expect(page.getByText(/The vault is now in the folder “picked-folder”/)).toBeVisible({ timeout: 15_000 });

  const source = await snapshot(page, "app-vault");
  const folder = await snapshot(page, PICKED);
  expect(Object.keys(source).sort()).toEqual(expect.arrayContaining(["Welcome.md", "projects/lumen-asset-all.bin"]));
  expect(folder).toEqual(source);
  expect(Buffer.from(folder["Welcome.md"]).toString("utf8")).toBe(note);

  // Editing the open note now autosaves into the folder; browser storage keeps the old copy.
  const edited = "# שלום מהתיקייה\n\nedited after the move";
  await typeNote(page, edited);
  await expect.poll(async () => Buffer.from((await snapshot(page, PICKED))["Welcome.md"] ?? []).toString("utf8"), { timeout: 10_000 }).toBe(edited);
  expect(Buffer.from((await snapshot(page, "app-vault"))["Welcome.md"]).toString("utf8")).toBe(note);

  // After a reload the vault is still the folder.
  await page.reload();
  await expect(page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".vault-folder-banner")).toHaveCount(0);
  await page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" }).click();
  await expect(page.locator(".cm-content").first()).toContainText("edited after the move", { timeout: 10_000 });
  await typeNote(page, "# after reload");
  await expect.poll(async () => Buffer.from((await snapshot(page, PICKED))["Welcome.md"] ?? []).toString("utf8"), { timeout: 10_000 }).toBe("# after reload");
  expect(Buffer.from((await snapshot(page, "app-vault"))["Welcome.md"]).toString("utf8")).toBe(note);
});

test("a folder with different files at the same paths is not touched", async ({ page }) => {
  await saveNote(page, "# mine");
  await expect(page.locator("aside.file-tree .file-tree-name", { hasText: "Welcome.md" })).toBeVisible({ timeout: 10_000 });
  await page.evaluate(async (picked) => {
    const realRoot = await (Object.getPrototypeOf(navigator.storage) as { getDirectory: () => Promise<FileSystemDirectoryHandle> }).getDirectory.call(navigator.storage);
    const dir = await realRoot.getDirectoryHandle(picked, { create: true });
    const w = await (await dir.getFileHandle("Welcome.md", { create: true })).createWritable();
    await w.write("# theirs");
    await w.close();
  }, PICKED);
  await run(page, "vault.toFolder");
  await expect(page.getByText(/Not moved: 1 files in “picked-folder”/)).toBeVisible({ timeout: 15_000 });
  expect(Object.keys(await snapshot(page, PICKED))).toEqual(["Welcome.md"]);
  expect(Buffer.from((await snapshot(page, PICKED))["Welcome.md"]).toString("utf8")).toBe("# theirs");
});

test("without showDirectoryPicker the vault stays in browser storage, and says so", async ({ page }) => {
  await page.evaluate(() => {
    const w = window as unknown as { showDirectoryPicker?: unknown };
    delete w.showDirectoryPicker;
    w.showDirectoryPicker = undefined; // the native one too, as in Firefox / Safari
  });
  await run(page, "vault.toFolder");
  await expect(page.getByText(/can't open a folder on your computer, so your notes stay in the browser's private storage/)).toBeVisible({ timeout: 10_000 });
});

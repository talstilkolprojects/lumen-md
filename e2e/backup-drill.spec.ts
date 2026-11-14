import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W1.6, the restore drill in the browser: back up the vault from the
 * Backups panel, delete the vault, restore everything into a new folder,
 * compare SHA-256 file by file.
 *
 * Playwright can't drive the system folder picker, so `showDirectoryPicker`
 * is replaced: it hands out folders of the browser's private storage
 * (`.e2e-drive`, `.e2e-restored`). A real user can't pick those; here they
 * stand in for an external drive. The 1,000 notes + 200 attachments case
 * runs in src/__tests__/backup.test.ts.
 */
const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

test("back up, lose the vault, restore everything: every file identical", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "the File System Access API (and OPFS iteration) is Chromium's");
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    const picks = [".e2e-drive", ".e2e-restored"];
    (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
      const root = await navigator.storage.getDirectory();
      return root.getDirectoryHandle(picks.shift() ?? ".e2e-extra", { create: true });
    };
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });

  // A vault: notes in folders, Hebrew names, binary attachments.
  const before = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const write = async (path: string, data: string | Uint8Array) => {
      const parts = path.split("/");
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(data);
      await w.close();
    };
    for (let i = 0; i < 30; i++) await write(`drill/${i % 3}/${i % 2 ? "פתק" : "note"}-${i}.md`, `# ${i}\nשלום ${i}\n`);
    for (let i = 0; i < 5; i++) await write(`drill/img/${i}.png`, new Uint8Array(3000).map((_, k) => (k * 7 + i) & 255));
    return true;
  });
  expect(before).toBe(true);

  const hashes = (folder: string) =>
    page.evaluate(async (f) => {
      const out: Record<string, string> = {};
      const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
      async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
        for await (const [n, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
          const p = prefix ? `${prefix}/${n}` : n;
          if (h.kind === "directory") await walk(h as FileSystemDirectoryHandle, p);
          else out[p] = hex(await crypto.subtle.digest("SHA-256", await (await (h as FileSystemFileHandle).getFile()).arrayBuffer()));
        }
      }
      let dir = await navigator.storage.getDirectory();
      for (const p of f.split("/").filter(Boolean)) dir = await dir.getDirectoryHandle(p);
      await walk(dir, "");
      return out;
    }, folder);
  const original = await hashes("drill");
  expect(Object.keys(original)).toHaveLength(35);

  await run(page, "vault.backups");
  const panel = page.getByRole("dialog", { name: "Backups" });
  await expect(panel).toBeVisible({ timeout: 10_000 });
  await panel.getByRole("button", { name: "Back up to a folder or drive…" }).click();
  await expect(panel.getByTestId("backup-status")).toHaveAttribute("data-health", "ok", { timeout: 30_000 });
  await expect(panel.getByTestId("backup-list").locator("li")).toHaveCount(1, { timeout: 10_000 });

  // The vault is lost.
  await page.evaluate(async () => (await navigator.storage.getDirectory()).removeEntry("drill", { recursive: true }));

  await panel.getByRole("button", { name: "Restore everything to a new folder…" }).click();
  await expect(panel.getByRole("status").filter({ hasText: /Restored \d+ files/ })).toBeVisible({ timeout: 30_000 });
  const restored = await hashes(".e2e-restored/drill");
  expect(restored).toEqual(original);
});

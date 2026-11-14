import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";
import { testHooks, type LumenTestWindow } from "./_lumen";

/**
 * Plan 11.4 — vault encryption at rest, in a real browser, on each backend
 * the browser has: the default vault (OPFS) through the UI, and a real
 * folder (a FileSystemDirectoryHandle) through the same session API. Scan
 * ("Check and repair") and recovery run on both. The desktop (Tauri) and
 * in-memory backends run the same checks in src/__tests__/vaultEncryption.test.ts.
 */

const PASS = "correct horse battery staple";
const NOTE = "# סוד\nthe secret plan";

async function opfsBytes(page: Page, path: string): Promise<number[]> {
  return page.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split("/");
    for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d);
    const f = await (await dir.getFileHandle(parts[parts.length - 1])).getFile();
    return [...new Uint8Array(await f.arrayBuffer())];
  }, path);
}

async function runCommand(page: Page, name: string) {
  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill(name);
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(name, { timeout: 8000 });
  await page.keyboard.press("Enter");
}

test("OPFS vault: turn on in the dialog, only ciphertext stored, unlock after reload, check and repair, recovery key", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const ok = await page.evaluate(async (note) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("Private", { create: true });
      const w = await (await dir.getFileHandle("Plan.md", { create: true }) as unknown as { createWritable(): Promise<{ write(s: string): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(note);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }, NOTE);
  vaultOrSkip(ok, browserName);

  await runCommand(page, "Vault encryption");
  const dialog = page.getByTestId("vault-encryption");
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await dialog.getByLabel("Repeat the passphrase").fill(PASS);
  await dialog.getByRole("button", { name: "Turn on encryption" }).click();
  const key = (await dialog.getByTestId("vault-recovery-key").innerText()).trim();
  expect(key).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){5}$/);
  // Nothing is written before the recovery key is confirmed.
  expect((await opfsBytes(page, "Private/Plan.md"))[0]).not.toBe(0);
  await dialog.getByLabel("I have saved the recovery key").check();
  await dialog.getByRole("button", { name: "Encrypt the vault" }).click();
  await expect(dialog.getByTestId("vault-enc-done")).toBeVisible({ timeout: 60_000 });

  const stored = await opfsBytes(page, "Private/Plan.md");
  expect(stored.slice(0, 5)).toEqual([0x00, 0x4c, 0x4d, 0x45, 0x01]);
  expect(Buffer.from(stored).toString("utf8")).not.toContain("secret");

  // After a reload the vault is locked: a wrong passphrase is refused, the right one opens it.
  await page.reload();
  const lock = page.getByTestId("vault-unlock");
  await expect(lock).toBeVisible({ timeout: 15_000 });
  await lock.getByLabel("Passphrase").fill("not the passphrase");
  await lock.getByRole("button", { name: "Unlock" }).click();
  await expect(lock.getByRole("alert")).toHaveText("Wrong passphrase or recovery key.", { timeout: 15_000 });
  await lock.getByLabel("Passphrase").fill(PASS);
  await lock.getByRole("button", { name: "Unlock" }).click();
  await expect(lock).toBeHidden({ timeout: 15_000 });
  await testHooks(page);
  const read = await page.evaluate(async () => (await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace")).readWorkspaceFile("Private/Plan.md"));
  expect(read).toBe(NOTE);

  // Check and repair: everything encrypted, nothing broken.
  await runCommand(page, "Vault encryption");
  await dialog.getByRole("button", { name: "Check and repair" }).click();
  await expect(dialog.getByRole("status").first()).toContainText(/\d+ encrypted, 0 still plain text, 0 not decryptable/, { timeout: 30_000 });

  // Lock now, then open with the recovery key and a new passphrase.
  await dialog.getByRole("button", { name: "Lock now" }).click();
  await expect(lock).toBeVisible();
  await lock.getByRole("button", { name: /Use the recovery key/ }).click();
  await lock.getByLabel("Recovery key").fill(key.toLowerCase());
  await lock.getByLabel("New passphrase").fill("a new passphrase, long enough");
  await lock.getByLabel("Repeat the passphrase").fill("a new passphrase, long enough");
  await lock.getByRole("button", { name: "Open and set the new passphrase" }).click();
  await expect(lock).toBeHidden({ timeout: 30_000 });
  expect(await page.evaluate(async () => (await (window as unknown as LumenTestWindow).__lumenTest.load("storage/workspace")).readWorkspaceFile("Private/Plan.md"))).toBe(NOTE);
});

test("a real folder (FileSystemDirectoryHandle): only ciphertext, scan, wrong passphrase, recovery, off again", async ({ page, browserName }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await testHooks(page);
  const result = await page.evaluate(async (note) => {
    const root = await navigator.storage.getDirectory().catch(() => null);
    if (!root) return null;
    // A directory handle like the one the folder picker returns.
    const handle = await root.getDirectoryHandle("picked-folder", { create: true });
    const vault = await (window as unknown as LumenTestWindow).__lumenTest.load("storage/vault");
    const { createFolderBackend } = await (window as unknown as LumenTestWindow).__lumenTest.load("storage/vault/location");
    const s = await (window as unknown as LumenTestWindow).__lumenTest.load("storage/vault/encrypted/session");
    const folder = createFolderBackend(handle);
    await folder.write("Notes/Plan.md", note);
    const previous = vault.setVaultBackend(folder);
    const rawFirst = async (path: string) => {
      let d: FileSystemDirectoryHandle = handle;
      const parts = path.split("/");
      for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
      return [...new Uint8Array(await (await (await d.getFileHandle(parts[parts.length - 1])).getFile()).arrayBuffer())];
    };
    try {
      const on = await s.enableEncryption("folder passphrase, long", { confirmRecoveryKey: async () => true });
      const stored = await rawFirst("Notes/Plan.md");
      const scan = (await s.repair()).scan;
      s.lock();
      let wrong = "";
      await s.unlock("wrong folder passphrase").catch((e: Error) => (wrong = e.name));
      await s.recover(on!.recoveryKey, "second folder passphrase");
      const text = await vault.getVaultBackend().readText("Notes/Plan.md");
      const off = await s.disableEncryption("second folder passphrase");
      const plain = new TextDecoder().decode(new Uint8Array(await rawFirst("Notes/Plan.md")));
      return { prefix: stored.slice(0, 5), leaks: new TextDecoder().decode(new Uint8Array(stored)).includes("secret"), scan: { encrypted: scan.encrypted, plain: scan.plain.length, broken: scan.broken.length }, wrong, text, off: off.done, plain };
    } finally {
      vault.setVaultBackend(previous);
    }
  }, NOTE);
  vaultOrSkip(result !== null, browserName);
  expect(result!.prefix).toEqual([0x00, 0x4c, 0x4d, 0x45, 0x01]);
  expect(result!.leaks).toBe(false);
  expect(result!.scan).toEqual({ encrypted: 1, plain: 0, broken: 0 });
  expect(result!.wrong).toBe("WrongPassphraseError");
  expect(result!.text).toBe(NOTE);
  expect(result!.off).toBe(true);
  expect(result!.plain).toBe(NOTE);
});

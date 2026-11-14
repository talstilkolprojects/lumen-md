import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { fakeWebdav } from "../src/__tests__/helpers/fakeServers/webdav";

/**
 * Plan W1.8 — sync that explains itself, in two browsers sharing one mock
 * WebDAV server (wired as in sync-providers.spec.ts):
 *   • a conflict is shown in the activity panel within 5 s of the round
 *     that finds it, while its dialog is still open;
 *   • a folder left out on one device stays there: the other device never
 *     receives it, and the panel says it was kept.
 */
const DAV = "http://127.0.0.1:8787/dav/tal/Lumen/";
const PASS = "a long passphrase for the e2e vault";

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, PUT, DELETE, PROPFIND, MKCOL, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, If-Match, If-None-Match, Depth",
  "Access-Control-Expose-Headers": "ETag",
};

async function wire(context: BrowserContext, server: ReturnType<typeof fakeWebdav>) {
  await context.route("http://127.0.0.1:8787/dav/**", async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const res = await server.handle({
      method: req.method(),
      url: new URL(req.url()),
      headers: new Headers(await req.allHeaders()),
      body: new Uint8Array(req.postDataBuffer() ?? Buffer.alloc(0)),
    });
    await route.fulfill({
      status: res.status,
      headers: { ...CORS, ...(res.headers ?? {}) },
      body: res.body === undefined ? "" : typeof res.body === "string" ? res.body : Buffer.from(res.body),
    });
  });
}

/** Write a note into the browser's vault (OPFS), creating its folders. */
function writeNote(page: Page, path: string, text: string) {
  return page.evaluate(
    async ([p, t]) => {
      let dir = await navigator.storage.getDirectory();
      const parts = p.split("/");
      for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create: true });
      const w = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await w.write(t);
      await w.close();
    },
    [path, text] as const,
  );
}

/** Does the vault hold `path`? */
function hasNote(page: Page, path: string) {
  return page.evaluate(async (p) => {
    try {
      let dir = await navigator.storage.getDirectory();
      const parts = p.split("/");
      for (const seg of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(seg);
      await dir.getFileHandle(parts[parts.length - 1]);
      return true;
    } catch {
      return false;
    }
  }, path);
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  // Encrypted sync is experimental in 0.2.0-beta.1 (W6.43): the user turns it on in Settings → Feature flags.
  await page.addInitScript(() => localStorage.setItem("lumen-flags", JSON.stringify({ "sync.e2ee": true })));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  return page;
}

async function connect(page: Page) {
  await page.bringToFront();
  await run(page, "sync.open");
  const panel = page.getByRole("dialog", { name: "Sync" });
  await expect(panel.getByText("Where to keep the encrypted vault")).toBeVisible({ timeout: 15_000 });
  await panel.getByLabel("Folder address").fill(DAV);
  await panel.getByLabel("User name").fill("tal");
  await panel.getByLabel("Password or app password").fill("app-password");
  await panel.getByRole("button", { name: "Connect" }).click();
  return panel;
}

test("the panel shows a conflict within 5 s, and a folder left out stays on its device", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "the vault reads OPFS through Chromium's async iterator");
  const server = fakeWebdav({ baseUrl: DAV, username: "tal", password: "app-password" });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await wire(ctxA, server);
  await wire(ctxB, server);
  const a = await open(ctxA);
  const b = await open(ctxB);

  // A leaves Private/ out before its first round, then creates the vault.
  await writeNote(a, "shared.md", "# shared\n\nבסיס");
  await writeNote(a, "Private/diary.md", "# יומן");
  const pa = await connect(a);
  await expect(pa.getByText("There is no vault there yet. Choose a passphrase to create it.")).toBeVisible({ timeout: 15_000 });
  await pa.getByText("What syncs on this device").click();
  await pa.getByLabel("Folders to leave out (one per line)").fill("Private");
  await pa.getByRole("button", { name: "Save" }).click();
  await expect(pa.getByText("Saved. Applies from the next sync.")).toBeVisible();
  await pa.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await pa.getByLabel("Repeat the passphrase").fill(PASS);
  await pa.getByRole("button", { name: "Encrypt and sync" }).click();
  await expect(pa.getByTestId("sync-result")).toContainText(/1 up, 0 down/, { timeout: 30_000 });
  await expect(pa.getByTestId("sync-activity")).toContainText("Kept on this device: Private/diary.md (folder Private)");

  // B joins and gets shared.md only.
  const pb = await connect(b);
  await pb.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await pb.getByRole("button", { name: "Unlock" }).click();
  await expect(pb.getByTestId("sync-result")).toContainText(/0 up, 1 down/, { timeout: 30_000 });
  expect(await hasNote(b, "shared.md")).toBe(true);
  expect(await hasNote(b, "Private/diary.md")).toBe(false);
  for (const f of server.files.values()) expect(Buffer.from(f.data).toString("utf8")).not.toContain("יומן");

  // Both edit shared.md; A syncs first, then B's round finds the conflict.
  await writeNote(a, "shared.md", "# shared\n\nfrom A");
  await writeNote(b, "shared.md", "# shared\n\nfrom B");
  await a.bringToFront();
  await pa.getByRole("button", { name: "Sync now" }).click();
  await expect(pa.getByRole("button", { name: "Sync now" })).toBeEnabled({ timeout: 30_000 });
  await b.bringToFront();
  await pb.getByRole("button", { name: "Sync now" }).click();
  // Within 5 s, while the conflict dialog is still waiting for a decision.
  await expect(pb.getByTestId("sync-activity")).toContainText("Conflict: shared.md", { timeout: 5_000 });
  await expect(b.getByRole("dialog", { name: /Sync conflict — shared\.md/ })).toBeVisible();
  await b.getByRole("button", { name: "Decide later" }).click();
  await expect(pb.getByTestId("sync-attention")).toContainText("shared.md", { timeout: 15_000 });
  await expect(pb.getByTestId("sync-attention").locator('[data-state="conflict"]')).toHaveCount(1);
  // The file tree's badges are on while the vault is unlocked.
  await expect.poll(() => b.evaluate(() => document.getElementById("lumen-sync-badges")?.textContent ?? "")).toContain('[data-path="shared.md"]');

  await ctxA.close();
  await ctxB.close();
});

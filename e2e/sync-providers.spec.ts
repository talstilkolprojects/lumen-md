import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { fakeWebdav } from "../src/__tests__/helpers/fakeServers/webdav";

/**
 * Plan 3.5 / 3.7 G8 — settings → connect a provider → sync, in two
 * browsers that share one (mock) WebDAV server: nothing is lost.
 *
 * The WebDAV server is the same mock the unit tests use, answered from
 * Playwright's request interception. Its address is http://127.0.0.1:8787,
 * an origin the app's CSP already allows (the local worker port), because
 * the browser applies the page's CSP before interception sees a request.
 * The mock answers with the CORS headers a real server must send.
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

/** Every note in the browser's vault (OPFS), path → text. */
function vault(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {};
    async function walk(dir: FileSystemDirectoryHandle, prefix: string) {
      for await (const [n, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const p = prefix ? `${prefix}/${n}` : n;
        if (h.kind === "directory") {
          if (!prefix && n.startsWith(".")) continue;
          await walk(h as FileSystemDirectoryHandle, p);
        } else if (p.endsWith(".md")) out[p] = await (await (h as FileSystemFileHandle).getFile()).text();
      }
    }
    await walk(await navigator.storage.getDirectory(), "");
    return out;
  });
}

function writeNote(page: Page, name: string, text: string) {
  return page.evaluate(
    async ([n, t]) => {
      const w = await (await (await navigator.storage.getDirectory()).getFileHandle(n, { create: true })).createWritable();
      await w.write(t);
      await w.close();
    },
    [name, text] as const,
  );
}

async function open(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
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

const result = (page: Page) => page.getByTestId("sync-result");

test("two browsers sync through one WebDAV server without losing a note", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "the vault reads OPFS through Chromium's async iterator");
  const server = fakeWebdav({ baseUrl: DAV, username: "tal", password: "app-password" });
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  await wire(ctxA, server);
  await wire(ctxB, server);
  const a = await open(ctxA);
  const b = await open(ctxB);

  // A: the first device creates the vault.
  await writeNote(a, "from-a.md", "# from A\n\nשלום");
  const pa = await connect(a);
  await expect(pa.getByText("There is no vault there yet. Choose a passphrase to create it.")).toBeVisible({ timeout: 15_000 });
  await pa.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await pa.getByLabel("Repeat the passphrase").fill(PASS);
  await pa.getByRole("button", { name: "Encrypt and sync" }).click();
  await expect(result(a)).toContainText(/1 up, 0 down/, { timeout: 30_000 });

  // B: joins with the passphrase and receives A's note.
  await writeNote(b, "from-b.md", "# from B");
  const pb = await connect(b);
  await expect(pb.getByText("A vault is already there. Enter its passphrase.")).toBeVisible({ timeout: 15_000 });
  await pb.getByLabel("Passphrase", { exact: true }).fill(PASS);
  await pb.getByRole("button", { name: "Unlock" }).click();
  await expect(result(b)).toContainText(/1 up, 1 down/, { timeout: 30_000 });
  // B's device has not been paired: the panel says so instead of claiming rollback protection.
  await expect(pb.getByText(/Freshness not verified/)).toBeVisible();

  // Both write while both sync at the same time: the manifest race is retried, not lost.
  await writeNote(a, "a-2.md", "second from A");
  await writeNote(b, "b-2.md", "second from B");
  await Promise.all([pa.getByRole("button", { name: "Sync now" }).click(), pb.getByRole("button", { name: "Sync now" }).click()]);
  for (const [page, panel] of [[a, pa], [b, pb], [a, pa]] as const) {
    await expect(panel.getByRole("button", { name: "Sync now" })).toBeEnabled({ timeout: 30_000 });
    await panel.getByRole("button", { name: "Sync now" }).click();
    await expect(panel.getByRole("button", { name: "Sync now" })).toBeEnabled({ timeout: 30_000 });
    void page;
  }

  const want = { "from-a.md": "# from A\n\nשלום", "from-b.md": "# from B", "a-2.md": "second from A", "b-2.md": "second from B" };
  await expect.poll(() => vault(a), { timeout: 15_000 }).toMatchObject(want);
  await expect.poll(() => vault(b), { timeout: 15_000 }).toMatchObject(want);
  expect(await vault(a)).toEqual(await vault(b));

  // The server holds only ciphertext under opaque names.
  for (const [name, f] of server.files) {
    expect(name).not.toMatch(/\.md$/);
    expect(Buffer.from(f.data).toString("utf8")).not.toMatch(/from A|from B|שלום/);
  }
  await ctxA.close();
  await ctxB.close();
});

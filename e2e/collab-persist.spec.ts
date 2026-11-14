import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plan 3.6.4: two browsers edit one room through the persistent collab
 * server, both leave, the server restarts (as on a redeploy), and a third
 * browser rejoins from the share link: the room's content is still there.
 *
 * The server is sync-server/collab-server.mjs run with Node (no docker),
 * on an ephemeral port with a temporary SQLite directory. WebRTC signaling
 * points at a closed port, so everything the browsers share goes through
 * the server: the room is end-to-end encrypted, and the server holds only
 * ciphertext.
 */

// One engine is enough for a server round trip; the client code is the same.
test.skip(({ browserName }) => browserName !== "chromium", "server-backed flow, chromium only");

const ACCESS_KEY = "e2e-collab-access-key";
const SECRET = "e2e-collab-token-secret-0123456789abcdef";

interface Running {
  proc: ChildProcess;
  url: string;
}

function startServer(dataDir: string): Promise<Running> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "sync-server/collab-server.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      COLLAB_DATA_DIR: dataDir,
      COLLAB_ACCESS_KEY: ACCESS_KEY,
      COLLAB_TOKEN_SECRET: SECRET,
      COLLAB_DEBOUNCE_MS: "100",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`collab server did not start:\n${out}`)), 15_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = out.match(/listening on :(\d+)/);
      if (m) {
        clearTimeout(timer);
        resolve({ proc, url: `ws://127.0.0.1:${m[1]}` });
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`collab server exited (${code}):\n${out}`));
    });
  });
}

/** SIGTERM: the server stores every room and takes a backup before it exits. */
function stopServer(s: Running): Promise<void> {
  if (s.proc.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    s.proc.once("exit", () => resolve());
    s.proc.kill("SIGTERM");
  });
}

async function openApp(browser: Browser, serverUrl: string, path = "/"): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext();
  await ctx.addInitScript(
    ({ ws, key }) => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen.collab.ws", ws);
      // Plain text here; the secret store moves it into encrypted storage at startup.
      localStorage.setItem("lumen.collab.wsToken", key);
      localStorage.setItem("lumen.collab.signaling", "ws://127.0.0.1:9");
    },
    { ws: serverUrl, key: ACCESS_KEY },
  );
  const page = await ctx.newPage();
  await page.goto(path);
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  return { ctx, page };
}

async function joinFromLink(page: Page): Promise<void> {
  // "Join collaborative session …?"
  await page.locator(".prompt-btn-ok").click({ timeout: 10_000 });
}

/** Type at the top of the document, where the editor renders it in every viewport. */
async function typeAtTop(page: Page, text: string): Promise<void> {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await page.keyboard.press("Control+Home");
  await page.keyboard.type(text);
}

/** The whole document text (CodeMirror renders only the lines in view). */
function docText(page: Page): Promise<string> {
  return page.evaluate(() => {
    type View = { state: { doc: { toString(): string } } };
    // EditorView.findFromDOM without importing CodeMirror: the content node's tile leads to the view.
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    return el?.cmTile?.root?.view?.state.doc.toString() ?? "";
  });
}

/** True once the editor is bound to the room's shared text (y-codemirror's sync plugin is live). */
function collabBound(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    type Plugin = { value?: { conf?: { ytext?: unknown } } | null };
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: { plugins?: Plugin[] } } } }) | null;
    return !!el?.cmTile?.root?.view?.plugins?.some((p) => !!p.value?.conf?.ytext);
  });
}

let dataDir = "";
let server: Running | null = null;

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lumen-collab-e2e-"));
});

test.afterEach(async () => {
  if (server) await stopServer(server);
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
});

test("a room both peers leave keeps its content across a server restart", async ({ browser }) => {
  test.setTimeout(90_000);
  const alpha = `ALPHA-${Date.now().toString(36)}`;
  const beta = `BETA-${Date.now().toString(36)}`;
  server = await startServer(dataDir);

  // A starts a room (new rooms are end-to-end encrypted; the link carries the password).
  const a = await openApp(browser, server.url);
  await expect(a.page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await a.page.keyboard.press("Meta+K");
  await a.page.keyboard.type("Start collaboration");
  await a.page.keyboard.press("Enter");
  await expect.poll(() => a.page.url(), { timeout: 10_000 }).toMatch(/#room=[\w-]+&password=/);
  const link = a.page.url().slice(a.page.url().indexOf("/#"));
  await expect.poll(() => collabBound(a.page), { timeout: 10_000 }).toBe(true);
  await typeAtTop(a.page, `${alpha}\n`);

  // B joins from the link and edits too.
  const b = await openApp(browser, server.url, link);
  await joinFromLink(b.page);
  await expect.poll(() => docText(b.page), { timeout: 20_000 }).toContain(alpha);
  await expect.poll(() => collabBound(b.page), { timeout: 10_000 }).toBe(true);
  await typeAtTop(b.page, `${beta}\n`);
  await expect.poll(() => docText(a.page), { timeout: 20_000 }).toContain(beta);

  // Both leave; the server goes down and comes back on the same storage.
  await a.ctx.close();
  await b.ctx.close();
  await stopServer(server);
  server = await startServer(dataDir);

  // C rejoins from the same link: the room's content is back, once.
  const c = await openApp(browser, server.url, link);
  await joinFromLink(c.page);
  await expect.poll(() => docText(c.page), { timeout: 20_000 }).toContain(alpha);
  const text = await docText(c.page);
  expect(text).toContain(beta);
  expect(text).toContain("Welcome to");
  expect(text.split(alpha).length - 1).toBe(1);
  expect(text.split(beta).length - 1).toBe(1);
  await c.ctx.close();
});

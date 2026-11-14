import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plan W2.20: live sharing end-to-end encrypted, through a server that never
 * sees the content. The server runs with COLLAB_REQUIRE_E2EE=1, so it refuses
 * anything but ciphertext envelopes and sealed presence: the real app's
 * traffic must pass that check (no "plaintext refused" in the server's log),
 * the note must still reach the second browser, and once the server has
 * stored the room and taken its backup, no file it wrote holds the text.
 * Server and browsers as in collab-sharing.spec.ts.
 */
test.skip(({ browserName }) => browserName !== "chromium", "server-backed flow, chromium only");

const ACCESS_KEY = "e2e-collab-access-key";
const SECRET = "e2e-collab-token-secret-0123456789abcdef";

interface Running {
  proc: ChildProcess;
  url: string;
  /** Everything the server printed. */
  output: () => string;
}

function startServer(dataDir: string, extraEnv: Record<string, string> = {}): Promise<Running> {
  const proc = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "sync-server/collab-server.mjs"], {
    env: {
      ...process.env,
      PORT: "0",
      HOST: "127.0.0.1",
      COLLAB_DATA_DIR: dataDir,
      COLLAB_ACCESS_KEY: ACCESS_KEY,
      COLLAB_TOKEN_SECRET: SECRET,
      COLLAB_DEBOUNCE_MS: "100",
      ...extraEnv,
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
        resolve({ proc, url: `ws://127.0.0.1:${m[1]}`, output: () => out });
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.once("exit", (code) => {
      clearTimeout(timer);
      if (out.match(/listening on :(\d+)/)) return;
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


async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press("Meta+K");
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

function filesUnder(dir: string): Buffer[] {
  const out: Buffer[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(readFileSync(p));
  }
  return out;
}

let dataDir = "";
let server: Running | null = null;

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lumen-e2ee-e2e-"));
});

test.afterEach(async () => {
  if (server) await stopServer(server);
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
});

test("a shared note reaches the viewer through a server that holds ciphertext only", async ({ browser }) => {
  test.setTimeout(90_000);
  const stamp = Date.now().toString(36);
  const secret = `סוד-${stamp} SECRET-${stamp}`;
  const later = `LATER-${stamp}`;
  server = await startServer(dataDir, { COLLAB_REQUIRE_E2EE: "1" });

  const a = await openApp(browser, server.url);
  await expect(a.page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await palette(a.page, "Start collaboration");
  await expect.poll(() => a.page.url(), { timeout: 10_000 }).toMatch(/#room=[\w-]+&password=/);
  await expect.poll(() => collabBound(a.page), { timeout: 10_000 }).toBe(true);
  await typeAtTop(a.page, `${secret}\n`);

  await palette(a.page, "Share this note");
  const dialog = a.page.getByRole("dialog", { name: "Share" });
  await expect(dialog.getByTestId("share-e2ee")).toBeVisible();
  await dialog.getByRole("button", { name: "Create link" }).click();
  const linkText = (await dialog.getByTestId("share-link").textContent({ timeout: 10_000 })) ?? "";
  const key = /[#&]password=([^&]+)/.exec(linkText)?.[1] ?? "";
  expect(key.length).toBeGreaterThan(16);
  await a.page.keyboard.press("Escape");

  const b = await openApp(browser, server.url, linkText.slice(linkText.indexOf("/#")));
  await joinFromLink(b.page);
  await expect.poll(() => docText(b.page), { timeout: 20_000 }).toContain(secret);
  await typeAtTop(a.page, `${later}\n`);
  await expect.poll(() => docText(b.page), { timeout: 20_000 }).toContain(later);

  await a.ctx.close();
  await b.ctx.close();
  await stopServer(server); // stores every room and takes a backup
  expect(server.output()).not.toContain("plaintext refused");
  const files = filesUnder(dataDir);
  expect(files.length).toBeGreaterThan(0);
  for (const needle of [`סוד-${stamp}`, `SECRET-${stamp}`, later, decodeURIComponent(key)]) {
    expect(files.some((f) => f.includes(Buffer.from(needle, "utf8"))), needle).toBe(false);
  }
});

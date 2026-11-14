import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Plan W3.11, two browsers through the persistent collab server (helpers as
 * in collab-sharing.spec.ts):
 * - a participant with an "edit" link suggests in suggesting mode: the
 *   owner sees the suggestion, and the text (all suggestions rejected) is
 *   unchanged until it is accepted, by author;
 * - the owner names a version ("לפני הגשה"); the participant sees it in the
 *   shared list and compares it with the current text word by word.
 */

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


async function palette(page: Page, command: string): Promise<void> {
  await page.keyboard.press("Meta+K");
  await page.keyboard.type(command);
  await page.keyboard.press("Enter");
}

let dataDir = "";
let server: Running | null = null;

test.beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "lumen-share-e2e-"));
});

test.afterEach(async () => {
  if (server) await stopServer(server);
  server = null;
  rmSync(dataDir, { recursive: true, force: true });
});


test("a suggestion changes nothing until accepted; named versions are shared and compared", async ({ browser }) => {
  test.setTimeout(120_000);
  const stamp = Date.now().toString(36);
  const base = `שורת בסיס ${stamp}`;
  server = await startServer(dataDir);

  const a = await openApp(browser, server.url);
  await expect(a.page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await palette(a.page, "Start collaboration");
  await expect.poll(() => collabBound(a.page), { timeout: 10_000 }).toBe(true);
  await typeAtTop(a.page, `${base}\n`);

  await palette(a.page, "Share this note");
  const dialog = a.page.getByRole("dialog", { name: "Share" });
  await dialog.getByLabel("Access").selectOption("edit");
  await dialog.getByRole("button", { name: "Create link" }).click();
  const linkText = (await dialog.getByTestId("share-link").textContent({ timeout: 10_000 })) ?? "";
  await a.page.keyboard.press("Escape");

  const b = await openApp(browser, server.url, linkText.slice(linkText.indexOf("/#")));
  await joinFromLink(b.page);
  await expect.poll(() => docText(b.page), { timeout: 20_000 }).toContain(base);
  await expect.poll(() => collabBound(b.page), { timeout: 10_000 }).toBe(true);

  // The participant suggests.
  await palette(b.page, "Turn on suggesting mode");
  await typeAtTop(b.page, "הצעה ");
  await expect.poll(() => docText(a.page), { timeout: 20_000 }).toContain("{++הצעה ++}");
  // The text itself is unchanged until someone accepts.
  const resolved = (s: string) => s.replace(/\{\+\+[\s\S]*?\+\+\}(\{>>@[^<]*<<\})?/g, "");
  expect(resolved(await docText(a.page))).toContain(base);
  expect(resolved(await docText(a.page))).not.toContain("הצעה");

  // The owner accepts that author's suggestions.
  await palette(a.page, "Accept all from");
  await expect.poll(() => docText(b.page), { timeout: 20_000 }).toContain(`הצעה ${base}`);
  expect(await docText(a.page)).not.toContain("{++");

  // A named version, shared with the participant.
  await palette(a.page, "Named versions");
  const versions = a.page.getByRole("dialog", { name: "Named versions" });
  await versions.getByLabel("Version name").fill("לפני הגשה");
  await versions.getByRole("button", { name: "Save this version" }).click();
  await expect(versions.getByTestId("named-versions")).toContainText("לפני הגשה");
  await a.page.keyboard.press("Escape");
  await typeAtTop(a.page, "חדש ");

  await palette(b.page, "Named versions");
  const bv = b.page.getByRole("dialog", { name: "Named versions" });
  await expect(bv.getByTestId("named-versions")).toContainText("לפני הגשה", { timeout: 20_000 });
  await expect(bv.getByTestId("version-diff").locator("ins")).toHaveText("חדש ", { timeout: 20_000 });

  await a.ctx.close();
  await b.ctx.close();
});

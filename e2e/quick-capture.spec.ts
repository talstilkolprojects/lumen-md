import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 4.16 — quick capture in two steps on every platform:
 *  - ⌥⌘N (Ctrl+Alt+N) opens the capture box; type, Enter → appended to inbox.md.
 *  - The installed app's "Quick Capture" shortcut (`/?capture=1`) opens the
 *    same box; type, click "Add to inbox".
 *  - Sharing to the installed app (share target `/?title=…&text=…&url=…`)
 *    appends to inbox.md, after what is already there.
 */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

/**
 * Can this engine write OPFS files at all here? Playwright's WebKit runs in
 * an ephemeral context, where WebKit may refuse OPFS writes; the vault can't
 * work there, so these tests skip (and say why) instead of failing.
 */
async function opfsWritable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
      if (typeof h.createWritable === "function") {
        const w = await h.createWritable();
        await w.write("x");
        await w.close();
      } else {
        const src =
          "self.onmessage=async()=>{try{const r=await navigator.storage.getDirectory();const f=await r.getFileHandle('__probe',{create:true});const a=await f.createSyncAccessHandle();a.write(new Uint8Array([120]),{at:0});a.flush();a.close();postMessage(true)}catch(e){postMessage(false)}}";
        const ok = await new Promise<boolean>((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([src], { type: "application/javascript" })));
          w.onmessage = (e) => res(e.data === true);
          w.onerror = () => res(false);
          w.postMessage(0);
          setTimeout(() => res(false), 5000);
        });
        if (!ok) return false;
      }
      await root.removeEntry("__probe");
      return true;
    } catch {
      return false;
    }
  });
}

/** inbox.md in the vault, or null when there is none. */
const inbox = (page: Page) =>
  page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      return await (await (await root.getFileHandle("inbox.md")).getFile()).text();
    } catch {
      return null;
    }
  });

const ENTRY = /^- \[\[journal\/\d{4}-\d{2}-\d{2}\]\] \d{2}:\d{2} /m;

test("⌥⌘N, type, Enter → the line is at the end of inbox.md", async ({ page }) => {
  test.skip(!(await opfsWritable(page)), "this engine refuses OPFS writes here, so there is no vault for inbox.md");
  expect(await inbox(page)).toBeNull();

  await page.keyboard.press("ControlOrMeta+Alt+KeyN");
  const box = page.getByTestId("quick-capture");
  await expect(box).toBeVisible({ timeout: 5000 });
  const field = box.locator("textarea");
  await expect(field).toBeFocused();
  await field.fill("לקנות חלב — call the plumber");
  await field.press("Enter");
  await expect(box).toBeHidden();
  await expect.poll(() => inbox(page), { timeout: 10_000 }).toContain("לקנות חלב — call the plumber");
  const text = (await inbox(page)) ?? "";
  expect(text.startsWith("# ")).toBe(true);
  expect(text).toMatch(ENTRY);
  // The editor was not replaced: capture doesn't take you away from your note.
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to");

  // A second capture goes after the first; nothing is overwritten.
  await page.keyboard.press("ControlOrMeta+Alt+KeyN");
  await expect(box).toBeVisible();
  await box.locator("textarea").fill("second thought");
  await box.locator("textarea").press("Enter");
  await expect.poll(() => inbox(page), { timeout: 10_000 }).toContain("second thought");
  const after = (await inbox(page)) ?? "";
  expect(after.startsWith(text)).toBe(true);
  expect(after.indexOf("second thought")).toBeGreaterThan(after.indexOf("call the plumber"));
});

test("the PWA shortcut /?capture=1 opens the box; type, click Add → inbox.md", async ({ page }) => {
  test.skip(!(await opfsWritable(page)), "this engine refuses OPFS writes here, so there is no vault for inbox.md");
  await page.goto("/?capture=1");
  const box = page.getByTestId("quick-capture");
  await expect(box).toBeVisible({ timeout: 15_000 });
  // The launch parameter is removed so a reload doesn't open it again.
  await expect.poll(() => new URL(page.url()).search).toBe("");
  await box.locator("textarea").fill("from the home-screen shortcut");
  await box.getByRole("button", { name: "Add to inbox" }).click();
  await expect.poll(() => inbox(page), { timeout: 10_000 }).toContain("from the home-screen shortcut");
  expect((await inbox(page)) ?? "").toMatch(ENTRY);
});

test("a share to the installed app is appended to inbox.md", async ({ page }) => {
  test.skip(!(await opfsWritable(page)), "this engine refuses OPFS writes here, so there is no vault for inbox.md");
  // Something already in the inbox must stay.
  await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("inbox.md", { create: true });
    const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
    if (typeof h.createWritable !== "function") return;
    const w = await h.createWritable();
    await w.write("# Inbox\n\n- already here\n");
    await w.close();
  });
  // WebKit writes OPFS only from a worker: there the inbox starts empty.
  const seeded = !!(await inbox(page));

  await page.goto("/?title=" + encodeURIComponent("Shared page") + "&text=" + encodeURIComponent("שווה לקרוא") + "&url=" + encodeURIComponent("https://example.com/a"));
  await expect.poll(() => inbox(page), { timeout: 15_000 }).toContain("<https://example.com/a>");
  const text = (await inbox(page)) ?? "";
  if (seeded) expect(text.startsWith("# Inbox\n\n- already here\n")).toBe(true);
  expect(text).toMatch(ENTRY);
  expect(text).toContain("Shared page <https://example.com/a>");
  expect(text).toContain("שווה לקרוא");
  // The inbox is shown, and the parameters are gone so a reload doesn't share twice.
  await expect(page.locator(".cm-content").first()).toContainText("Shared page");
  await expect.poll(() => new URL(page.url()).search).toBe("");
});

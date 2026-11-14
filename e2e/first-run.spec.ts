import { test, expect, type Page } from "@playwright/test";

/**
 * First run (plan 14.1): a brand-new user — no lumen-tour-done — gets the
 * setup (language, where the vault lives, the look, what to start with),
 * then the short tour. Acceptance: from opening Lumen to the first note in
 * under 60 seconds, measured here.
 *
 * The rest of the suite skips all this by setting lumen-tour-done=1.
 */

test.beforeEach(async ({ page }) => {
  // Intentionally do NOT seed lumen-tour-done: this is a fresh user.
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("fr-cleared")) {
      localStorage.clear();
      sessionStorage.setItem("fr-cleared", "1");
    }
  });
});

/** Can this engine write OPFS files here? (Playwright's WebKit may refuse in its ephemeral context.) */
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

test("a new user reaches their first note in under 60 s: setup, sample vault, tour skipped", async ({ page }) => {
  const started = Date.now();
  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Welcome to Lumen" });
  await expect(setup).toBeVisible({ timeout: 15_000 });
  test.skip(!(await opfsWritable(page)), "this engine refuses OPFS writes here, so there is no vault for the sample");

  // Language → vault → look → start: the defaults are fine for this user.
  await expect(setup.getByRole("radio", { name: "English" })).toBeChecked();
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.getByRole("radio", { name: /In this browser/ })).toBeChecked();
  await setup.getByRole("button", { name: "Next" }).click();
  await setup.getByRole("radio", { name: "Sepia" }).check();
  await expect(page.locator("html")).toHaveAttribute("data-theme-preset", "sepia");
  await setup.getByRole("button", { name: "Next" }).click();
  await expect(setup.getByRole("radio", { name: /A sample vault/ })).toBeChecked();
  await expect(setup.getByRole("button", { name: "Import a Notion export (.zip)" })).toBeVisible();
  await setup.getByRole("button", { name: "Start writing" }).click();

  // The sample's start page is open, in the editor and in the file tree.
  await expect(setup).toBeHidden();
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to the Lumen sample workspace", { timeout: 15_000 });
  const ms = Date.now() - started;
  test.info().annotations.push({ type: "first-note-ms", description: String(ms) });
  // hygiene-allow: benchmark output
  console.log(`first run: first note after ${ms} ms`);
  expect(ms).toBeLessThan(60_000);
  await expect(page.locator("aside.file-tree")).toContainText("Lumen Sample");

  // The tour follows; it can be skipped from its first step.
  const skipTour = page.getByRole("button", { name: "Skip tour" });
  await expect(skipTour).toBeVisible({ timeout: 5_000 });
  await skipTour.click();
  await expect(skipTour).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("lumen-tour-done"))).toBe("1");

  // Setup doesn't come back on the next visit.
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await page.waitForFunction(() => performance.now() > 1500, null, { timeout: 10_000 });
  await expect(page.getByRole("dialog", { name: "Welcome to Lumen" })).toHaveCount(0);
});

test("an empty vault: the first note, then every tour step to Done", async ({ page }) => {
  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Welcome to Lumen" });
  await expect(setup).toBeVisible({ timeout: 15_000 });
  test.skip(!(await opfsWritable(page)), "this engine refuses OPFS writes here, so there is no vault for the first note");
  for (let i = 0; i < 3; i++) await setup.getByRole("button", { name: "Next" }).click();
  await setup.getByRole("radio", { name: /An empty vault/ }).check();
  await setup.getByRole("button", { name: "Start writing" }).click();
  const editor = page.locator(".cm-content").first();
  await expect(editor).toContainText("My first note", { timeout: 15_000 });

  const counter = page.getByText(/^\s*\d+ \/ \d+\s*$/).first();
  await expect(counter).toBeVisible({ timeout: 5_000 });
  const total = Number(/\/ (\d+)/.exec((await counter.textContent()) ?? "")![1]);
  for (let step = 1; step < total; step++) {
    await expect(counter).toHaveText(new RegExp(`^\\s*${step} / ${total}\\s*$`));
    await page.getByRole("button", { name: "→ Next" }).click();
  }
  await page.getByRole("button", { name: "✓ Done" }).click();
  await expect(counter).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("lumen-tour-done"))).toBe("1");

  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type("\n\nHello world!");
  await expect(editor).toContainText("Hello world!");
});

test("Hebrew turns the setup right-to-left at once; Skip setup ends it with no tour", async ({ page }) => {
  await page.goto("/");
  const setup = page.getByRole("dialog", { name: "Welcome to Lumen" });
  await expect(setup).toBeVisible({ timeout: 15_000 });
  await setup.getByRole("radio", { name: "עברית" }).check();
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 10_000 });
  const he = page.getByRole("dialog", { name: "ברוכים הבאים ל-Lumen" });
  await expect(he).toBeVisible();
  // Logical layout: the primary button sits at the inline end, which is the left in RTL.
  const next = await he.getByRole("button", { name: "הבא" }).boundingBox();
  const skip = await he.getByRole("button", { name: "דילוג על ההגדרה" }).boundingBox();
  expect(next!.x).toBeLessThan(skip!.x);
  await he.getByRole("button", { name: "דילוג על ההגדרה" }).click();
  await expect(he).toBeHidden();
  await expect(page.getByText(/^\s*\d+ \/ \d+\s*$/)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("lumen-tour-done"))).toBe("1");
});

test("with storage blocked there is no setup, and the editor still works", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Storage denied for testing", "SecurityError");
      },
    });
  });
  await page.goto("/");
  await page.locator("header").first().waitFor({ state: "visible", timeout: 15_000 });
  await page.waitForFunction(() => performance.now() > 1500, null, { timeout: 10_000 });
  await expect(page.getByRole("dialog", { name: "Welcome to Lumen" })).toHaveCount(0);
  await expect(page.locator(".cm-content").first()).toBeVisible();
});

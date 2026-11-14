import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W2.21 — a cold start, measured from navigation to the last note
 * being editable (the editor holds its text and takes input):
 *
 *   - < 800 ms on the desktop profile, < 1.5 s on the phone profile
 *     ("coldstart-phone": Pixel 7, CPU 4× slower);
 *   - a 10,000-note vault opens within 15 % of a 100-note one;
 *   - the start shifts nothing: CLS < 0.05;
 *   - the boot shell shows the note's own text before the app has started
 *     (public/note-boot.js).
 *
 * Budgets are asserted against a production build only (PLAYWRIGHT_BASE_URL),
 * as e2e/perf-vault.spec.ts does: the dev server's on-the-fly transforms are
 * not Lumen's start. Run with `npm run perf:coldstart`. Every number is also
 * a "perf" annotation in the report.
 */

const PROD = !!process.env.PLAYWRIGHT_BASE_URL;
const NOTE = "# Last note\n\nThe text I was writing when I closed the tab.\n";

function report(name: string, value: number, unit = "ms"): void {
  test.info().annotations.push({ type: "perf", description: `${name}: ${Math.round(value * 1000) / 1000} ${unit}` });
}

async function seedVault(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const root = await navigator.storage.getDirectory();
    const notes = await root.getDirectoryHandle("notes", { create: true });
    const dirs = new Map<number, FileSystemDirectoryHandle>();
    for (let k = 0; k * 500 < n; k++) dirs.set(k, await notes.getDirectoryHandle(String(k), { create: true }));
    const write = async (i: number) => {
      const fh = await dirs.get(Math.floor(i / 500))!.getFileHandle(`n${i}.md`, { create: true });
      const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await w.write(`# Note ${i}\n\nLinks to [[n${(i + 1) % n}]].\n`);
      await w.close();
    };
    for (let i = 0; i < n; i += 250) await Promise.all(Array.from({ length: Math.min(250, n - i) }, (_, k) => write(i + k)));
  }, count);
}

async function canSeed(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const ok = typeof (fh as unknown as { createWritable?: unknown }).createWritable === "function";
      await root.removeEntry("__probe");
      return ok;
    } catch {
      return false;
    }
  });
}

/**
 * Reload, and measure: time to the last note editable, CLS of the start, and
 * whether the boot shell showed the note's text before the app replaced it.
 */
async function coldStart(page: Page): Promise<{ editableMs: number; cls: number; shellShowedNote: boolean }> {
  await page.reload();
  const handle = await page.waitForFunction(
    (text) => {
      const el = document.querySelector<HTMLElement>(".cm-content");
      return el && el.isContentEditable && (el.textContent ?? "").includes(text) ? performance.now() : 0;
    },
    "The text I was writing",
    { polling: "raf", timeout: 60_000 },
  );
  const editableMs = (await handle.jsonValue()) as number;
  // Let late shifts (fonts, panels) be reported before reading CLS.
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
  const { cls, shell } = await page.evaluate(() => ({
    cls: (window as unknown as { __cls: number }).__cls,
    shell: document.documentElement.hasAttribute("data-boot-note"),
  }));
  return { editableMs, cls, shellShowedNote: shell };
}

test.beforeEach(async ({ page }, info) => {
  // Every navigation: the layout shifts of this page load (one observer per load).
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) if (!e.hadRecentInput) w.__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  await page.addInitScript((note) => {
    localStorage.setItem("lumen-tour-done", "1");
    // The note the user had open: the persisted store, as after a real session.
    if (!localStorage.getItem("lumen-md")) {
      localStorage.setItem("lumen-md", JSON.stringify({ state: { showWorkspace: true, mode: "source", doc: { name: "Last.md", content: note, dirty: false, workspaceName: null } }, version: 0 }));
    }
  }, NOTE);
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 30_000 });
  if (info.project.name === "coldstart-phone") {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
});

test("cold start: the last note is editable within budget, without layout shifts", { tag: "@coldstart" }, async ({ page }, info) => {
  test.setTimeout(300_000);
  const phone = info.project.name === "coldstart-phone";
  const budget = phone ? 1500 : 800;

  const small = await coldStart(page);
  report("cold start → last note editable (100 notes)", small.editableMs);
  report("CLS of the start", small.cls, "");
  expect(small.shellShowedNote, "the boot shell shows the note's own text").toBe(true);
  expect(small.cls).toBeLessThan(0.05);
  if (PROD) expect(small.editableMs).toBeLessThan(budget);

  test.skip(!(await canSeed(page)), "OPFS createWritable is unavailable in this engine's test context");
  await seedVault(page, 100);
  const hundred = await coldStart(page);
  await seedVault(page, 10_000);
  const big = await coldStart(page);
  report("cold start → last note editable (100-note vault)", hundred.editableMs);
  report("cold start → last note editable (10,000-note vault)", big.editableMs);
  expect(big.cls).toBeLessThan(0.05);
  if (PROD) {
    expect(big.editableMs).toBeLessThan(budget);
    expect(big.editableMs, "10,000 notes open within 15 % of 100").toBeLessThan(hundred.editableMs * 1.15);
  }
});

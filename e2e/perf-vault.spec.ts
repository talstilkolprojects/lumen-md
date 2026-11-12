import { test, expect, type Page } from "@playwright/test";

/**
 * Plan 8.4 — a large vault and a long document, in a real browser.
 *
 *   - 10,000 notes in OPFS: the app opens in < 1 s (asserted against the
 *     production build, where the e2e-prod job serves dist/; the dev
 *     server's on-the-fly transforms are not Lumen's startup), the file
 *     tree opens with folders collapsed, the index builds in the worker,
 *     a save reaches the index in < 50 ms and a search answers in < 100 ms.
 *   - typing into a 2 MB note keeps each keystroke under a frame (16 ms of
 *     handler time).
 *
 * Both are @nightly: they run only in the "perf" project (playwright.config.ts),
 * from the nightly runner (scripts/test-tiers.mjs), never in a per-push gate.
 *
 * Every number is also attached to the report as a "perf" annotation.
 */

const NOTES = 10_000;
const PROD = !!process.env.PLAYWRIGHT_BASE_URL;

/** What window.__lumen.vaultIndex() resolves to (src/storage/vaultIndexProbe.ts). */
interface Probe {
  ensureIndex(force?: boolean): Promise<void>;
  searchWorkspace(query: string, opts?: { limit?: number }): Promise<{ path: string }[]>;
  findBacklinks(path: string): Promise<{ fromPath: string }[]>;
  indexStats(): Promise<{ files: number; indexed: number; backlinkReads: number; engine: string }>;
  writeWorkspaceFile(path: string, content: string): Promise<void>;
  notifyWorkspaceChanged(change?: { kind: "content" | "structure"; paths?: string[] }): void;
}

function report(name: string, value: number, unit = "ms"): void {
  test.info().annotations.push({ type: "perf", description: `${name}: ${Math.round(value * 10) / 10} ${unit}` });
}

/** OPFS with `createWritable` (Playwright WebKit has neither in its test context). */
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

/** Write `count` notes straight into OPFS: notes/<k>/n<i>.md, 500 per folder, each linking to the next. */
async function seedVault(page: Page, count: number): Promise<number> {
  return page.evaluate(async (n) => {
    const t0 = performance.now();
    const root = await navigator.storage.getDirectory();
    const notes = await root.getDirectoryHandle("notes", { create: true });
    const dirs = new Map<number, FileSystemDirectoryHandle>();
    for (let k = 0; k * 500 < n; k++) dirs.set(k, await notes.getDirectoryHandle(String(k), { create: true }));
    const write = async (i: number) => {
      const dir = dirs.get(Math.floor(i / 500))!;
      const fh = await dir.getFileHandle(`n${i}.md`, { create: true });
      const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      const hebrew = i % 10 === 0 ? "\n\nשָׁלוֹם עולם" : "";
      await w.write(`# Note ${i}\n\nLinks to [[n${(i + 1) % n}]]. Topic word${i}.${hebrew}\n`);
      await w.close();
    };
    for (let i = 0; i < n; i += 250) await Promise.all(Array.from({ length: Math.min(250, n - i) }, (_, k) => write(i + k)));
    return performance.now() - t0;
  }, count);
}

/** Time from navigation start to the first frame where `selector` exists. */
async function msUntil(page: Page, selector: string, timeout: number): Promise<number> {
  const handle = await page.waitForFunction((sel) => (document.querySelector(sel) ? performance.now() : 0), selector, {
    polling: "raf",
    timeout,
  });
  return (await handle.jsonValue()) as number;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 30_000 });
});

// @nightly (W6.8): its budgets are wall-clock times, which the 2-CPU Vercel
// build machine missed by a hair (open 1017 ms, verify/e2e-probe run 4). It runs
// in the "perf" project on the nightly host, against the production build.
test("a 10,000-note vault: open < 1 s, save → index < 50 ms, search < 100 ms", { tag: "@nightly" }, async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(!(await canSeed(page)), "OPFS createWritable is unavailable in this engine's test context");
  report("seed 10,000 notes (test setup)", await seedVault(page, NOTES));

  // Reopen with the workspace panel showing, as a user with a big vault would.
  await page.addInitScript(() => {
    localStorage.setItem("lumen-md", JSON.stringify({ state: { showWorkspace: true }, version: 0 }));
  });
  await page.reload();
  const openMs = await msUntil(page, ".cm-content, [data-preview-root] .prose-lumen > :not(:empty)", 30_000);
  const treeMs = await msUntil(page, "aside.file-tree .file-tree-item", 60_000);
  report("open (navigation → editor or preview)", openMs);
  report("file tree listed (navigation → first row)", treeMs);
  if (PROD) expect(openMs, "open with a 10,000-note vault").toBeLessThan(1000);
  // Over LARGE_VAULT_FILES the folders start collapsed: no 10,000 rows.
  const tree = page.locator("aside.file-tree");
  await expect(tree.locator('[role="treeitem"][aria-expanded="false"]').first()).toBeVisible();
  expect(await tree.locator(".file-tree-item").count()).toBeLessThan(100);

  const build = await page.evaluate(async () => {
    const m = await (window as unknown as { __lumen: { vaultIndex(): Promise<Probe> } }).__lumen.vaultIndex();
    const t0 = performance.now();
    await m.ensureIndex();
    return { ms: performance.now() - t0, stats: await m.indexStats() };
  });
  report("first index build (10,000 notes, in the worker)", build.ms);
  expect(build.stats.files).toBeGreaterThanOrEqual(NOTES);
  expect(build.stats.engine).toBe("worker");

  const save = await page.evaluate(async () => {
    const m = await (window as unknown as { __lumen: { vaultIndex(): Promise<Probe> } }).__lumen.vaultIndex();
    const before = await m.indexStats();
    await m.writeWorkspaceFile("notes/0/n1.md", "# Note 1\n\nNow about zebracorns and [[n42]].\n");
    m.notifyWorkspaceChanged({ kind: "content", paths: ["notes/0/n1.md"] });
    const t0 = performance.now();
    await m.ensureIndex();
    const ms = performance.now() - t0;
    const after = await m.indexStats();
    const hits = await m.searchWorkspace("zebracorns");
    return { ms, indexed: after.indexed - before.indexed, hit: hits[0]?.path };
  });
  report("save → index (one note)", save.ms);
  expect(save.indexed, "a save re-indexes the saved note only").toBe(1);
  expect(save.hit).toBe("notes/0/n1.md");
  expect(save.ms).toBeLessThan(50);

  const search = await page.evaluate(async () => {
    const m = await (window as unknown as { __lumen: { vaultIndex(): Promise<Probe> } }).__lumen.vaultIndex();
    const time = async <T,>(fn: () => Promise<T>) => {
      const t0 = performance.now();
      const result = await fn();
      return { result, ms: performance.now() - t0 };
    };
    const word = await time(() => m.searchWorkspace("word4321"));
    const hebrew = await time(() => m.searchWorkspace("והעולם"));
    const before = (await m.indexStats()).backlinkReads;
    const back = await time(() => m.findBacklinks("notes/10/n5000.md"));
    const reads = (await m.indexStats()).backlinkReads - before;
    return {
      word: { ms: word.ms, top: word.result[0]?.path },
      hebrew: { ms: hebrew.ms, count: hebrew.result.length },
      back: { ms: back.ms, from: back.result.map((h) => h.fromPath), reads },
    };
  });
  report("search (word)", search.word.ms);
  report("search (Hebrew, prefix + niqqud folding)", search.hebrew.ms);
  report("backlinks", search.back.ms);
  expect(search.word.top).toBe("notes/8/n4321.md");
  expect(search.word.ms).toBeLessThan(100);
  // "והעולם" finds "שָׁלוֹם עולם" (every tenth note): prefix letters and niqqud folded.
  expect(search.hebrew.count).toBeGreaterThan(0);
  expect(search.hebrew.ms).toBeLessThan(100);
  expect(search.back.from).toEqual(["notes/9/n4999.md"]);
  expect(search.back.reads, "backlinks read only the linking notes").toBe(1);
  expect(search.back.ms).toBeLessThan(100);
});

test("typing in a 2 MB note keeps each keystroke under a frame", { tag: "@nightly" }, async ({ page }) => {
  test.setTimeout(300_000);
  test.skip(!(await canSeed(page)), "OPFS createWritable is unavailable in this engine's test context");
  const last = await page.evaluate(async () => {
    let s = "";
    let i = 0;
    while (s.length < 2 * 1024 * 1024) {
      s += `## Section ${i}\n\nParagraph ${i} with **bold** text, a [[note ${i}]] link and \`code\`.\n\n- one\n- two\n\n`;
      if (i % 50 === 0) s += "```js\nconst x = " + i + ";\n```\n\n";
      i++;
    }
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle("big.md", { create: true });
    const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
    await w.write(s);
    await w.close();
    return i - 1;
  });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "big.md" } })));
  await expect(page.locator(".cm-content").first()).toContainText("Section 0", { timeout: 60_000 });
  // The preview has rendered the whole note (block by block).
  report("preview of 2 MB rendered (navigation → last heading)", await msUntil(page, `[data-preview-root] #section-${last}`, 180_000));

  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.press("ControlOrMeta+End");
  await page.evaluate(() => {
    const perf = { slowKeys: [] as number[], longTasks: [] as number[], frames: [] as number[] };
    (window as unknown as { __perf: typeof perf }).__perf = perf;
    // Event timing reports only events of 16 ms or more: those are the slow keystrokes.
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (e.name === "keydown" || e.name === "keypress" || e.name === "beforeinput" || e.name === "input") {
          perf.slowKeys.push(e.processingEnd - e.processingStart);
        }
      }
    }).observe({ type: "event", durationThreshold: 16 } as PerformanceObserverInit);
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) perf.longTasks.push(e.duration);
    }).observe({ type: "longtask" });
    let prev = performance.now();
    const frame = (t: number) => {
      perf.frames.push(t - prev);
      prev = t;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
  const typed = " The quick brown fox jumps over the lazy dog.";
  await page.keyboard.type(typed, { delay: 40 });
  await expect(page.locator("[data-preview-root]")).toContainText("lazy dog.", { timeout: 30_000 });
  const perf = await page.evaluate(() => (window as unknown as { __perf: { slowKeys: number[]; longTasks: number[]; frames: number[] } }).__perf);
  const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)] ?? 0;
  const overFrame = perf.slowKeys.filter((ms) => ms >= 16).length;
  report("key events with 16 ms or more of handler time", overFrame, `of ${typed.length} keystrokes`);
  report("p95 frame interval while typing", p95(perf.frames));
  report("longest task while typing", Math.max(0, ...perf.longTasks));
  // ≤ 5% of the key events may take a frame or more (p95 < 16 ms).
  expect(overFrame).toBeLessThanOrEqual(Math.floor(typed.length * 0.05));
});

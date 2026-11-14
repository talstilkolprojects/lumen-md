import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan W1.22 — responsiveness budget, in Chromium with the CPU slowed 4×
 * (a mid-range phone, like Lighthouse's mobile profile).
 *
 *   - INP: 20 fixed interactions (palette, view modes, opening and switching
 *     notes, typing, a task checkbox, search, undo). Each one's duration is
 *     the longest Event Timing entry it caused (input → next paint); an
 *     interaction the browser does not report took under 16 ms and counts
 *     as 16. Budget: p75 < 100 ms.
 *   - keypress → paint: 100 keystrokes at the end of a 50 KB and of a 2 MB
 *     note, each timed from the key event to the frame after it. Budget:
 *     p95 < 16 ms (50 KB) and < 33 ms (2 MB).
 *
 * The numbers go to reports/perf/inp-latest.json; `npm run perf:inp:gate`
 * (scripts/perf/inp-gate.mjs) compares them with the committed baseline and
 * fails on a regression of 10 % or more. Runs only in the "inp" project
 * (`npm run perf:inp`), never in the per-browser PR runs.
 */

const REPORT_DIR = join(__dirname, "..", "reports", "perf");
const CPU_SLOWDOWN = 4;

interface Metrics {
  inpP75: number;
  interactions: Array<{ name: string; ms: number }>;
  keyToPaintP95: { "50KB": number; "2MB": number };
}
const metrics: Partial<Metrics> = {};

function quantile(values: number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.ceil(q * s.length) - 1)];
}

function report(name: string, value: number): void {
  test.info().annotations.push({ type: "perf", description: `${name}: ${Math.round(value * 10) / 10} ms` });
}

/** Wait for two frames: the one the input produced and the next. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
}

async function slowDown(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_SLOWDOWN });
}

/** Write a note straight into OPFS and open it. */
async function openNote(page: Page, path: string, text: string, expectText: string): Promise<void> {
  await page.evaluate(
    async ({ path, text }) => {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle(path, { create: true });
      const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await w.write(text);
      await w.close();
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
    },
    { path, text },
  );
  await expect(page.locator(".cm-content").first()).toContainText(expectText, { timeout: 60_000 });
}

function noteOfSize(bytes: number): string {
  let s = "";
  for (let i = 0; s.length < bytes; i++) {
    s += `## Section ${i}\n\nParagraph ${i} with **bold** text, a [[note ${i}]] link and \`code\`.\n\n- [ ] task ${i}\n- two\n\n`;
    if (i % 50 === 0) s += "```js\nconst x = " + i + ";\n```\n\n";
  }
  return s;
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "CPU throttling and Event Timing need Chromium");
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { showWorkspace: true }, version: 0 }));
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 30_000 });
  await page.locator("header").first().waitFor({ state: "visible" });
});

test("INP p75 < 100 ms over 20 interactions (CPU 4× slower)", { tag: "@inp" }, async ({ page }) => {
  test.setTimeout(240_000);
  await openNote(page, "inp-a.md", "# Note A\n\n- [ ] first task\n- [ ] second task\n\nSome text.\n", "Note A");
  await openNote(page, "inp-b.md", "# Note B\n\nOther text.\n", "Note B");
  await page.evaluate(() => {
    const seen: Array<{ start: number; duration: number }> = [];
    (window as unknown as { __inp: typeof seen }).__inp = seen;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEventTiming[]) {
        if (e.interactionId) seen.push({ start: e.startTime, duration: e.duration });
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  });
  await slowDown(page);

  const editor = page.locator(".cm-content").first();
  const tree = page.locator("aside.file-tree");
  const steps: Array<[string, () => Promise<void>]> = [
    ["palette: open", () => page.keyboard.press("ControlOrMeta+K")],
    ["palette: type", () => page.keyboard.type("t")],
    ["palette: next option", () => page.keyboard.press("ArrowDown")],
    ["palette: close", () => page.keyboard.press("Escape")],
    ["view: source", () => page.keyboard.press("ControlOrMeta+1")],
    ["view: split", () => page.keyboard.press("ControlOrMeta+2")],
    ["view: preview", () => page.keyboard.press("ControlOrMeta+3")],
    ["task: check in the preview", () => page.locator("[data-preview-root] input[type=checkbox]").first().click()],
    ["view: back to source", () => page.keyboard.press("ControlOrMeta+1")],
    ["note: open from the tree", () => tree.locator(".file-tree-name", { hasText: "inp-a.md" }).first().click()],
    ["note: switch to the other", () => tree.locator(".file-tree-name", { hasText: "inp-b.md" }).first().click()],
    ["editor: focus", () => editor.click()],
    ["editor: go to the end", () => page.keyboard.press("ControlOrMeta+End")],
    ["editor: type a letter", () => page.keyboard.type("x")],
    ["editor: new line", () => page.keyboard.press("Enter")],
    ["editor: delete", () => page.keyboard.press("Backspace")],
    ["editor: undo", () => page.keyboard.press("ControlOrMeta+Z")],
    ["search: open", () => page.keyboard.press("ControlOrMeta+Shift+F")],
    ["search: type", () => page.keyboard.type("n")],
    ["search: close", () => page.keyboard.press("Escape")],
  ];
  expect(steps).toHaveLength(20);

  const starts: number[] = [];
  for (const [, act] of steps) {
    starts.push(await page.evaluate(() => performance.now()));
    await act();
    await settle(page);
  }
  // Entries are queued after the paint: wait until the last interaction's frame has been reported.
  await settle(page);
  const entries = await page.evaluate(() => (window as unknown as { __inp: Array<{ start: number; duration: number }> }).__inp);
  const interactions = steps.map(([name], i) => {
    const from = starts[i];
    const to = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    const own = entries.filter((e) => e.start >= from && e.start < to).map((e) => e.duration);
    return { name, ms: own.length ? Math.max(...own) : 16 };
  });
  for (const it of interactions) report(`INP ${it.name}`, it.ms);
  const p75 = quantile(
    interactions.map((i) => i.ms),
    0.75,
  );
  report("INP p75", p75);
  metrics.inpP75 = p75;
  metrics.interactions = interactions;
  expect(p75, `INP p75 (slowest: ${[...interactions].sort((a, b) => b.ms - a.ms).slice(0, 3).map((i) => `${i.name} ${Math.round(i.ms)} ms`).join(", ")})`).toBeLessThan(100);
});

for (const [label, bytes, budget] of [
  ["50KB", 50 * 1024, 16],
  ["2MB", 2 * 1024 * 1024, 33],
] as const) {
  test(`keypress → paint p95 < ${budget} ms in a ${label} note (CPU 4× slower)`, { tag: "@inp" }, async ({ page }) => {
    test.setTimeout(300_000);
    await openNote(page, `inp-${label}.md`, noteOfSize(bytes), "Section 0");
    const editor = page.locator(".cm-content").first();
    await editor.click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.evaluate(() => {
      const times: number[] = [];
      (window as unknown as { __k2p: number[] }).__k2p = times;
      // From the key event to the frame after it: rAF runs before the paint,
      // the message after it lands once that frame is painted.
      document.addEventListener(
        "keydown",
        (e) => {
          const t0 = e.timeStamp;
          requestAnimationFrame(() => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => times.push(performance.now() - t0);
            ch.port2.postMessage(0);
          });
        },
        { capture: true },
      );
    });
    await slowDown(page);
    for (let i = 0; i < 100; i++) {
      await page.keyboard.press(i % 10 === 9 ? "Enter" : "a");
      await settle(page);
    }
    const times = await page.evaluate(() => (window as unknown as { __k2p: number[] }).__k2p);
    expect(times.length).toBeGreaterThanOrEqual(95);
    const p95 = quantile(times, 0.95);
    report(`keypress → paint p95 (${label})`, p95);
    metrics.keyToPaintP95 = { ...(metrics.keyToPaintP95 ?? { "50KB": 0, "2MB": 0 }), [label]: p95 };
    expect(p95).toBeLessThan(budget);
  });
}

test.afterAll(() => {
  if (metrics.inpP75 === undefined && metrics.keyToPaintP95 === undefined) return;
  mkdirSync(REPORT_DIR, { recursive: true });
  const out = { at: new Date().toISOString(), cpuSlowdown: CPU_SLOWDOWN, ...metrics };
  writeFileSync(join(REPORT_DIR, "inp-latest.json"), JSON.stringify(out, null, 2) + "\n");
});

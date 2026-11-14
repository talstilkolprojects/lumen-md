import { test, expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  installInpObserver,
  installKeyToPaint,
  interactionsFromEntries,
  noteOfSize,
  quantile,
  twoFrames,
  type InpEntry,
} from "./perf/probes";

/**
 * Plan W6.45: INP and keypress → paint in both editors (source and WYSIWYG)
 * on a 10,000-note vault, per environment:
 *
 *   inp-desktop   Desktop Chrome, CPU as is               budget INP p75 < 100 ms
 *   inp-phone     Pixel 7 emulation, CPU 4× slower        budget INP p75 < 200 ms
 *   BrowserStack  real Pixel and iPhone (scripts/perf/browserstack.mjs, project
 *                 named by the SDK after the device)      budget INP p75 < 200 ms
 *
 * keypress → paint p95 budgets: < 16 ms in a 50 KB note, < 33 ms in a 2 MB
 * note. A browser without Event Timing (Safari) measures keypress → paint
 * only; INP is then "not measured", never 0.
 *
 * Writes reports/perf/responsiveness/<env>.json. `npm run perf:responsiveness`
 * runs these projects against the production build, gates the run against the
 * environment's baseline (+10 % fails) and seals a lumen-metric receipt
 * (scripts/perf/responsiveness.mjs). Tagged @responsiveness: never in the
 * per-browser PR runs.
 */

const NOTES = 10_000;
const OUT_DIR = join(__dirname, "..", "reports", "perf", "responsiveness");
type EditorName = "source" | "wysiwyg";
interface EditorResult {
  inpP75: number | null;
  interactions: { name: string; ms: number }[];
  k2pP95: { "50KB": number; "2MB": number };
}
interface Env {
  env: string;
  device: string;
  cpuSlowdown: number;
  scored: boolean;
  inpBudget: number;
}
const results: Partial<Record<EditorName, EditorResult>> = {};
let eventTiming = false;
/** Whether the related-notes panel (W2.2) was open: the plan measures with it. */
let relatedPanel = false;
let envOf: Env | null = null;

function environment(info: TestInfo): Env {
  const m = (info.project.metadata ?? {}) as Partial<Env>;
  const name = info.project.name || "unnamed";
  // A BrowserStack SDK project has no metadata: a real device, CPU as it is.
  return {
    env: m.env ?? `real-device-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`,
    device: m.device ?? name,
    cpuSlowdown: m.cpuSlowdown ?? 1,
    scored: m.scored ?? true,
    inpBudget: m.inpBudget ?? 200,
  };
}

function note(name: string, value: number): void {
  test.info().annotations.push({ type: "perf", description: `${name}: ${Math.round(value * 10) / 10} ms` });
}

/** CPU throttling through CDP, where there is one (Chromium); real devices run as they are. */
async function throttle(page: Page, rate: number): Promise<void> {
  if (rate <= 1) return;
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  } catch {
    throw new Error(`CPU ×${rate} needs Chromium's DevTools protocol`);
  }
}

/** 10,000 notes in OPFS (notes/<k>/n<i>.md, as e2e/perf-vault.spec.ts) plus the two long notes. */
async function seed(page: Page): Promise<boolean> {
  return page.evaluate(
    async ({ n, mid, big }) => {
      const root = await navigator.storage.getDirectory();
      const probe = await root.getFileHandle("__probe", { create: true });
      if (typeof (probe as unknown as { createWritable?: unknown }).createWritable !== "function") return false;
      await root.removeEntry("__probe");
      const put = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await (fh as unknown as { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
        await w.write(text);
        await w.close();
      };
      const notes = await root.getDirectoryHandle("notes", { create: true });
      const dirs: FileSystemDirectoryHandle[] = [];
      for (let k = 0; k * 500 < n; k++) dirs.push(await notes.getDirectoryHandle(String(k), { create: true }));
      for (let i = 0; i < n; i += 250)
        await Promise.all(
          Array.from({ length: Math.min(250, n - i) }, (_, j) => i + j).map((x) =>
            put(dirs[Math.floor(x / 500)], `n${x}.md`, `# Note ${x}\n\nLinks to [[n${(x + 1) % n}]]. Topic word${x}.${x % 10 === 0 ? "\n\nשָׁלוֹם עולם" : ""}\n`),
          ),
        );
      await put(root, "inp-a.md", "# Note A\n\n- [ ] first task\n\nSome text. טקסט.\n");
      await put(root, "inp-b.md", "# Note B\n\nOther text.\n");
      await put(root, "inp-50KB.md", mid);
      await put(root, "inp-2MB.md", big);
      return true;
    },
    { n: NOTES, mid: noteOfSize(50 * 1024), big: noteOfSize(2 * 1024 * 1024) },
  );
}

const surface = (page: Page, editor: EditorName) => page.locator(editor === "source" ? ".cm-content" : ".ProseMirror").first();

async function open(page: Page, editor: EditorName, path: string, text: string): Promise<void> {
  await page.evaluate((p) => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: p } })), path);
  await page.keyboard.press(editor === "source" ? "ControlOrMeta+1" : "ControlOrMeta+4");
  await expect(surface(page, editor)).toContainText(text, { timeout: 120_000 });
}

/**
 * Open the related-notes panel (W2.2) through its palette command, before
 * the observers start, so its own opening is not an interaction measured.
 * It stays open while the steps type, switch notes and search: it re-ranks
 * after every typing pause. A build without the command (before W2.2) runs
 * without it, and the run says so: its numbers then score no board metric.
 */
async function openRelated(page: Page): Promise<boolean> {
  const panel = page.getByTestId("related-panel");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "related.toggle" } })));
  try {
    await expect(panel).toBeVisible({ timeout: 15_000 });
    return true;
  } catch {
    // why: no related.toggle command in this build; the run records relatedPanel: false instead of failing
    return false;
  }
}

async function measureEditor(page: Page, editor: EditorName, env: Env): Promise<EditorResult> {
  await open(page, editor, "inp-a.md", "Note A");
  relatedPanel = await openRelated(page);
  test.info().annotations.push({ type: "perf", description: `${editor}: related-notes panel ${relatedPanel ? "open" : "not in this build"}` });
  eventTiming = await page.evaluate(installInpObserver);
  await throttle(page, env.cpuSlowdown);
  const tree = page.locator("aside.file-tree");
  const treeShown = await tree.isVisible();
  const ed = surface(page, editor);
  const steps: [string, () => Promise<void>][] = [
    ["palette: open", () => page.keyboard.press("ControlOrMeta+K")],
    ["palette: type", () => page.keyboard.type("n")],
    ["palette: next option", () => page.keyboard.press("ArrowDown")],
    ["palette: close", () => page.keyboard.press("Escape")],
    ...(treeShown
      ? ([
          ["note: switch in the tree", () => tree.locator(".file-tree-name", { hasText: "inp-b.md" }).first().click()],
          ["note: switch back", () => tree.locator(".file-tree-name", { hasText: "inp-a.md" }).first().click()],
        ] as [string, () => Promise<void>][])
      : []),
    ["editor: focus", () => ed.click()],
    ["editor: go to the end", () => page.keyboard.press("ControlOrMeta+End")],
    ["editor: type a letter", () => page.keyboard.type("x")],
    ["editor: type Hebrew", () => page.keyboard.type("ש")],
    ["editor: new line", () => page.keyboard.press("Enter")],
    ["editor: delete", () => page.keyboard.press("Backspace")],
    ["editor: undo", () => page.keyboard.press("ControlOrMeta+Z")],
    ["search: open", () => page.keyboard.press("ControlOrMeta+Shift+F")],
    ["search: type", () => page.keyboard.type("word42")],
    ["search: close", () => page.keyboard.press("Escape")],
  ];
  const starts: number[] = [];
  for (const [, act] of steps) {
    starts.push(await page.evaluate(() => performance.now()));
    await act();
    await page.evaluate(twoFrames);
  }
  await page.evaluate(twoFrames);
  let inpP75: number | null = null;
  let interactions: { name: string; ms: number }[] = [];
  if (eventTiming) {
    const entries = await page.evaluate(() => window.__lumenInp ?? ([] as InpEntry[]));
    interactions = interactionsFromEntries(steps.map(([n]) => n), starts, entries);
    inpP75 = quantile(interactions.map((i) => i.ms), 0.75);
    for (const i of interactions) note(`${editor} INP ${i.name}`, i.ms);
    note(`${editor} INP p75`, inpP75);
  }
  await throttle(page, 1);

  const k2pP95 = { "50KB": 0, "2MB": 0 };
  for (const [label, path] of [["50KB", "inp-50KB.md"], ["2MB", "inp-2MB.md"]] as const) {
    await open(page, editor, path, "Section 0");
    await surface(page, editor).click();
    await page.keyboard.press("ControlOrMeta+End");
    await page.evaluate(installKeyToPaint);
    await throttle(page, env.cpuSlowdown);
    for (let i = 0; i < 100; i++) {
      // press() knows only the US layout's keys: Hebrew letters are typed (a keydown + input like a real key).
      if (i % 3 === 0 && i % 10 !== 9) await page.keyboard.type("ש");
      else await page.keyboard.press(i % 10 === 9 ? "Enter" : "a");
      await page.evaluate(twoFrames);
    }
    await throttle(page, 1);
    const times = await page.evaluate(() => window.__lumenK2p ?? []);
    // Typed Hebrew arrives as text input with no keydown, so only the pressed keys (70 of 100) are timed.
    const pressed = Array.from({ length: 100 }, (_, i) => i).filter((i) => !(i % 3 === 0 && i % 10 !== 9)).length;
    expect(times.length, `keypress → paint samples in ${label}`).toBeGreaterThanOrEqual(pressed - 5);
    k2pP95[label] = quantile(times, 0.95);
    note(`${editor} keypress → paint p95 (${label})`, k2pP95[label]);
  }
  return { inpP75, interactions, k2pP95 };
}

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page, browserName }, info) => {
  envOf = environment(info);
  test.skip(envOf.cpuSlowdown > 1 && browserName !== "chromium", "CPU throttling needs Chromium");
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { showWorkspace: true }, version: 0 }));
  });
  await page.goto("/");
  await expect(page.locator(".cm-content, .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
  test.skip(!(await seed(page)), "OPFS createWritable is unavailable in this engine's test context");
  await page.reload();
  await expect(page.locator(".cm-content, .ProseMirror").first()).toBeVisible({ timeout: 60_000 });
});

for (const editor of ["source", "wysiwyg"] as const) {
  test(`${editor} editor: INP and keypress → paint on a 10,000-note vault`, { tag: "@responsiveness" }, async ({ page }) => {
    test.setTimeout(900_000);
    const env = envOf!;
    const r = await measureEditor(page, editor, env);
    results[editor] = r;
    if (r.inpP75 !== null)
      expect(r.inpP75, `${editor} INP p75 on ${env.device} (slowest: ${[...r.interactions].sort((a, b) => b.ms - a.ms).slice(0, 3).map((i) => `${i.name} ${Math.round(i.ms)} ms`).join(", ")})`).toBeLessThan(env.inpBudget);
    expect(r.k2pP95["50KB"], `${editor} keypress → paint p95, 50 KB`).toBeLessThan(16);
    expect(r.k2pP95["2MB"], `${editor} keypress → paint p95, 2 MB`).toBeLessThan(33);
  });
}

test.afterAll(() => {
  if (!envOf || !Object.keys(results).length) return;
  mkdirSync(OUT_DIR, { recursive: true });
  const run = {
    format: "lumen-responsiveness",
    version: 1,
    ...envOf,
    eventTiming,
    relatedPanel,
    vaultNotes: NOTES,
    at: new Date().toISOString(),
    editors: results,
  };
  writeFileSync(join(OUT_DIR, `${envOf.env}.json`), JSON.stringify(run, null, 2) + "\n");
});

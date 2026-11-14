import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// @ts-expect-error -- plain ESM builder, no types
import { bidi } from "../scripts/golden/sets/small.mjs";

/**
 * Plan 9.7: keyboard editing of 30 mixed Hebrew / English / neutral lines
 * from the bidi golden set, in the source editor (CodeMirror) and the
 * WYSIWYG editor (ProseMirror), in the real browser.
 *
 * Lines: the committed dev split (8), plus 22 more from the set's own
 * builder. With GOLDEN_SEED (the golden workflow's secret) those 22 are the
 * held-out test split; without it — every pull request — they are built
 * with a public seed, so they are the same kind of line but not the
 * held-out items.
 *
 * Per line and editor, the scenario is correct when:
 *   1. the line gets the set's direction (a neutral line: the note's, LTR here);
 *   2. from the line's start, the arrow that points toward its end — Left
 *      in RTL, Right in LTR — visits every grapheme boundary in text order,
 *      through Latin tokens, numbers, brackets and marks (logical order);
 *   3. the opposite arrow walks back the same way;
 *   4. Shift + that arrow selects the first characters of the text, in order.
 */

type Item = { id: string; line: string; dir: "rtl" | "ltr" | "neutral" };

function lines(): Item[] {
  const dev = JSON.parse(readFileSync(join(import.meta.dirname, "..", "eval", "golden", "bidi", "dev", "lines.json"), "utf8")).items as Item[];
  const seed = process.env.GOLDEN_SEED || "public-e2e-9.7";
  const { test: rest } = bidi.select(bidi.pool(), { set: "bidi", part: "lines", nDev: 8, nTest: 22, secret: seed }) as { test: Item[] };
  return [...dev, ...rest];
}
const ITEMS = lines();

const SELECT_STEPS = 4;

// One page per worker, lines in order; a failing line does not skip the others.
test.describe.configure({ mode: "default" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test.afterAll(async () => {
  await page.close();
});

/** Replace the note with one line, in the source editor. */
async function loadLine(line: string): Promise<void> {
  await page.keyboard.press("Meta+1");
  const source = page.locator(".cm-content").first();
  await expect(source).toBeVisible();
  await source.click();
  // Through CodeMirror itself, not select-all + typing: WebKit sometimes
  // kept a line break from the select-all (the scenario is the arrows,
  // not loading the line).
  await page.evaluate((text) => {
    type View = { state: { doc: { length: number } }; dispatch(tr: unknown): void; focus(): void };
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: 0 }, userEvent: "input" });
    view?.focus();
  }, line);
  await expect.poll(() => sourceState().then((s) => s.text)).toBe(line);
}

/** CodeMirror's text, selection and line direction (EditorView.findFromDOM without importing CodeMirror). */
function sourceState(): Promise<{ text: string; anchor: number; head: number; dir: string; css: string }> {
  return page.evaluate(() => {
    type View = { state: { doc: { toString(): string }; selection: { main: { anchor: number; head: number } } } };
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    const line = document.querySelector(".cm-content .cm-line");
    return {
      text: view?.state.doc.toString() ?? "",
      anchor: view?.state.selection.main.anchor ?? -1,
      head: view?.state.selection.main.head ?? -1,
      dir: line?.getAttribute("dir") ?? "",
      css: line ? getComputedStyle(line).direction : "",
    };
  });
}

/** The WYSIWYG textblock around the caret: its text, the caret's offset in it, its direction and the selected text. */
async function wysiwygState(): Promise<{ text: string; offset: number; dir: string; selected: string; html: string }> {
  // WebKit can report no DOM selection for a moment after a key event while
  // ProseMirror re-applies it: wait (a condition, bounded) until there is one in the editor.
  await page
    .waitForFunction(() => {
      const n = getSelection()?.focusNode;
      return !!n && !!document.querySelector(".ProseMirror")?.contains(n);
    }, null, { timeout: 2000 })
    .catch(() => undefined);
  return readWysiwygState();
}

function readWysiwygState(): Promise<{ text: string; offset: number; dir: string; selected: string; html: string }> {
  return page.evaluate(() => {
    const sel = getSelection();
    const pm = document.querySelector(".ProseMirror");
    let block: Element | null = null;
    if (sel?.focusNode && pm?.contains(sel.focusNode)) {
      const start = sel.focusNode instanceof Element ? sel.focusNode : sel.focusNode.parentElement;
      block = start?.closest("p, h1, h2, h3, h4, h5, h6") ?? null;
    }
    block ??= pm?.querySelector("p, h1, h2, h3, h4, h5, h6") ?? null;
    if (!block || !sel || !sel.focusNode) return { text: "", offset: -1, dir: "", selected: "", html: "" };
    // Text inside contenteditable=false widgets (drag handles, task boxes) is not the block's text.
    const inWidget = (n: Node) => {
      const w = n.parentElement?.closest('[contenteditable="false"]');
      return !!w && block!.contains(w);
    };
    const r = document.createRange();
    r.setStart(block, 0);
    r.setEnd(sel.focusNode, sel.focusOffset);
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let text = "";
    let offset = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (inWidget(n)) continue;
      const t = n.textContent ?? "";
      if (n === sel.focusNode) offset = text.length + sel.focusOffset;
      else if (r.intersectsNode(n) && r.comparePoint(n, t.length) <= 0) offset = text.length + t.length;
      text += t;
    }
    return { text, offset, dir: getComputedStyle(block).direction, selected: sel.toString(), html: (block.closest("li, blockquote") ?? block).outerHTML.slice(0, 700) };
  });
}

/** Grapheme boundaries after 0, in text order. */
function boundaries(text: string): number[] {
  const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const out = [...seg.segment(text)].map((s) => s.index).filter((i) => i > 0);
  out.push(text.length);
  return out;
}

const expectedDir = (it: Item) => (it.dir === "neutral" ? "ltr" : it.dir);

for (const it of ITEMS) {
  test(`source: ${it.id} ${JSON.stringify(it.line)}`, async () => {
    await loadLine(it.line);
    const dir = expectedDir(it);
    const s0 = await sourceState();
    expect(s0.dir, "the line's dir").toBe(dir);
    expect(s0.css, "the line's computed direction").toBe(dir);
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const stops = boundaries(it.line);

    await page.keyboard.press("ControlOrMeta+Home");
    expect((await sourceState()).head).toBe(0);
    const seen: number[] = [];
    for (let i = 0; i < stops.length; i++) {
      await page.keyboard.press(forward);
      seen.push((await sourceState()).head);
    }
    expect(seen, `${forward} walks the text in order`).toEqual(stops);

    const back_: number[] = [];
    for (let i = 0; i < stops.length; i++) {
      await page.keyboard.press(back);
      back_.push((await sourceState()).head);
    }
    expect(back_, `${back} walks back`).toEqual([...stops.slice(0, -1)].reverse().concat(0));

    const k = Math.min(SELECT_STEPS, stops.length);
    for (let i = 0; i < k; i++) await page.keyboard.press(`Shift+${forward}`);
    const sel = await sourceState();
    expect([sel.anchor, sel.head], `Shift+${forward} selects in order`).toEqual([0, stops[k - 1]]);
  });
}

for (const it of ITEMS) {
  test(`wysiwyg: ${it.id} ${JSON.stringify(it.line)}`, async () => {
    await loadLine(it.line);
    await page.keyboard.press("Meta+4");
    const pm = page.locator(".ProseMirror").first();
    await expect(pm).toBeVisible({ timeout: 10_000 });
    // The note reaches the WYSIWYG editor once it has parsed it: wait for a word of the line.
    const word = it.line.replace(/\]\([^)]*\)/g, "]").match(/[\p{L}\p{N}]{2,}/u)?.[0] ?? "";
    await expect(pm).toContainText(word, { timeout: 10_000 });
    // The dev server runs React StrictMode, which builds the editor, drops it
    // and builds it again: wait until one editor element has stayed in place
    // for three polls in a row, or the caret lands in the one being dropped.
    let stable = 0;
    await expect
      .poll(
        async () => {
          const same = await page.evaluate(() => {
            const el = document.querySelector(".ProseMirror");
            const w = window as unknown as { __bidiProbe?: Element | null };
            const kept = !!el && w.__bidiProbe === el && (el.textContent ?? "").length > 0;
            w.__bidiProbe = el;
            return kept;
          });
          stable = same ? stable + 1 : 0;
          return stable;
        },
        { intervals: [100], timeout: 10_000 },
      )
      .toBeGreaterThanOrEqual(3);
    await pm.focus();
    // The caret at the start of the first block's text. Set through the DOM
    // selection: WebKit does not place a caret on focus() and its
    // Ctrl+Home is not reliable in contenteditable.
    await page.evaluate(() => {
      const root = document.querySelector(".ProseMirror");
      const block = root?.querySelector("p, h1, h2, h3, h4, h5, h6");
      if (!block) return;
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (n.parentElement?.closest('[contenteditable="false"]')) continue;
        const r = document.createRange();
        r.setStart(n, 0);
        r.collapse(true);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(r);
        return;
      }
    });
    await expect.poll(() => wysiwygState().then((st) => st.offset)).toBe(0);
    const s0 = await wysiwygState();
    expect(s0.offset, `the caret starts at the block's start: ${s0.html}`).toBe(0);
    const dir = expectedDir(it);
    expect(s0.dir, `the block's computed direction: ${s0.html}`).toBe(dir);
    const forward = dir === "rtl" ? "ArrowLeft" : "ArrowRight";
    const back = dir === "rtl" ? "ArrowRight" : "ArrowLeft";
    const stops = boundaries(s0.text);

    const seen: number[] = [];
    for (let i = 0; i < stops.length; i++) {
      await page.keyboard.press(forward);
      seen.push((await wysiwygState()).offset);
    }
    expect(seen, `${forward} walks the rendered text in order`).toEqual(stops);

    const back_: number[] = [];
    for (let i = 0; i < stops.length; i++) {
      await page.keyboard.press(back);
      back_.push((await wysiwygState()).offset);
    }
    expect(back_, `${back} walks back`).toEqual([...stops.slice(0, -1)].reverse().concat(0));

    const k = Math.min(SELECT_STEPS, stops.length);
    for (let i = 0; i < k; i++) await page.keyboard.press(`Shift+${forward}`);
    expect((await wysiwygState()).selected, `Shift+${forward} selects in order`).toBe(s0.text.slice(0, stops[k - 1]));
  });
}

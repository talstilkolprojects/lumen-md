import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fixBidiText } from "../src/lib/bidiMarks";
import { markdownLineDirection } from "../src/lib/bidiDirection";
import { goldenBidiLines, withNoiseMarks } from "../src/__tests__/fixtures/goldenBidiLines";

/**
 * Plan W5.4 in the real browser (Chromium, Firefox, WebKit):
 *
 *  1. Cleaning keeps the visual order: each line is laid out by the
 *     browser before and after fixBidi, and its visible characters must
 *     come out in the same left-to-right order on screen. The lines are the
 *     30 of the 9.7 golden set with unneeded marks added (GOLDEN_SEED gives
 *     the held-out ones), and the 30 marked lines of the W5.4 fixture.
 *  2. In the app: "Show direction marks" tags the controls, a pasted
 *     override gets the Trojan Source warning, its "Remove them" button
 *     deletes it, and "Clean direction marks and fix brackets" is one
 *     change that a single undo reverts.
 */

type Pair = { id: string; before: string; after: string; dir: string };

function pairs(): Pair[] {
  const out: Pair[] = [];
  goldenBidiLines().forEach((line, i) => {
    const noisy = withNoiseMarks(line);
    out.push({ id: `golden-${i}`, before: noisy, after: fixBidiText(noisy), dir: markdownLineDirection(line) ?? "ltr" });
  });
  const fixture = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__tests__", "fixtures", "bidi-marks-lines.json"), "utf8")).items as Array<{ id: string; line: string }>;
  for (const f of fixture) out.push({ id: f.id, before: f.line, after: fixBidiText(f.line, { brackets: false }), dir: markdownLineDirection(f.line) ?? "ltr" });
  return out;
}

/** In the page: each line's visible characters in on-screen order, left to right. */
function visualOrder(page: Page, list: Pair[]): Promise<Array<{ id: string; before: string; after: string }>> {
  return page.evaluate((items) => {
    const CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const lay = (line: string, dir: string) => {
      const div = document.createElement("div");
      div.dir = dir;
      div.style.cssText = "white-space:pre;font:16px sans-serif;position:absolute;top:0;left:0;width:1400px";
      div.textContent = line;
      host.appendChild(div);
      const node = div.firstChild!;
      const cells: Array<{ x: number; i: number; ch: string }> = [];
      for (let i = 0; i < line.length; ) {
        const cp = line.codePointAt(i)!;
        const len = cp > 0xffff ? 2 : 1;
        const ch = line.slice(i, i + len);
        if (!CONTROL.test(ch)) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + len);
          const rect = r.getClientRects()[0] ?? r.getBoundingClientRect();
          cells.push({ x: Math.round((rect.left + rect.right) * 5), i, ch });
        }
        i += len;
      }
      div.remove();
      return cells.sort((p, q) => p.x - q.x || p.i - q.i).map((c) => c.ch).join("");
    };
    const out = items.map((p) => ({ id: p.id, before: lay(p.before, p.dir), after: lay(p.after, p.dir) }));
    host.remove();
    return out;
  }, list);
}

test("cleaning direction marks keeps the visual order (60 lines)", async ({ page }) => {
  await page.setContent('<!doctype html><meta charset="utf-8"><body></body>');
  const list = pairs();
  expect(list.length).toBe(60);
  expect(list.filter((p) => p.before !== p.after).length).toBeGreaterThan(30); // cleaning did something
  const laid = await visualOrder(page, list);
  const changed = laid.filter((l) => l.before !== l.after).map((l) => l.id);
  expect(changed).toEqual([]);
  // The check can fail: an override does reorder.
  const control = await visualOrder(page, [{ id: "override", before: "שלום \u202dעולם\u202c", after: "שלום עולם", dir: "rtl" }]);
  expect(control[0].before).not.toBe(control[0].after);
});

type View = { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void; focus(): void };

/** Replace the note, or append to it with a user event ("input.paste"), through CodeMirror itself. */
function edit(page: Page, insert: string, userEvent: "input" | "input.paste", append = false): Promise<void> {
  return page.evaluate(
    ({ insert, userEvent, append }) => {
      const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
      const view = el?.cmTile?.root?.view;
      const end = view?.state.doc.length ?? 0;
      view?.dispatch({ changes: { from: append ? end : 0, to: end, insert }, userEvent });
    },
    { insert, userEvent, append },
  );
}

const text = (page: Page) => page.evaluate(() => (document.querySelector(".cm-content") as HTMLElement & { cmTile?: { root?: { view?: View } } }).cmTile?.root?.view?.state.doc.toString() ?? "");

async function palette(page: Page, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+k");
  const dialog = page.locator('[role="dialog"]').filter({ has: page.getByPlaceholder(/Type a command/i) });
  await dialog.waitFor({ timeout: 3000 });
  await dialog.locator("input").first().fill(query);
  await expect(dialog.locator('[role="option"][aria-selected="true"]')).toContainText(new RegExp(query, "i"), { timeout: 5000 });
  await page.keyboard.press("Enter");
  await expect(dialog).not.toBeVisible({ timeout: 3000 });
}

test("the app shows, warns about and cleans direction controls", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen.bidiMarks");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await page.keyboard.press("Meta+1");
  await page.locator(".cm-content").first().click();

  const note = "\u200fשלום לכולם\n)הערה( בסוף\n\u200f10:30 פגישה";
  await edit(page, note, "input");
  await expect.poll(() => text(page)).toBe(note);

  // Off by default: no tags for harmless marks.
  await expect(page.locator(".cm-bidi-tag")).toHaveCount(0);
  await palette(page, "Show direction marks");
  await expect(page.locator('.cm-bidi-tag[data-bidi="RLM"]')).toHaveCount(2);

  // A pasted override: red tag even with the switch off, and the warning.
  await palette(page, "Hide direction marks");
  await expect(page.locator(".cm-bidi-tag")).toHaveCount(0);
  await source(page, (view, t) => view.dispatch({ changes: { from: view.state.doc.length, insert: t }, userEvent: "input.paste" }), "\naccess = \"\u202euser\u202c\"");
  await expect(page.locator(".cm-bidi-tag-risk")).toHaveCount(1);
  const warning = page.getByRole("alert").filter({ hasText: /hides its real order/i });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: /Remove them/i }).click();
  await expect.poll(() => text(page)).toBe(note + '\naccess = "user"');
  await expect(page.locator(".cm-bidi-tag-risk")).toHaveCount(0);

  // Clean + fix brackets: one change, one undo.
  await palette(page, "Clean direction marks");
  await expect.poll(() => text(page)).toBe('שלום לכולם\n(הערה) בסוף\n\u200f10:30 פגישה\naccess = "user"');
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => text(page)).toBe(note + '\naccess = "user"');
});

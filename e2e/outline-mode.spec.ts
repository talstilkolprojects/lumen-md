import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W2.13 — outline mode and block operations on plain Markdown, in the
 * source editor (CodeMirror) and the WYSIWYG editor (ProseMirror), on a
 * Hebrew (RTL) list and an English (LTR) section:
 *
 *   1–2 move block up / down     Alt+Shift+↑ / ↓
 *   3–4 indent / outdent         Ctrl+Alt+→ / ← (the arrow toward the line's end indents: ← in RTL)
 *   5   duplicate                Alt+Shift+D
 *   6   delete                   Alt+Shift+Backspace
 *   7–8 fold / unfold            Ctrl+Alt+↑ / ↓
 *   9–10 zoom in / out           Ctrl+Alt+Enter, Escape / the "back" bar
 *
 * Folding and zoom leave the file byte-for-byte the same, and the fold state
 * is kept per note (localStorage), not in the file.
 */

const NOTE = [
  "# רשימה",
  "",
  "- פריט א",
  "  - תת א1",
  "- פריט ב",
  "- פריט ג",
  "",
  "# Alpha",
  "alpha text",
  "",
  "# Beta",
  "beta text",
  "",
].join("\n");

/**
 * The editors' "Mod": Meta where navigator.platform says Mac (Playwright's
 * WebKit does, on any OS), Control elsewhere — CodeMirror and ProseMirror
 * read the platform, not the OS the test runs on.
 */
async function mod(page: Page): Promise<string> {
  return (await page.evaluate(() => /Mac|iP(hone|[oa]d)/.test(navigator.platform))) ? "Meta" : "Control";
}

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    // Only on the first load of a test: a reload keeps the note and its folds.
    if (!sessionStorage.getItem("outline-e2e")) {
      sessionStorage.setItem("outline-e2e", "1");
      localStorage.removeItem("lumen-md");
      localStorage.removeItem("lumen-outline-folds");
      localStorage.removeItem("lumen-outline-mode");
    }
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 20_000 });
});

type View = { state: { doc: { length: number; toString(): string }; selection: { main: { head: number } } }; dispatch(tr: unknown): void; focus(): void };

/** Replace the note through CodeMirror, cursor at `at`. */
async function load(page: Page, text: string, at: string): Promise<void> {
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await page.evaluate(
    ([t, a]) => {
      const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
      const view = el?.cmTile?.root?.view;
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: t }, selection: { anchor: t.indexOf(a) }, userEvent: "input" });
      view?.focus();
    },
    [text, at] as const,
  );
  await expect.poll(() => source(page)).toBe(text);
}

function source(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    return el?.cmTile?.root?.view?.state.doc.toString() ?? "";
  });
}

/** Put the source cursor at the start of `at`. */
async function cursorAt(page: Page, at: string): Promise<void> {
  await page.evaluate((a) => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    view?.dispatch({ selection: { anchor: view.state.doc.toString().indexOf(a) } });
    view?.focus();
  }, at);
}

test("source editor: the ten block operations, in RTL and LTR", async ({ page }) => {
  const M = await mod(page);
  await load(page, NOTE, "- פריט ב");
  const lineDir = await page.locator(".cm-line", { hasText: "פריט ב" }).first().evaluate((el) => getComputedStyle(el).direction);
  expect(lineDir).toBe("rtl");

  // 1. Move up (RTL item).
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect.poll(() => source(page)).toContain("- פריט ב\n- פריט א\n  - תת א1\n- פריט ג");
  // 2. Move down: back where it was.
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect.poll(() => source(page)).toBe(NOTE);
  // 3. Indent: in a right-to-left line, ← (toward the line's end) indents.
  await page.keyboard.press(`${M}+Alt+ArrowLeft`);
  await expect.poll(() => source(page)).toContain("  - תת א1\n  - פריט ב\n- פריט ג");
  // 4. Outdent: →.
  await page.keyboard.press(`${M}+Alt+ArrowRight`);
  await expect.poll(() => source(page)).toBe(NOTE);
  // 5. Duplicate.
  await page.keyboard.press("Alt+Shift+D");
  await expect.poll(() => source(page)).toContain("- פריט ב\n- פריט ב\n- פריט ג");
  // 6. Delete (the copy, where the cursor went).
  await page.keyboard.press("Alt+Shift+Backspace");
  await expect.poll(() => source(page)).toBe(NOTE);

  // LTR: a whole section moves, and → indents (demotes) it.
  await cursorAt(page, "# Alpha");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect.poll(() => source(page)).toContain("# Beta\nbeta text\n\n# Alpha\nalpha text");
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect.poll(() => source(page)).toBe(NOTE);
  await page.keyboard.press(`${M}+Alt+ArrowRight`);
  await expect.poll(() => source(page)).toContain("## Alpha\nalpha text");
  await page.keyboard.press(`${M}+Alt+ArrowLeft`);
  await expect.poll(() => source(page)).toBe(NOTE);

  // 7. Fold the Hebrew section; 8. unfold it.
  await cursorAt(page, "# רשימה");
  await page.keyboard.press(`${M}+Alt+ArrowUp`);
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(1);
  await expect(page.locator(".cm-line", { hasText: "פריט ג" })).toHaveCount(0);
  await page.keyboard.press(`${M}+Alt+ArrowDown`);
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: "פריט ג" })).toHaveCount(1);

  // 9. Zoom into "פריט א": only its subtree is shown, with a bar back; 10. Escape zooms out.
  await cursorAt(page, "- פריט א");
  await page.keyboard.press(`${M}+Alt+Enter`);
  await expect(page.locator(".cm-outline-zoombar")).toBeVisible();
  await expect(page.locator(".cm-line", { hasText: "תת א1" })).toHaveCount(1);
  await expect(page.locator(".cm-line", { hasText: "# Alpha" })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.locator(".cm-outline-zoombar")).toHaveCount(0);
  await expect(page.locator(".cm-line", { hasText: "# Alpha" })).toHaveCount(1);
  expect(await source(page)).toBe(NOTE);
});

test("fold and zoom are views: the file is byte-for-byte the same, and folds are kept per note", async ({ page }) => {
  await load(page, NOTE, "# Alpha");
  await run(page, "outline.foldAll");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(3);
  await run(page, "outline.zoomIn");
  await expect(page.locator(".cm-outline-zoombar")).toBeVisible();
  await page.locator(".cm-outline-zoomout").dispatchEvent("mousedown");
  await expect(page.locator(".cm-outline-zoombar")).toHaveCount(0);
  expect(await source(page)).toBe(NOTE);
  // What is saved is the fold state of this note, not anything in the file.
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("lumen-outline-folds") ?? "{}") as Record<string, string[]>);
  expect(Object.values(saved).flat().sort()).toEqual(["h:alpha#0", "h:beta#0", "h:רשימה#0"].sort());

  // The folds come back after a reload, and the text still has nothing of them.
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => source(page), { timeout: 10_000 }).toBe(NOTE);
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(3, { timeout: 10_000 });
  await run(page, "outline.unfoldAll");
  await expect(page.locator(".cm-foldPlaceholder")).toHaveCount(0);
  expect(await source(page)).toBe(NOTE);
});

/* ─── WYSIWYG ────────────────────────────────────────────────────── */

async function toWysiwyg(page: Page): Promise<void> {
  await page.keyboard.press("Meta+4");
  const pm = page.locator(".ProseMirror").first();
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await expect(pm).toContainText("פריט ב", { timeout: 10_000 });
  // React StrictMode builds the editor twice in dev: wait for the one that stays.
  let stable = 0;
  await expect
    .poll(
      async () => {
        const same = await page.evaluate(() => {
          const el = document.querySelector(".ProseMirror");
          const w = window as unknown as { __outlineProbe?: Element | null };
          const kept = !!el && w.__outlineProbe === el;
          w.__outlineProbe = el;
          return kept;
        });
        stable = same ? stable + 1 : 0;
        return stable;
      },
      { intervals: [100], timeout: 10_000 },
    )
    .toBeGreaterThanOrEqual(3);
}

/**
 * Caret into the WYSIWYG block whose own text starts with `text`. Set
 * through the DOM selection, and set again on each poll: WebKit sometimes
 * drops it while ProseMirror re-applies its own selection.
 */
async function caretIn(page: Page, text: string): Promise<void> {
  await page.locator(".ProseMirror").first().focus();
  await expect
    .poll(() =>
      page.evaluate((want) => {
        const current = getSelection()?.focusNode?.textContent ?? "";
        if (current.startsWith(want)) return current;
        const root = document.querySelector(".ProseMirror");
        for (const block of root?.querySelectorAll("p, h1, h2, h3, h4, h5, h6") ?? []) {
          const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            if (n.parentElement?.closest('[contenteditable="false"]')) continue;
            if (!(n.textContent ?? "").startsWith(want)) break;
            const r = document.createRange();
            r.setStart(n, 1);
            r.collapse(true);
            getSelection()?.removeAllRanges();
            getSelection()?.addRange(r);
            return "";
          }
        }
        return "";
      }, text),
    )
    .toContain(text);
}

/** The WYSIWYG document as an outline: "#… heading" or "-… item" (one "-" per list level), visible blocks only. */
function wysiwygOutline(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const root = document.querySelector(".ProseMirror");
    const out: string[] = [];
    for (const el of root?.querySelectorAll("p, h1, h2, h3, h4, h5, h6") ?? []) {
      if ((el as HTMLElement).closest(".lumen-fold-hidden")) continue;
      const text = [...el.childNodes].filter((n) => !(n instanceof HTMLElement && n.getAttribute("contenteditable") === "false")).map((n) => n.textContent).join("").trim();
      if (/^H\d$/.test(el.tagName)) out.push(`${"#".repeat(Number(el.tagName[1]))} ${text}`);
      else {
        let depth = 0;
        for (let li = el.parentElement?.closest("li"); li; li = li.parentElement?.closest("li")) depth++;
        out.push(depth ? `${"-".repeat(depth)} ${text}` : text);
      }
    }
    return out;
  });
}

test("WYSIWYG editor: the ten block operations, in RTL and LTR", async ({ page }) => {
  const M = await mod(page);
  await load(page, NOTE, "# רשימה");
  await toWysiwyg(page);
  const base = ["# רשימה", "- פריט א", "-- תת א1", "- פריט ב", "- פריט ג", "# Alpha", "alpha text", "# Beta", "beta text"];
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);

  await caretIn(page, "פריט ב");
  const dir = await page.locator(".ProseMirror li", { hasText: "פריט ב" }).first().evaluate((el) => getComputedStyle(el).direction);
  expect(dir).toBe("rtl");
  // 1–2. Move up, then down.
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect.poll(() => wysiwygOutline(page)).toEqual(["# רשימה", "- פריט ב", "- פריט א", "-- תת א1", "- פריט ג", "# Alpha", "alpha text", "# Beta", "beta text"]);
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);
  // 3–4. Indent with ← in RTL, outdent with →.
  await page.keyboard.press(`${M}+Alt+ArrowLeft`);
  await expect.poll(() => wysiwygOutline(page)).toEqual(["# רשימה", "- פריט א", "-- תת א1", "-- פריט ב", "- פריט ג", "# Alpha", "alpha text", "# Beta", "beta text"]);
  await page.keyboard.press(`${M}+Alt+ArrowRight`);
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);
  // 5–6. Duplicate, delete.
  await page.keyboard.press("Alt+Shift+D");
  await expect.poll(() => wysiwygOutline(page)).toEqual(["# רשימה", "- פריט א", "-- תת א1", "- פריט ב", "- פריט ב", "- פריט ג", "# Alpha", "alpha text", "# Beta", "beta text"]);
  await page.keyboard.press("Alt+Shift+Backspace");
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);

  // LTR: a section moves whole, → demotes it.
  await caretIn(page, "Alpha");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect.poll(() => wysiwygOutline(page)).toEqual(["# רשימה", "- פריט א", "-- תת א1", "- פריט ב", "- פריט ג", "# Beta", "beta text", "# Alpha", "alpha text"]);
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);
  await page.keyboard.press(`${M}+Alt+ArrowRight`);
  await expect.poll(() => wysiwygOutline(page)).toContain("## Alpha");
  await page.keyboard.press(`${M}+Alt+ArrowLeft`);
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);

  // 7–8. Fold the Hebrew section, unfold it.
  await caretIn(page, "רשימה");
  await page.keyboard.press(`${M}+Alt+ArrowUp`);
  await expect.poll(() => wysiwygOutline(page)).toEqual(["# רשימה", "# Alpha", "alpha text", "# Beta", "beta text"]);
  await page.keyboard.press(`${M}+Alt+ArrowDown`);
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);

  // 9–10. Zoom into פריט א, then out from the bar.
  await caretIn(page, "פריט א");
  await page.keyboard.press(`${M}+Alt+Enter`);
  await expect(page.locator(".lumen-outline-zoombar")).toBeVisible();
  await expect.poll(() => wysiwygOutline(page)).toEqual(["- פריט א", "-- תת א1"]);
  await page.locator(".lumen-outline-zoomout").dispatchEvent("mousedown");
  await expect(page.locator(".lumen-outline-zoombar")).toHaveCount(0);
  await expect.poll(() => wysiwygOutline(page)).toEqual(base);
});

test("WYSIWYG: folding and zoom don't change the file", async ({ page }) => {
  await load(page, NOTE, "# רשימה");
  await toWysiwyg(page);
  await caretIn(page, "רשימה");
  await run(page, "outline.foldAll");
  await expect.poll(() => wysiwygOutline(page)).toEqual(["# רשימה", "# Alpha", "# Beta"]);
  await caretIn(page, "Beta");
  await run(page, "outline.zoomIn");
  await expect(page.locator(".lumen-outline-zoombar")).toBeVisible();
  await run(page, "outline.zoomOut");
  await run(page, "outline.unfoldAll");
  await page.keyboard.press("Meta+1");
  await expect(page.locator(".cm-content").first()).toBeVisible();
  await expect.poll(() => source(page)).toBe(NOTE);
});

import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W11.H3: the caret in right-to-left and mixed lines of the source
 * editor (CodeMirror), in Chromium, Firefox and WebKit (the "chromium",
 * "firefox" and "webkit" projects; the full three-browser run is W11.M7).
 *
 * 40 caret scenarios — 10 lines that start or end with Latin text, digits,
 * code, a URL, a wiki link, a footnote or a tag (the W11.H2 edge lines),
 * four checks each:
 *   home   Home from the end reaches offset 0, drawn at the line's visual
 *          start edge (right in RTL), in one press;
 *   end    End from the start reaches the end, drawn at the visual end edge;
 *   trip   from the middle, three presses of the arrow toward the end and
 *          three back return to the same offset (no bounce at RTL/LTR
 *          boundaries);
 *   word   Ctrl/⌥+arrow toward the end moves forward by a word and the
 *          opposite one returns to 0.
 * 12 scenarios from Obsidian's forum reports (1.14.2 Home/End one character
 * short; arrow bounce at boundaries; numbered items; footnotes; first-strong
 * flips), research R2 §1.9.
 *
 * The arrows are logical (plan 9.7: the arrow that points toward the end of
 * the line goes to the next character in the text), so "toward the end" is
 * Left in an RTL line and Right in an LTR one.
 */

type Dir = "rtl" | "ltr";
type View = {
  state: { doc: { length: number; toString(): string }; selection: { main: { anchor: number; head: number } } };
  dispatch(tr: unknown): void;
  focus(): void;
  coordsAtPos(pos: number, side?: number): { left: number; right: number; top: number; bottom: number } | null;
};

let page: Page;

test.describe.configure({ mode: "default" });

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

/** Replace the note with `text` (one line) through CodeMirror, caret at `at`. */
async function load(text: string, at = 0): Promise<void> {
  await page.keyboard.press("Meta+1");
  const source = page.locator(".cm-content").first();
  await expect(source).toBeVisible();
  await source.click();
  await page.evaluate(
    ({ text, at }) => {
      const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
      const view = el?.cmTile?.root?.view;
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, selection: { anchor: at }, userEvent: "input" });
      view?.focus();
    },
    { text, at },
  );
  await expect.poll(() => state().then((s) => s.text)).toBe(text);
}

/** Text, selection, the first line's direction, where the caret is drawn and the line's content edges. */
function state(): Promise<{ text: string; anchor: number; head: number; dir: string; caretX: number; startEdge: number; endEdge: number }> {
  return page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    const line = document.querySelector(".cm-content .cm-line") as HTMLElement | null;
    const head = view?.state.selection.main.head ?? -1;
    const c = view?.coordsAtPos(head, head === 0 ? 1 : -1);
    const dir = line ? getComputedStyle(line).direction : "";
    // The text's visual extent: a range over the line's contents (not the line box, which spans the editor).
    let left = 0;
    let right = 0;
    if (line) {
      const r = document.createRange();
      r.selectNodeContents(line);
      const rect = r.getBoundingClientRect();
      left = rect.left;
      right = rect.right;
    }
    return {
      text: view?.state.doc.toString() ?? "",
      anchor: view?.state.selection.main.anchor ?? -1,
      head,
      dir,
      caretX: c ? c.left : Number.NaN,
      startEdge: dir === "rtl" ? right : left,
      endEdge: dir === "rtl" ? left : right,
    };
  });
}

const forwardKey = (d: Dir) => (d === "rtl" ? "ArrowLeft" : "ArrowRight");
const backKey = (d: Dir) => (d === "rtl" ? "ArrowRight" : "ArrowLeft");
/** Within 3 CSS px: the caret is drawn at the edge, not one character short of it. */
const PX = 3;

async function expectHome(text: string, dir: Dir) {
  await load(text, text.length);
  await page.keyboard.press("Home");
  const s = await state();
  expect(s.dir, "line direction").toBe(dir);
  expect(s.head, "Home reaches offset 0 in one press").toBe(0);
  expect(Math.abs(s.caretX - s.startEdge), `caret at the visual start edge (x ${s.caretX} vs ${s.startEdge})`).toBeLessThanOrEqual(PX);
}

async function expectEnd(text: string, dir: Dir) {
  await load(text, 0);
  await page.keyboard.press("End");
  const s = await state();
  expect(s.dir, "line direction").toBe(dir);
  expect(s.head, "End reaches the end in one press").toBe(text.length);
  expect(Math.abs(s.caretX - s.endEdge), `caret at the visual end edge (x ${s.caretX} vs ${s.endEdge})`).toBeLessThanOrEqual(PX);
}

async function expectRoundTrip(text: string, dir: Dir, from = Math.floor(text.length / 2)) {
  await load(text, from);
  for (let i = 0; i < 3; i++) await page.keyboard.press(forwardKey(dir));
  const mid = (await state()).head;
  expect(mid, "three presses toward the end move forward").toBeGreaterThan(from);
  for (let i = 0; i < 3; i++) await page.keyboard.press(backKey(dir));
  expect((await state()).head, "three presses back return to the start").toBe(from);
}

async function expectWord(text: string, dir: Dir) {
  await load(text, 0);
  const mod = process.platform === "darwin" ? "Alt" : "Control";
  await page.keyboard.press(`${mod}+${forwardKey(dir)}`);
  const w = (await state()).head;
  expect(w, "a word forward").toBeGreaterThan(0);
  expect(w).toBeLessThanOrEqual(text.length);
  await page.keyboard.press(`${mod}+${backKey(dir)}`);
  expect((await state()).head, "and back to 0").toBe(0);
}

/** The W11.H2 edge lines: each starts or ends with something that is not Hebrew. */
const LINES: [string, Dir][] = [
  ["iPhone חדש הגיע היום", "ltr"],
  ["שלום לכולם 2026", "rtl"],
  ["2026 שנה טובה לכולם", "rtl"],
  ["ראה `npm run dev`", "rtl"],
  ["`git status` לפני הכול", "rtl"],
  ["https://lumen-md.vercel.app היא הכתובת", "rtl"],
  ["ראו [[מתכון עוגה]] היום", "rtl"],
  ["הערה[^1] בסוף השורה", "rtl"],
  ["Hello עולם יפה", "ltr"],
  ["תגית בסוף #todo", "rtl"],
];

test.describe("caret: 40 scenarios (10 lines × Home, End, 3-press round trip, word)", () => {
  for (const [text, dir] of LINES) {
    test(`home: ${text}`, () => expectHome(text, dir));
    test(`end: ${text}`, () => expectEnd(text, dir));
    test(`trip: ${text}`, () => expectRoundTrip(text, dir));
    test(`word: ${text}`, () => expectWord(text, dir));
  }
});

test.describe("caret: 12 Obsidian forum scenarios", () => {
  test("1. an RTL line that starts with a Latin word: Home reaches the right edge", () => expectHome("API של השרת החדש", "rtl"));
  test("2. an RTL line that ends with a Latin word: End reaches the left edge", () => expectEnd("השרת החדש של API", "rtl"));
  test("3. an RTL line that ends with digits: End reaches the left edge", () => expectEnd("פגישה ב-10:30", "rtl"));
  test("4. a click right of an RTL line that starts with Latin puts the caret at its start", async () => {
    const text = "API של השרת";
    await load(text, text.length);
    const box = await page.locator(".cm-content .cm-line").first().boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width - 2, box!.y + box!.height / 2);
    expect((await state()).head).toBe(0);
  });
  test("5. a click left of an RTL line that ends with Latin puts the caret at its end", async () => {
    const text = "השרת של API";
    await load(text, 0);
    const s = await state();
    const box = await page.locator(".cm-content .cm-line").first().boundingBox();
    expect(box).not.toBeNull();
    // Left of the text (the line box spans the editor; the text ends at s.endEdge).
    await page.mouse.click(Math.max(box!.x + 2, s.endEdge - 20), box!.y + box!.height / 2);
    expect((await state()).head).toBe(text.length);
  });
  test("6. a numbered item at the start of the line: Home and End reach both edges", async () => {
    await expectHome("1. פריט ראשון ברשימה", "rtl");
    await expectEnd("1. פריט ראשון ברשימה", "rtl");
  });
  test("7. a footnote reference at the end: End reaches the left edge", () => expectEnd("טקסט עם הערה[^12]", "rtl"));
  test("8. a footnote definition line is RTL and Home reaches its right edge", () => expectHome("[^1]: הסבר בעברית", "rtl"));
  test("9. first-strong flip: a Latin letter typed at the start of a Hebrew line keeps the caret after it", async () => {
    await load("שלום", 0);
    await page.keyboard.type("a");
    const s = await state();
    expect(s.text).toBe("aשלום");
    expect(s.head).toBe(1);
    expect(s.dir).toBe("ltr");
  });
  test("10. first-strong flip back: deleting it makes the line RTL again with the caret at 0", async () => {
    await load("aשלום", 1);
    await page.keyboard.press("Backspace");
    const s = await state();
    expect([s.text, s.head, s.dir]).toEqual(["שלום", 0, "rtl"]);
  });
  test("11. no bounce at RTL/LTR boundaries: 'עברית English עברית' round trip from each boundary", async () => {
    const text = "עברית English עברית";
    for (const from of [5, 6, 13, 14]) await expectRoundTrip(text, "rtl", from);
  });
  test("12. Shift+End selects to the visual end of an RTL line that ends with Latin", async () => {
    const text = "גרסה חדשה של iOS";
    await load(text, 0);
    await page.keyboard.press("Shift+End");
    const s = await state();
    expect([s.anchor, s.head]).toEqual([0, text.length]);
    expect(Math.abs(s.caretX - s.endEdge)).toBeLessThanOrEqual(PX);
  });
});

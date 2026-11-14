/**
 * W11.H2 — bidi isolates for Markdown inline syntax.
 *
 * 40 lines: the 8 committed dev lines of the 9.7 golden set
 * (eval/golden/bidi/dev/lines.json; its 22 test lines are never committed,
 * CI rebuilds them from the secret seed) and 32 edge lines written for this
 * test — lines that start or end with Latin text or digits, code, URLs,
 * links, wiki links, tags and footnotes. Each expectation is the exact
 * substring that must become an isolate, and its direction.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EditorState } from "@codemirror/state";
import { Direction, EditorView } from "@codemirror/view";
import { inlineIsolates } from "../lib/inlineIsolates";
import { inlineIsolatesPlugin, isolateDecorations } from "../editor/bidiIsolates";

type Want = [text: string, dir: "ltr" | "auto"][];

const golden = (JSON.parse(readFileSync("eval/golden/bidi/dev/lines.json", "utf8")) as { items: { id: string; line: string }[] }).items;
const GOLDEN_WANT: Record<string, Want> = {
  "bidi-86": [],
  "bidi-18": [["(https://example.com/Dana)", "ltr"]],
  "bidi-41": [["`iPhone`", "ltr"]],
  "bidi-30": [],
  "bidi-49": [["`iPhone`", "ltr"]],
  "bidi-33": [["`README.md`", "ltr"]],
  "bidi-29": [["(https://example.com/iPhone)", "ltr"]],
  "bidi-34": [],
};

const EDGE: [string, Want][] = [
  ["iPhone חדש הגיע", []],
  ["שלום לכולם 2026", []],
  ["2026 שנה טובה", []],
  ["ראה `npm run dev`", [["`npm run dev`", "ltr"]]],
  ["`git status` לפני הכול", [["`git status`", "ltr"]]],
  ["קישור: https://example.com/path?q=1.", [["https://example.com/path?q=1", "ltr"]]],
  ["https://lumen-md.vercel.app היא הכתובת", [["https://lumen-md.vercel.app", "ltr"]]],
  ["ראו [[מתכון עוגה]] ו-[[Project Plan|תוכנית]]", [["[[מתכון עוגה]]", "auto"], ["[[Project Plan|תוכנית]]", "auto"]]],
  ["#פרויקט וגם #work בשורה", [["#פרויקט", "auto"], ["#work", "auto"]]],
  ["## כותרת #1", []],
  ["הערה[^1] בסוף", [["[^1]", "ltr"]]],
  ["1. פריט ראשון", []],
  ["<https://example.com> קישור", [["<https://example.com>", "ltr"]]],
  ["![תמונה](img/photo.png) כיתוב", [["(img/photo.png)", "ltr"]]],
  ["נוסחה $x^2$ ו-`code`", [["`code`", "ltr"]]],
  ["קוד `a $b$ c` כאן", [["`a $b$ c`", "ltr"]]],
  ["[link](https://en.wikipedia.org/wiki/Foo_(bar)) עברית", [["(https://en.wikipedia.org/wiki/Foo_(bar))", "ltr"]]],
  ["www.example.co.il הוא אתר", [["www.example.co.il", "ltr"]]],
  ["דוא״ל: mailto:a@b.com", [["mailto:a@b.com", "ltr"]]],
  ["(ראו https://x.io/a)", [["https://x.io/a", "ltr"]]],
  ["טקסט עם `` קוד עם ` בפנים `` וסוף", [["`` קוד עם ` בפנים ``", "ltr"]]],
  ["מחיר $5 ו-$10", []],
  ["שורה שמסתיימת ב-README.md", []],
  ["[[Note#Heading]] בהתחלה", [["[[Note#Heading]]", "auto"]]],
  ["תגית בסוף #todo", [["#todo", "auto"]]],
  ["![[image.png]] מוטמע", [["![[image.png]]", "auto"]]],
  ["`unclosed code ועברית", []],
  ["[טקסט](<קובץ עם רווח.md>) ועוד", [["(<קובץ עם רווח.md>)", "ltr"]]],
  ["שאלה? https://a.b/c?d=e&f=g!", [["https://a.b/c?d=e&f=g", "ltr"]]],
  ["ftp://files.example.org/x עברית", [["ftp://files.example.org/x", "ltr"]]],
  ["(#תגית) בסוגריים", [["#תגית", "auto"]]],
  ["‏RLM ואז `x`", [["`x`", "ltr"]]],
];

const got = (line: string): Want => inlineIsolates(line).map((i) => [line.slice(i.from, i.to), i.dir]);

describe("inline isolates: 40 lines (8 golden dev lines of 9.7 + 32 edge lines)", () => {
  it("covers exactly 40 lines", () => {
    expect(golden).toHaveLength(8);
    expect(golden.length + EDGE.length).toBe(40);
  });
  for (const g of golden) it(`golden ${g.id}: ${g.line}`, () => expect(got(g.line)).toEqual(GOLDEN_WANT[g.id]));
  EDGE.forEach(([line, want], i) => it(`edge ${i + 1}: ${line}`, () => expect(got(line)).toEqual(want)));
  it("isolates never overlap each other or inline math", () => {
    for (const [line] of EDGE) {
      const r = inlineIsolates(line);
      for (let k = 1; k < r.length; k++) expect(r[k].from).toBeGreaterThanOrEqual(r[k - 1].to);
    }
  });
});

describe("the CodeMirror plugin", () => {
  const view = (doc: string) => new EditorView({ state: EditorState.create({ doc, extensions: [inlineIsolatesPlugin] }), parent: document.body });
  it("hands the isolates to CodeMirror through bidiIsolatedRanges, with their direction", () => {
    const v = view("ראה `npm run dev` ו-[[דף]]\n```\n`not here`\n```");
    const sets = v.state.facet(EditorView.bidiIsolatedRanges).map((f) => (typeof f === "function" ? f(v) : f));
    const marks: { from: number; to: number; iso: unknown }[] = [];
    for (const s of sets) s.between(0, v.state.doc.length, (from, to, d) => void marks.push({ from, to, iso: d.spec.bidiIsolate }));
    const text = (m: { from: number; to: number }) => v.state.sliceDoc(m.from, m.to);
    expect(marks.map(text)).toEqual(["`npm run dev`", "[[דף]]"]);
    expect(marks.map((m) => m.iso)).toEqual([Direction.LTR, null]);
    v.destroy();
  });
  it("skips lines inside fenced code", () => {
    const v = view("```\n`a` https://x.y\n```\nטקסט `b`");
    const out: string[] = [];
    isolateDecorations(v).between(0, v.state.doc.length, (f, t) => void out.push(v.state.sliceDoc(f, t)));
    expect(out).toEqual(["`b`"]);
    v.destroy();
  });
});

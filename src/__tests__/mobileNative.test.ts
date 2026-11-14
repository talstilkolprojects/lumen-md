/**
 * W1.25 — native-level phone editing: the toolbar's text actions (one
 * transaction each), the customisable row, edge swipes mirrored in RTL,
 * long notes opening for reading and a tap landing on the right line, and
 * the tap-count table against the real default row.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyEdit, applyTextAction, DEFAULT_TOOLBAR, moveAction, sanitizeToolbar, toggleAction, TOOLBAR_ACTIONS, type ToolbarActionId } from "../mobile/toolbarActions";
import { classifySwipe, DEFAULT_READING_WORDS, EDGE_PX, isTap, lineForTap, opensInReading, wordCount } from "../mobile/gestures";
import { lumenTaps, TAP_ROWS } from "../mobile/tapCounts";
import { noteOptions, wikiQueryAt } from "../editor/wikiLinkQuery";
import { readLocale } from "../../scripts/lib/i18n-files.mjs";
import { lazyEnglish } from "./helpers/i18nLazy";

/** Run an action on "text with | as the cursor" (or [ ] as the selection) and return the same notation. */
function run(id: ToolbarActionId, marked: string): string {
  let text: string;
  let from: number;
  let to: number;
  if (marked.includes("⟦")) {
    from = marked.indexOf("⟦");
    text = marked.replace("⟦", "");
    to = text.indexOf("⟧");
    text = text.replace("⟧", "");
  } else {
    from = to = marked.indexOf("|");
    text = marked.replace("|", "");
  }
  const edit = applyTextAction(id, text, from, to);
  if (!edit) throw new Error(`no text edit for ${id}`);
  const out = applyEdit(text, edit);
  const [a, b] = [Math.min(edit.anchor, edit.head), Math.max(edit.anchor, edit.head)];
  return a === b ? out.slice(0, a) + "|" + out.slice(a) : out.slice(0, a) + "⟦" + out.slice(a, b) + "⟧" + out.slice(b);
}

describe("toolbar text actions", () => {
  it("task cycles: line → open task → checked → plain, keeping the cursor on the text", () => {
    expect(run("task", "buy mi|lk")).toBe("- [ ] buy mi|lk");
    expect(run("task", "- [ ] buy mi|lk")).toBe("- [x] buy mi|lk");
    expect(run("task", "- [x] buy mi|lk")).toBe("buy mi|lk");
    expect(run("task", "- buy |milk")).toBe("- [ ] buy |milk");
    expect(run("task", "|")).toBe("- [ ] |");
    expect(run("task", "  - קנ|ות")).toBe("  - [ ] קנ|ות");
  });

  it("indent and outdent every selected line, lists keep their marker", () => {
    expect(run("indent", "- a|")).toBe("  - a|");
    expect(run("outdent", "    - a|")).toBe("  - a|");
    expect(run("outdent", "- a|")).toBe("- a|");
    expect(run("indent", "⟦- a\n- b⟧\n- c")).toBe("⟦  - a\n  - b⟧\n- c");
    expect(run("outdent", "\t- tab|")).toBe("- tab|");
  });

  it("heading cycles none → # → ## → ### → none", () => {
    expect(run("heading", "Ti|tle")).toBe("# Ti|tle");
    expect(run("heading", "# Ti|tle")).toBe("## Ti|tle");
    expect(run("heading", "## Ti|tle")).toBe("### Ti|tle");
    expect(run("heading", "### Ti|tle")).toBe("Ti|tle");
    expect(run("heading", "line one\nכות|רת")).toBe("line one\n# כות|רת");
  });

  it("bold/italic/code/wikilink wrap a selection, insert a pair at the cursor, and unwrap", () => {
    expect(run("bold", "say ⟦שלום⟧ now")).toBe("say **⟦שלום⟧** now");
    expect(run("bold", "say **⟦שלום⟧** now")).toBe("say ⟦שלום⟧ now");
    expect(run("bold", "x |")).toBe("x **|**");
    expect(run("italic", "⟦a⟧")).toBe("_⟦a⟧_");
    expect(run("code", "⟦x()⟧")).toBe("`⟦x()⟧`");
    expect(run("code", "⟦a\nb⟧")).toBe("```\n⟦a\nb⟧\n```");
    expect(run("wikilink", "see |")).toBe("see [[|]]");
  });

  it("link: selected text becomes the label, a selected URL the target", () => {
    expect(run("link", "⟦docs⟧")).toBe("[docs](|)");
    expect(run("link", "⟦https://example.org/a⟧")).toBe("[|](https://example.org/a)");
    expect(run("link", "|")).toBe("[|]()");
  });

  it("bullet, numbered, quote and tag", () => {
    expect(run("bullet", "a|")).toBe("- a|");
    expect(run("bullet", "- a|")).toBe("a|");
    expect(run("numbered", "⟦a\nb⟧")).toBe("1. ⟦a\n2. b⟧");
    expect(run("quote", "a|")).toBe("> a|");
    expect(run("quote", "> a|")).toBe("a|");
    expect(run("tag", "x|")).toBe("x #|");
    expect(run("tag", "x ⟦לימודים⟧")).toBe("x #לימודים|");
  });

  it("history, image and keyboard actions are left to the editor", () => {
    for (const id of ["undo", "redo", "image", "hideKeyboard"] as const) expect(applyTextAction(id, "a", 0, 0)).toBe(null);
    for (const a of TOOLBAR_ACTIONS) if (a.kind === "text") expect(applyTextAction(a.id, "a b", 0, 1), a.id).not.toBe(null);
  });

  it("every change set is ascending and non-overlapping (what CodeMirror requires)", () => {
    const samples = ["⟦- a\n- b\n- c⟧", "x ⟦y⟧ z", "|", "- [ ] ⟦t⟧", "# ⟦h⟧"];
    for (const a of TOOLBAR_ACTIONS) {
      if (a.kind !== "text") continue;
      for (const s of samples) {
        const from = s.indexOf("⟦") >= 0 ? s.indexOf("⟦") : s.indexOf("|");
        const text = s.replace(/[⟦⟧|]/g, "");
        const to = s.indexOf("⟧") >= 0 ? s.indexOf("⟧") - 1 : from;
        const e = applyTextAction(a.id, text, from, to)!;
        for (let i = 1; i < e.changes.length; i++) expect(e.changes[i].from, `${a.id} on ${s}`).toBeGreaterThanOrEqual(e.changes[i - 1].to);
        const len = applyEdit(text, e).length;
        expect(e.anchor >= 0 && e.anchor <= len && e.head >= 0 && e.head <= len, `${a.id} on ${s}`).toBe(true);
      }
    }
  });
});

describe("the customisable row", () => {
  it("defaults to the plan's four first, hide-keyboard last", () => {
    expect(DEFAULT_TOOLBAR.slice(0, 5)).toEqual(["indent", "outdent", "task", "link", "image"]);
    expect(DEFAULT_TOOLBAR[DEFAULT_TOOLBAR.length - 1]).toBe("hideKeyboard");
  });

  it("a stored row is cleaned: unknown ids and repeats go, an empty row falls back", () => {
    expect(sanitizeToolbar(["task", "nope", "task", "bold", 3])).toEqual(["task", "bold"]);
    expect(sanitizeToolbar([])).toEqual([...DEFAULT_TOOLBAR]);
    expect(sanitizeToolbar("x")).toEqual([...DEFAULT_TOOLBAR]);
  });

  it("move, add and remove; the last action can't be removed", () => {
    expect(moveAction(["task", "bold", "link"], "bold", -1)).toEqual(["bold", "task", "link"]);
    expect(moveAction(["task", "bold"], "task", -1)).toEqual(["task", "bold"]);
    expect(toggleAction(["task"], "bold")).toEqual(["task", "bold"]);
    expect(toggleAction(["task", "bold"], "task")).toEqual(["bold"]);
    expect(toggleAction(["task"], "task")).toEqual(["task"]);
  });

  it("every action has a label in English and Hebrew", () => {
    // English: the startup files plus the lazy files (the toolbar's own strings load with it); Hebrew: its domain files.
    const en = { ...readLocale("en"), ...lazyEnglish() } as Record<string, string>;
    const he = readLocale("he") as Record<string, string>;
    for (const a of TOOLBAR_ACTIONS) {
      expect(en[a.labelKey], a.labelKey).toBeTruthy();
      expect(he[a.labelKey], a.labelKey).toBeTruthy();
    }
  });
});

describe("edge swipes, mirrored in RTL", () => {
  const W = 390;
  const closed = { start: false, end: false };
  const swipe = (x0: number, x1: number, dy = 0, ms = 200) => ({ x0, y0: 300, x1, y1: 300 + dy, ms });

  it("LTR: in from the left opens the file tree, in from the right the outline", () => {
    expect(classifySwipe(swipe(5, 120), W, false, closed)).toBe("open-start");
    expect(classifySwipe(swipe(W - 5, W - 120), W, false, closed)).toBe("open-end");
  });

  it("RTL: the same gestures mirrored — the file tree comes in from the right", () => {
    expect(classifySwipe(swipe(W - 5, W - 120), W, true, closed)).toBe("open-start");
    expect(classifySwipe(swipe(5, 120), W, true, closed)).toBe("open-end");
  });

  it("a swipe back towards a panel's edge closes it", () => {
    expect(classifySwipe(swipe(200, 60), W, false, { start: true, end: false })).toBe("close-start");
    expect(classifySwipe(swipe(60, 200), W, true, { start: true, end: false })).toBe("close-start");
    expect(classifySwipe(swipe(100, 300), W, false, { start: false, end: true })).toBe("close-end");
  });

  it("not a swipe: from the middle, too short, too slow, or mostly vertical", () => {
    expect(classifySwipe(swipe(EDGE_PX + 40, 300), W, false, closed)).toBe(null);
    expect(classifySwipe(swipe(5, 40), W, false, closed)).toBe(null);
    expect(classifySwipe(swipe(5, 200, 0, 1200), W, false, closed)).toBe(null);
    expect(classifySwipe(swipe(5, 120, 90), W, false, closed)).toBe(null);
  });

  it("a tap is short and still", () => {
    expect(isTap({ x0: 10, y0: 10, x1: 14, y1: 12, ms: 120 })).toBe(true);
    expect(isTap({ x0: 10, y0: 10, x1: 40, y1: 12, ms: 120 })).toBe(false);
    expect(isTap({ x0: 10, y0: 10, x1: 10, y1: 10, ms: 600 })).toBe(false);
  });
});

describe("long notes open for reading; a tap edits there", () => {
  const long = `---\ntitle: x\n---\n${"מילה ".repeat(DEFAULT_READING_WORDS)}`;

  it("counts words in Hebrew and English, not front matter or code", () => {
    expect(wordCount("שלום עולם, hello world")).toBe(4);
    expect(wordCount("---\na: b c d\n---\none\n```\nnot counted at all\n```")).toBe(1);
    expect(wordCount("צה״ל ו-don't")).toBe(2);
  });

  it("only on a phone, only when on, only past the threshold", () => {
    expect(opensInReading(long, { phone: true, enabled: true })).toBe(true);
    expect(opensInReading(long, { phone: false, enabled: true })).toBe(false);
    expect(opensInReading(long, { phone: true, enabled: false })).toBe(false);
    expect(opensInReading("קצר", { phone: true, enabled: true })).toBe(false);
    expect(opensInReading(long, { phone: true, enabled: true, words: 10_000 })).toBe(false);
  });

  const src = ["---", "title: t", "---", "# מבוא", "", "פסקה ראשונה עם **הדגשה** ו[קישור](x).", "", "## שיטה", "", "- פריט אחד", "- [ ] משימה", "", "פסקה ראשונה עם הדגשה וקישור.", "", "```", "# not a heading", "```", "## סוף", "טקסט"].join("\n");

  it("finds the tapped block's line, in its own section first", () => {
    expect(lineForTap(src, { headingIndex: 0, text: "פסקה ראשונה עם הדגשה וקישור." })).toBe(6);
    // The same sentence again under "שיטה": the section decides.
    expect(lineForTap(src, { headingIndex: 1, text: "פסקה ראשונה עם הדגשה וקישור." })).toBe(13);
    expect(lineForTap(src, { headingIndex: 1, text: "משימה" })).toBe(11);
    expect(lineForTap(src, { headingIndex: 0, text: "מבוא" })).toBe(4);
    // A fenced "# not a heading" doesn't count as a heading.
    expect(lineForTap(src, { headingIndex: 2, text: "טקסט" })).toBe(19);
    // Text not found: the section's heading.
    expect(lineForTap(src, { headingIndex: 1, text: "nothing like this" })).toBe(8);
  });
});

describe("tap counts (plan acceptance: ≤ Obsidian Mobile on all 10)", () => {
  it("10 actions, each no more taps than Obsidian Mobile", () => {
    expect(TAP_ROWS.length).toBe(10);
    for (const r of TAP_ROWS) expect(lumenTaps(r), r.id).toBeLessThanOrEqual(r.obsidian);
  });

  it("every toolbar step is on the default row; every gesture exists", () => {
    for (const r of TAP_ROWS)
      for (const s of r.lumen) {
        if (s.startsWith("toolbar:")) expect(DEFAULT_TOOLBAR as readonly string[], `${r.id}: ${s}`).toContain(s.slice(8));
        else expect(["swipe:start-edge", "swipe:end-edge", "tap:text", "pick:suggestion", "pick:photo", "select:word"], s).toContain(s);
      }
  });

  it("the docs table matches, in English and Hebrew", () => {
    for (const [lang, file] of [["en", "docs/src/content/docs/editor/touch.md"], ["he", "docs/src/content/docs/he/editor/touch.md"]] as const) {
      const md = readFileSync(join(process.cwd(), file), "utf8");
      for (const r of TAP_ROWS) expect(md, `${lang}: ${r.id}`).toContain(`| ${r[lang]} | ${lumenTaps(r)} | ${r.obsidian} |`);
    }
  });
});

describe("note names after [[", () => {
  it("knows the query and offers Markdown notes by name", () => {
    expect(wikiQueryAt("see [[מח")).toEqual({ query: "מח", offset: 6 });
    expect(wikiQueryAt("see [[a|b")).toBe(null);
    expect(wikiQueryAt("see [[a]] and")).toBe(null);
    expect(wikiQueryAt("no link")).toBe(null);
    expect(noteOptions(["notes/מחקר.md", "b.md", "img.png", "a.mdx"]).map((o) => o.label)).toEqual(["a", "b", "מחקר"]);
    expect(noteOptions(["notes/מחקר.md"])[0].detail).toBe("notes");
  });
});

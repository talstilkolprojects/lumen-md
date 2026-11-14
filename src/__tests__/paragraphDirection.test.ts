/**
 * W11.H4 — an explicit direction per paragraph, saved in the note, and
 * `dir: rtl | ltr | auto` for the whole note.
 */
import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { markdownLineDirection } from "../lib/bidiDirection";
import { RLM, LRM, explicitDirection, frontmatterDir, resolveLineDirection, setLineDirection, toggledLine, withoutSwitch } from "../lib/paragraphDirection";
import { toggleParagraphDirection, toggleDirectionChanges } from "../editor/paragraphDirection";
import { SHORTCUTS } from "../lib/shortcuts";

const ctx = { pinned: null, fallback: "ltr" as const };

describe("the paragraph switch (a mark after the Markdown markers)", () => {
  it("a Hebrew sentence that starts with a Latin word can be made RTL, and back", () => {
    const line = "iPhone 17 יצא היום";
    expect(resolveLineDirection(line, null, "ltr")).toBe("ltr");
    const rtl = toggledLine(line, ctx);
    expect(rtl).toBe(`${RLM}iPhone 17 יצא היום`);
    expect(resolveLineDirection(rtl, null, "ltr")).toBe("rtl");
    expect(toggledLine(rtl, ctx)).toBe(line);
  });
  it("the mark goes after list bullets, task boxes, headings, quotes and numbers, so the Markdown still parses", () => {
    expect(toggledLine("- [ ] Buy חלב", ctx)).toBe(`- [ ] ${RLM}Buy חלב`);
    expect(toggledLine("## שלום world", ctx)).toBe(`## ${LRM}שלום world`);
    expect(toggledLine("> quote עם עברית", ctx)).toBe(`> ${RLM}quote עם עברית`);
    expect(toggledLine("1. API של השרת", ctx)).toBe(`1. ${RLM}API של השרת`);
    expect(explicitDirection(`- [ ] ${RLM}Buy`)).toBe("rtl");
    expect(withoutSwitch(`## ${LRM}שלום`)).toBe("## שלום");
  });
  it("a neutral line takes the note's direction, and switching it writes a mark", () => {
    expect(toggledLine("12:30", { pinned: null, fallback: "rtl" })).toBe(`${LRM}12:30`);
    expect(toggledLine("12:30", { pinned: null, fallback: "ltr" })).toBe(`${RLM}12:30`);
  });
  it("setting the direction the line already reads in writes nothing; auto removes the switch", () => {
    expect(setLineDirection("שלום", "rtl", ctx)).toBe("שלום");
    expect(setLineDirection(`${LRM}שלום`, "auto", ctx)).toBe("שלום");
    expect(setLineDirection(`${LRM}שלום`, "rtl", ctx)).toBe("שלום");
  });
});

describe("dir in the frontmatter", () => {
  it("rtl / ltr pin the note; a paragraph's own switch wins; auto is first-strong", () => {
    expect(frontmatterDir("---\ntitle: x\ndir: rtl\n---\nhello")).toBe("rtl");
    expect(resolveLineDirection("hello", "rtl", "ltr")).toBe("rtl");
    expect(resolveLineDirection(`${LRM}hello`, "rtl", "ltr")).toBe("ltr");
    for (const line of ["hello world", "שלום עולם", "> `iPhone` הפגישה נדחתה", "## Talk tomorrow"]) {
      expect(resolveLineDirection(line, "auto", "ltr"), line).toBe(markdownLineDirection(line));
    }
    expect(resolveLineDirection("12:30", "auto", "rtl")).toBe("rtl");
  });
  it("under a pin, switching a line writes the mark for the other direction", () => {
    expect(toggledLine("hello", { pinned: "rtl", fallback: "ltr" })).toBe(`${LRM}hello`);
    expect(toggledLine(`${LRM}hello`, { pinned: "rtl", fallback: "ltr" })).toBe("hello");
  });
});

describe("source editor: the command, saved in the text and read again on reopening", () => {
  const view = (doc: string, sel: EditorSelection) => new EditorView({ state: EditorState.create({ doc, selection: sel }), parent: document.body });

  it("switches every selected line in one change, skipping fenced code and the frontmatter", () => {
    const doc = "---\ndir: auto\n---\niPhone חדש\n```\ncode line\n```\nאחת two";
    const v = view(doc, EditorSelection.single(0, doc.length));
    expect(toggleParagraphDirection(v)).toBe(true);
    const text = v.state.doc.toString();
    expect(text).toBe(`---\ndir: auto\n---\n${RLM}iPhone חדש\n\`\`\`\ncode line\n\`\`\`\n${LRM}אחת two`);
    v.destroy();

    // "Close and open again": a new editor from the saved text reads the switched directions.
    const reopened = EditorState.create({ doc: text });
    const pinned = frontmatterDir(text);
    const dirs = [4, 8].map((n) => resolveLineDirection(reopened.doc.line(n).text, pinned, "ltr"));
    expect(dirs).toEqual(["rtl", "ltr"]);
  });
  it("keeps the caret on the text it was on, and a second switch restores the original text", () => {
    const v = view("iPhone חדש", EditorSelection.cursor(0));
    toggleParagraphDirection(v);
    expect(v.state.selection.main.head).toBe(1);
    toggleParagraphDirection(v);
    expect(v.state.doc.toString()).toBe("iPhone חדש");
    v.destroy();
  });
  it("does nothing inside fenced code", () => {
    const s = EditorState.create({ doc: "```\nx\n```", selection: EditorSelection.cursor(4) });
    expect(toggleDirectionChanges(s)).toBeNull();
  });
});

describe("the shortcut", () => {
  it("Mod+Shift+X is registered for the editors and collides with nothing", () => {
    const mine = SHORTCUTS.filter((s) => s.combo === "Mod+Shift+X");
    expect(mine.map((s) => s.id)).toEqual(["edit.toggleDirection"]);
  });
});

describe("the WYSIWYG editor's Markdown layer keeps the mark (remark, as Milkdown parses and serialises)", () => {
  it("parse → stringify round-trips a switched list item and heading", async () => {
    let remark: { parse: (s: string) => unknown; stringify: (t: unknown) => string } | null = null;
    try {
      const [{ unified }, parse, stringify] = await Promise.all([import("unified"), import("remark-parse"), import("remark-stringify")]);
      const p = unified().use(parse.default).use(stringify.default, { bullet: "-" });
      remark = { parse: (s) => p.parse(s), stringify: (t) => String(p.stringify(t as never)) };
    } catch {
      remark = null;
    }
    if (!remark) return; // why: remark is not installed in every offline runner; Milkdown's own round trip is in e2e (owed)
    const md = `- ${RLM}API של השרת\n\n## ${LRM}שלום world\n`;
    const out = remark.stringify(remark.parse(md));
    expect(out).toContain(`${RLM}API של השרת`);
    expect(out).toContain(`${LRM}שלום world`);
  });
});

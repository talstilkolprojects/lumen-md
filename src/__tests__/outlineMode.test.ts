/**
 * Plan W2.13 — outline mode and block operations on plain Markdown.
 *
 * The same ten operations in both editors, on Hebrew (RTL) and English
 * (LTR) notes: move up/down, indent/outdent, duplicate, delete (the text
 * model of the source editor, text/outline), and fold/unfold, zoom in/out
 * (views over it that never touch the text). The WYSIWYG side runs the same
 * scenarios on ProseMirror nodes (editor/wysiwygOutline).
 */
import { describe, it, expect, beforeEach } from "vitest";
import { EditorState as CMState } from "@codemirror/state";
import { EditorView as CMView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { Schema, type Node as PMNode } from "@milkdown/prose/model";
import { EditorState, TextSelection } from "@milkdown/prose/state";
import {
  applyOutlineOp,
  blockAt,
  foldKeysOf,
  foldRangeAt,
  loadFolds,
  saveFolds,
  zoomRange,
  type OutlineOp,
} from "../text/outline";
import { outlineExtension, runOutlineCommandInView } from "../editor/outlineExtension";
import { foldablesOf, outlineOpTransaction } from "../editor/wysiwygOutline";

const EN = ["# Alpha", "alpha text", "", "# Beta", "beta text", "", "## Beta one", "inner", "", "# Gamma", "gamma text", ""].join("\n");
const HE = ["# אלף", "טקסט אלף", "", "- פריט א", "  - תת א1", "  - תת א2", "- פריט ב", "- פריט ג", "", "# בית", "טקסט בית", ""].join("\n");

const op = (text: string, o: OutlineOp, at: string) => {
  const i = text.indexOf(at);
  expect(i, `"${at}" in text`).toBeGreaterThanOrEqual(0);
  return applyOutlineOp(text, o, i);
};

describe("text/outline — blocks", () => {
  it("a heading is its section; an item is its subtree; code is not structure", () => {
    const lines = ["# A", "a", "```", "# not a heading", "- not an item", "```", "", "## A1", "x", "# B"];
    expect(blockAt(lines, 0)).toEqual({ kind: "heading", start: 0, end: 9, level: 1 });
    expect(blockAt(lines, 3)).toEqual({ kind: "block", start: 1, end: 6, level: 0 });
    expect(blockAt(lines, 7)).toEqual({ kind: "heading", start: 7, end: 9, level: 2 });
    const list = ["- a", "  - a1", "    more", "- b"];
    expect(blockAt(list, 2)).toEqual({ kind: "item", start: 1, end: 3, level: 2 });
    expect(blockAt(list, 0)).toEqual({ kind: "item", start: 0, end: 3, level: 0 });
  });

  it("the frontmatter and blank lines are no block", () => {
    const lines = ["---", "title: x", "---", "", "# A"];
    expect(blockAt(lines, 1)).toBeNull();
    expect(blockAt(lines, 3)).toBeNull();
    expect(applyOutlineOp(lines.join("\n"), "moveUp", lines.join("\n").indexOf("# A"))).toBeNull();
  });
});

describe("text/outline — the six editing operations, LTR", () => {
  it("move up / down swaps sections and keeps the blank lines in place", () => {
    expect(op(EN, "moveUp", "# Beta")?.text).toBe(["# Beta", "beta text", "", "## Beta one", "inner", "", "# Alpha", "alpha text", "", "# Gamma", "gamma text", ""].join("\n"));
    expect(op(EN, "moveDown", "# Beta")?.text).toBe(["# Alpha", "alpha text", "", "# Gamma", "gamma text", "", "# Beta", "beta text", "", "## Beta one", "inner", ""].join("\n"));
    // A first child doesn't leave its parent; the last section has no next.
    expect(op(EN, "moveUp", "## Beta one")).toBeNull();
    expect(op(EN, "moveDown", "# Gamma")).toBeNull();
  });

  it("the cursor stays on the moved block, at the same place", () => {
    const r = op(EN, "moveUp", "Beta\nbeta")!;
    expect(r.text.slice(r.cursor, r.cursor + 9)).toBe("Beta\nbeta");
    // Text under a heading is a block of its own: first in its section, it stays.
    expect(op(EN, "moveUp", "beta text")).toBeNull();
  });

  it("indent / outdent a heading changes the level of its whole section", () => {
    expect(op(EN, "indent", "# Beta")?.text).toContain("## Beta\nbeta text\n\n### Beta one");
    expect(op(EN, "outdent", "## Beta one")?.text).toContain("# Beta one");
    expect(op(EN, "outdent", "# Alpha")).toBeNull();
  });

  it("indent makes an item the last child of the one before; outdent lifts it", () => {
    const list = "- a\n  - a1\n- b\n- c";
    expect(op(list, "indent", "- b")?.text).toBe("- a\n  - a1\n  - b\n- c");
    expect(op(list, "outdent", "- a1")?.text).toBe("- a\n- a1\n- b\n- c");
    expect(op(list, "indent", "- a")).toBeNull();
    // Ordered lists indent to the text column of the parent.
    expect(op("1. one\n2. two", "indent", "2. two")?.text).toBe("1. one\n   2. two");
  });

  it("duplicate copies the block with its children after it; delete removes it", () => {
    expect(op(EN, "duplicate", "# Gamma")?.text).toBe(EN.replace("# Gamma\ngamma text", "# Gamma\ngamma text\n\n# Gamma\ngamma text"));
    expect(op("- a\n  - a1\n- b", "duplicate", "- a")?.text).toBe("- a\n  - a1\n- a\n  - a1\n- b");
    expect(op(EN, "delete", "# Beta")?.text).toBe(["# Alpha", "alpha text", "", "# Gamma", "gamma text", ""].join("\n"));
  });

  it("a paragraph next to a list swaps with the whole list", () => {
    expect(op("- a\n- b\n\npara", "moveUp", "para")?.text).toBe("para\n\n- a\n- b");
  });
});

describe("text/outline — the six editing operations, RTL (Hebrew)", () => {
  it("move, indent, outdent, duplicate and delete on Hebrew items", () => {
    expect(op(HE, "moveUp", "- פריט ב")?.text).toContain("- פריט ב\n- פריט א\n  - תת א1\n  - תת א2\n- פריט ג");
    expect(op(HE, "moveDown", "- פריט א")?.text).toContain("- פריט ב\n- פריט א\n  - תת א1");
    expect(op(HE, "indent", "- פריט ב")?.text).toContain("  - תת א2\n  - פריט ב\n- פריט ג");
    expect(op(HE, "outdent", "  - תת א2")?.text).toContain("  - תת א1\n- תת א2\n- פריט ב");
    expect(op(HE, "duplicate", "- פריט ג")?.text).toContain("- פריט ג\n- פריט ג\n");
    expect(op(HE, "delete", "- פריט א")?.text).toContain("# אלף\nטקסט אלף\n\n- פריט ב\n- פריט ג");
  });

  it("Hebrew sections move whole", () => {
    expect(op(HE, "moveUp", "# בית")?.text.startsWith("# בית\nטקסט בית\n\n# אלף")).toBe(true);
  });
});

describe("text/outline — folding and zoom never touch the text", () => {
  it("fold ranges cover a section or a subtree, from the end of its first line", () => {
    const lines = EN.split("\n");
    expect(foldRangeAt(lines, 3)).toEqual({ from: EN.indexOf("# Beta") + 6, to: EN.indexOf("inner") + 5 });
    expect(foldRangeAt(lines, 1)).toBeNull();
    const he = HE.split("\n");
    expect(foldRangeAt(he, 3)).not.toBeNull();
    expect(foldRangeAt(he, 6)).toBeNull(); // a single-line item
  });

  it("zoom gives the block's range and its title", () => {
    expect(zoomRange(HE, HE.indexOf("תת א1"))).toEqual({ from: HE.indexOf("  - תת א1"), to: HE.indexOf("  - תת א1") + 9, title: "תת א1" });
    expect(zoomRange(EN, EN.indexOf("## Beta one"))).toEqual({ from: EN.indexOf("## Beta one"), to: EN.indexOf("inner") + 5, title: "Beta one" });
  });

  it("fold keys are the same for the same title, and count repeats", () => {
    const keys = foldKeysOf("# Notes\nx\n\n# Notes\ny\n\n- **Bold** [link](https://example.com)\n  - c");
    expect(keys.map((k) => k.key)).toEqual(["h:notes#0", "h:notes#1", "i:bold link#0"]);
  });
});

describe("fold state per note, outside the file", () => {
  beforeEach(() => localStorage.clear());

  it("saves and loads per note; an empty set removes the entry", () => {
    saveFolds("a.md", ["h:x#0", "h:x#0", "i:y#0"]);
    saveFolds("b.md", ["h:z#0"]);
    expect(loadFolds("a.md")).toEqual(["h:x#0", "i:y#0"]);
    expect(loadFolds("b.md")).toEqual(["h:z#0"]);
    saveFolds("a.md", []);
    expect(loadFolds("a.md")).toEqual([]);
    expect(localStorage.getItem("lumen-outline-folds")).not.toContain("a.md");
  });
});

describe("source editor (CodeMirror)", () => {
  beforeEach(() => localStorage.clear());

  function mount(doc: string, at: string) {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const view = new CMView({ state: CMState.create({ doc, extensions: [outlineExtension()] }), parent });
    view.dispatch({ selection: { anchor: doc.indexOf(at) } });
    return view;
  }

  it("fold, fold all, zoom and their undo leave the document byte-for-byte the same", () => {
    const view = mount(HE, "- פריט א");
    expect(runOutlineCommandInView(view, "fold")).toBe(true);
    expect(foldedRanges(view.state).size).toBe(1);
    runOutlineCommandInView(view, "unfold");
    expect(foldedRanges(view.state).size).toBe(0);
    runOutlineCommandInView(view, "foldAll");
    expect(foldedRanges(view.state).size).toBeGreaterThanOrEqual(2);
    runOutlineCommandInView(view, "unfoldAll");
    expect(runOutlineCommandInView(view, "zoomIn")).toBe(true);
    expect(runOutlineCommandInView(view, "zoomOut")).toBe(true);
    expect(view.state.doc.toString()).toBe(HE);
    view.destroy();
  });

  it("a fold is saved for the note (not in the file)", () => {
    const view = mount(EN, "# Beta");
    runOutlineCommandInView(view, "fold");
    expect(loadFolds("Welcome.md")).toEqual(["h:beta#0"]);
    expect(view.state.doc.toString()).toBe(EN);
    view.destroy();
  });

  it("a block operation is one change", () => {
    const view = mount(EN, "# Beta");
    expect(runOutlineCommandInView(view, "moveDown")).toBe(true);
    expect(view.state.doc.toString()).toBe(op(EN, "moveDown", "# Beta")!.text);
    view.destroy();
  });
});

// A Milkdown-shaped schema: enough for headings, lists and code.
const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { group: "block", content: "inline*", toDOM: () => ["p", 0] },
    heading: { group: "block", content: "inline*", attrs: { level: { default: 1 } }, toDOM: (n) => [`h${n.attrs.level as number}`, 0] },
    bullet_list: { group: "block", content: "list_item+", toDOM: () => ["ul", 0] },
    ordered_list: { group: "block", content: "list_item+", toDOM: () => ["ol", 0] },
    list_item: { content: "paragraph block*", defining: true, toDOM: () => ["li", 0] },
    code_block: { group: "block", content: "text*", code: true, toDOM: () => ["pre", ["code", 0]] },
    text: { group: "inline" },
  },
});

const p = (s: string) => schema.node("paragraph", null, s ? [schema.text(s)] : []);
const h = (level: number, s: string) => schema.node("heading", { level }, [schema.text(s)]);
const li = (s: string, ...kids: PMNode[]) => schema.node("list_item", null, [p(s), ...kids]);
const ul = (...items: PMNode[]) => schema.node("bullet_list", null, items);

function stateAt(doc: PMNode, text: string): EditorState {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(text)) at = pos + n.text!.indexOf(text);
  });
  expect(at, text).toBeGreaterThanOrEqual(0);
  const s = EditorState.create({ doc, schema });
  return s.apply(s.tr.setSelection(TextSelection.create(doc, at)));
}

/** A readable outline of the doc: one line per block, indented by depth. */
function outline(doc: PMNode): string[] {
  const out: string[] = [];
  doc.descendants((n, _pos, parent) => {
    if (n.type.name === "heading") out.push(`${"#".repeat(n.attrs.level as number)} ${n.textContent}`);
    else if (n.type.name === "paragraph") out.push(parent?.type.name === "list_item" ? `- ${n.textContent}` : n.textContent);
    return n.type.name !== "paragraph" && n.type.name !== "heading";
  });
  return out;
}

describe("WYSIWYG editor (ProseMirror) — the same operations", () => {
  const run = (doc: PMNode, at: string, o: OutlineOp) => {
    const tr = outlineOpTransaction(stateAt(doc, at), o);
    return tr ? tr.doc : null;
  };

  const docEn = schema.node("doc", null, [h(1, "Alpha"), p("alpha text"), h(1, "Beta"), p("beta text"), h(2, "Beta one"), p("inner"), h(1, "Gamma"), p("gamma text")]);
  const docHe = schema.node("doc", null, [h(1, "אלף"), ul(li("פריט א", ul(li("תת א1"), li("תת א2"))), li("פריט ב"), li("פריט ג"))]);

  it("move up / down: sections in LTR, items in RTL", () => {
    expect(outline(run(docEn, "Beta", "moveUp")!)).toEqual(["# Beta", "beta text", "## Beta one", "inner", "# Alpha", "alpha text", "# Gamma", "gamma text"]);
    expect(outline(run(docEn, "Beta", "moveDown")!).slice(2, 4)).toEqual(["# Gamma", "gamma text"]);
    expect(run(docEn, "Beta one", "moveUp")).toBeNull();
    expect(outline(run(docHe, "פריט ב", "moveUp")!)).toEqual(["# אלף", "- פריט ב", "- פריט א", "- תת א1", "- תת א2", "- פריט ג"]);
    expect(outline(run(docHe, "פריט א", "moveDown")!).slice(1, 3)).toEqual(["- פריט ב", "- פריט א"]);
  });

  it("indent / outdent: a heading's section, an item into its sibling", () => {
    expect(outline(run(docEn, "Beta", "indent")!).slice(2, 5)).toEqual(["## Beta", "beta text", "### Beta one"]);
    expect(run(docEn, "Alpha", "outdent")).toBeNull();
    const indented = run(docHe, "פריט ב", "indent")!;
    // פריט ב is now inside פריט א's list.
    const first = indented.child(1).child(0);
    expect(first.textContent).toContain("פריט ב");
    expect(indented.child(1).childCount).toBe(2);
    const lifted = run(docHe, "תת א2", "outdent")!;
    expect(lifted.child(1).childCount).toBe(4);
  });

  it("duplicate and delete", () => {
    expect(outline(run(docEn, "Gamma", "duplicate")!).slice(-4)).toEqual(["# Gamma", "gamma text", "# Gamma", "gamma text"]);
    expect(outline(run(docEn, "Beta", "delete")!)).toEqual(["# Alpha", "alpha text", "# Gamma", "gamma text"]);
    expect(outline(run(docHe, "פריט ג", "duplicate")!).slice(-2)).toEqual(["- פריט ג", "- פריט ג"]);
    expect(outline(run(docHe, "פריט א", "delete")!)).toEqual(["# אלף", "- פריט ב", "- פריט ג"]);
  });

  it("foldable blocks use the same keys as the source editor", () => {
    const keys = foldablesOf(docHe).map((f) => f.key);
    const md = "# אלף\n- פריט א\n  - תת א1\n  - תת א2\n- פריט ב\n- פריט ג";
    expect(keys).toEqual(foldKeysOf(md).map((k) => k.key));
    expect(foldablesOf(docEn).map((f) => f.key)).toEqual(foldKeysOf(EN).map((k) => k.key));
  });
});

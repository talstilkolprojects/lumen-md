/**
 * Obsidian syntax in the source editor (W1.3): `==highlights==` (in their
 * colour), `%%comments%%` (faded, across lines too) and callout heads
 * (`> [!type]`) are marked, so the source reads like the preview. Styling
 * only; the text is never changed. Nothing is marked inside code.
 */
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { HIGHLIGHT_COLORS } from "../renderer/remarkObsidian";

/** Above this size only the visible lines are scanned (multi-line comments may then be missed). */
const FULL_SCAN_LIMIT = 200_000;

export interface SourceMark {
  from: number;
  to: number;
  cls: string;
}

/** The marks for a text, in order. Pure, for tests. */
export function obsidianSourceMarks(text: string, offset = 0): SourceMark[] {
  const out: SourceMark[] = [];
  for (const m of text.matchAll(/%%[\s\S]*?(?:%%|$)/g)) {
    out.push({ from: offset + m.index, to: offset + m.index + m[0].length, cls: "cm-obs-comment" });
  }
  const inComment = (i: number) => out.some((c) => c.cls === "cm-obs-comment" && i >= c.from - offset && i < c.to - offset);
  for (const m of text.matchAll(/(?<!=)==(?=\S)([^\n]*?\S)==(?!=)/g)) {
    if (inComment(m.index)) continue;
    const color = Object.entries(HIGHLIGHT_COLORS).find(([e]) => m[1].startsWith(e))?.[1];
    out.push({
      from: offset + m.index,
      to: offset + m.index + m[0].length,
      cls: color ? `cm-obs-highlight hl-${color}` : "cm-obs-highlight",
    });
  }
  for (const m of text.matchAll(/^(?:[ \t]*>[ \t]?)+\[![\w-]+\][+-]?/gm)) {
    if (inComment(m.index)) continue;
    out.push({ from: offset + m.index, to: offset + m.index + m[0].length, cls: "cm-obs-callout" });
  }
  return out.sort((a, b) => a.from - b.from || a.to - b.to);
}

function inCode(view: EditorView, pos: number): boolean {
  const name = syntaxTree(view.state).resolveInner(pos, 1).name;
  return /Code|CodeText|CodeMark|CodeInfo/.test(name);
}

function build(view: EditorView): DecorationSet {
  const doc = view.state.doc;
  const ranges: SourceMark[] = [];
  if (doc.length <= FULL_SCAN_LIMIT) ranges.push(...obsidianSourceMarks(doc.toString()));
  else for (const r of view.visibleRanges) ranges.push(...obsidianSourceMarks(doc.sliceString(r.from, r.to), r.from));
  const b = new RangeSetBuilder<Decoration>();
  for (const r of ranges.sort((x, y) => x.from - y.from || x.to - y.to)) {
    if (r.to <= r.from || inCode(view, r.from)) continue;
    b.add(r.from, r.to, Decoration.mark({ class: r.cls }));
  }
  return b.finish();
}

export const obsidianSourceExtension = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = build(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged || u.viewportChanged) this.decorations = build(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

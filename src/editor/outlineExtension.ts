/**
 * Outline mode in the source editor (plan W2.13): folding of heading
 * sections and list items, zoom into one block, and the block operations
 * of text/outline — all on the plain Markdown text.
 *
 * Folding and zoom are views: they never change the document, so the file
 * stays byte-for-byte the same. The fold state is kept per note in
 * localStorage (text/outline `saveFolds`), never in the file.
 *
 * Keys (also in the palette, "Outline: …"):
 *   Alt+Shift+↑ / ↓            move block up / down
 *   Ctrl+Alt+→ / ←             indent / outdent (in a right-to-left line the
 *                              arrows swap: the one pointing to the line's end indents)
 *   Alt+Shift+D                duplicate block
 *   Alt+Shift+Backspace        delete block
 *   Ctrl+Alt+↑ / ↓             fold / unfold
 *   Ctrl+Alt+Enter             zoom into the block / zoom out
 *
 * Loaded on demand by Editor.tsx, so none of this is in the startup bundle.
 */

import { Direction, Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { Compartment, EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension, type Range, type Transaction } from "@codemirror/state";
import { codeFolding, foldAll, foldEffect, foldGutter, foldKeymap, foldService, foldedRanges, unfoldAll, unfoldEffect } from "@codemirror/language";
import { t } from "../i18n";
import { markdownLineDirection } from "../lib/bidiDirection";
import { tabIdOf, useAppStore } from "../store/useStore";
import {
  OUTLINE_EVENT,
  analyse,
  applyOutlineOp,
  foldKeysOf,
  foldRangeAt,
  loadFolds,
  outlineModeOn,
  saveFolds,
  setOutlineMode,
  zoomRange,
  type OutlineCommand,
  type OutlineOp,
} from "../text/outline";

/* ─── Folding ────────────────────────────────────────────────────── */

const analysisCache = new WeakMap<object, { lines: string[]; info: ReturnType<typeof analyse> }>();
function analysisOf(state: EditorState) {
  let a = analysisCache.get(state.doc);
  if (!a) {
    const lines = state.doc.toString().split("\n");
    a = { lines, info: analyse(lines) };
    analysisCache.set(state.doc, a);
  }
  return a;
}

const outlineFolding = foldService.of((state, lineStart) => {
  const { lines, info } = analysisOf(state);
  const n = state.doc.lineAt(lineStart).number - 1;
  return foldRangeAt(lines, n, info);
});

function noteId(): string {
  return tabIdOf(useAppStore.getState().doc);
}

/** Fold keys of the ranges folded now. */
function foldedKeys(state: EditorState): string[] {
  const byLine = new Map(foldKeysOf(state.doc.toString()).map((k) => [k.line, k.key]));
  const out: string[] = [];
  foldedRanges(state).between(0, state.doc.length, (from) => {
    const key = byLine.get(state.doc.lineAt(from).number - 1);
    if (key) out.push(key);
  });
  return out;
}

function restoreFolds(view: EditorView, note: string): void {
  const wanted = new Set(loadFolds(note));
  if (!wanted.size) return;
  const { lines, info } = analysisOf(view.state);
  const effects: StateEffect<unknown>[] = [];
  for (const { line, key } of foldKeysOf(view.state.doc.toString())) {
    if (!wanted.has(key)) continue;
    const r = foldRangeAt(lines, line, info);
    if (r) effects.push(foldEffect.of(r));
  }
  if (effects.length) view.dispatch({ effects });
}

/* ─── Zoom ───────────────────────────────────────────────────────── */

interface Zoom {
  from: number;
  to: number;
  title: string;
}

const setZoom = StateEffect.define<Zoom | null>();

class ZoomBar extends WidgetType {
  constructor(readonly title: string) {
    super();
  }
  eq(o: ZoomBar) {
    return o.title === this.title;
  }
  toDOM(view: EditorView) {
    const bar = document.createElement("div");
    bar.className = "cm-outline-zoombar";
    bar.setAttribute("dir", "auto");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "cm-outline-zoomout";
    btn.textContent = t("outline.zoomOut");
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch({ effects: setZoom.of(null) });
      view.focus();
    });
    const title = document.createElement("span");
    title.className = "cm-outline-zoomtitle";
    title.textContent = this.title;
    bar.append(btn, title);
    return bar;
  }
  ignoreEvent() {
    return true;
  }
}

function zoomDecorations(state: EditorState, z: Zoom): DecorationSet {
  const doc = state.doc;
  const decos: Range<Decoration>[] = [];
  const bar = new ZoomBar(z.title);
  if (z.from > 0) decos.push(Decoration.replace({ block: true, widget: bar }).range(0, z.from - 1));
  else decos.push(Decoration.widget({ block: true, side: -1, widget: bar }).range(0));
  if (z.to < doc.length) decos.push(Decoration.replace({ block: true }).range(z.to + 1, doc.length));
  return Decoration.set(decos, true);
}

const zoomField = StateField.define<Zoom | null>({
  create: () => null,
  update(z, tr: Transaction) {
    for (const e of tr.effects) if (e.is(setZoom)) return e.value;
    if (!z || !tr.docChanged) return z;
    const from = tr.changes.mapPos(z.from, -1);
    const to = tr.changes.mapPos(z.to, 1);
    if (to <= from) return null;
    // Keep whole lines: the block can grow as the user types at its end.
    const doc = tr.state.doc;
    return { ...z, from: doc.lineAt(from).from, to: doc.lineAt(to).to };
  },
});

// The hidden ranges and the bar, recomputed once per transaction.
const zoomDecoField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(_d, tr) {
    const z = tr.state.field(zoomField);
    return z ? zoomDecorations(tr.state, z) : Decoration.none;
  },
  provide: (f) => [EditorView.decorations.from(f), EditorView.atomicRanges.of((v) => v.state.field(f))],
});

/* ─── Commands ───────────────────────────────────────────────────── */

function runOp(view: EditorView, op: OutlineOp): boolean {
  const before = view.state.doc.toString();
  const head = view.state.selection.main.head;
  const res = applyOutlineOp(before, op, head);
  if (!res) return false;
  // The smallest change: keep the common prefix and suffix.
  let a = 0;
  const max = Math.min(before.length, res.text.length);
  while (a < max && before.charCodeAt(a) === res.text.charCodeAt(a)) a++;
  let b = 0;
  while (b < max - a && before.charCodeAt(before.length - 1 - b) === res.text.charCodeAt(res.text.length - 1 - b)) b++;
  view.dispatch({
    changes: { from: a, to: before.length - b, insert: res.text.slice(a, res.text.length - b) },
    selection: EditorSelection.cursor(Math.min(res.cursor, res.text.length)),
    scrollIntoView: true,
    userEvent: `input.outline.${op}`,
  });
  return true;
}

function foldHere(view: EditorView, fold: boolean): boolean {
  const { lines, info } = analysisOf(view.state);
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head).number - 1;
  // Fold the block the cursor is in: its own first line, or its parent's.
  let n = line;
  let range = foldRangeAt(lines, n, info);
  while (!range && n > 0) {
    n--;
    const r = foldRangeAt(lines, n, info);
    if (r && r.to >= head) range = r;
    if (info[n].kind === "heading" && !r) break;
  }
  if (!range) return false;
  const r = range;
  if (fold) {
    view.dispatch({ effects: foldEffect.of(r), selection: EditorSelection.cursor(Math.min(head, r.from)) });
    return true;
  }
  const found: Array<{ from: number; to: number }> = [];
  foldedRanges(view.state).between(r.from, r.from, (from, to) => {
    if (from === r.from) found.push({ from, to });
  });
  if (!found.length) return false;
  view.dispatch({ effects: found.map((f) => unfoldEffect.of(f)) });
  return true;
}

function zoom(view: EditorView, into: boolean): boolean {
  const current = view.state.field(zoomField);
  if (!into || current) {
    if (!current) return false;
    view.dispatch({ effects: setZoom.of(null), scrollIntoView: true });
    return true;
  }
  const text = view.state.doc.toString();
  const z = zoomRange(text, view.state.selection.main.head);
  if (!z) return false;
  view.dispatch({ effects: setZoom.of(z), selection: EditorSelection.cursor(z.from), scrollIntoView: true });
  return true;
}

const modeCompartment = new Compartment();
const MODE_EXT: Extension = [foldGutter(), EditorView.editorAttributes.of({ class: "cm-outline-mode" })];

function setMode(view: EditorView, on: boolean): void {
  view.dispatch({ effects: modeCompartment.reconfigure(on ? MODE_EXT : []) });
}

export function runOutlineCommandInView(view: EditorView, cmd: OutlineCommand): boolean {
  switch (cmd) {
    case "fold":
      return foldHere(view, true);
    case "unfold":
      return foldHere(view, false);
    case "foldAll":
      return foldAll(view);
    case "unfoldAll":
      return unfoldAll(view);
    case "zoomIn":
      return zoom(view, true);
    case "zoomOut":
      return zoom(view, false);
    case "toggleMode": {
      const note = noteId();
      const on = !outlineModeOn(note);
      setOutlineMode(note, on);
      setMode(view, on);
      if (on) foldAll(view);
      return true;
    }
    default:
      return runOp(view, cmd);
  }
}

/** Indent/outdent by arrow: the arrow toward the line's end indents. */
function arrowIndent(towardRight: boolean) {
  return (view: EditorView) => {
    // The line's own direction, by the same rule as the bidi extension (its
    // first strong character after the Markdown markers); the layout's only
    // for a line without one.
    const head = view.state.selection.main.head;
    const own = markdownLineDirection(view.state.doc.lineAt(head).text);
    const rtl = own ? own === "rtl" : view.textDirectionAt(head) === Direction.RTL;
    runOp(view, towardRight !== rtl ? "indent" : "outdent");
    return true;
  };
}

const outlineKeymap = Prec.high(
  keymap.of([
    { key: "Alt-Shift-ArrowUp", run: (v) => (runOp(v, "moveUp"), true) },
    { key: "Alt-Shift-ArrowDown", run: (v) => (runOp(v, "moveDown"), true) },
    { key: "Mod-Alt-ArrowRight", run: arrowIndent(true) },
    { key: "Mod-Alt-ArrowLeft", run: arrowIndent(false) },
    { key: "Alt-Shift-d", run: (v) => (runOp(v, "duplicate"), true) },
    // Where Option types a character (macOS, and WebKit reporting a Mac), the key arrives as Alt + "D".
    { key: "Alt-D", run: (v) => (runOp(v, "duplicate"), true) },
    { key: "Alt-Shift-Backspace", run: (v) => (runOp(v, "delete"), true) },
    { key: "Mod-Alt-ArrowUp", run: (v) => (foldHere(v, true), true) },
    { key: "Mod-Alt-ArrowDown", run: (v) => (foldHere(v, false), true) },
    { key: "Mod-Alt-Enter", run: (v) => zoom(v, !v.state.field(zoomField)) },
    { key: "Escape", run: (v) => (v.state.field(zoomField) ? zoom(v, false) : false) },
  ]),
);

/** Keeps folds per note, restores them on open, and runs palette commands. */
const persistence = ViewPlugin.fromClass(
  class {
    note: string;
    private onCmd: (e: Event) => void;
    constructor(readonly view: EditorView) {
      this.note = noteId();
      this.onCmd = (e: Event) => {
        const cmd = (e as CustomEvent<{ cmd: OutlineCommand }>).detail?.cmd;
        if (!cmd || !this.view.dom.isConnected) return;
        runOutlineCommandInView(this.view, cmd);
        this.view.focus();
      };
      window.addEventListener(OUTLINE_EVENT, this.onCmd);
      setTimeout(() => this.open(), 0);
    }
    open() {
      if (!this.view.dom.isConnected) return;
      setMode(this.view, outlineModeOn(this.note));
      restoreFolds(this.view, this.note);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        const note = noteId();
        // A whole-document replace (another note opened, or reloaded from disk).
        let whole = false;
        u.changes.iterChangedRanges((fromA, toA) => {
          if (fromA === 0 && toA === u.startState.doc.length) whole = true;
        });
        if (note !== this.note || whole) {
          this.note = note;
          if (u.state.field(zoomField)) setTimeout(() => this.view.dispatch({ effects: setZoom.of(null) }), 0);
          setTimeout(() => this.open(), 0);
          return;
        }
      }
      // Only explicit fold / unfold changes the saved state: an edit that
      // removes a folded block must not forget the other folds.
      const touched = u.transactions.some((tr) => tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
      if (touched) saveFolds(this.note, foldedKeys(u.state));
    }
    destroy() {
      window.removeEventListener(OUTLINE_EVENT, this.onCmd);
    }
  },
);

const outlineTheme = EditorView.baseTheme({
  ".cm-outline-zoombar": {
    display: "flex",
    gap: "0.5em",
    alignItems: "center",
    padding: "4px 0 8px",
    fontSize: "0.85em",
    opacity: "0.85",
  },
  ".cm-outline-zoomout": {
    font: "inherit",
    cursor: "pointer",
    border: "1px solid currentColor",
    borderRadius: "4px",
    background: "transparent",
    color: "inherit",
    padding: "0 6px",
  },
  ".cm-outline-zoomtitle": { fontWeight: "600" },
});

export function outlineExtension(): Extension {
  return [codeFolding(), outlineFolding, keymap.of(foldKeymap), outlineKeymap, zoomField, zoomDecoField, modeCompartment.of([]), persistence, outlineTheme];
}

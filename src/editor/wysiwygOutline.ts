/**
 * Outline mode in the WYSIWYG editor (plan W2.13): the same block
 * operations, folding and zoom as the source editor (outlineExtension.ts),
 * on ProseMirror nodes.
 *
 * A block is a list item with its children, a heading with its section (the
 * top-level nodes up to the next heading of the same or a higher level), or
 * any other top-level node. Folding and zoom are decorations only — the
 * document doesn't change, so Milkdown emits nothing and the file stays
 * byte-for-byte the same. Folds use the same per-note keys as the source
 * editor (text/outline `foldKey`), so a section folded in one editor is
 * folded in the other.
 */

import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/prose/state";
import { Decoration, DecorationSet, type EditorView } from "@milkdown/prose/view";
import { Fragment, type Node as PMNode, type ResolvedPos } from "@milkdown/prose/model";
import { keymap } from "prosemirror-keymap";
import { liftListItem, sinkListItem } from "prosemirror-schema-list";
import { t } from "../i18n";
import { firstStrong } from "../lib/bidiDirection";
import { tabIdOf, useAppStore } from "../store/useStore";
import { OUTLINE_EVENT, foldKey, loadFolds, outlineModeOn, saveFolds, setOutlineMode, type OutlineCommand, type OutlineOp } from "../text/outline";

type Target =
  | { kind: "item"; pos: number; node: PMNode; depth: number; $pos: ResolvedPos }
  | { kind: "heading"; start: number; end: number }
  | { kind: "block"; start: number; end: number };

interface OutlineState {
  folds: Set<string>;
  /** Zoom: a position inside the zoomed node (mapped through edits), or null. */
  zoom: number | null;
  mode: boolean;
  decos: DecorationSet;
}

export const wysiwygOutlineKey = new PluginKey<OutlineState>("lumen-outline");

const ITEM = "list_item";

function noteId(): string {
  return tabIdOf(useAppStore.getState().doc);
}

/* ─── Blocks ─────────────────────────────────────────────────────── */

function topPos(doc: PMNode, index: number): number {
  let pos = 0;
  for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
  return pos;
}

function sectionEnd(doc: PMNode, i: number): number {
  const level = doc.child(i).attrs.level as number;
  let j = i + 1;
  while (j < doc.childCount && !(doc.child(j).type.name === "heading" && (doc.child(j).attrs.level as number) <= level)) j++;
  return j;
}

function targetAt(state: EditorState): Target | null {
  const $from = state.selection.$from;
  for (let d = $from.depth; d > 0; d--) {
    if ($from.node(d).type.name === ITEM) return { kind: "item", pos: $from.before(d), node: $from.node(d), depth: d, $pos: $from };
  }
  if ($from.depth < 1) return null;
  const i = $from.index(0);
  const top = state.doc.child(i);
  if (top.type.name === "heading") return { kind: "heading", start: i, end: sectionEnd(state.doc, i) };
  return { kind: "block", start: i, end: i + 1 };
}

function children(doc: PMNode, from: number, to: number): PMNode[] {
  const out: PMNode[] = [];
  for (let i = from; i < to; i++) out.push(doc.child(i));
  return out;
}

/** Previous / next sibling range of a top-level target, as child indices. */
function topSibling(doc: PMNode, tg: { kind: "heading" | "block"; start: number; end: number }, dir: -1 | 1): [number, number] | null {
  if (tg.kind === "heading") {
    const level = doc.child(tg.start).attrs.level as number;
    if (dir < 0) {
      for (let k = tg.start - 1; k >= 0; k--) {
        const n = doc.child(k);
        if (n.type.name !== "heading") continue;
        const l = n.attrs.level as number;
        if (l < level) return null;
        if (l === level) return [k, tg.start];
      }
      return null;
    }
    if (tg.end >= doc.childCount) return null;
    const n = doc.child(tg.end);
    return n.type.name === "heading" && n.attrs.level === level ? [tg.end, sectionEnd(doc, tg.end)] : null;
  }
  const k = dir < 0 ? tg.start - 1 : tg.end;
  if (k < 0 || k >= doc.childCount || doc.child(k).type.name === "heading") return null;
  return [k, k + 1];
}

/** Apply one block operation. Returns null when it doesn't apply. */
export function outlineOpTransaction(state: EditorState, op: OutlineOp): Transaction | null {
  const tg = targetAt(state);
  if (!tg) return null;
  const { doc } = state;
  const selFrom = state.selection.from;
  const tr = state.tr;
  const place = (pos: number) => {
    const p = Math.max(0, Math.min(pos, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(p)));
    return tr.scrollIntoView();
  };

  if (tg.kind === "item") {
    const listDepth = tg.depth - 1;
    const list = tg.$pos.node(listDepth);
    const index = tg.$pos.index(listDepth);
    const start = tg.pos;
    const end = start + tg.node.nodeSize;
    const inItem = selFrom - start;
    switch (op) {
      case "moveUp": {
        if (index === 0) return null;
        const prev = list.child(index - 1);
        const prevStart = start - prev.nodeSize;
        tr.replaceWith(prevStart, end, Fragment.from([tg.node, prev]));
        return place(prevStart + inItem);
      }
      case "moveDown": {
        if (index + 1 >= list.childCount) return null;
        const next = list.child(index + 1);
        tr.replaceWith(start, end + next.nodeSize, Fragment.from([next, tg.node]));
        return place(start + next.nodeSize + inItem);
      }
      case "indent":
      case "outdent": {
        const type = state.schema.nodes[ITEM];
        if (!type) return null;
        let out: Transaction | null = null;
        const cmd = op === "indent" ? sinkListItem(type) : liftListItem(type);
        cmd(state, (t2) => {
          out = t2;
        });
        return out;
      }
      case "duplicate":
        tr.insert(end, tg.node);
        return place(end + inItem);
      case "delete": {
        if (list.childCount === 1) {
          const lStart = tg.$pos.before(listDepth);
          tr.delete(lStart, lStart + list.nodeSize);
        } else tr.delete(start, end);
        if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph.create());
        return place(start);
      }
    }
  }

  const range = tg as { kind: "heading" | "block"; start: number; end: number };
  const from = topPos(doc, range.start);
  const to = topPos(doc, range.end);
  const inBlock = selFrom - from;
  switch (op) {
    case "moveUp":
    case "moveDown": {
      const sib = topSibling(doc, range, op === "moveUp" ? -1 : 1);
      if (!sib) return null;
      const mine = children(doc, range.start, range.end);
      const theirs = children(doc, sib[0], sib[1]);
      if (op === "moveUp") {
        const sFrom = topPos(doc, sib[0]);
        tr.replaceWith(sFrom, to, Fragment.from([...mine, ...theirs]));
        return place(sFrom + inBlock);
      }
      const sTo = topPos(doc, sib[1]);
      tr.replaceWith(from, sTo, Fragment.from([...theirs, ...mine]));
      return place(from + (sTo - to) + inBlock);
    }
    case "indent":
    case "outdent": {
      if (range.kind !== "heading") return null;
      const sign = op === "indent" ? 1 : -1;
      const heads: Array<{ pos: number; node: PMNode }> = [];
      for (let i = range.start, pos = from; i < range.end; pos += doc.child(i).nodeSize, i++) {
        if (doc.child(i).type.name === "heading") heads.push({ pos, node: doc.child(i) });
      }
      if (heads.some((h) => (h.node.attrs.level as number) + sign < 1 || (h.node.attrs.level as number) + sign > 6)) return null;
      for (const h of heads) tr.setNodeMarkup(h.pos, undefined, { ...h.node.attrs, level: (h.node.attrs.level as number) + sign });
      return tr.scrollIntoView();
    }
    case "duplicate":
      tr.insert(to, Fragment.from(children(doc, range.start, range.end)));
      return place(to + inBlock);
    case "delete":
      tr.delete(from, to);
      if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph.create());
      return place(from);
  }
  return null;
}

/* ─── Folds and zoom (decorations only) ──────────────────────────── */

/** A block's title as the source editor sees it, and its fold key. */
function itemTitle(item: PMNode): string {
  const first = item.firstChild;
  return first ? first.textContent : "";
}

interface Foldable {
  key: string;
  /** Position of the node that carries the fold. */
  pos: number;
  node: PMNode;
  /** Positions + nodes hidden when folded. */
  hide: Array<{ pos: number; node: PMNode }>;
}

/** Every foldable block with its key, in document order. */
export function foldablesOf(doc: PMNode): Foldable[] {
  const seen = new Map<string, number>();
  const out: Foldable[] = [];
  const keyFor = (kind: "heading" | "item", title: string) => {
    const base = foldKey(kind, title, 0).replace(/#0$/, "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  };
  doc.descendants((node, pos, parent, index) => {
    if (node.type.name === "code_block" || node.type.name === "math_block") return false;
    if (node.type.name === "heading" && parent === doc) {
      const key = keyFor("heading", node.textContent);
      const end = sectionEnd(doc, index);
      if (end > index + 1) {
        const hide: Foldable["hide"] = [];
        let p = pos + node.nodeSize;
        for (let i = index + 1; i < end; i++) {
          hide.push({ pos: p, node: doc.child(i) });
          p += doc.child(i).nodeSize;
        }
        out.push({ key, pos, node, hide });
      }
      return false;
    }
    if (node.type.name === ITEM) {
      const key = keyFor("item", itemTitle(node));
      if (node.childCount > 1) {
        const hide: Foldable["hide"] = [];
        let p = pos + 1 + node.child(0).nodeSize;
        for (let i = 1; i < node.childCount; i++) {
          hide.push({ pos: p, node: node.child(i) });
          p += node.child(i).nodeSize;
        }
        out.push({ key, pos, node, hide });
      }
      return true;
    }
    return true;
  });
  return out;
}

function zoomBarDom(view: EditorView, title: string): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "lumen-outline-zoombar";
    bar.setAttribute("contenteditable", "false");
    bar.setAttribute("dir", "auto");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "lumen-outline-zoomout";
    btn.textContent = t("outline.zoomOut");
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, { zoom: null }));
      view.focus();
    });
    const span = document.createElement("span");
    span.className = "lumen-outline-zoomtitle";
    span.textContent = title;
    bar.append(btn, span);
    return bar;
}

function toggleDom(view: EditorView, key: string, folded: boolean): HTMLElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "lumen-outline-toggle";
  b.setAttribute("contenteditable", "false");
  b.setAttribute("aria-expanded", folded ? "false" : "true");
  b.setAttribute("aria-label", folded ? t("outline.unfold") : t("outline.fold"));
  b.textContent = folded ? "▸" : "▾";
  b.addEventListener("mousedown", (e) => {
    e.preventDefault();
    const s = wysiwygOutlineKey.getState(view.state);
    if (!s) return;
    const folds = new Set(s.folds);
    if (folds.has(key)) folds.delete(key);
    else folds.add(key);
    view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, { folds }));
  });
  return b;
}

function decorate(doc: PMNode, s: Omit<OutlineState, "decos">, view: EditorView | null): DecorationSet {
  const decos: Decoration[] = [];
  const hidden = new Set<number>();
  for (const f of foldablesOf(doc)) {
    const folded = s.folds.has(f.key);
    if (folded) {
      decos.push(Decoration.node(f.pos, f.pos + f.node.nodeSize, { class: "lumen-folded" }));
      for (const h of f.hide) {
        if (hidden.has(h.pos)) continue;
        hidden.add(h.pos);
        decos.push(Decoration.node(h.pos, h.pos + h.node.nodeSize, { class: "lumen-fold-hidden" }));
      }
    }
    if (s.mode && view) {
      const v = view;
      decos.push(Decoration.widget(f.pos + 1, () => toggleDom(v, f.key, folded), { side: -1, key: `t:${f.key}:${folded}`, ignoreSelection: true }));
    }
  }
  if (s.zoom !== null && s.zoom <= doc.content.size) {
    const $p = doc.resolve(s.zoom);
    let itemDepth = 0;
    for (let d = $p.depth; d > 0; d--) if ($p.node(d).type.name === ITEM) {
      itemDepth = d;
      break;
    }
    const hide = (pos: number, node: PMNode) => {
      if (!hidden.has(pos)) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: "lumen-fold-hidden" }));
    };
    let title = "";
    if (itemDepth) {
      // Keep the path down to the item; hide everything else beside it.
      for (let d = 1; d <= itemDepth; d++) {
        const parent = $p.node(d - 1);
        const keep = $p.index(d - 1);
        let pos = d === 1 ? 0 : $p.start(d - 1);
        for (let i = 0; i < parent.childCount; i++) {
          const c = parent.child(i);
          if (i !== keep) hide(pos, c);
          pos += c.nodeSize;
        }
      }
      title = itemTitle($p.node(itemDepth));
    } else if ($p.depth >= 1) {
      const i = $p.index(0);
      const top = doc.child(i);
      const end = top.type.name === "heading" ? sectionEnd(doc, i) : i + 1;
      let pos = 0;
      for (let k = 0; k < doc.childCount; k++) {
        if (k < i || k >= end) hide(pos, doc.child(k));
        pos += doc.child(k).nodeSize;
      }
      title = top.textContent;
    }
    if (view) {
      const v = view;
      const at = $p.depth >= 1 ? $p.before(1) : 0;
      decos.push(Decoration.widget(at, () => zoomBarDom(v, title), { side: -1, key: `z:${title}`, ignoreSelection: true }));
    }
  }
  return DecorationSet.create(doc, decos);
}

let styleInjected = false;
function injectStyle(): void {
  if (styleInjected || typeof document === "undefined") return;
  styleInjected = true;
  const el = document.createElement("style");
  el.textContent = [
    ".lumen-fold-hidden{display:none !important}",
    ".lumen-folded > :first-child::after, h1.lumen-folded::after, h2.lumen-folded::after, h3.lumen-folded::after, h4.lumen-folded::after, h5.lumen-folded::after, h6.lumen-folded::after{content:' …';opacity:.6}",
    ".lumen-outline-toggle{all:unset;cursor:pointer;display:inline-block;width:1.1em;margin-inline-end:.25em;opacity:.6;font-size:.8em}",
    ".lumen-outline-zoombar{display:flex;gap:.5em;align-items:center;padding:4px 0 8px;font-size:.85em;opacity:.85}",
    ".lumen-outline-zoomout{font:inherit;cursor:pointer;border:1px solid currentColor;border-radius:4px;background:transparent;color:inherit;padding:0 6px}",
    ".lumen-outline-zoomtitle{font-weight:600}",
  ].join("\n");
  document.head.appendChild(el);
}

/* ─── Commands ───────────────────────────────────────────────────── */

function blockIsRtl(view: EditorView): boolean {
  // The block's own text decides (the rule of wysiwygBidi); the layout only when it has no strong character.
  const own = firstStrong(view.state.selection.$from.parent.textContent);
  if (own) return own === "rtl";
  try {
    const { node } = view.domAtPos(view.state.selection.from);
    const el = node instanceof HTMLElement ? node : node.parentElement;
    return !!el && getComputedStyle(el).direction === "rtl";
  } catch {
    return false;
  }
}

function setFolds(view: EditorView, update: (folds: Set<string>, all: Foldable[]) => void): boolean {
  const s = wysiwygOutlineKey.getState(view.state);
  if (!s) return false;
  const folds = new Set(s.folds);
  update(folds, foldablesOf(view.state.doc));
  view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, { folds }));
  return true;
}

/** The foldable block the cursor is in (innermost). */
function foldableHere(view: EditorView): Foldable | null {
  const sel = view.state.selection.from;
  let best: Foldable | null = null;
  for (const f of foldablesOf(view.state.doc)) {
    const end = f.hide.length ? f.hide[f.hide.length - 1].pos + f.hide[f.hide.length - 1].node.nodeSize : f.pos + f.node.nodeSize;
    if (sel >= f.pos && sel <= end) best = f;
  }
  return best;
}

export function runOutlineCommandInWysiwyg(view: EditorView, cmd: OutlineCommand): boolean {
  const s = wysiwygOutlineKey.getState(view.state);
  if (!s) return false;
  switch (cmd) {
    case "fold":
    case "unfold": {
      const f = foldableHere(view);
      if (!f) return false;
      return setFolds(view, (folds) => (cmd === "fold" ? folds.add(f.key) : folds.delete(f.key)));
    }
    case "foldAll":
      return setFolds(view, (folds, all) => {
        // Top level only, like the source editor: a folded parent hides the rest.
        const doc = view.state.doc;
        for (const f of all) if (doc.resolve(f.pos).depth === 0 || doc.resolve(f.pos).depth === 1) folds.add(f.key);
      });
    case "unfoldAll":
      return setFolds(view, (folds) => folds.clear());
    case "zoomIn":
      view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, { zoom: view.state.selection.from }).scrollIntoView());
      return true;
    case "zoomOut":
      if (s.zoom === null) return false;
      view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, { zoom: null }));
      return true;
    case "toggleMode": {
      const note = noteId();
      const on = !outlineModeOn(note);
      setOutlineMode(note, on);
      view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, { mode: on }));
      if (on) runOutlineCommandInWysiwyg(view, "foldAll");
      return true;
    }
    default: {
      const tr = outlineOpTransaction(view.state, cmd);
      if (tr) view.dispatch(tr);
      return true;
    }
  }
}

function arrowIndent(towardRight: boolean) {
  return (_s: EditorState, _d?: (tr: Transaction) => void, view?: EditorView) => {
    if (!view) return false;
    const rtl = blockIsRtl(view);
    return runOutlineCommandInWysiwyg(view, towardRight !== rtl ? "indent" : "outdent");
  };
}

const run = (cmd: OutlineCommand) => (_s: EditorState, _d?: (tr: Transaction) => void, view?: EditorView) => (view ? (runOutlineCommandInWysiwyg(view, cmd), true) : false);

export function wysiwygOutlineKeymap(): Plugin {
  return keymap({
    "Alt-Shift-ArrowUp": run("moveUp"),
    "Alt-Shift-ArrowDown": run("moveDown"),
    "Mod-Alt-ArrowRight": arrowIndent(true),
    "Mod-Alt-ArrowLeft": arrowIndent(false),
    "Alt-Shift-d": run("duplicate"),
    "Alt-Shift-D": run("duplicate"),
    "Alt-Shift-Backspace": run("delete"),
    "Mod-Alt-ArrowUp": run("fold"),
    "Mod-Alt-ArrowDown": run("unfold"),
    "Mod-Alt-Enter": (state, _d, view) => (view ? runOutlineCommandInWysiwyg(view, wysiwygOutlineKey.getState(state)?.zoom !== null ? "zoomOut" : "zoomIn") : false),
  });
}

export function wysiwygOutlinePlugin(): Plugin<OutlineState> {
  const note = noteId();
  let viewRef: EditorView | null = null;
  return new Plugin<OutlineState>({
    key: wysiwygOutlineKey,
    state: {
      init: (_c, state) => {
        const base = { folds: new Set(loadFolds(note)), zoom: null, mode: outlineModeOn(note) };
        return { ...base, decos: decorate(state.doc, base, null) };
      },
      apply(tr, prev, _old, state) {
        const meta = tr.getMeta(wysiwygOutlineKey) as Partial<Omit<OutlineState, "decos">> | undefined;
        if (!meta && !tr.docChanged) return prev;
        const next = {
          folds: meta?.folds ?? prev.folds,
          zoom: meta && "zoom" in meta ? (meta.zoom ?? null) : prev.zoom === null ? null : tr.mapping.map(prev.zoom),
          mode: meta?.mode ?? prev.mode,
        };
        if (meta?.folds) saveFolds(note, [...meta.folds]);
        return { ...next, decos: decorate(state.doc, next, viewRef) };
      },
    },
    props: {
      decorations: (state) => wysiwygOutlineKey.getState(state)?.decos ?? null,
      attributes: (state): Record<string, string> => (wysiwygOutlineKey.getState(state)?.mode ? { class: "lumen-outline-mode" } : {}),
    },
    view(view) {
      viewRef = view;
      injectStyle();
      // Redraw once with the view, so toggles and the zoom bar can act on it.
      setTimeout(() => {
        if (view.isDestroyed) return;
        view.dispatch(view.state.tr.setMeta(wysiwygOutlineKey, {}));
      }, 0);
      const onCmd = (e: Event) => {
        const cmd = (e as CustomEvent<{ cmd: OutlineCommand }>).detail?.cmd;
        if (!cmd || !view.dom.isConnected) return;
        runOutlineCommandInWysiwyg(view, cmd);
        view.focus();
      };
      window.addEventListener(OUTLINE_EVENT, onCmd);
      return {
        destroy() {
          window.removeEventListener(OUTLINE_EVENT, onCmd);
          viewRef = null;
        },
      };
    },
  });
}

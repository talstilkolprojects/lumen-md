/**
 * Suggesting mode (track changes) in the WYSIWYG editor.
 *
 * The document stays plain markdown with CriticMarkup, exactly as in the
 * source editor (see ./suggesting.ts):
 *
 *   {++inserted++}   {--deleted--}   {~~old~>new~~}   + optional {>>@author<<}
 *
 * In Milkdown, insertions and deletions are two ProseMirror marks,
 * `critic_insert` and `critic_delete` (attr `author`):
 *
 *  - parse: before Milkdown sees the markdown, `encodeCriticForWysiwyg`
 *    swaps every delimiter (outside code) for a private-use sentinel
 *    (the renderer's own `prepareCriticMarkup`); `remarkCriticMarkup`
 *    pairs the sentinels inside each phrasing parent into `criticInsert` /
 *    `criticDelete` mdast nodes, which the mark schemas turn into marks
 *    (a suggestion spanning paragraphs is first split per block, where
 *    that is lossless — see pairAcrossBlocks).
 *    Comments and highlights stay literal text.
 *  - serialize: the marks become those mdast nodes again, and the
 *    remark-stringify handlers write CriticMarkup — an adjacent
 *    deletion + insertion is written as one substitution.
 *  - track: while suggesting is on, `suggestTrackingPlugin` rewrites each
 *    user edit: typed / pasted text gets `critic_insert`; deleted text is
 *    put back with `critic_delete` (deleting one's own insertion really
 *    deletes it); structural deletions (joining blocks) are undone.
 */
import { $prose } from "@milkdown/utils";
import type { Node as ProseNode, Schema, Slice } from "@milkdown/prose/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@milkdown/prose/state";
import { ReplaceStep, type Mapping } from "@milkdown/prose/transform";
import { parseSuggestions, sanitizeAuthor, type Resolution, type Suggestion } from "./suggesting";
import { setWysiwygSuggestActions, type WysiwygSuggestActions } from "./wysiwygSuggestBridge";
import { criticRemark, criticInsertSchema, criticDeleteSchema } from "./wysiwygCritic";
export { remarkCriticMarkup, criticRemark, criticInsertSchema, criticDeleteSchema, encodeCriticForWysiwyg } from "./wysiwygCritic";

/* ─── Configuration (set by the editor host) ────────────────────────── */

export interface WysiwygSuggestConfig {
  enabled: () => boolean;
  author: () => string | null;
}
let config: WysiwygSuggestConfig = { enabled: () => false, author: () => null };
export function configureWysiwygSuggest(next: WysiwygSuggestConfig): void {
  config = next;
}

type View = import("@milkdown/prose/view").EditorView;

/**
 * The mounted WYSIWYG views, for the palette's commands. More than one can
 * be mounted at once (the main editor under the Focus Mode overlay), so
 * each registers and unregisters itself by identity — one unmounting
 * leaves the other in charge. The most recently focused one is last.
 */
const views: View[] = [];
const toFront = (e: Event) => {
  const i = views.findIndex((v) => v.dom === e.currentTarget);
  if (i !== -1) views.push(...views.splice(i, 1));
};

const actions: WysiwygSuggestActions = {
  resolve: (mode) => {
    const v = getActiveWysiwygView();
    const ok = !!v && resolveAtCursor(v, mode);
    if (ok) v!.focus();
    return ok;
  },
  jump: (dir) => {
    const v = getActiveWysiwygView();
    const ok = !!v && jumpToChange(v, dir);
    if (ok) v!.focus();
    return ok;
  },
  // Against the live editor state, so edits the debounced listener
  // hasn't emitted yet are neither lost nor missed.
  resolveAll: (mode) => {
    const v = getActiveWysiwygView();
    if (!v) return false;
    const tr = resolveAllChanges(v.state, mode);
    if (!tr) return false;
    v.dispatch(tr);
    v.focus();
    return true;
  },
};

export function registerWysiwygView(view: View): void {
  if (!views.includes(view)) {
    views.push(view);
    view.dom.addEventListener("focusin", toFront);
  }
  setWysiwygSuggestActions(actions);
}

export function unregisterWysiwygView(view: View): void {
  const i = views.indexOf(view);
  if (i !== -1) {
    views.splice(i, 1);
    view.dom.removeEventListener("focusin", toFront);
  }
  if (views.length === 0) setWysiwygSuggestActions(null);
}

export function getActiveWysiwygView(): View | null {
  for (let i = views.length - 1; i >= 0; i--) if (views[i].dom.isConnected) return views[i];
  return null;
}

/** Transactions this module makes itself (never re-tracked). */
export const SUGGEST_META = "lumenSuggest";
const trackingKey = new PluginKey("lumenSuggestTracking");

interface Change {
  from: number;
  insertedSize: number;
  deleted: Slice;
  /** The insertion adds block structure (Enter, multi-paragraph paste). */
  structural: boolean;
}

/** A slice that adds or splits blocks rather than only inline content. */
/** CriticMarkup delimiters: typed inside a suggestion they'd end or nest it. */
const CRITIC_DELIM = /\{(?:\+\+|--|~~|==|>>)|(?:\+\+|--|~~|==|<<)\}|~>/g;

/**
 * True when text inserted at [from, to) would form a CriticMarkup
 * delimiter with itself or its neighbours: serialized as `{++…++}`, such
 * an insertion couldn't be read back as one suggestion (source mode
 * refuses the same edits).
 */
function formsDelimiter(doc: EditorState["doc"], from: number, to: number): boolean {
  const $from = doc.resolve(from);
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return false;
  const start = Math.max($from.start(), from - 2);
  const end = Math.min($from.end(), to + 2);
  if (to > end) return false;
  const text = doc.textBetween(start, end, "\n", "\ufffc");
  for (const m of text.matchAll(CRITIC_DELIM)) {
    const a = start + m.index!;
    if (a < to && a + m[0].length > from) return true;
  }
  return false;
}

export function isStructural(slice: Slice): boolean {
  // A slice open on both sides around a single textblock (how a pasted
  // paragraph of inline text can arrive: `paragraph("x")` open 1/1) is
  // inline content; any other block boundary in it is structure.
  let frag = slice.content;
  let start = slice.openStart;
  let end = slice.openEnd;
  while (start > 0 && end > 0) {
    if (frag.childCount !== 1) return true;
    frag = frag.firstChild!.content;
    start--;
    end--;
  }
  if (start !== end) return true;
  let block = false;
  frag.forEach((n) => {
    if (n.isBlock) block = true;
  });
  return block;
}

/** Inline code: text with a `code` mark (CriticMarkup is literal there). */
const isCodeText = (n: ProseNode | null | undefined) => !!n && n.isText && n.marks.some((m) => m.type.spec.code);

/**
 * True when a replace step lies wholly in code, where source mode leaves
 * edits untracked: inside one code block, or inside an inline code span —
 * which in ProseMirror is a mark on paragraph text, not a code node, so the
 * removed and the inserted inline content must all be code-marked text,
 * next to existing code.
 */
function stepInCode(before: ProseNode, from: number, to: number, slice: Slice): boolean {
  const $from = before.resolve(from);
  if (!$from.sameParent(before.resolve(to))) return false;
  if ($from.parent.type.spec.code) return true;
  if (!isCodeText($from.nodeBefore) && !isCodeText($from.nodeAfter)) return false;
  let code = true;
  if (to > from) before.nodesBetween(from, to, (n) => void (n.isInline && !isCodeText(n) && (code = false)));
  slice.content.descendants((n) => void (n.isInline && !isCodeText(n) && (code = false)));
  return code;
}

/**
 * A user transaction suggesting mode can't track:
 *  - any step other than a plain replace: formatting (mark steps), block
 *    type and list structure (replace-around), node attributes;
 *  - a replace that inserts structure (a paragraph split, a multi-block
 *    paste, a dragged block);
 *  - a deletion whose text contains a CriticMarkup delimiter, which
 *    couldn't be read back as one suggestion.
 * Edits wholly inside a code block or code span are exempt (they pass untracked).
 */
function untrackable(tr: Transaction): boolean {
  return tr.steps.some((st, i) => {
    if (!(st instanceof ReplaceStep)) return true;
    const { from, to, slice } = st as unknown as { from: number; to: number; slice: Slice };
    const before = tr.docs[i];
    const $from = before.resolve(from);
    if (stepInCode(before, from, to, slice)) return false;
    if (slice.size > 0 && isStructural(slice) && !$from.parent.type.spec.code) return true;
    // The text the step leaves behind — two characters each side, plus any
    // inserted text — mustn't form a CriticMarkup delimiter across the edit
    // (`a++}b` typed over a selection, or `+X+}` minus `X`): such a change
    // couldn't be read back as one suggestion. Refused whole, as in source mode.
    const $to = before.resolve(to);
    if ($from.sameParent($to) && $from.parent.isTextblock && !$from.parent.type.spec.code) {
      const left = before.textBetween(Math.max($from.start(), from - 2), from, "", "\ufffc");
      const mid = slice.content.textBetween(0, slice.content.size, "", "\ufffc");
      const right = before.textBetween(to, Math.min($to.end(), to + 2), "", "\ufffc");
      for (const m of (left + mid + right).matchAll(CRITIC_DELIM)) {
        const a = m.index!;
        if (a < left.length + mid.length && a + m[0].length > left.length) return true;
      }
    }
    if (to > from) {
      // A removed block (a whole paragraph or list item, or a boundary
      // between two) can't be suggested: accepting couldn't remove it.
      if (isStructural(before.slice(from, to))) return true;
      // `match` (not `test`) leaves the shared global regex's lastIndex alone.
      if (before.textBetween(from, to, "\n", "\ufffc").match(CRITIC_DELIM)) return true;
    }
    return false;
  });
}

/** True when a slice holds an inline node other than text (an image, a hard break). */
function hasAtom(slice: Slice): boolean {
  let atom = false;
  slice.content.descendants((n) => {
    if (n.isInline && !n.isText) atom = true;
  });
  return atom;
}

/** Text content of a slice, ignoring structure. */
const sliceText = (slice: Slice) => slice.content.textBetween(0, slice.content.size, "", "");

/**
 * Rewrite the user's transactions (already applied in `newState`) into
 * tracked changes. Returns the follow-up transaction, or null.
 */
export function trackChanges(
  trs: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  author: string | null,
): Transaction | null {
  const schema: Schema = newState.schema;
  const ins = schema.marks.critic_insert;
  const del = schema.marks.critic_delete;
  if (!ins || !del) return null;
  const user = trs.filter(
    (tr) => tr.docChanged && !tr.getMeta(SUGGEST_META) && !tr.getMeta("history$") && tr.getMeta("addToHistory") !== false,
  );
  if (user.length !== trs.filter((t) => t.docChanged).length || user.length === 0) return null;

  // Collect replace steps across the transactions, with the mapping that
  // carries a position from just after each step to `newState.doc`.
  const changes: Array<Change & { toEnd: Mapping; deletesStructure: boolean; inCode: boolean }> = [];
  user.forEach((tr, ti) => {
    tr.steps.forEach((step, i) => {
      if (!(step instanceof ReplaceStep)) return;
      const before = tr.docs[i];
      const s = step as unknown as { from: number; to: number; slice: Slice };
      const toEnd = tr.mapping.slice(i + 1);
      for (const later of user.slice(ti + 1)) toEnd.appendMapping(later.mapping);
      changes.push({
        from: s.from,
        insertedSize: s.slice.size,
        deleted: before.slice(s.from, s.to),
        structural: s.slice.size > 0 && isStructural(s.slice),
        inCode: stepInCode(before, s.from, s.to, s.slice),
        deletesStructure: s.to > s.from && (!before.resolve(s.from).sameParent(before.resolve(s.to)) || hasAtom(before.slice(s.from, s.to))),
        toEnd,
      });
    });
  });
  if (changes.length === 0) return null;

  const tr = newState.tr;
  tr.setMeta(SUGGEST_META, true);
  const attrs = { author: sanitizeAuthor(author) };
  let selection: number | null = null;
  const oldHead = oldState.selection.head;
  for (const c of changes) {
    const at = tr.mapping.map(c.toEnd.map(c.from, -1), -1);
    const insertedEnd = tr.mapping.map(c.toEnd.map(c.from + c.insertedSize, 1), 1);
    // Code can't carry suggestions: edits there pass untracked, as in
    // source mode (CriticMarkup inside code is literal text).
    // Only edits wholly inside one code block or span (judged before the edit).
    if (c.inCode) continue;
    // 1. Insertions are suggested. Structural ones (a new paragraph, a
    //    multi-block paste) can't be expressed as CriticMarkup or undone
    //    by Reject, so they are blocked, like structural deletions — and
    //    so is text that would form a CriticMarkup delimiter (`a++}b`).
    // Inline atoms (an image, a hard break) can't carry the insertion mark
    // either, so Reject couldn't remove them: blocked too.
    let atom = false;
    if (insertedEnd > at) tr.doc.nodesBetween(at, insertedEnd, (n) => void (n.isInline && !n.isText && (atom = true)));
    // A replacement that removes structure (a paragraph boundary, an image)
    // can't be tracked as one suggestion either: the old text comes back
    // as a suggested deletion, the typed text is dropped.
    if (insertedEnd > at && (c.structural || atom || c.deletesStructure || formsDelimiter(tr.doc, at, insertedEnd))) {
      tr.delete(at, insertedEnd);
    } else if (insertedEnd > at) {
      tr.removeMark(at, insertedEnd, del);
      // Typing inside someone's suggested insertion extends it (their
      // mark is inherited): keep that author, as source mode does.
      let inherited = true;
      tr.doc.nodesBetween(at, insertedEnd, (n) => {
        if (n.isText && !ins.isInSet(n.marks)) inherited = false;
      });
      if (!inherited) tr.addMark(at, insertedEnd, ins.create(attrs));
    }
    // 2. Deletions are kept, marked — unless they only removed one's own
    //    suggested insertion, which really goes away.
    if (c.deleted.size === 0) continue;
    const text = sliceText(c.deleted);
    const onlyOwnInsert = (() => {
      let own = !!text;
      c.deleted.content.descendants((n) => {
        // Unmarked text, or an inline atom (it can't carry the insertion
        // mark), isn't one's own insertion: the slice must be restored.
        if ((n.isText && !ins.isInSet(n.marks)) || (n.isInline && !n.isText)) own = false;
      });
      return own;
    })();
    // A block boundary in the range isn't anyone's insertion: restore it.
    if (onlyOwnInsert && !c.deletesStructure) continue;
    // Re-insert the deleted slice with its openness, so a removed block
    // boundary (Backspace at a paragraph start) is restored, not inlined:
    // structural joins are blocked while the text is suggested deleted.
    const mapsBefore = tr.mapping.maps.length;
    tr.replace(at, at, c.deleted);
    const end = tr.mapping.slice(mapsBefore).map(at, 1);
    const mapsRestored = tr.mapping.maps.length;
    // Drop the parts that were suggested insertions; mark the rest deleted.
    const ownRanges: Array<[number, number]> = [];
    tr.doc.nodesBetween(at, end, (n, pos) => {
      if (n.isText) {
        if (ins.isInSet(n.marks)) ownRanges.push([pos, pos + n.nodeSize]);
        // Text that was already a suggested deletion keeps its author.
        else if (!del.isInSet(n.marks)) tr.addMark(Math.max(pos, at), Math.min(pos + n.nodeSize, end), del.create(attrs));
      }
    });
    for (const [f, t] of ownRanges.reverse()) tr.delete(f, t);
    // `end` is already past the restored slice: map it through the removals only.
    const keptEnd = tr.mapping.slice(mapsRestored).map(end, -1);
    // Backspace leaves the caret before the kept text; Delete after it.
    if (c.insertedSize === 0) {
      const backward = oldHead > c.from;
      selection = backward ? at : keptEnd;
    }
  }
  if (selection !== null && tr.docChanged) {
    const pos = Math.max(0, Math.min(selection, tr.doc.content.size));
    tr.setSelection(TextSelection.near(tr.doc.resolve(pos), -1));
  }
  return tr.docChanged || tr.storedMarksSet ? tr : null;
}

export const suggestTracking = $prose(
  () =>
    new Plugin({
      key: trackingKey,
      appendTransaction: (trs, oldState, newState) =>
        config.enabled() ? trackChanges(trs, oldState, newState, config.author()) : null,
      // Edits CriticMarkup can't express are refused while suggesting, so
      // nothing changes that Reject couldn't undo (see untrackable).
      filterTransaction: (tr) =>
        !config.enabled() ||
        !!tr.getMeta(SUGGEST_META) ||
        !!tr.getMeta("history$") ||
        tr.getMeta("addToHistory") === false ||
        !untrackable(tr),
      props: {
        // Typing over a selection: some browsers (Firefox) report it as the
        // minimal DOM diff ("Hello" → "H" deletes only "ello"), which would
        // track the wrong range. Replace the whole selection instead.
        // Typing over a selection is taken before the browser edits the DOM:
        // Firefox otherwise turns "H" over "Hello" into a deletion of "ello"
        // (a DOM diff), which can't be told apart from a real deletion.
        handleDOMEvents: {
          beforeinput: (view, event) => {
            const e = event as InputEvent;
            if (!config.enabled() || e.inputType !== "insertText" || !e.data || view.composing) return false;
            const sel = view.state.selection;
            if (sel.empty) return false;
            e.preventDefault();
            view.dispatch(view.state.tr.insertText(e.data, sel.from, sel.to).scrollIntoView());
            return true;
          },
        },
        handleTextInput: (view, from, to, text) => {
          if (!config.enabled()) return false;
          const sel = view.state.selection;
          if (sel.empty || from < sel.from || to > sel.to) return false;
          // The reported range is a diff: the selected text outside it was
          // kept in the DOM (typing "H" over "Hello" arrives as "ello" → "").
          const doc = view.state.doc;
          const typed = doc.textBetween(sel.from, from, "", "") + text + doc.textBetween(to, sel.to, "", "");
          const tr = view.state.tr.insertText(typed, sel.from, sel.to);
          view.dispatch(tr.scrollIntoView());
          return true;
        },
      },
    }),
);

/* ─── Accept / reject at the cursor ─────────────────────────────────── */

/** The run of `critic_*` marked text around `pos` (one change). */
export function changeAt(state: EditorState, pos: number): { from: number; to: number; type: "insert" | "delete" } | null {
  const ins = state.schema.marks.critic_insert;
  const del = state.schema.marks.critic_delete;
  if (!ins || !del) return null;
  const $pos = state.doc.resolve(pos);
  const parent = $pos.parent;
  const base = $pos.start();
  const ranges: Array<{ from: number; to: number; type: "insert" | "delete"; author: string | null }> = [];
  parent.forEach((child, offset) => {
    // Inline atoms (an image, a hard break) carry the marks too.
    if (!child.isInline) return;
    const mark = ins.isInSet(child.marks) ?? del.isInSet(child.marks);
    if (!mark) return;
    const type = mark.type === ins ? "insert" : "delete";
    const author = (mark.attrs.author as string | null) ?? null;
    const from = base + offset;
    const to = from + child.nodeSize;
    const last = ranges[ranges.length - 1];
    // One change = adjacent text of the same kind AND author.
    if (last && last.type === type && last.author === author && last.to === from) last.to = to;
    else ranges.push({ from, to, type, author });
  });
  // A substitution (deletion + insertion by the same author) resolves as one.
  const inR = (x: { from: number; to: number }) => pos >= x.from && pos <= x.to;
  const pick = (r: (typeof ranges)[number]) => ({ from: r.from, to: r.to, type: r.type });
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const n = ranges[i + 1];
    if (r.type === "delete" && n?.type === "insert" && n.from === r.to && n.author === r.author && (inR(r) || inR(n))) {
      return { from: r.from, to: n.to, type: "delete" };
    }
  }
  // Otherwise the change under the cursor; at a boundary between two, the
  // one the cursor is inside of (or ends) first.
  const hit = ranges.find((r) => pos > r.from && pos < r.to) ?? ranges.find(inR);
  return hit ? pick(hit) : null;
}

/** Accept or reject every change in [from, to). */
export function resolveRange(state: EditorState, from: number, to: number, mode: "accept" | "reject"): Transaction | null {
  const ins = state.schema.marks.critic_insert;
  const del = state.schema.marks.critic_delete;
  if (!ins || !del) return null;
  const tr = state.tr.setMeta(SUGGEST_META, true);
  const drop: Array<[number, number]> = [];
  state.doc.nodesBetween(from, to, (n, pos) => {
    // Text and marked inline atoms (`{++![alt](img.png)++}` loads the image
    // with the insertion mark): both are part of the change.
    if (!n.isInline) return;
    const a = Math.max(pos, from);
    const b = Math.min(pos + n.nodeSize, to);
    const isIns = !!ins.isInSet(n.marks);
    const isDel = !!del.isInSet(n.marks);
    if (!isIns && !isDel) return;
    // accept: insert stays (unmarked), delete goes. reject: the opposite.
    if ((mode === "accept" && isDel) || (mode === "reject" && isIns)) drop.push([a, b]);
    else tr.removeMark(a, b, isIns ? ins : del);
  });
  for (const [a, b] of drop.reverse()) tr.delete(a, b);
  return tr.docChanged ? tr : null;
}

/** The ranges of `s` to delete so that it collapses to its resolved text. */
function literalDrops(s: Suggestion, mode: Resolution): Array<[number, number]> {
  const keep = (a: number, b: number): Array<[number, number]> => [
    [s.from, a],
    [b, s.to],
  ];
  switch (s.kind) {
    case "insert":
      return mode === "accept" ? keep(s.contentFrom, s.contentTo) : [[s.from, s.to]];
    case "delete":
      return mode === "accept" ? [[s.from, s.to]] : keep(s.contentFrom, s.contentTo);
    case "substitute":
      return mode === "accept" ? keep(s.newFrom!, s.newTo!) : keep(s.contentFrom, s.contentTo);
    case "comment":
      return [[s.from, s.to]];
    case "highlight":
      return keep(s.contentFrom, s.contentTo);
  }
}

/**
 * Accept or reject everything in the document, as the source editor's
 * resolveAll does on the text: the marked changes, and the CriticMarkup
 * WYSIWYG keeps as literal text — comments, highlights, markup whose
 * delimiters couldn't be paired — found per textblock with the source
 * parser (code and marked text masked out) and resolved with its semantics.
 */
export function resolveAllChanges(state: EditorState, mode: Resolution): Transaction | null {
  const ins = state.schema.marks.critic_insert;
  const del = state.schema.marks.critic_delete;
  if (!ins || !del) return null;
  const tr = resolveRange(state, 0, state.doc.content.size, mode) ?? state.tr.setMeta(SUGGEST_META, true);
  const drops: Array<[number, number]> = [];
  state.doc.descendants((block, pos) => {
    if (!block.isTextblock) return true;
    if (block.type.spec.code) return false;
    // One character per position, so offsets map straight to the block.
    let text = "";
    block.forEach((child) => {
      const masked = !child.isText || child.marks.some((m) => m.type.spec.code || m.type === ins || m.type === del);
      text += masked ? "\ufffc".repeat(child.nodeSize) : child.text!;
    });
    for (const sg of parseSuggestions(text, [])) {
      for (const [a, b] of literalDrops(sg, mode)) if (b > a) drops.push([pos + 1 + a, pos + 1 + b]);
    }
    return false;
  });
  // Positions are in `state.doc`; map each through what's been done so far.
  for (const [a, b] of drops) {
    const from = tr.mapping.map(a, 1);
    const to = tr.mapping.map(b, -1);
    if (to > from) tr.delete(from, to);
  }
  return tr.docChanged ? tr : null;
}

/** Resolve the change at the cursor; false when there is none. */
export function resolveAtCursor(
  view: { state: EditorState; dispatch: (tr: Transaction) => void },
  mode: "accept" | "reject",
): boolean {
  const c = changeAt(view.state, view.state.selection.head);
  if (!c) return false;
  const tr = resolveRange(view.state, c.from, c.to, mode);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
}

/** Move the cursor to the next (dir 1) / previous (-1) change, wrapping around. */
export function jumpToChange(view: { state: EditorState; dispatch: (tr: Transaction) => void }, dir: 1 | -1): boolean {
  const { state } = view;
  const ins = state.schema.marks.critic_insert;
  const del = state.schema.marks.critic_delete;
  if (!ins || !del) return false;
  const head = state.selection.head;
  // A change starts where marked text begins, or where the kind or author
  // changes — except a same-author deletion followed by an insertion,
  // which is one substitution (as changeAt resolves it).
  const starts: number[] = [];
  let prev: { kind: "insert" | "delete"; author: string | null; end: number } | null = null;
  state.doc.descendants((n, pos) => {
    if (!n.isInline) {
      prev = null;
      return;
    }
    const mark = ins.isInSet(n.marks) ?? del.isInSet(n.marks);
    if (!mark) {
      prev = null;
      return;
    }
    const kind = mark.type === ins ? "insert" : "delete";
    const author = (mark.attrs.author as string | null) ?? null;
    const p = prev as { kind: "insert" | "delete"; author: string | null; end: number } | null;
    const continues =
      !!p && p.end === pos && p.author === author && (p.kind === kind || (p.kind === "delete" && kind === "insert"));
    if (!continues) starts.push(pos);
    prev = { kind, author, end: pos + n.nodeSize };
  });
  // Past the last (before the first) change, wrap around — as the source
  // editor's nextSuggestion / prevSuggestion do.
  const target =
    dir === 1
      ? (starts.find((p) => p > head) ?? starts[0])
      : ([...starts].reverse().find((p) => p < head) ?? starts[starts.length - 1]);
  if (target === undefined) return false;
  view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, target)).scrollIntoView());
  return true;
}

/** All Milkdown plugins of the feature, in `.use()` order. */
export const wysiwygSuggestPlugins = [criticRemark, criticInsertSchema, criticDeleteSchema, suggestTracking].flat();


/**
 * Suggesting mode (track changes) for the CodeMirror source editor.
 *
 * - `suggestingField` holds the on/off flag (toggled by `setSuggesting`).
 * - A `transactionFilter` rewrites user edits into CriticMarkup while the
 *   mode is on (see ./suggesting for the pure transform). Undo/redo,
 *   transactions without a user event (programmatic edits, file loads) and
 *   remote collab transactions (`suggestingSkip`, wired by the collab
 *   binding) pass through untouched.
 * - Decorations render the markup in place whether or not the mode is on:
 *   insertions green-underlined, deletions red-struck, comments highlighted,
 *   delimiters dimmed.
 * - Commands accept / reject the suggestion at the cursor or all of them,
 *   and jump between suggestions.
 */
import {
  EditorSelection,
  EditorState,
  Facet,
  StateEffect,
  StateField,
  Transaction,
} from "@codemirror/state";
import type { ChangeSpec, Extension, Range, TransactionSpec } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { showAiToast } from "../ui/AiToast";
import { authorHue, isAiAuthor } from "./suggestAuthors";
import { t } from "../i18n";
import type { DecorationSet } from "@codemirror/view";
import {
  editKindFor,
  nextSuggestion,
  parseSuggestions,
  prevSuggestion,
  resolutionChanges,
  suggestionAt,
  transformEdit,
} from "./suggesting";
import type { PlainChange, Resolution, Suggestion } from "./suggesting";

/* ─── State ───────────────────────────────────────────────────────────── */

export const setSuggesting = StateEffect.define<boolean>();

export const suggestingField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSuggesting)) value = e.value;
    return value;
  },
});

/**
 * Predicates marking transactions the filter must leave alone — the collab
 * binding registers one that recognises y-codemirror's sync annotation, so
 * remote peers' edits are never re-wrapped as *our* suggestions.
 */
export const suggestingSkip = Facet.define<(tr: Transaction) => boolean>();

/**
 * Who is suggesting. The editor provides a getter (read per transaction, so
 * signing in/out needs no reconfiguration); new suggestions are tagged
 * `{>>@name<<}` when it returns a name.
 */
export const suggestingAuthor = Facet.define<() => string | null, () => string | null>({
  combine: (getters) => getters[0] ?? (() => null),
});

/** Parsed suggestions of the current document (shared by decorations + commands). */
export const suggestionsField = StateField.define<Suggestion[]>({
  create: (state) => parseSuggestions(state.doc.toString()),
  update(value, tr) {
    return tr.docChanged ? parseSuggestions(tr.state.doc.toString()) : value;
  },
});

/* ─── Transaction filter ─────────────────────────────────────────────── */

const TRACKED_EVENTS = ["input", "delete"];

function shouldTrack(tr: Transaction): boolean {
  if (!tr.docChanged) return false;
  if (!tr.startState.field(suggestingField, false)) return false;
  if (tr.isUserEvent("undo") || tr.isUserEvent("redo")) return false;
  if (!TRACKED_EVENTS.some((e) => tr.isUserEvent(e))) return false;
  for (const skip of tr.startState.facet(suggestingSkip)) if (skip(tr)) return false;
  return true;
}

/**
 * Rewrite the transaction's changes as CriticMarkup. Exported for tests.
 * Returns the original transaction when nothing needs rewriting.
 */
export function suggestTransaction(tr: Transaction): Transaction | TransactionSpec {
  if (!shouldTrack(tr)) return tr;
  const userEvent = tr.annotation(Transaction.userEvent) ?? "input";
  const original: PlainChange[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    original.push({ from: fromA, to: toA, insert: inserted.toString() });
  });

  // Rewrite each change against the start document, last change first so
  // earlier positions stay valid. Give up (pass through) on overlap.
  let text = tr.startState.doc.toString();
  const rewritten: PlainChange[] = [];
  /** Per original change: cursor (before earlier changes apply) + length delta. */
  const marks: Array<{ cur: number; delta: number }> = [];
  let lowerBound = Number.POSITIVE_INFINITY;
  let changed = false;
  let untrackable = false;
  let author: string | null = null;
  try {
    author = tr.startState.facet(suggestingAuthor)();
  } catch {
    author = null;
  }
  for (let i = original.length - 1; i >= 0; i--) {
    const c = original[i];
    const kind = editKindFor(userEvent, c.from, c.to, c.insert);
    const res = kind ? transformEdit(text, { ...c, kind, author }) : null;
    if (res?.untrackable) untrackable = true;
    const out = res ? res.change : c;
    if (res) changed = true;
    if (out) {
      if (out.to > lowerBound) return tr;
      lowerBound = out.from;
      rewritten.unshift(out);
      text = text.slice(0, out.from) + out.insert + text.slice(out.to);
    }
    let cur = res ? res.cursor : c.from + c.insert.length;
    // Respect a caret placed inside the typed text (e.g. auto-closed brackets).
    if (c.insert && original.length === 1) {
      const offset = tr.newSelection.main.head - (c.from + c.insert.length);
      if (offset < 0 && offset >= -c.insert.length) cur += offset;
    }
    marks.unshift({ cur, delta: out ? out.insert.length - (out.to - out.from) : 0 });
  }
  if (!changed) return tr;
  if (untrackable) {
    // Never silently drop typing: say why (after the filter returns).
    queueMicrotask(() => showAiToast(t("suggesting.untrackable"), "info"));
  }

  // A mark's cursor ignores the length change of the edits before it.
  let shift = 0;
  const cursors = marks.map((m) => {
    const pos = m.cur + shift;
    shift += m.delta;
    return pos;
  });

  const changes: ChangeSpec[] = rewritten;
  const selection =
    cursors.length === tr.newSelection.ranges.length
      ? EditorSelection.create(
          cursors.map((p) => EditorSelection.cursor(p)),
          tr.newSelection.mainIndex,
        )
      : EditorSelection.single(cursors[cursors.length - 1]);
  return {
    changes,
    selection,
    effects: tr.effects,
    scrollIntoView: tr.scrollIntoView,
    userEvent,
  };
}

const suggestingFilter = EditorState.transactionFilter.of((tr) => suggestTransaction(tr));

/* ─── Decorations ─────────────────────────────────────────────────────── */

const delim = Decoration.mark({ class: "cm-sugg-delim" });
const insMark = Decoration.mark({ class: "cm-sugg-ins" });
const delMark = Decoration.mark({ class: "cm-sugg-del" });
const commentMark = Decoration.mark({ class: "cm-sugg-comment" });
const highlightMark = Decoration.mark({ class: "cm-sugg-highlight" });

/** The same mark, with a tooltip naming the change's author. */
function withAuthor(_base: Decoration, className: string, author: string): Decoration {
  // W3.11 — each author in their own colour (one of eight), the AI marked as such.
  const ai = isAiAuthor(author);
  return Decoration.mark({
    class: `${className} cm-author-${Math.floor(authorHue(author) / 45) % 8}${ai ? " cm-sugg-ai" : ""}`,
    attributes: { title: ai ? t("suggest.author.ai") : t("suggesting.byAuthor", { name: author }), "data-author": author },
  });
}

export function buildSuggestionDecorations(suggestions: readonly Suggestion[]): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const add = (deco: Decoration, from: number, to: number) => {
    if (to > from) ranges.push(deco.range(from, to));
  };
  for (const s of suggestions) {
    add(delim, s.from, s.contentFrom);
    const ins = s.author ? withAuthor(insMark, "cm-sugg-ins", s.author) : insMark;
    const del = s.author ? withAuthor(delMark, "cm-sugg-del", s.author) : delMark;
    switch (s.kind) {
      case "insert":
        add(ins, s.contentFrom, s.contentTo);
        break;
      case "delete":
        add(del, s.contentFrom, s.contentTo);
        break;
      case "substitute":
        add(del, s.contentFrom, s.contentTo);
        add(delim, s.contentTo, s.newFrom!);
        add(ins, s.newFrom!, s.newTo!);
        break;
      case "comment":
        add(commentMark, s.contentFrom, s.contentTo);
        break;
      case "highlight":
        add(highlightMark, s.contentFrom, s.contentTo);
        break;
    }
    add(delim, s.kind === "substitute" ? s.newTo! : s.contentTo, s.to);
  }
  return Decoration.set(ranges, true);
}

const suggestionDecorations = EditorView.decorations.compute([suggestionsField], (state) =>
  buildSuggestionDecorations(state.field(suggestionsField)),
);

const suggestingTheme = EditorView.baseTheme({
  ".cm-sugg-ins": {
    textDecoration: "underline 2px",
    textDecorationColor: "hsl(145 60% 40%)",
    textUnderlineOffset: "3px",
    backgroundColor: "hsl(145 60% 45% / 0.12)",
  },
  ".cm-sugg-del": {
    textDecoration: "line-through 2px",
    textDecorationColor: "hsl(0 75% 55%)",
    backgroundColor: "hsl(0 75% 55% / 0.10)",
  },
  ".cm-sugg-comment": {
    backgroundColor: "hsl(45 95% 55% / 0.30)",
    fontStyle: "italic",
  },
  ".cm-sugg-highlight": {
    backgroundColor: "hsl(45 95% 55% / 0.30)",
  },
  ".cm-sugg-delim": {
    opacity: "0.4",
    fontSize: "0.85em",
  },
});

/* ─── Extension ───────────────────────────────────────────────────────── */

/** Everything suggesting mode needs. `enabled` sets the initial flag. */
export function suggestingExtension(enabled = false): Extension {
  return [
    suggestingField.init(() => enabled),
    suggestionsField,
    suggestingFilter,
    suggestionDecorations,
    suggestingTheme,
  ];
}

/* ─── Commands ────────────────────────────────────────────────────────── */

/** What the commands need from a view (an `EditorView` satisfies it). */
export interface ViewLike {
  readonly state: EditorState;
  dispatch(...specs: TransactionSpec[]): void;
}

function suggestionsOf(state: EditorState): Suggestion[] {
  return state.field(suggestionsField, false) ?? parseSuggestions(state.doc.toString());
}

function resolveAt(view: ViewLike, mode: Resolution): boolean {
  const { state } = view;
  const s = suggestionAt(suggestionsOf(state), state.selection.main.head);
  if (!s) return false;
  const [change] = resolutionChanges(state.doc.toString(), [s], mode);
  view.dispatch({
    changes: change,
    selection: { anchor: change.from + change.insert.length },
    scrollIntoView: true,
  });
  return true;
}

function resolveEvery(view: ViewLike, mode: Resolution): boolean {
  const { state } = view;
  const all = suggestionsOf(state);
  if (all.length === 0) return false;
  view.dispatch({ changes: resolutionChanges(state.doc.toString(), all, mode) });
  return true;
}

function jump(view: ViewLike, dir: 1 | -1): boolean {
  const { state } = view;
  const all = suggestionsOf(state);
  // Search from the selection's far edge so a selected suggestion is skipped.
  const { from, to } = state.selection.main;
  const s = dir === 1 ? nextSuggestion(all, Math.max(to - 1, from)) : prevSuggestion(all, from);
  if (!s) return false;
  view.dispatch({ selection: { anchor: s.from, head: s.to }, scrollIntoView: true });
  return true;
}

/** W3.11 — accept or reject one author's suggestions (null: those without an author tag). */
export function resolveAuthorSuggestions(view: ViewLike, author: string | null, mode: Resolution): boolean {
  const { state } = view;
  const mine = suggestionsOf(state).filter(
    (s) => (s.kind === "insert" || s.kind === "delete" || s.kind === "substitute") && (s.author ?? null) === author,
  );
  if (mine.length === 0) return false;
  view.dispatch({ changes: resolutionChanges(state.doc.toString(), mine, mode) });
  return true;
}

export const acceptSuggestionAtCursor = (view: ViewLike) => resolveAt(view, "accept");
export const rejectSuggestionAtCursor = (view: ViewLike) => resolveAt(view, "reject");
export const acceptAllSuggestions = (view: ViewLike) => resolveEvery(view, "accept");
export const rejectAllSuggestions = (view: ViewLike) => resolveEvery(view, "reject");
export const nextSuggestionCommand = (view: ViewLike) => jump(view, 1);
export const prevSuggestionCommand = (view: ViewLike) => jump(view, -1);

/** Number of suggestions in the editor's document. */
export function countSuggestions(state: EditorState): number {
  return suggestionsOf(state).length;
}

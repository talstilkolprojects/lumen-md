/**
 * AI-written text in the source editor (plan 5.9), like iA Writer's
 * authorship: what the AI wrote is shown lighter until you edit it.
 *
 * - A transaction that inserts text without the user typing it (an AI
 *   command inserting at the cursor, replacing a selection, or rewriting
 *   the whole document from the store) is checked against the recent AI
 *   answers (`ai/authorship.ts`, fed by the agent runtime); the matching
 *   parts are marked. An editor that knows its insertion is AI text (the
 *   ghost completion) says so with the `aiAuthored` annotation.
 * - What the user types, pastes or drops is never marked, and typing
 *   inside a mark cuts that part out of it: edited text is the user's.
 * - The marks are saved per note (text-checked on load) and can be hidden
 *   (`data-ai-marks-hidden` on <html>).
 */

import { Annotation, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { aiSpansIn, diffMiddle, loadSpans, marksShown, normalize, recentAiTexts, saveSpans, subtract, type Span } from "../ai/authorship";

/** Marks every insertion of the transaction as AI-written. */
export const aiAuthored = Annotation.define<boolean>();

/** Replaces the spans (a note was loaded). */
export const setAiSpans = StateEffect.define<readonly Span[]>();

/** Typing, pasting, dropping, deleting: the user's own edits. */
function byUser(tr: Transaction): boolean {
  return tr.isUserEvent("input") || tr.isUserEvent("delete") || tr.isUserEvent("move");
}

function mapSpans(spans: readonly Span[], tr: Transaction): Span[] {
  const out: Span[] = [];
  for (const [a, b] of spans) {
    const from = tr.changes.mapPos(a, 1);
    const to = tr.changes.mapPos(b, -1);
    if (to > from) out.push([from, to]);
  }
  return out;
}

/** The spans after one transaction (exported for tests). */
export function nextSpans(spans: readonly Span[], tr: Transaction, texts: () => readonly string[] = recentAiTexts): Span[] {
  let next: Span[] = [...spans];
  for (const e of tr.effects) if (e.is(setAiSpans)) next = [...e.value];
  if (!tr.docChanged) return next;

  const explicit = tr.annotation(aiAuthored) === true;
  const user = !explicit && byUser(tr);
  const before = tr.startState.doc;
  const whole = before.length > 0 && !explicit && !user && isWholeReplace(tr);

  if (whole) {
    // A rewrite from outside (the store): keep the spans in the unchanged
    // prefix and suffix, look for AI text only in the middle.
    const prev = before.toString();
    const now = tr.state.doc.toString();
    const { start, endBefore, endAfter } = diffMiddle(prev, now);
    const delta = endAfter - endBefore;
    next = next.flatMap(([a, b]): Span[] => {
      if (b <= start) return [[a, b]];
      if (a >= endBefore) return [[a + delta, b + delta]];
      const head: Span[] = a < start ? [[a, start]] : [];
      const tail: Span[] = b > endBefore ? [[endBefore + delta, b + delta]] : [];
      return [...head, ...tail];
    });
    const middle = now.slice(start, endAfter);
    for (const [a, b] of aiSpansIn(middle, texts())) next.push([start + a, start + b]);
    return normalize(next);
  }

  next = mapSpans(next, tr);
  const recent = explicit || user ? [] : texts();
  tr.changes.iterChanges((_fa, _ta, fromB, toB, inserted) => {
    if (toB <= fromB) return;
    if (explicit) next.push([fromB, toB]);
    else if (user) next = subtract(normalize(next), fromB, toB);
    else if (recent.length) for (const [a, b] of aiSpansIn(inserted.toString(), recent)) next.push([fromB + a, fromB + b]);
  });
  return normalize(next);
}

/** One change that replaces the whole document (the store's sync does this). */
export function isWholeReplace(tr: Transaction): boolean {
  let n = 0;
  let whole = false;
  tr.changes.iterChangedRanges((fromA, toA) => {
    n++;
    whole = fromA === 0 && toA === tr.startState.doc.length;
  });
  return n === 1 && whole;
}

const aiMark = Decoration.mark({ class: "cm-ai-authored" });

export const aiSpansField = StateField.define<Span[]>({
  create: () => [],
  update: (spans, tr) => nextSpans(spans, tr),
  provide: (f) =>
    EditorView.decorations.from(f, (spans): DecorationSet => Decoration.set(spans.map(([a, b]) => aiMark.range(a, b)))),
});

const theme = EditorView.baseTheme({
  ".cm-ai-authored": { color: "hsl(var(--fg-muted))" },
  "html[data-ai-marks-hidden] & .cm-ai-authored": { color: "inherit" },
});

/**
 * The marks plus their storage for the note `noteKey()` names (null: an
 * unsaved scratch note, kept for the session only).
 */
export function aiAuthorshipExtension(noteKey: () => string | null): Extension {
  const persist = ViewPlugin.fromClass(
    class {
      key: string | null;
      timer: ReturnType<typeof setTimeout> | null = null;
      gone = false;
      constructor(readonly view: EditorView) {
        this.key = noteKey();
        document.documentElement.toggleAttribute("data-ai-marks-hidden", !marksShown());
        // Can't dispatch while the view is being built.
        queueMicrotask(() => this.load());
      }
      load() {
        if (this.gone) return;
        const doc = this.view.state.doc.toString();
        const saved = this.key ? loadSpans(this.key, doc) : [];
        // Text written by the AI in another view (WYSIWYG) since the last
        // save is found again while the answer is recent.
        const found = aiSpansIn(doc, recentAiTexts());
        if (!saved.length && !found.length && !this.view.state.field(aiSpansField).length) return;
        this.view.dispatch({ effects: setAiSpans.of(normalize([...saved, ...found])) });
      }
      update(u: ViewUpdate) {
        const key = noteKey();
        if (key !== this.key) {
          if (u.transactions.some(isWholeReplace)) {
            // Another note was opened: save the old one as it was, load the new one.
            this.save(this.key, u.startState.doc.toString(), u.startState.field(aiSpansField));
            this.key = key;
            queueMicrotask(() => this.load());
            return;
          }
          // Same text under a new name (saved as): the marks move along.
          this.key = key;
          this.schedule();
          return;
        }
        if (u.startState.field(aiSpansField) !== u.state.field(aiSpansField)) this.schedule();
      }
      schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 800);
      }
      save(key: string | null, doc: string, spans: readonly Span[]) {
        if (key) saveSpans(key, doc, spans);
      }
      flush() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.save(this.key, this.view.state.doc.toString(), this.view.state.field(aiSpansField));
      }
      destroy() {
        if (this.timer) this.flush();
        this.gone = true;
      }
    },
  );
  return [aiSpansField, persist, theme];
}

/** The AI-written spans of the editor's note (for the export). */
export function aiSpansOf(view: EditorView): readonly Span[] {
  return view.state.field(aiSpansField, false) ?? [];
}

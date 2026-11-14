/**
 * "Looks reversed — fix?" after a paste (plan W5.5), in both editors.
 *
 * The paste itself goes through unchanged: the text is never rewritten
 * behind the writer's back. When it reads like Hebrew from a PDF (visual
 * order, or broken final letters — lib in ./pdfHebrew), a toast offers the
 * fix with a preview of the result; "Fix" replaces exactly what was pasted,
 * as one undoable change. The palette command does the same for a
 * selection already in the note.
 */
import { t } from "../i18n";
import { useToastStore } from "../store/useToastStore";
import { fixFinalForms, fixVisualLine, suggestPdfHebrewFix, type PdfHebrewKind } from "./pdfHebrew";

/** The fix for one line of text of a known kind. */
export function fixLine(line: string, kind: PdfHebrewKind): string {
  return kind === "reversed" ? fixVisualLine(line) : fixFinalForms(line);
}

const PREVIEW_CHARS = 160;

/** The toast's preview: the start of the fixed text, on one line. */
export function previewOf(fixed: string): string {
  const one = fixed.replace(/\s*\n\s*/g, " ⏎ ").trim();
  return one.length > PREVIEW_CHARS ? `${one.slice(0, PREVIEW_CHARS)}…` : one;
}

/** Offer the fix for pasted text; `apply` replaces the pasted text with the fixed one. */
export function offerPdfHebrewFix(pasted: string, apply: (kind: PdfHebrewKind, fixed: string) => boolean): boolean {
  const s = suggestPdfHebrewFix(pasted);
  if (!s) return false;
  useToastStore.getState().push({
    kind: "info",
    title: s.kind === "reversed" ? t("pdfPaste.reversed.title") : t("pdfPaste.finals.title"),
    body: t("pdfPaste.preview", { text: previewOf(s.fixed) }),
    ttlMs: 20_000,
    action: {
      label: t("pdfPaste.fix"),
      run: () => {
        if (!apply(s.kind, s.fixed)) useToastStore.getState().push({ kind: "warning", title: t("pdfPaste.changed") });
      },
    },
  });
  return true;
}

/** For the palette command: the fix for selected text, or a message. */
export function fixSelection(text: string): { fixed: string; kind: PdfHebrewKind } | { message: string } {
  if (!text.trim()) return { message: t("pdfPaste.selectFirst") };
  const s = suggestPdfHebrewFix(text);
  if (!s) return { message: t("pdfPaste.looksFine") };
  return s;
}

// ── Source editor (CodeMirror) ──────────────────────────────────────────

interface CMViewLike {
  state: { doc: { length: number; sliceString(from: number, to?: number): string }; selection: { main: { from: number; to: number } } };
  dispatch(spec: { changes: { from: number; to: number; insert: string }; selection?: { anchor: number; head?: number }; userEvent?: string }): void;
  focus(): void;
}

/**
 * Called for each paste transaction in the source editor: `from`/`to` are
 * where the pasted text now sits. Finds it again on "Fix" (later typing
 * may have moved it) and replaces it.
 */
export function offerInSourceEditor(view: CMViewLike, from: number, pasted: string): boolean {
  return offerPdfHebrewFix(pasted, (_kind, fixed) => {
    const doc = view.state.doc;
    let at = doc.sliceString(from, from + pasted.length) === pasted ? from : -1;
    if (at < 0) {
      const all = doc.sliceString(0);
      const near = all.lastIndexOf(pasted, from + pasted.length);
      at = near >= 0 ? near : all.indexOf(pasted);
    }
    if (at < 0) return false;
    view.dispatch({ changes: { from: at, to: at + pasted.length, insert: fixed }, selection: { anchor: at, head: at + fixed.length }, userEvent: "input.pdffix" });
    view.focus();
    return true;
  });
}

/** The palette command in the source editor: fix the selection. */
export function fixSourceSelection(view: CMViewLike): string | null {
  const { from, to } = view.state.selection.main;
  const r = fixSelection(view.state.doc.sliceString(from, to));
  if ("message" in r) return r.message;
  view.dispatch({ changes: { from, to, insert: r.fixed }, selection: { anchor: from, head: from + r.fixed.length }, userEvent: "input.pdffix" });
  view.focus();
  return null;
}

// ── The palette command, in whichever editor is showing ─────────────────

export const FIX_PDF_HEBREW_EVENT = "lumen-fix-pdf-hebrew";

/** Ask the mounted editor to fix its selection. The editor answers through `detail.done`. */
export function runFixPdfHebrew(): void {
  let answered = false;
  const done = (message: string | null) => {
    answered = true;
    useToastStore.getState().push(message ? { kind: "info", title: message } : { kind: "success", title: t("pdfPaste.fixed") });
  };
  window.dispatchEvent(new CustomEvent(FIX_PDF_HEBREW_EVENT, { detail: { done } }));
  if (!answered) useToastStore.getState().push({ kind: "info", title: t("pdfPaste.needsEditor") });
}

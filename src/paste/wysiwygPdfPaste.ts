/**
 * Plan W5.5 in the WYSIWYG editor: after a paste that reads like Hebrew
 * from a PDF, the same "Looks reversed — fix?" toast as the source editor;
 * "Fix" rewrites the pasted range block by block (each pasted line is a
 * paragraph here) in one transaction, so one undo restores it. The range
 * is mapped through later edits. The palette command fixes the selection.
 */
import { Plugin, PluginKey } from "@milkdown/prose/state";
import type { EditorView } from "@milkdown/prose/view";
import { t } from "../i18n";
import { FIX_PDF_HEBREW_EVENT, fixLine, fixSelection, offerPdfHebrewFix } from "./pdfPaste";
import { suggestPdfHebrewFix, type PdfHebrewKind } from "./pdfHebrew";

type Range = { from: number; to: number } | null;
const key = new PluginKey<Range>("lumen-pdf-paste");

/** Replace the text of every textblock inside [from, to) with its fix; one transaction. */
export function applyProseFix(view: EditorView, from: number, to: number, kind: PdfHebrewKind): boolean {
  const { doc } = view.state;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    const start = Math.max(from, pos + 1);
    const end = Math.min(to, pos + 1 + node.content.size);
    if (end <= start) return false;
    const text = doc.textBetween(start, end, undefined, "\ufffc");
    if (text.includes("\ufffc")) return false; // an image or a break inside: leave the block
    const fixed = fixLine(text, kind);
    if (fixed !== text) edits.push({ start, end, text: fixed });
    return false;
  });
  if (!edits.length) return false;
  const tr = view.state.tr;
  for (const e of edits.reverse()) tr.insertText(e.text, e.start, e.end);
  view.dispatch(tr);
  view.focus();
  return true;
}

export function wysiwygPdfPastePlugin(): Plugin<Range> {
  return new Plugin<Range>({
    key,
    state: {
      init: () => null,
      apply(tr, range) {
        const meta = tr.getMeta(key) as Range | undefined;
        if (meta !== undefined) return meta;
        if (!range || !tr.docChanged) return range;
        return { from: tr.mapping.map(range.from, 1), to: tr.mapping.map(range.to, -1) };
      },
    },
    view(view) {
      const onFix = (e: Event) => {
        const done = (e as CustomEvent<{ done: (message: string | null) => void }>).detail?.done;
        if (!done || !view.dom.isConnected) return;
        const { from, to } = view.state.selection;
        const r = fixSelection(view.state.doc.textBetween(from, to, "\n", "\ufffc"));
        if ("message" in r) done(r.message);
        else done(applyProseFix(view, from, to, r.kind) ? null : t("pdfPaste.looksFine"));
      };
      window.addEventListener(FIX_PDF_HEBREW_EVENT, onFix);
      return { destroy: () => window.removeEventListener(FIX_PDF_HEBREW_EVENT, onFix) };
    },
    props: {
      handlePaste(view, event) {
        const text = event.clipboardData?.getData("text/plain") ?? "";
        if (!text || !suggestPdfHebrewFix(text)) return false;
        const from = view.state.selection.from;
        // After ProseMirror has inserted the slice: remember where it went.
        setTimeout(() => {
          const to = view.state.selection.to;
          view.dispatch(view.state.tr.setMeta(key, { from, to }).setMeta("addToHistory", false));
          offerPdfHebrewFix(text, (kind) => {
            const range = key.getState(view.state);
            return !!range && applyProseFix(view, range.from, range.to, kind);
          });
        });
        return false;
      },
    },
  });
}

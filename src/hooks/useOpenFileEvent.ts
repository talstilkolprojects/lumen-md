/**
 * `lumen-open-file`, fired by database views, backlinks, the graph view and
 * any other component that knows a workspace path: the single hub that
 * opens it (W6.25: moved out of App.tsx unchanged). A PDF opens in the
 * reader (4.14) and a book in the EPUB reader (W1.14), at the page,
 * chapter or highlight the link names; a note opens in a tab, scrolled to
 * the heading of `[[Note#Heading]]`.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useStore";
import { docIdentity } from "../renderer/previewDoc";
import { scrollToHeadingWhenRendered } from "../renderer/wikiLinks";

/** A document open in a reader, with the link fragment that opened it (`page=N&highlight=ID`). */
export interface ReaderView {
  path: string;
  fragment: string | null;
  seq: number;
}

export function useOpenFileEvent(handleOpenFromWorkspace: (name: string, content: string) => void) {
  /** The PDF open in the reader, with the link fragment that opened it (`page=N&highlight=ID`). */
  const [pdfView, setPdfView] = useState<ReaderView | null>(null);
  const [epubView, setEpubView] = useState<ReaderView | null>(null);
  /** The open reader's save gate: replacing the reader waits until its highlights are saved. */
  const pdfSaveGate = useRef<((then: () => void) => void) | null>(null);
  const registerPdfSaveGate = useCallback((gate: ((then: () => void) => void) | null) => {
    pdfSaveGate.current = gate;
  }, []);

  // Listen for `lumen-open-file` events fired by Database views, backlinks,
  // graph view, and any other component that knows a workspace path. Single
  // hub keeps the open path consistent (recents, dirty handling, etc).
  useEffect(() => {
    async function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ path: string; heading?: string; fragment?: string }>).detail;
      if (!detail?.path) return;
      // A book opens in the EPUB reader, at the chapter / highlight the link names (W1.14).
      if (/\.epub$/i.test(detail.path)) {
        setEpubView((prev) => ({ path: detail.path, fragment: detail.fragment ?? null, seq: (prev?.seq ?? 0) + 1 }));
        return;
      }
      // A PDF opens in the reader, at the page / highlight the link names.
      if (/\.pdf$/i.test(detail.path)) {
        const open = () => setPdfView((prev) => ({ path: detail.path, fragment: detail.fragment ?? null, seq: (prev?.seq ?? 0) + 1 }));
        // Another PDF replaces the open reader: only once its highlights are saved.
        if (pdfSaveGate.current) pdfSaveGate.current(open);
        else open();
        return;
      }
      try {
        const { readWorkspaceFile } = await import("../storage/workspace");
        const content = await readWorkspaceFile(detail.path);
        handleOpenFromWorkspace(detail.path, content);
        // `[[Note#Heading]]`: scroll to the heading (by its slug id) once the
        // opened note has rendered.
        if (detail.heading) {
          scrollToHeadingWhenRendered(detail.heading, { docKey: docIdentity(useAppStore.getState().doc) ?? undefined });
        }
      } catch {
        /* why: the file was moved or deleted since the link was made; the click does nothing */
      }
    }
    window.addEventListener("lumen-open-file", onOpen);
    return () => window.removeEventListener("lumen-open-file", onOpen);
  }, [handleOpenFromWorkspace]);

  return { pdfView, setPdfView, epubView, setEpubView, registerPdfSaveGate };
}

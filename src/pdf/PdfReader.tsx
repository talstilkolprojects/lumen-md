/**
 * PDF reader with highlights (plan 4.14), on the pdf.js already in the app.
 *
 * - Pages are virtualised: only those near the viewport get a canvas and a
 *   text layer; the rest are empty boxes of the right size.
 * - Select text on a page and press Highlight (or H): the highlight is stored
 *   as a W3C Web Annotation in the companion note `<file>.pdf.md`, with a
 *   `[[file.pdf#page=N&highlight=ID]]` link that opens the reader at that
 *   page and flashes the highlight.
 * - Search runs over the text of every page (case, spacing and niqqud
 *   insensitive). Scanned pages (no text layer) can be read with the
 *   on-device OCR the importer uses; W6.47: the recognised lines become a
 *   hidden text layer over the page image (./ocrPages.ts), so a scanned page
 *   is searched, selected and highlighted where its words are, and what OCR
 *   found is kept for the next open.
 * - W6.47: reading mode (the pages alone, fitted to the width), and the
 *   place you were in each PDF, kept in the vault so it syncs to your other
 *   devices (./readingPosition.ts).
 * - W6.47: "Send to Zotero" — highlights back to the PDF's Zotero item, after
 *   the user confirms (../citations/zoteroAnnotations.ts).
 *
 * Page geometry is physical (left/top of the PDF), so the page boxes are
 * `dir="ltr"`; each text span keeps the direction pdf.js gives it, which is
 * what makes selecting and highlighting Hebrew lines right in RTL.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./strings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { companionNotePath, createPdfAnnotation, describeAnnotation, findAll, nextMatchIndex, readAnnotationsNote, parsePdfFragment, shortId, unionRect, upsertAnnotationsNote, withNote, type PdfAnnotation } from "./annotations";
import { layerText, offsetsToRange, pageTextFromItems, rangePageRects, rangeToOffsets } from "./textMap";
import { openPdf, type PdfDocument } from "./pdfjs";
import "./PdfReader.css";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";
import { EmptyState, learnHow } from "../ui/EmptyState";
import { PdfPageView } from "./PdfPageView";
import type { PageSize } from "./PdfPageView";
import type { OcrPage } from "./ocrPages";
import { positionAt, scrollTopFor, type PageBox, type PositionsIO } from "./readingPosition";

/** "Ask this PDF" (plan 6.8): its own chunk, loaded on the first click of Ask. */
const PdfChatPanel = lazy(() => import("./PdfChatPanel").then((m) => ({ default: m.PdfChatPanel })));

interface Props {
  /** Vault path of the PDF. */
  path: string;
  /** `page=N&highlight=ID` from the link that opened it (re-applied when it changes). */
  fragment?: string | null;
  /** Bumped by the opener for every open, so the same link opened twice flashes twice. */
  openSeq?: number;
  onClose: () => void;
  /** Open the companion note in the editor. */
  onOpenNotes: (notePath: string) => void;
  /**
   * Receives the reader's save gate (null on unmount): whoever replaces the
   * reader (another PDF opened) runs through it, so pending or failed
   * highlight writes are saved first.
   */
  registerSaveGate?: (gate: ((then: () => void) => void) | null) => void;
}

/**
 * What the app mounts: the reader in an error boundary; "Open the notes"
 * closes it and opens the companion note through the app's open-file hub.
 */
export function PdfReaderOverlay(props: Omit<Props, "onOpenNotes">) {
  const { onClose } = props;
  return (
    <ErrorBoundary
      fallback={
        <div className="pdf-reader pdf-message pdf-error" role="alert">
          <p>{t("errorBoundary.heading")}</p>
          <button type="button" className="icon-btn pdf-text-btn" onClick={onClose}>
            {t("privacy.close")}
          </button>
        </div>
      }
    >
      <PdfReader
        {...props}
        onOpenNotes={(notePath) => {
          onClose();
          window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: notePath } }));
        }}
      />
    </ErrorBoundary>
  );
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 4;
/** Pages kept rendered beyond the viewport, in viewport heights. */
const ROOT_MARGIN = "150% 0px";

/** A random RFC 4122 v4 uuid (crypto.randomUUID is missing in insecure contexts). */
function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A file (or folder on its path) that isn't there — as opposed to a read that failed. */
function isMissing(e: unknown): boolean {
  return !!e && typeof e === "object" && (e as { name?: unknown }).name === "NotFoundError";
}

function baseName(p: string): string {
  return p.split("/").pop() ?? p;
}

export function PdfReader({ path, fragment = null, openSeq = 0, onClose, onOpenNotes, registerSaveGate }: Props) {
  const notePath = companionNotePath(path);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [scale, setScale] = useState(1);
  const [visible, setVisible] = useState<Set<number>>(() => new Set([1]));
  const [current, setCurrent] = useState(1);
  const [annotations, setAnnotations] = useState<PdfAnnotation[]>([]);
  const [flash, setFlash] = useState<{ id: string; seq: number } | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const [ocrPages, setOcrPages] = useState<Record<number, OcrPage>>({});
  /** SHA-256 of the PDF: what OCR found is kept under it (./ocrPages.ts). */
  const fingerprint = useRef<string | null>(null);
  const [ocrAllBusy, setOcrAllBusy] = useState(false);
  /** W6.47: the pages alone, fitted to the width. */
  const [reading, setReading] = useState(false);
  /** The saved place to return to once the pages are laid out (null: none, or already used). */
  const restoreAt = useRef<{ page: number; offset: number } | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ page: number; occurrence: number }[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  /** A search ran for the current query (so "no matches" can be said). */
  const [searched, setSearched] = useState(false);
  /** The "Ask this PDF" panel is open (plan 6.8). */
  const [askOpen, setAskOpen] = useState(false);
  const [unanchored, setUnanchored] = useState<Set<string>>(() => new Set());
  const scrollRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef(new Map<number, HTMLDivElement>());
  const pageTexts = useRef(new Map<number, string>());
  const writeQueue = useRef<Promise<void>>(Promise.resolve());
  /** The last note write failed: the highlights in the reader are not saved. */
  const writeFailed = useRef(false);
  /** Note writes queued and not finished yet. */
  const pendingWrites = useRef(0);

  // Leaving the page (closing the tab or window) with highlights not saved
  // yet — queued, or after a failed write — asks first, like unsaved notes do.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingWrites.current === 0 && !writeFailed.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  annotationsRef.current = annotations;
  const searchRef = useRef<HTMLInputElement>(null);
  /** Bumped per search and per query edit: a slower, older search must not commit its results. */
  const searchSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // Take focus from the editor underneath, so keys go to the reader.
  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
  }, []);

  // Open the PDF and read its highlights.
  useEffect(() => {
    let cancelled = false;
    let closeDoc: (() => Promise<void>) | null = null;
    // Another PDF in the same reader: nothing of the previous one carries over.
    setDoc(null);
    setError(null);
    setSizes([]);
    setCurrent(1);
    setVisible(new Set([1]));
    setAnnotations([]);
    setFlash(null);
    setOcrPages({});
    fingerprint.current = null;
    restoreAt.current = null;
    setQuery("");
    setHits([]);
    setHitIndex(-1);
    setSearched(false);
    setUnanchored(new Set());
    searchSeq.current++;
    (async () => {
      const ws = await import("../storage/workspace");
      const blob = await ws.readWorkspaceBlob(path);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // W6.47: what OCR found in this PDF before, and where the user was in it.
      const [{ loadOcrPages, pdfFingerprint }, { loadPosition }] = await Promise.all([import("./ocrPages"), import("./readingPosition")]);
      const fp = await pdfFingerprint(bytes).catch(() => null);
      const [cachedOcr, savedPos] = await Promise.all([fp ? loadOcrPages(fp) : Promise.resolve({}), loadPosition(positionsIO, path).catch(() => null)]);
      const opened = await openPdf(bytes);
      closeDoc = opened.close;
      if (cancelled) {
        void opened.close();
        return;
      }
      const pdf = opened.doc;
      const all: PageSize[] = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const vp = (await pdf.getPage(i)).getViewport({ scale: 1 });
        all.push({ w: vp.width, h: vp.height });
      }
      // No note yet means no highlights. Any other read failure stops here:
      // opening with an empty list would let the next save drop the saved ones.
      let note: string | null = null;
      try {
        note = await ws.readWorkspaceFile(notePath);
      } catch (e) {
        if (!isMissing(e)) throw e;
      }
      if (cancelled) return;
      const width = scrollRef.current?.clientWidth ?? 800;
      const fit = all.length ? (width - 48) / all[0].w : 1;
      setScale(Math.min(2, Math.max(MIN_SCALE, Math.round(fit * 20) / 20)));
      setSizes(all);
      // Every annotation in the companion note is this PDF's: after the folder
      // was moved or renamed, `source` still names the old path — adopt them
      // (the next write stores the new path) instead of dropping them.
      const saved = readAnnotationsNote(note);
      // A highlights block that can't be read whole: open nothing for editing,
      // or the next save would replace it with only the new highlights.
      if (!saved) throw new Error(t("pdf.notesUnreadable", { name: baseName(notePath) }));
      setAnnotations(saved.map((a) => (a.target.source === path ? a : { ...a, target: { ...a.target, source: path } })));
      fingerprint.current = fp;
      setOcrPages(cachedOcr);
      restoreAt.current = savedPos && savedPos.page <= all.length ? { page: savedPos.page, offset: savedPos.offset } : null;
      setDoc(pdf);
    })().catch((e: unknown) => {
      if (!cancelled) setError(explainError(e));
    });
    return () => {
      cancelled = true;
      void closeDoc?.().catch(() => undefined);
      pageTexts.current.clear();
    };
  }, [path, notePath]);

  /** Scroll so that `page`'s top is at the top of the reader. */
  const goToPage = useCallback((page: number) => {
    const el = pageEls.current.get(page);
    const box = scrollRef.current;
    if (!el || !box) return;
    box.scrollTop = el.offsetTop - 12;
    setCurrent(page);
    setVisible((v) => (v.has(page) ? v : new Set([...v, page])));
  }, []);

  // The link that opened the reader: its page, and the highlight to flash.
  useEffect(() => {
    if (!doc || !sizes.length) return;
    const f = parsePdfFragment(fragment);
    let page = f.page;
    if (f.highlight) {
      const a = annotationsRef.current.find((x) => shortId(x.id) === f.highlight);
      if (a) page ??= describeAnnotation(a).page;
      setFlash({ id: f.highlight, seq: openSeq });
    }
    if (page) {
      restoreAt.current = null;
      const target = Math.min(Math.max(1, page), sizes.length);
      // After the page boxes are laid out at their size.
      requestAnimationFrame(() => goToPage(target));
    } else if (restoreAt.current) {
      // W6.47: no page in the link — back to where the user was (on any device).
      const at = restoreAt.current;
      restoreAt.current = null;
      requestAnimationFrame(() => {
        const box = scrollRef.current;
        if (!box) return;
        box.scrollTop = scrollTopFor(pageBoxes(pageEls.current), at);
        setVisible((v) => (v.has(at.page) ? v : new Set([...v, at.page])));
        setCurrent(at.page);
      });
    }
  }, [doc, sizes, fragment, openSeq, goToPage]);

  // Which pages are near the viewport.
  useEffect(() => {
    const box = scrollRef.current;
    if (!doc || !box || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        setVisible((prev) => {
          const next = new Set(prev);
          for (const e of entries) {
            const n = Number((e.target as HTMLElement).dataset.pageNumber);
            if (e.isIntersecting) next.add(n);
            else next.delete(n);
          }
          return next;
        });
      },
      { root: box, rootMargin: ROOT_MARGIN },
    );
    for (const el of pageEls.current.values()) io.observe(el);
    return () => io.disconnect();
  }, [doc, sizes, scale]);

  // The current page: the last one whose top is above the middle of the view.
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const mark = box.scrollTop + box.clientHeight / 2;
    let page = 1;
    for (const [n, el] of pageEls.current) if (el.offsetTop <= mark && n > page) page = n;
    setCurrent(page);
    // W6.47: remember the place a moment after scrolling stops.
    if (savePosTimer.current) clearTimeout(savePosTimer.current);
    savePosTimer.current = setTimeout(() => {
      savePosTimer.current = null;
      const b = scrollRef.current;
      if (!b) return;
      const pos = positionAt(pageBoxes(pageEls.current), b.scrollTop);
      void import("./readingPosition").then(({ savePosition }) => savePosition(positionsIO, path, pos)).catch(() => undefined);
    }, POSITION_SAVE_MS);
  }, [path]);
  const savePosTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (savePosTimer.current) clearTimeout(savePosTimer.current);
    },
    [],
  );

  // Selection inside a page's text: enables Highlight.
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const node = sel && sel.rangeCount && !sel.isCollapsed ? sel.getRangeAt(0).startContainer : null;
      const el = node ? (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement) : null;
      setHasSelection(!!el?.closest("[data-pdf-text]") && !!scrollRef.current?.contains(el));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const persist = useCallback(
    (next: PdfAnnotation[]) => {
      // Two changes before the next render must not drop the first one.
      annotationsRef.current = next;
      setAnnotations(next);
      pendingWrites.current++;
      const job = writeQueue.current.then(async () => {
        const [ws, { flushActiveWorkspaceDoc }, { notifyWorkspaceChanged }] = await Promise.all([
          import("../storage/workspace"),
          import("../store/openDocs"),
          import("../storage/workspaceEvents"),
        ]);
        // The note may be open with edits the autosave hasn't written yet.
        await flushActiveWorkspaceDoc();
        // Missing: the first highlight creates the note. Unreadable: fail the
        // save (the user's own text in the note must not be replaced).
        let existing: string | null = null;
        try {
          existing = await ws.readWorkspaceFile(notePath);
        } catch (e) {
          if (!isMissing(e)) throw e;
        }
        if (existing !== null && !readAnnotationsNote(existing)) throw new Error(t("pdf.notesUnreadable", { name: baseName(notePath) }));
        const labels = {
          title: t("pdf.noteTitle", { name: baseName(path) }),
          page: (n: number) => t("pdf.notePage", { n }),
          empty: t("pdf.noteEmpty"),
        };
        const content = upsertAnnotationsNote(existing, path, next, labels);
        await ws.writeWorkspaceFile(notePath, content);
        // The note may be open (active, or in a tab): give the open copies the
        // new block too, or their next autosave would write the old one back.
        const { useAppStore, tabIdOf } = await import("../store/useStore");
        const st = useAppStore.getState();
        if (st.doc.workspaceName === notePath) {
          st.setDoc({ name: st.doc.name, content: upsertAnnotationsNote(st.doc.content, path, next, labels), dirty: st.doc.dirty });
        }
        const activeId = tabIdOf(useAppStore.getState().doc);
        useAppStore.setState((s) => ({
          openTabs: s.openTabs.map((tab) =>
            tab.workspaceName === notePath && tab.id !== activeId ? { ...tab, content: upsertAnnotationsNote(tab.content, path, next, labels) } : tab,
          ),
        }));
        notifyWorkspaceChanged(existing === null ? { kind: "structure" } : { kind: "content", paths: [notePath] });
        writeFailed.current = false;
      });
      writeQueue.current = job
        .finally(() => {
          pendingWrites.current--;
        })
        .catch((e: unknown) => {
          writeFailed.current = true;
          showAiToast(t("pdf.saveFailed", { error: explainError(e) }), "error");
        });
    },
    [path, notePath],
  );

  const highlightSelection = useCallback(() => {
    const sel = document.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const startEl = range.startContainer.nodeType === Node.ELEMENT_NODE ? (range.startContainer as Element) : range.startContainer.parentElement;
    const layer = startEl?.closest<HTMLElement>("[data-pdf-text]");
    const wrap = startEl?.closest<HTMLElement>("[data-page-wrap]");
    const pageEl = wrap?.querySelector<HTMLElement>("[data-page-number]");
    if (!layer || !wrap || !pageEl) return;
    const page = Number(wrap.dataset.pageWrap);
    // A selection that runs past this page's text is cut at its end.
    const off = rangeToOffsets(layer, range);
    if (!off) return;
    const text = layerText(layer);
    if (!text.slice(off.start, off.end).trim()) return;
    const exactRange = offsetsToRange(layer, off.start, off.end);
    // The page's own text, or W6.47's OCR layer laid over the page image: both in page coordinates.
    const onPage = layer.dataset.pdfText === "page" || layer.dataset.pdfText === "ocr-layer";
    const rect = onPage && exactRange ? unionRect(rangePageRects(exactRange, pageEl.getBoundingClientRect(), scale)) : null;
    const a = createPdfAnnotation({ id: newUuid(), source: path, page, text, start: off.start, end: off.end, rect });
    sel.removeAllRanges();
    setHasSelection(false);
    persist([...annotationsRef.current, a]);
    setFlash({ id: shortId(a.id), seq: Date.now() });
  }, [path, persist, scale]);

  const runSearch = useCallback(
    async (q: string, step: 1 | -1 | 0) => {
      if (!doc) return;
      const seq = ++searchSeq.current;
      if (!q.trim()) {
        setHits([]);
        setHitIndex(-1);
        return;
      }
      let list = hits;
      if (step === 0 || !list.length) {
        const found: { page: number; occurrence: number }[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
          let text = ocrPages[p]?.text ?? pageTexts.current.get(p);
          if (text === undefined) {
            text = pageTextFromItems((await (await doc.getPage(p)).getTextContent()).items);
            pageTexts.current.set(p, text);
            if (seq !== searchSeq.current) return;
          }
          // A scanned page's text is what OCR read: matched loosely (W6.47), the same way when the hit is drawn below.
          findAll(text, q, { loose: !!ocrPages[p] }).forEach((_, occurrence) => found.push({ page: p, occurrence }));
        }
        list = found;
        setHits(found);
        setSearched(true);
      }
      if (!list.length) {
        setHitIndex(-1);
        return;
      }
      const i = step === 0 ? Math.max(0, list.findIndex((h) => h.page >= current)) : nextMatchIndex(hitIndex, step, list.length);
      setHitIndex(i);
      goToPage(list[i].page);
    },
    [doc, hits, hitIndex, current, ocrPages, goToPage],
  );

  const zoom = useCallback(
    (next: number) => {
      const page = current;
      setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, Math.round(next * 20) / 20)));
      requestAnimationFrame(() => goToPage(page));
    },
    [current, goToPage],
  );

  const fitWidth = useCallback(() => {
    const width = scrollRef.current?.clientWidth ?? 800;
    const w = sizes[current - 1]?.w ?? sizes[0]?.w;
    if (w) zoom((width - 48) / w);
  }, [sizes, current, zoom]);

  /**
   * Run `then` (close the reader, open the note) once the queued note writes
   * are done, so leaving the reader means the highlights are saved. After a
   * failed write the save is tried once more; if that fails too the reader
   * stays open (the error toast says why) instead of dropping the changes.
   */
  const whenSaved = useCallback(
    (then: () => void) => {
      void writeQueue.current.then(() => {
        if (!writeFailed.current) return then();
        persist(annotationsRef.current);
        void writeQueue.current.then(() => {
          if (!writeFailed.current) then();
        });
      });
    },
    [persist],
  );

  const close = useCallback(() => whenSaved(onClose), [whenSaved, onClose]);

  useEffect(() => {
    registerSaveGate?.(whenSaved);
    return () => registerSaveGate?.(null);
  }, [registerSaveGate, whenSaved]);

  /** Open the companion note — creating it first when the PDF has no highlights yet. */
  const openNotes = useCallback(async () => {
    const ws = await import("../storage/workspace");
    if (!(await ws.workspaceHasEntry(notePath).catch(() => false))) persist(annotationsRef.current);
    whenSaved(() => onOpenNotes(notePath));
  }, [notePath, persist, whenSaved, onOpenNotes]);

  // Keyboard: Esc closes, ⌘F / Ctrl+F searches, H highlights the selection.
  // The reader is modal: the keys it handles don't reach the app underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target instanceof HTMLElement ? e.target : null;
      const typing = !!el && (el.closest("input, textarea") !== null || el.isContentEditable);
      const handled = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      // Esc leaves a note being edited alone (it may be undoing there).
      if (e.key === "Escape" && !(el && el.closest("textarea"))) {
        handled();
        close();
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "f") {
        handled();
        searchRef.current?.focus();
        searchRef.current?.select();
      } else if (!typing && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.toLowerCase() === "h") {
        handled();
        highlightSelection();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [close, highlightSelection]);

  const byPage = useMemo(() => {
    const m = new Map<number, PdfAnnotation[]>();
    for (const a of annotations) {
      const p = describeAnnotation(a).page;
      m.set(p, [...(m.get(p) ?? []), a]);
    }
    return m;
  }, [annotations]);

  const sorted = useMemo(
    () =>
      [...annotations].sort((a, b) => {
        const da = describeAnnotation(a);
        const db = describeAnnotation(b);
        return da.page - db.page || (da.position?.start ?? 0) - (db.position?.start ?? 0);
      }),
    [annotations],
  );

  const onAnchored = useCallback((missing: string[], all: string[]) => {
    setUnanchored((prev) => {
      const next = new Set([...prev].filter((id) => !all.includes(id)));
      for (const id of missing) next.add(id);
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
  }, []);

  const registerEl = useCallback((page: number, el: HTMLDivElement | null) => {
    if (el) pageEls.current.set(page, el);
    else pageEls.current.delete(page);
  }, []);

  const onPageText = useCallback((page: number, text: string) => {
    pageTexts.current.set(page, text);
  }, []);

  const onOcr = useCallback((page: number, value: OcrPage) => {
    setOcrPages((prev) => ({ ...prev, [page]: value }));
    setHits([]);
    const fp = fingerprint.current;
    if (fp) void import("./ocrPages").then(({ saveOcrPage }) => saveOcrPage(fp, page, value));
  }, []);

  /** W6.47: read every scanned page (no text of its own) with the on-device OCR, one after another. */
  const ocrAll = useCallback(async () => {
    if (!doc || ocrAllBusy) return;
    setOcrAllBusy(true);
    try {
      const { ocrPdfPage } = await import("./ocrPages");
      let done = 0;
      for (let p = 1; p <= doc.numPages; p++) {
        if (ocrPages[p]) continue;
        let text = pageTexts.current.get(p);
        if (text === undefined) {
          text = pageTextFromItems((await (await doc.getPage(p)).getTextContent()).items);
          pageTexts.current.set(p, text);
        }
        if (text.trim()) continue;
        showAiToast(t("pdf.ocr.allRunning", { n: p, total: doc.numPages }), "info");
        onOcr(p, await ocrPdfPage(doc, p));
        done++;
      }
      showAiToast(done ? t("pdf.ocr.allDone", { n: done }) : t("pdf.ocr.none"), "success");
    } catch (e) {
      showAiToast(t("pdf.failed", { error: explainError(e) }), "error");
    } finally {
      setOcrAllBusy(false);
    }
  }, [doc, ocrAllBusy, ocrPages, onOcr]);

  /** W6.47: the highlights not in Zotero yet go to the PDF's Zotero item — after the user confirms. */
  const sendToZotero = useCallback(() => {
    whenSaved(() => {
      void import("./zoteroSend")
        .then(({ sendHighlightsToZotero }) => sendHighlightsToZotero({ pdfPath: path, notePath, annotations: annotationsRef.current, pageHeights: sizes.map((z) => z.h) }))
        .catch((e: unknown) => showAiToast(t("pdf.zotero.failed", { error: explainError(e) }), "error"));
    });
  }, [whenSaved, path, notePath, sizes]);

  const toggleReading = useCallback(() => {
    setReading((r) => !r);
    // The pages fill the width in reading mode; after the side panel is gone.
    requestAnimationFrame(() => fitWidth());
  }, [fitWidth]);

  const activeHit = hitIndex >= 0 ? hits[hitIndex] : undefined;
  const name = baseName(path);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className={reading ? "pdf-reader pdf-reader--reading" : "pdf-reader"}
      data-testid="pdf-reader"
      data-reading={reading ? "true" : undefined}
      data-current-page={current}
      data-page-count={sizes.length}
      data-ready={doc ? "true" : undefined}
      role="dialog"
      aria-modal="true"
      aria-label={name}
    >
      <div className="pdf-toolbar">
        <strong className="pdf-title" title={path} dir="auto">
          {name}
        </strong>
        <HelpButton topic="workspace/pdf-reader" />
        <label className="pdf-pageinfo">
          <input
            type="number"
            min={1}
            max={Math.max(1, sizes.length)}
            value={current}
            aria-label={t("pdf.page.label", { n: current })}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n >= 1 && n <= sizes.length) goToPage(n);
            }}
          />
          <span data-testid="pdf-page-of">{t("pdf.page.of", { n: current, total: sizes.length })}</span>
        </label>
        <div className="pdf-group">
          <button type="button" className="icon-btn" onClick={() => zoom(scale - 0.25)} aria-label={t("pdf.zoomOut")} title={t("pdf.zoomOut")}>
            −
          </button>
          <span className="pdf-zoom">{Math.round(scale * 100)}%</span>
          <button type="button" className="icon-btn" onClick={() => zoom(scale + 0.25)} aria-label={t("pdf.zoomIn")} title={t("pdf.zoomIn")}>
            +
          </button>
          <button type="button" className="icon-btn pdf-text-btn" onClick={fitWidth}>
            {t("pdf.zoomFit")}
          </button>
        </div>
        <form
          className="pdf-group pdf-search"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(query, hits.length ? 1 : 0);
          }}
        >
          <input
            ref={searchRef}
            type="search"
            dir="auto"
            value={query}
            placeholder={t("pdf.search.placeholder")}
            aria-label={t("pdf.search.placeholder")}
            data-testid="pdf-search"
            onChange={(e) => {
              searchSeq.current++;
              setQuery(e.target.value);
              setHits([]);
              setHitIndex(-1);
              setSearched(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && e.shiftKey) {
                e.preventDefault();
                void runSearch(query, -1);
              }
            }}
          />
          <button type="button" className="icon-btn" onClick={() => void runSearch(query, -1)} aria-label={t("findReplace.prev")} title={t("findReplace.prev")}>
            ↑
          </button>
          <button type="submit" className="icon-btn" aria-label={t("findReplace.next")} title={t("findReplace.next")}>
            ↓
          </button>
          <span className="pdf-count" aria-live="polite" data-testid="pdf-search-count">
            {/* empty-action: the search field and arrows just before it */}
            {hitIndex >= 0 ? t("pdf.search.count", { i: hitIndex + 1, n: hits.length }) : searched ? t("search.noMatches") : ""}
          </span>
        </form>
        <div className="pdf-group pdf-end">
          <button type="button" className="icon-btn pdf-text-btn" data-testid="pdf-reading" aria-pressed={reading} onClick={toggleReading}>
            {t("pdf.reading")}
          </button>
          <button type="button" className="icon-btn pdf-text-btn" data-testid="pdf-ocr-all" disabled={!doc || ocrAllBusy} onClick={() => void ocrAll()}>
            {ocrAllBusy ? t("pdf.ocr.running") : t("pdf.ocr.all")}
          </button>
          <button
            type="button"
            className="pdf-primary"
            data-testid="pdf-highlight"
            disabled={!hasSelection}
            title={t("pdf.highlight.hint")}
            // Keep the text selection: a click on the button must not clear it.
            onMouseDown={(e) => e.preventDefault()}
            onClick={highlightSelection}
          >
            {t("pdf.highlight")}
          </button>
          <button type="button" className="icon-btn pdf-text-btn" data-testid="pdf-ask" aria-pressed={askOpen} onClick={() => setAskOpen((v) => !v)}>
            {t("pdf.ask")}
          </button>
          <button
            type="button"
            className="icon-btn pdf-text-btn"
            data-testid="pdf-open-notes"
            // After the pending highlight writes (a note just edited is saved on blur, before this click).
            onClick={() => void openNotes()}
          >
            {t("pdf.openNotes")}
          </button>
          <button type="button" className="icon-btn pdf-text-btn" data-testid="pdf-close" onClick={close}>
            {t("privacy.close")}
          </button>
        </div>
      </div>
      <div className="pdf-body">
        <div className="pdf-scroll" ref={scrollRef} onScroll={onScroll}>
          {error && (
            <p className="pdf-message pdf-error" role="alert">
              {t("pdf.failed", { error })}
            </p>
          )}
          {!doc && !error && <p className="pdf-message">{t("loading.generic")}</p>}
          {doc &&
            sizes.map((size, i) => (
              <PdfPageView
                key={i + 1}
                doc={doc}
                page={i + 1}
                size={size}
                scale={scale}
                active={visible.has(i + 1)}
                annotations={byPage.get(i + 1) ?? EMPTY}
                flash={flash}
                ocr={ocrPages[i + 1]}
                query={activeHit?.page === i + 1 ? query : ""}
                occurrence={activeHit?.page === i + 1 ? activeHit.occurrence : -1}
                registerEl={registerEl}
                onText={onPageText}
                onOcr={onOcr}
                onAnchored={onAnchored}
              />
            ))}
          <div className="pdf-tail" aria-hidden="true" />
        </div>
        {askOpen && (
          <Suspense fallback={null}>
            <PdfChatPanel
              path={path}
              onClose={() => setAskOpen(false)}
              onCite={(page, quote) => {
                // Open the cited page and mark the quote there (as a search hit).
                searchSeq.current++;
                setQuery(quote);
                setHits([{ page, occurrence: 0 }]);
                setHitIndex(0);
                setSearched(true);
                goToPage(page);
              }}
            />
          </Suspense>
        )}
        <aside className="pdf-side" aria-label={t("pdf.highlights")} hidden={reading}>
          <h3>{t("pdf.highlights")}</h3>
          {sorted.length > 0 && (
            <button type="button" className="icon-btn pdf-text-btn" data-testid="pdf-zotero-send" onClick={sendToZotero}>
              {t("pdf.zotero.send")}
            </button>
          )}
          {!sorted.length && <EmptyState message={t("pdf.highlights.empty")} action={learnHow("workspace/pdf-reader#highlight-text")} />}
          <ol className="pdf-hl-list" data-testid="pdf-highlights">
            {sorted.map((a) => {
              const d = describeAnnotation(a);
              const id = shortId(a.id);
              return (
                <li key={a.id} data-highlight-item={id}>
                  <button
                    type="button"
                    className="pdf-hl-quote"
                    dir="auto"
                    onClick={() => {
                      goToPage(d.page);
                      setFlash({ id, seq: Date.now() });
                    }}
                  >
                    <span className="pdf-hl-page">{t("pdf.notePage", { n: d.page })}</span> {d.quote?.exact ?? ""}
                  </button>
                  {unanchored.has(id) && <p className="pdf-muted">{t("pdf.unanchored")}</p>}
                  <textarea
                    dir="auto"
                    defaultValue={d.note}
                    placeholder={t("pdf.note.placeholder")}
                    aria-label={t("pdf.note.placeholder")}
                    rows={2}
                    onBlur={(e) => {
                      const v = e.target.value.trim();
                      if (v === d.note) return;
                      persist(annotationsRef.current.map((x) => (x.id === a.id ? withNote(x, v) : x)));
                    }}
                  />
                  <button type="button" className="icon-btn pdf-text-btn" onClick={() => persist(annotationsRef.current.filter((x) => x.id !== a.id))}>
                    {t("toolbar.delete")}
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>
      </div>
    </div>
  );
}

const EMPTY: PdfAnnotation[] = [];

/** W6.47: the place is saved this long after scrolling stops. */
const POSITION_SAVE_MS = 1_000;

/** Reading positions live in the vault (`.lumen/reading-positions.json`), so the vault's sync carries them. */
const positionsIO: PositionsIO = {
  read: async (p) => {
    const ws = await import("../storage/workspace");
    try {
      return await ws.readWorkspaceFile(p);
    } catch {
      return null;
    }
  },
  write: async (p, text) => {
    const ws = await import("../storage/workspace");
    await ws.createWorkspaceFolder(".lumen").catch(() => undefined);
    await ws.writeWorkspaceFile(p, text);
  },
};

/** The pages' boxes in the scroll container, page 1 first. */
function pageBoxes(els: Map<number, HTMLDivElement>): PageBox[] {
  return [...els.entries()].sort(([a], [b]) => a - b).map(([, el]) => ({ top: el.offsetTop, height: el.offsetHeight }));
}

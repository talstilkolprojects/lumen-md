/**
 * PDF reader with highlights (plan 4.14), on the pdf.js already in the app.
 *
 * - Pages are virtualised: only those near the viewport get a canvas and a
 *   text layer; the rest are empty boxes. The reader opens with page 1's
 *   size for every box, and each page takes its real size once it is loaded.
 * - The reader is modal: the rest of the app is inert while it is open, and
 *   focus goes back where it was when it closes.
 * - Select text on a page and press Highlight (or H): the highlight is stored
 *   as a W3C Web Annotation in the companion note `<file>.pdf.md`, with a
 *   `[[file.pdf#page=N&highlight=ID]]` link that opens the reader at that
 *   page and flashes the highlight.
 * - Search runs over the text of every page (case, spacing and niqqud
 *   insensitive). Scanned pages (no text layer) can be read with the
 *   on-device OCR the importer uses; the recognised text is searchable and
 *   can be highlighted too.
 *
 * Page geometry is physical (left/top of the PDF), so the page boxes are
 * `dir="ltr"`; each text span keeps the direction pdf.js gives it, which is
 * what makes selecting and highlighting Hebrew lines right in RTL.
 */

import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import "./strings";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { inertOutside } from "../ui/inertOutside";
import {
  anchorAnnotation,
  companionNotePath,
  createPdfAnnotation,
  describeAnnotation,
  findAll,
  nextMatchIndex,
  readAnnotationsNote,
  parsePdfFragment,
  shortId,
  unionRect,
  upsertAnnotationsNote,
  withNote,
  type PageRect,
  type PdfAnnotation,
} from "./annotations";
import { layerText, offsetsToRange, pageTextFromItems, rangePageRects, rangeToOffsets } from "./textMap";
import { openPdf, loadPdfjs, type PdfDocument, type PdfRenderTask, type PdfTextLayer } from "./pdfjs";
import "./PdfReader.css";

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

interface PageSize {
  w: number;
  h: number;
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

/**
 * Wait until the write queue is empty: a write queued while an earlier one
 * was awaited is awaited too, until the queue is the same promise after the
 * await (review #272, step 2.25). A snapshot of the queue would let a
 * highlight edit made meanwhile be dropped on close.
 */
export async function drainQueue(queue: { readonly current: Promise<unknown> }): Promise<void> {
  for (;;) {
    const seen = queue.current;
    await seen;
    if (queue.current === seen) return;
  }
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
  const [ocrTexts, setOcrTexts] = useState<Record<number, string>>({});
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ page: number; occurrence: number }[]>([]);
  const [hitIndex, setHitIndex] = useState(-1);
  /** A search ran for the current query (so "no matches" can be said). */
  const [searched, setSearched] = useState(false);
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
  // The guard outlives the reader until its queued writes are done (step 2.25).
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (pendingWrites.current === 0 && !writeFailed.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => {
      const remove = () => window.removeEventListener("beforeunload", onBeforeUnload);
      if (pendingWrites.current > 0) void drainQueue(writeQueue).then(remove);
      else remove();
    };
  }, []);
  const annotationsRef = useRef<PdfAnnotation[]>([]);
  annotationsRef.current = annotations;
  const searchRef = useRef<HTMLInputElement>(null);
  /** Bumped per search and per query edit: a slower, older search must not commit its results. */
  const searchSeq = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

  // The reader is modal (step 2.21): take focus from the editor underneath,
  // make everything outside the reader inert so Tab can't reach the hidden
  // editor, and give focus back to where it was on close.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const before = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null;
    const inert = inertOutside(root);
    root.focus({ preventScroll: true });
    // Where `inert` isn't supported: focus that lands underneath comes back.
    const onFocusIn = (e: FocusEvent) => {
      if (e.target instanceof Node && inert.isInsideInerted(e.target)) root.focus({ preventScroll: true });
    };
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("focusin", onFocusIn);
      inert.release();
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
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
    setOcrTexts({});
    setQuery("");
    setHits([]);
    setHitIndex(-1);
    setSearched(false);
    setUnanchored(new Set());
    searchSeq.current++;
    (async () => {
      const ws = await import("../storage/workspace");
      const blob = await ws.readWorkspaceBlob(path);
      const opened = await openPdf(new Uint8Array(await blob.arrayBuffer()));
      closeDoc = opened.close;
      if (cancelled) {
        void opened.close();
        return;
      }
      const pdf = opened.doc;
      // Page 1's size stands in for every page, so a long PDF opens at once
      // (step 2.18); each page reports its real size when it comes near the
      // viewport and is rendered (onPageSize).
      const first = pdf.numPages > 0 ? (await pdf.getPage(1)).getViewport({ scale: 1 }) : null;
      const all: PageSize[] = first ? Array.from({ length: pdf.numPages }, () => ({ w: first.width, h: first.height })) : [];
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
      setDoc(pdf);
    })().catch((e: unknown) => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
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
      const target = Math.min(Math.max(1, page), sizes.length);
      // After the page boxes are laid out at their size.
      requestAnimationFrame(() => goToPage(target));
    }
    // On the page count, not the sizes: a page reporting its real size must
    // not scroll back to the link's page or flash again.
  }, [doc, sizes.length, fragment, openSeq, goToPage]);

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
  }, [doc, sizes.length, scale]);

  // The current page: the last one whose top is above the middle of the view.
  const onScroll = useCallback(() => {
    const box = scrollRef.current;
    if (!box) return;
    const mark = box.scrollTop + box.clientHeight / 2;
    let page = 1;
    for (const [n, el] of pageEls.current) if (el.offsetTop <= mark && n > page) page = n;
    setCurrent(page);
  }, []);

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
          showAiToast(t("pdf.saveFailed", { error: e instanceof Error ? e.message : String(e) }), "error");
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
    const onPage = layer.dataset.pdfText === "page";
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
          let text = ocrTexts[p] ?? pageTexts.current.get(p);
          if (text === undefined) {
            text = pageTextFromItems((await (await doc.getPage(p)).getTextContent()).items);
            pageTexts.current.set(p, text);
            if (seq !== searchSeq.current) return;
          }
          findAll(text, q).forEach((_, occurrence) => found.push({ page: p, occurrence }));
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
    [doc, hits, hitIndex, current, ocrTexts, goToPage],
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
      void (async () => {
        // Every write, including those queued while waiting (step 2.25).
        await drainQueue(writeQueue);
        if (!writeFailed.current) return then();
        persist(annotationsRef.current);
        await drainQueue(writeQueue);
        if (!writeFailed.current) then();
      })();
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

  /** A rendered page's real size (in points), replacing the page-1 placeholder. */
  const onPageSize = useCallback((page: number, size: PageSize) => {
    setSizes((prev: PageSize[]) => {
      const cur = prev[page - 1];
      if (!cur || (cur.w === size.w && cur.h === size.h)) return prev;
      const next = prev.slice();
      next[page - 1] = size;
      return next;
    });
  }, []);

  const onOcr = useCallback((page: number, text: string) => {
    setOcrTexts((prev) => ({ ...prev, [page]: text }));
    setHits([]);
  }, []);

  const activeHit = hitIndex >= 0 ? hits[hitIndex] : undefined;
  const name = baseName(path);

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      className="pdf-reader"
      data-testid="pdf-reader"
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
            {hitIndex >= 0 ? t("pdf.search.count", { i: hitIndex + 1, n: hits.length }) : searched ? t("search.noMatches") : ""}
          </span>
        </form>
        <div className="pdf-group pdf-end">
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
                ocrText={ocrTexts[i + 1]}
                query={activeHit?.page === i + 1 ? query : ""}
                occurrence={activeHit?.page === i + 1 ? activeHit.occurrence : -1}
                registerEl={registerEl}
                onSize={onPageSize}
                onText={onPageText}
                onOcr={onOcr}
                onAnchored={onAnchored}
              />
            ))}
          <div className="pdf-tail" aria-hidden="true" />
        </div>
        <aside className="pdf-side" aria-label={t("pdf.highlights")}>
          <h3>{t("pdf.highlights")}</h3>
          {!sorted.length && <p className="pdf-muted">{t("pdf.highlights.empty")}</p>}
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

interface PageProps {
  doc: PdfDocument;
  page: number;
  size: PageSize;
  scale: number;
  /** Near the viewport: render it. */
  active: boolean;
  annotations: PdfAnnotation[];
  flash: { id: string; seq: number } | null;
  ocrText: string | undefined;
  /** Search query whose `occurrence`-th match on this page is the current hit ("" for none). */
  query: string;
  occurrence: number;
  registerEl: (page: number, el: HTMLDivElement | null) => void;
  /** The page's real size at scale 1, once it is loaded. */
  onSize: (page: number, size: PageSize) => void;
  onText: (page: number, text: string) => void;
  onOcr: (page: number, text: string) => void;
  onAnchored: (missing: string[], all: string[]) => void;
}

interface DrawnRect {
  id: string;
  kind: "highlight" | "search";
  rects: PageRect[];
  /** Rects in px of the OCR text block, not points of the page. */
  ocr?: boolean;
}

const PdfPageView = memo(function PdfPageView({
  doc,
  page,
  size,
  scale,
  active,
  annotations,
  flash,
  ocrText,
  query,
  occurrence,
  registerEl,
  onSize,
  onText,
  onOcr,
  onAnchored,
}: PageProps) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasHost = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const ocrRef = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(0);
  const [scanned, setScanned] = useState(false);
  const [ocrBusy, setOcrBusy] = useState(false);
  const [drawn, setDrawn] = useState<DrawnRect[]>([]);

  // Render the canvas and the text layer while the page is near the viewport.
  useEffect(() => {
    const host = canvasHost.current;
    const layer = textRef.current;
    if (!active || !host || !layer) return;
    let cancelled = false;
    let task: PdfRenderTask | null = null;
    let textLayer: PdfTextLayer | null = null;
    (async () => {
      const [pdfjs, p] = await Promise.all([loadPdfjs(), doc.getPage(page)]);
      if (cancelled) return;
      const base = p.getViewport({ scale: 1 });
      onSize(page, { w: base.width, h: base.height });
      const viewport = p.getViewport({ scale });
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.setAttribute("aria-hidden", "true");
      task = p.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
      // Cancelled when the page scrolls away: not an error.
      task.promise.catch(() => undefined);
      const content = await p.getTextContent();
      if (cancelled) return;
      layer.replaceChildren();
      textLayer = new pdfjs.TextLayer({ textContentSource: content, container: layer, viewport });
      await Promise.all([task.promise, textLayer.render()]);
      if (cancelled) return;
      host.replaceChildren(canvas);
      const text = layerText(layer);
      setScanned(!text.trim());
      onText(page, text);
      setReady((n) => n + 1);
    })().catch(() => {
      /* cancelled (scrolled away / zoomed) or a broken page: the box stays empty */
    });
    return () => {
      cancelled = true;
      task?.cancel();
      textLayer?.cancel();
      host.replaceChildren();
      layer.replaceChildren();
      setDrawn([]);
    };
  }, [active, doc, page, scale, onSize, onText]);

  // Where this page's highlights (and the current search hit) are.
  useEffect(() => {
    const box = boxRef.current;
    if (!active || !box || !ready) return;
    const layers: { el: HTMLElement; ocr: boolean }[] = [];
    if (textRef.current && layerText(textRef.current).trim()) layers.push({ el: textRef.current, ocr: false });
    if (ocrRef.current) layers.push({ el: ocrRef.current, ocr: true });
    const out: DrawnRect[] = [];
    const missing: string[] = [];
    for (const a of annotations) {
      const id = shortId(a.id);
      let placed = false;
      for (const { el, ocr } of layers) {
        const anchor = anchorAnnotation(a, layerText(el));
        const range = anchor && offsetsToRange(el, anchor.start, anchor.end);
        if (!range) continue;
        const origin = (ocr ? el : box).getBoundingClientRect();
        out.push({ id, kind: "highlight", rects: rangePageRects(range, origin, ocr ? 1 : scale), ocr });
        placed = true;
        break;
      }
      if (!placed) missing.push(id);
    }
    if (query && occurrence >= 0) {
      for (const { el, ocr } of layers) {
        const hit = findAll(layerText(el), query)[occurrence];
        const range = hit && offsetsToRange(el, hit.start, hit.end);
        if (!range) continue;
        const origin = (ocr ? el : box).getBoundingClientRect();
        out.push({ id: "search", kind: "search", rects: rangePageRects(range, origin, ocr ? 1 : scale), ocr });
        range.startContainer.parentElement?.scrollIntoView({ block: "center" });
        break;
      }
    }
    setDrawn(out);
    onAnchored(
      missing,
      annotations.map((a) => shortId(a.id)),
    );
  }, [active, ready, annotations, scale, query, occurrence, ocrText, onAnchored]);

  // Bring a flashed highlight into view.
  useEffect(() => {
    if (!flash) return;
    const el = boxRef.current?.parentElement?.querySelector(`[data-highlight-id="${flash.id}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [flash, drawn]);

  const runOcr = useCallback(async () => {
    setOcrBusy(true);
    try {
      const p = await doc.getPage(page);
      const viewport = p.getViewport({ scale: 2 });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await p.render({ canvas, viewport }).promise;
      const { ocrImage } = await import("../ai/ocr");
      const { text } = await ocrImage(canvas);
      onOcr(page, text);
      setReady((n) => n + 1);
    } catch (e) {
      showAiToast(t("pdf.failed", { error: e instanceof Error ? e.message : String(e) }), "error");
    } finally {
      setOcrBusy(false);
    }
  }, [doc, page, onOcr]);

  const style = {
    width: `${size.w * scale}px`,
    height: `${size.h * scale}px`,
    "--total-scale-factor": String(scale),
    "--scale-round-x": "1px",
    "--scale-round-y": "1px",
  } as CSSProperties;

  const pct = (r: PageRect): CSSProperties => ({
    left: `${(r.left / size.w) * 100}%`,
    top: `${(r.top / size.h) * 100}%`,
    width: `${(r.width / size.w) * 100}%`,
    height: `${(r.height / size.h) * 100}%`,
  });
  const px = (r: PageRect): CSSProperties => ({ left: r.left, top: r.top, width: r.width, height: r.height });

  const marks = (ocr: boolean) =>
    drawn
      .filter((d) => !!d.ocr === ocr)
      .map((d) => (
        <div
          key={`${d.kind}-${d.id}`}
          className={`pdf-hl-group pdf-hl--${d.kind}`}
          data-highlight-id={d.kind === "highlight" ? d.id : undefined}
          data-search-hit={d.kind === "search" ? "true" : undefined}
          data-flash={d.kind === "highlight" && flash?.id === d.id ? "true" : undefined}
        >
          {d.rects.map((r, i) => (
            // Re-keyed per flash, so the same highlight flashes again on the next open.
            <span key={`${i}-${flash?.id === d.id ? flash.seq : 0}`} className="pdf-hl-rect" style={ocr ? px(r) : pct(r)} />
          ))}
        </div>
      ));

  return (
    <div className="pdf-page-wrap" data-page-wrap={page}>
      <div
        ref={(el) => {
          boxRef.current = el;
          registerEl(page, el);
        }}
        className="pdf-page"
        data-page-number={page}
        data-rendered={ready > 0 && active ? "true" : undefined}
        style={style}
        dir="ltr"
        role="region"
        aria-label={t("pdf.page.label", { n: page })}
      >
        <div ref={canvasHost} className="pdf-canvas" />
        <div className="pdf-hl-layer">{marks(false)}</div>
        <div ref={textRef} className="textLayer" data-pdf-text="page" />
        {active && scanned && ocrText === undefined && (
          <div className="pdf-scanned">
            <p>{t("pdf.ocr.scanned")}</p>
            <button type="button" className="pdf-primary" disabled={ocrBusy} onClick={() => void runOcr()}>
              {ocrBusy ? t("pdf.ocr.running") : t("pdf.ocr.run")}
            </button>
          </div>
        )}
      </div>
      {ocrText !== undefined && (
        <div className="pdf-ocr-wrap" style={{ width: `${size.w * scale}px` }}>
          <div className="pdf-hl-layer">{marks(true)}</div>
          <div ref={ocrRef} className="pdf-ocr" data-pdf-text="ocr" dir="auto">
            {ocrText || t("pdf.ocr.scanned")}
          </div>
        </div>
      )}
    </div>
  );
});

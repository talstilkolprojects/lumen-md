/**
 * EPUB reader (plan W1.14). Opens a book from the vault, shows one chapter
 * at a time with the book's own styles and fonts (scoped to the chapter),
 * right-to-left when the book is, with its table of contents, reading
 * themes, font size and line width kept per book, and highlights stored as
 * W3C Web Annotations in `<book>.epub.md` (the PDF reader's model).
 *
 * `#chapter=N&highlight=ID` (from a highlights note link) opens that chapter
 * and flashes the highlight. Nothing is fetched: the book's resources are
 * inlined from the file; links out of the book are not followed.
 */
import "./strings";
import { useCallback, useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from "react";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { ErrorBoundary } from "../ui/ErrorBoundary";
import { shortId } from "../pdf/annotations";
import { loadChapter, openEpub, scopeCss, type Chapter, type EpubBook, type TocEntry } from "./epub";
import {
  anchorEpubAnnotation,
  createEpubAnnotation,
  describeEpubAnnotation,
  epubCompanionPath,
  parseEpubFragment,
  readEpubNote,
  upsertEpubNote,
  withEpubNote,
  type EpubAnnotation,
} from "./annotations";
import { chapterText, markOffsets, rangeToOffsets } from "./textRange";
import { loadPrefs, savePrefs, THEMES, type ReaderPrefs, type ReaderTheme } from "./readerPrefs";
import "./EpubReader.css";

interface Props {
  path: string;
  fragment?: string | null;
  openSeq?: number;
  onClose: () => void;
}

const baseName = (p: string) => p.split("/").pop() ?? p;

function newUuid(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The TOC label of a chapter (the first entry that points into it). */
export function chapterLabel(toc: readonly TocEntry[], chapter: number): string {
  for (const e of toc) {
    if (e.chapter === chapter) return e.label;
    const sub = chapterLabel(e.children, chapter);
    if (sub) return sub;
  }
  return "";
}

export function EpubReaderOverlay(props: Props) {
  return (
    <ErrorBoundary
      fallback={
        <div className="epub-reader" role="alert">
          <p>{t("errorBoundary.heading")}</p>
          <button type="button" onClick={props.onClose}>
            {t("epub.close")}
          </button>
        </div>
      }
    >
      <EpubReader {...props} />
    </ErrorBoundary>
  );
}

export function EpubReader({ path, fragment = null, openSeq = 0, onClose }: Props) {
  const notePath = epubCompanionPath(path);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [chapter, setChapter] = useState<Chapter | null>(null);
  const [annotations, setAnnotations] = useState<EpubAnnotation[]>([]);
  /** The highlights note can't be read: highlighting is off so it is never overwritten. */
  const [readOnly, setReadOnly] = useState(false);
  /** What was saved for this book when it was opened (the chapter to resume at). */
  const saved = useRef(loadPrefs(path));
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => saved.current);
  const [tocOpen, setTocOpen] = useState(false);
  const [listOpen, setListOpen] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);
  const [unanchored, setUnanchored] = useState<Set<string>>(() => new Set());
  const contentRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const scrollTo = useRef<string | null>(null);

  useEffect(() => {
    rootRef.current?.focus({ preventScroll: true });
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (!pending.current) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  // Open the book and its highlights.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const ws = await import("../storage/workspace");
      const blob = await ws.readWorkspaceBlob(path);
      const opened = await openEpub(new Uint8Array(await blob.arrayBuffer()));
      let note: string | null = null;
      try {
        note = await ws.readWorkspaceFile(notePath);
      } catch (e) {
        if ((e as { name?: string })?.name !== "NotFoundError") throw e;
      }
      if (cancelled) return;
      const list = readEpubNote(note);
      if (list === null) {
        setReadOnly(true);
        showAiToast(t("epub.notesUnreadable", { name: baseName(notePath) }), "error");
      }
      setAnnotations(list ?? []);
      setBook(opened);
      setIndex(Math.min(saved.current.chapter, opened.spine.length - 1));
    })().catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [path, notePath]);

  // A link to a chapter / highlight (re-applied for every open).
  useEffect(() => {
    if (!book || !fragment) return;
    const f = parseEpubFragment(fragment);
    const target = f.highlight ? annotations.find((a) => shortId(a.id) === f.highlight) : undefined;
    const ch = target ? describeEpubAnnotation(target).chapter : f.chapter;
    if (ch && ch <= book.spine.length) setIndex(ch - 1);
    if (f.highlight) {
      scrollTo.current = f.highlight;
      setFlash(f.highlight);
    }
    // The annotations are loaded before the book is set, so they are current here.
  }, [book, fragment, openSeq]);

  // Load the chapter.
  useEffect(() => {
    if (!book) return;
    let cancelled = false;
    setChapter(null);
    loadChapter(book, index)
      .then((c) => !cancelled && setChapter(c))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    savePrefs(path, { ...prefs, chapter: index });
    return () => {
      cancelled = true;
    };
  }, [book, index]);

  useEffect(() => {
    if (book) savePrefs(path, { ...prefs, chapter: index });
  }, [prefs]);

  // Render the chapter and mark its highlights.
  useEffect(() => {
    const host = contentRef.current;
    if (!host || !chapter) return;
    host.innerHTML = chapter.html;
    const text = chapterText(host);
    const missing = new Set<string>();
    // Later marks first, so earlier offsets stay valid while wrapping.
    const mine = annotations
      .filter((a) => describeEpubAnnotation(a).chapter === chapter.index + 1)
      .map((a) => ({ a, at: anchorEpubAnnotation(a, text) }))
      .sort((x, y) => (y.at?.start ?? 0) - (x.at?.start ?? 0));
    for (const { a, at } of mine) {
      if (!at) {
        missing.add(a.id);
        continue;
      }
      markOffsets(host, at.start, at.end, { class: "epub-hl", "data-highlight": shortId(a.id), title: describeEpubAnnotation(a).note });
    }
    setUnanchored(missing);
    const id = scrollTo.current;
    if (id) {
      host.querySelector(`[data-highlight="${CSS.escape(id)}"]`)?.scrollIntoView({ block: "center" });
      scrollTo.current = null;
    } else if (!fragment) host.parentElement?.scrollTo?.({ top: 0 });
  }, [chapter, annotations]);

  // Flash the highlight a link or the list pointed at.
  useEffect(() => {
    if (!flash || !chapter) return;
    const marks = Array.from(contentRef.current?.querySelectorAll(`[data-highlight="${CSS.escape(flash)}"]`) ?? []);
    for (const m of marks) m.classList.add("epub-hl-flash");
    const tm = setTimeout(() => {
      for (const m of marks) m.classList.remove("epub-hl-flash");
      setFlash(null);
    }, 1600);
    return () => clearTimeout(tm);
  }, [flash, chapter, annotations]);

  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      const host = contentRef.current;
      setHasSelection(!!sel && !sel.isCollapsed && !!host && sel.rangeCount > 0 && host.contains(sel.getRangeAt(0).commonAncestorContainer));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const save = useCallback(
    (next: EpubAnnotation[]) => {
      setAnnotations(next);
      if (readOnly || !book) return;
      pending.current++;
      writes.current = writes.current
        .then(async () => {
          const ws = await import("../storage/workspace");
          let existing: string | null = null;
          try {
            existing = await ws.readWorkspaceFile(notePath);
          } catch (e) {
            if ((e as { name?: string })?.name !== "NotFoundError") throw e;
          }
          if (readEpubNote(existing) === null) throw new Error(t("epub.notesUnreadable", { name: baseName(notePath) }));
          const labels = { title: t("epub.noteTitle", { name: book.title || baseName(path) }), chapter: (n: number, label: string) => (label ? t("epub.noteChapterNamed", { n, label }) : t("epub.noteChapter", { n })), empty: t("epub.noteEmpty") };
          await ws.writeWorkspaceFile(notePath, upsertEpubNote(existing, path, next, labels, (n) => chapterLabel(book.toc, n - 1)));
          const { notifyWorkspaceChanged } = await import("../storage/workspaceEvents");
          notifyWorkspaceChanged();
        })
        .catch((e: unknown) => showAiToast(t("epub.saveFailed", { error: e instanceof Error ? e.message : String(e) }), "error"))
        .finally(() => {
          pending.current--;
        });
    },
    [readOnly, book, notePath, path],
  );

  const highlight = useCallback(() => {
    const host = contentRef.current;
    const sel = document.getSelection();
    if (!host || !sel || sel.isCollapsed || !chapter || readOnly) return;
    const off = rangeToOffsets(host, sel.getRangeAt(0));
    if (!off) return;
    const text = chapterText(host);
    const a = createEpubAnnotation({ id: newUuid(), source: path, chapter: chapter.index + 1, text, start: off.start, end: off.end });
    sel.removeAllRanges();
    save([...annotations, a]);
  }, [chapter, annotations, path, readOnly, save]);

  const go = (step: 1 | -1) => book && setIndex((i) => Math.min(book.spine.length - 1, Math.max(0, i + step)));

  const close = () => {
    void writes.current.then(onClose);
  };

  const onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).closest("input, textarea")) return;
    const forward = book?.rtl ? "ArrowLeft" : "ArrowRight";
    const back = book?.rtl ? "ArrowRight" : "ArrowLeft";
    if (e.key === "Escape") close();
    else if (e.key === forward) go(1);
    else if (e.key === back) go(-1);
    else if ((e.key === "h" || e.key === "H") && hasSelection) highlight();
  };

  const onContentClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a || !book) return;
    e.preventDefault();
    const href = a.getAttribute("data-epub-href");
    if (href) {
      const [file, frag] = href.split("#");
      const i = book.spine.findIndex((s) => s.href === file);
      if (i >= 0) setIndex(i);
      if (frag) setTimeout(() => contentRef.current?.querySelector(`#${CSS.escape(frag)}`)?.scrollIntoView(), 50);
    } else if (a.getAttribute("href")?.startsWith("#")) {
      contentRef.current?.querySelector(`#${CSS.escape(a.getAttribute("href")!.slice(1))}`)?.scrollIntoView();
    } else if (a.hasAttribute("data-external")) showAiToast(t("epub.external", { url: a.getAttribute("data-external") ?? "" }), "info");
  };

  const theme = THEMES[prefs.theme];
  const style = { "--epub-bg": theme.bg, "--epub-fg": theme.fg, "--epub-mark": theme.mark, "--epub-size": `${prefs.fontSize}px`, "--epub-width": `${prefs.width}ch` } as CSSProperties;
  const total = book?.spine.length ?? 0;
  const mine = annotations.filter((a) => book && describeEpubAnnotation(a).chapter <= total);

  const renderToc = (entries: TocEntry[], depth = 0) => (
    <ul className="epub-toc-list">
      {entries.map((e, i) => (
        <li key={`${depth}-${i}`}>
          <button type="button" className={e.chapter === index ? "current" : ""} disabled={e.chapter < 0} onClick={() => {
            setIndex(e.chapter);
            const frag = e.href.split("#")[1];
            if (frag) setTimeout(() => contentRef.current?.querySelector(`#${CSS.escape(frag)}`)?.scrollIntoView(), 50);
            setTocOpen(false);
          }}>
            {e.label}
          </button>
          {e.children.length > 0 && renderToc(e.children, depth + 1)}
        </li>
      ))}
    </ul>
  );

  return (
    <div ref={rootRef} className={`epub-reader epub-theme-${prefs.theme}`} style={style} role="dialog" aria-label={book?.title ?? baseName(path)} tabIndex={-1} onKeyDown={onKey} data-testid="epub-reader" data-chapter={chapter ? chapter.index + 1 : undefined} data-chapter-count={total || undefined}>
      <div className="epub-toolbar">
        <button type="button" onClick={() => setTocOpen((v) => !v)} aria-expanded={tocOpen}>
          {t("epub.toc")}
        </button>
        <span className="epub-title" dir="auto">
          {book ? `${book.title}${book.author ? ` — ${book.author}` : ""}` : baseName(path)}
        </span>
        <span className="epub-spacer" />
        {(["light", "sepia", "dark"] as ReaderTheme[]).map((th) => (
          <button key={th} type="button" aria-pressed={prefs.theme === th} onClick={() => setPrefs((p) => ({ ...p, theme: th }))}>
            {t(`epub.theme.${th}`)}
          </button>
        ))}
        <button type="button" aria-label={t("epub.fontSmaller")} onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.max(14, p.fontSize - 2) }))}>
          A−
        </button>
        <button type="button" aria-label={t("epub.fontLarger")} onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.min(32, p.fontSize + 2) }))}>
          A+
        </button>
        <button type="button" aria-label={t("epub.narrower")} onClick={() => setPrefs((p) => ({ ...p, width: Math.max(40, p.width - 6) }))}>
          ⇥⇤
        </button>
        <button type="button" aria-label={t("epub.wider")} onClick={() => setPrefs((p) => ({ ...p, width: Math.min(100, p.width + 6) }))}>
          ⇤⇥
        </button>
        <button type="button" data-testid="epub-highlight" disabled={!hasSelection || readOnly} title={t("epub.highlight.hint")} onMouseDown={(e) => e.preventDefault()} onClick={highlight}>
          {t("epub.highlight")}
        </button>
        <button type="button" onClick={() => setListOpen((v) => !v)} aria-expanded={listOpen}>
          {t("epub.highlights")} ({mine.length})
        </button>
        <button type="button" data-testid="epub-open-notes" onClick={() => void writes.current.then(() => { onClose(); window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: notePath } })); })}>
          {t("epub.openNotes")}
        </button>
        <button type="button" onClick={close} aria-label={t("epub.close")}>
          ✕
        </button>
      </div>
      <div className="epub-body">
        {tocOpen && book && (
          <nav className="epub-toc" aria-label={t("epub.toc")} dir={book.rtl ? "rtl" : "auto"}>
            {renderToc(book.toc)}
          </nav>
        )}
        <div className="epub-scroll">
          {error && <p className="epub-error" role="alert">{t("epub.failed", { error })}</p>}
          {!error && !chapter && <p className="epub-loading">{t("epub.loading")}</p>}
          {chapter && <style>{chapter.css.map((c) => scopeCss(c, ".epub-chapter")).join("\n")}</style>}
          <div
            ref={contentRef}
            className="epub-chapter"
            dir={chapter?.dir ?? (book?.rtl ? "rtl" : "auto")}
            lang={chapter?.lang ?? book?.language ?? undefined}
            onClick={onContentClick}
          />
          {book && (
            <div className="epub-nav">
              <button type="button" disabled={index === 0} onClick={() => go(-1)}>
                {t("epub.prev")}
              </button>
              <span>{t("epub.chapterOf", { n: index + 1, total })}</span>
              <button type="button" data-testid="epub-next" disabled={index >= total - 1} onClick={() => go(1)}>
                {t("epub.next")}
              </button>
            </div>
          )}
        </div>
        {listOpen && (
          <aside className="epub-list" aria-label={t("epub.highlights")}>
            {mine.length === 0 && <p>{t("epub.highlights.empty")}</p>}
            {mine.map((a) => {
              const d = describeEpubAnnotation(a);
              return (
                <div key={a.id} className="epub-list-item">
                  <button type="button" dir="auto" onClick={() => {
                    scrollTo.current = shortId(a.id);
                    setFlash(shortId(a.id));
                    if (d.chapter - 1 !== index) setIndex(d.chapter - 1);
                    else contentRef.current?.querySelector(`[data-highlight="${shortId(a.id)}"]`)?.scrollIntoView({ block: "center" });
                  }}>
                    “{d.quote?.exact}”
                  </button>
                  {unanchored.has(a.id) && <small>{t("epub.unanchored")}</small>}
                  <input
                    dir="auto"
                    defaultValue={d.note}
                    placeholder={t("epub.note.placeholder")}
                    disabled={readOnly}
                    onBlur={(e) => e.target.value.trim() !== d.note && save(annotations.map((x) => (x.id === a.id ? withEpubNote(x, e.target.value) : x)))}
                  />
                  <button type="button" disabled={readOnly} onClick={() => save(annotations.filter((x) => x.id !== a.id))}>
                    {t("epub.remove")}
                  </button>
                </div>
              );
            })}
          </aside>
        )}
      </div>
    </div>
  );
}

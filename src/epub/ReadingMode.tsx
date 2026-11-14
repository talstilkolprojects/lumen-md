/**
 * Reading mode (plan W1.14): the open note — typically a page clipped from
 * the web (4.15), whose front matter carries `source:` and `clipped:` — shown
 * as a page to read, with the EPUB reader's themes, font size and line width
 * (kept per note). Selecting a passage and pressing Highlight (or H) marks
 * it in the note itself as `==…==`, the clipper's own highlight syntax, so
 * the highlight lives in the Markdown and syncs with it.
 */
import "./strings";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { useAppStore } from "../store/useStore";
import { anchorTextQuote, createTextQuoteSelector } from "../pdf/annotations";
import { loadPrefs, savePrefs, THEMES, type ReaderPrefs, type ReaderTheme } from "./readerPrefs";
import { chapterText, rangeToOffsets } from "./textRange";
import "./EpubReader.css";
import { HelpButton } from "../ui/HelpButton";

/** `==x==` (clipper / Obsidian highlights) → CriticMarkup `{==x==}`, which the renderer shows as a mark. */
export function markHighlights(md: string): string {
  return md.replace(/(^|[^{=])==(?!\s)([^=\n]+?)(?<!\s)==(?!})/g, "$1{==$2==}");
}

/** The clip's source and date from its front matter, when it has them. */
export function clipInfo(md: string): { source: string | null; clipped: string | null } {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? "";
  const get = (k: string) => new RegExp(`^${k}:\\s*["']?([^"'\\n]+)["']?\\s*$`, "m").exec(fm)?.[1]?.trim() ?? null;
  return { source: get("source") ?? get("url"), clipped: get("clipped") ?? get("created") };
}

/**
 * Wrap the passage `quote` (with its rendered context) in `==…==` in the
 * Markdown `md`. Null when it can't be found as one run of plain text — a
 * passage across paragraphs, links or formatting is refused rather than
 * breaking the note's syntax.
 */
export function addHighlight(md: string, quote: { exact: string; prefix?: string; suffix?: string }): string | null {
  const body = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(md)?.[0].length ?? 0;
  const at = anchorTextQuote(md.slice(body), { type: "TextQuoteSelector", ...quote });
  if (!at || at.match === "fuzzy") return null;
  const start = body + at.start;
  const end = body + at.end;
  const span = md.slice(start, end);
  if (!span.trim() || /\n\s*\n|[[\]`*_<>]|==|\{|\}/.test(span)) return null;
  // Inside or across a mark that is already there.
  for (const m of md.matchAll(/==[^=\n]+?==/g)) if (m.index! < end && m.index! + m[0].length > start) return null;
  // Keep spaces outside the marks.
  const lead = span.length - span.trimStart().length;
  const trail = span.length - span.trimEnd().length;
  return `${md.slice(0, start + lead)}==${span.trim()}==${md.slice(end - trail)}`;
}

function ReadingView({ onClose }: { onClose: () => void }) {
  const doc = useAppStore((s) => s.doc);
  const key = `note:${doc.workspaceName ?? doc.name}`;
  const [prefs, setPrefs] = useState<ReaderPrefs>(() => loadPrefs(key));
  const [rendered, setRendered] = useState<ReactElement | null>(null);
  const [hasSelection, setHasSelection] = useState(false);
  const pageRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const info = useMemo(() => clipInfo(doc.content), [doc.content]);

  useEffect(() => rootRef.current?.focus({ preventScroll: true }), []);
  useEffect(() => savePrefs(key, prefs), [key, prefs]);
  useEffect(() => {
    let cancelled = false;
    void import("../renderer/pipeline").then(async ({ renderMarkdown }) => {
      const el = await renderMarkdown(markHighlights(doc.content), () => prefs.theme === "dark");
      if (!cancelled) setRendered(el);
    });
    return () => {
      cancelled = true;
    };
  }, [doc.content, prefs.theme]);
  useEffect(() => {
    const onSel = () => {
      const sel = document.getSelection();
      setHasSelection(!!sel && !sel.isCollapsed && sel.rangeCount > 0 && !!pageRef.current?.contains(sel.getRangeAt(0).commonAncestorContainer));
    };
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const highlight = () => {
    const page = pageRef.current;
    const sel = document.getSelection();
    if (!page || !sel || sel.isCollapsed) return;
    const off = rangeToOffsets(page, sel.getRangeAt(0));
    if (!off) return;
    const q = createTextQuoteSelector(chapterText(page), off.start, off.end);
    const next = addHighlight(doc.content, q);
    if (!next) {
      showAiToast(t("reading.highlightFailed"), "info");
      return;
    }
    sel.removeAllRanges();
    useAppStore.getState().setContent(next);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") onClose();
    else if ((e.key === "h" || e.key === "H") && hasSelection) highlight();
  };

  const theme = THEMES[prefs.theme];
  const style = { "--epub-bg": theme.bg, "--epub-fg": theme.fg, "--epub-mark": theme.mark, "--epub-size": `${prefs.fontSize}px`, "--epub-width": `${prefs.width}ch` } as CSSProperties;
  return (
    <div ref={rootRef} className={`epub-reader epub-theme-${prefs.theme}`} style={style} role="dialog" aria-label={t("reading.title")} tabIndex={-1} onKeyDown={onKey}>
      <div className="epub-toolbar">
        <span className="epub-title" dir="auto">{doc.name}</span>
        <HelpButton topic="workspace/epub-reader#reading-mode-for-clipped-pages" />
        <span className="epub-spacer" />
        {(["light", "sepia", "dark"] as ReaderTheme[]).map((th) => (
          <button key={th} type="button" aria-pressed={prefs.theme === th} onClick={() => setPrefs((p) => ({ ...p, theme: th }))}>
            {t(`epub.theme.${th}`)}
          </button>
        ))}
        <button type="button" aria-label={t("epub.fontSmaller")} onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.max(14, p.fontSize - 2) }))}>A−</button>
        <button type="button" aria-label={t("epub.fontLarger")} onClick={() => setPrefs((p) => ({ ...p, fontSize: Math.min(32, p.fontSize + 2) }))}>A+</button>
        <button type="button" aria-label={t("epub.narrower")} onClick={() => setPrefs((p) => ({ ...p, width: Math.max(40, p.width - 6) }))}>⇥⇤</button>
        <button type="button" aria-label={t("epub.wider")} onClick={() => setPrefs((p) => ({ ...p, width: Math.min(100, p.width + 6) }))}>⇤⇥</button>
        <button type="button" disabled={!hasSelection} title={t("epub.highlight.hint")} onMouseDown={(e) => e.preventDefault()} onClick={highlight}>
          {t("epub.highlight")}
        </button>
        <button type="button" onClick={onClose} aria-label={t("epub.close")}>✕</button>
      </div>
      <div className="epub-scroll">
        {info.source && (
          <p className="epub-chapter reading-source" dir="auto">
            {t("reading.source", { source: info.source, clipped: info.clipped ?? "—" })}
          </p>
        )}
        <div ref={pageRef} className="epub-chapter reading-page" dir="auto">
          {rendered}
        </div>
      </div>
    </div>
  );
}

let close: (() => void) | null = null;

/** Open the current note in reading mode (run again to close). */
export function openReadingMode(): void {
  if (close) {
    close();
    return;
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  close = () => {
    close = null;
    root.unmount();
    host.remove();
  };
  root.render(<ReadingView onClose={() => close?.()} />);
}

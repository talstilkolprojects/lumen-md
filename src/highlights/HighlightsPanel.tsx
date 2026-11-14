/**
 * All highlights (plan W1.15): every PDF, EPUB and clip highlight in the
 * vault, searchable by its text, note and tags, filtered by kind, document
 * and tag; tags added here are saved into the highlight's sidecar note; the
 * current results can be exported to a note whose links reopen each
 * highlight; a highlight can be dragged into a note or a canvas (it drops as
 * a quote with its link). Lazy: the palette opens it.
 */
import "./strings";
import "../epub/strings";
import "../pdf/strings";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import { showAiToast } from "../ui/AiToast";
import { allSources, allTags, cleanTag, exportNote, quoteBlock, retagItem, search, type HighlightItem, type HighlightKind } from "./hub";
import { retagSidecar, type RetagLabels } from "./retag";
import "./HighlightsPanel.css";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";
import { EmptyState, runCommand } from "../ui/EmptyState";

const SHOWN = 200;
const baseName = (p: string) => p.split("/").pop() ?? p;

export function whereLabel(it: HighlightItem): string {
  if (it.kind === "pdf") return t("pdf.notePage", { n: it.location ?? 1 });
  if (it.kind === "epub") return t("epub.noteChapter", { n: it.location ?? 1 });
  if (it.kind === "import") return it.where ?? baseName(it.source).replace(/\.(md|markdown)$/i, "");
  return baseName(it.source).replace(/\.(md|markdown)$/i, "");
}

function retagLabels(it: HighlightItem): RetagLabels {
  return {
    pdf: { title: t("pdf.noteTitle", { name: baseName(it.source) }), page: (n) => t("pdf.notePage", { n }), empty: t("pdf.noteEmpty") },
    epub: { title: t("epub.noteTitle", { name: baseName(it.source) }), chapter: (n, label) => (label ? t("epub.noteChapterNamed", { n, label }) : t("epub.noteChapter", { n })), empty: t("epub.noteEmpty") },
  };
}

/** The vault's highlights, from the index worker (W10.C25): nothing is read or parsed on this thread. */
export async function loadIndex(): Promise<HighlightItem[]> {
  return (await import("../storage/workspaceIndex")).indexedHighlights();
}

/** Open the highlight: the reader at its page / chapter (it flashes), or the clip note. */
export function openHighlight(it: HighlightItem): void {
  const hash = it.link.indexOf("#");
  const detail = it.kind === "clip" || hash < 0 ? { path: it.source } : { path: it.source, fragment: it.link.slice(hash + 1) };
  window.dispatchEvent(new CustomEvent("lumen-open-file", { detail }));
}

export function HighlightsPanel({ onClose, load = loadIndex }: { onClose: () => void; load?: () => Promise<HighlightItem[]> }) {
  const [items, setItems] = useState<HighlightItem[] | null>(null);
  const [text, setText] = useState("");
  const [kind, setKind] = useState<HighlightKind | "">("");
  const [source, setSource] = useState("");
  const [tag, setTag] = useState("");
  const [limit, setLimit] = useState(SHOWN);

  const reload = () =>
    load()
      .then(setItems)
      .catch((e: unknown) => showAiToast(t("hl.loadFailed", { error: explainError(e) }), "error"));
  useEffect(() => {
    void reload();
  }, []);

  const { results, ms } = useMemo(() => {
    if (!items) return { results: [] as HighlightItem[], ms: null };
    const t0 = performance.now();
    const r = search(items, { text, kind: kind || null, source: source || null, tag: tag || null });
    return { results: r, ms: performance.now() - t0 };
  }, [items, text, kind, source, tag]);
  const tags = useMemo(() => allTags(items ?? []), [items]);
  const sources = useMemo(() => allSources(items ?? []), [items]);

  const setTags = async (it: HighlightItem, next: string[]) => {
    try {
      const { writeSidecar } = await import("./sidecar");
      await writeSidecar(it.notePath, (existing) => retagSidecar(existing, it, next, retagLabels(it)));
      setItems((list) => list?.map((x) => (x.key === it.key ? retagItem(x, next) : x)) ?? list);
    } catch (e) {
      showAiToast(t("hl.tagFailed", { error: explainError(e) }), "error");
    }
  };

  const exportResults = async () => {
    try {
      const ws = await import("../storage/workspace");
      const { notifyWorkspaceChanged } = await import("../storage/workspaceEvents");
      const date = new Date().toISOString().slice(0, 10);
      const path = await ws.uniqueWorkspaceName(`${t("hl.exportName", { date })}.md`);
      await ws.writeWorkspaceFile(path, exportNote(results, { title: t("hl.exportTitle", { date, n: results.length }), where: whereLabel }));
      notifyWorkspaceChanged();
      onClose();
      window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
    } catch (e) {
      showAiToast(t("hl.exportFailed", { error: explainError(e) }), "error");
    }
  };

  const onDragStart = (e: DragEvent, it: HighlightItem) => {
    e.dataTransfer.setData("text/plain", quoteBlock(it, whereLabel(it)));
    e.dataTransfer.effectAllowed = "copy";
  };

  return (
    <div className="hl-panel" role="dialog" aria-label={t("hl.title")} data-testid="highlights-panel" onKeyDown={(e) => e.key === "Escape" && onClose()}>
      <div className="hl-head">
        <strong>{t("hl.title")}</strong>
        <HelpButton topic="workspace/highlights" />
        <span className="hl-count" data-testid="highlights-count">
          {items ? t("hl.count", { n: results.length, total: items.length }) : t("hl.loading")}
          {ms !== null && items ? ` · ${ms < 1 ? "<1" : Math.round(ms)} ms` : ""}
        </span>
        <span className="hl-spacer" />
        <button type="button" onClick={() => void exportResults()} disabled={!results.length} data-testid="highlights-export">
          {t("hl.export")}
        </button>
        <button type="button" onClick={onClose} aria-label={t("epub.close")}>
          ✕
        </button>
      </div>
      <div className="hl-filters">
        <input autoFocus dir="auto" type="search" value={text} placeholder={t("hl.search")} onChange={(e) => (setText(e.target.value), setLimit(SHOWN))} data-testid="highlights-search" />
        <select value={kind} onChange={(e) => setKind(e.target.value as HighlightKind | "")} aria-label={t("hl.kind")}>
          <option value="">{t("hl.kind.all")}</option>
          <option value="pdf">PDF</option>
          <option value="epub">EPUB</option>
          <option value="clip">{t("hl.kind.clip")}</option>
          <option value="import">{t("hl.kind.import")}</option>
        </select>
        <select value={source} onChange={(e) => setSource(e.target.value)} aria-label={t("hl.source")}>
          <option value="">{t("hl.source.all")}</option>
          {sources.map((s) => (
            <option key={s.source} value={s.source}>
              {baseName(s.source)} ({s.count})
            </option>
          ))}
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label={t("hl.tag")}>
          <option value="">{t("hl.tag.all")}</option>
          {tags.map((x) => (
            <option key={x.tag} value={x.tag}>
              #{x.tag} ({x.count})
            </option>
          ))}
        </select>
      </div>
      <ul className="hl-list">
        {items && results.length === 0 && (
          <li className="hl-empty">
            {items.length ? t("hl.noMatch") : <EmptyState message={t("hl.none")} action={{ label: t("cmd.highlights.import"), onClick: () => (onClose(), runCommand("highlights.import")) }} />}
          </li>
        )}
        {results.slice(0, limit).map((it) => (
          <li key={it.key} className="hl-item" draggable onDragStart={(e) => onDragStart(e, it)} data-testid="highlight-item">
            <button type="button" className="hl-quote" dir="auto" onClick={() => (onClose(), openHighlight(it))}>
              “{it.text}”
            </button>
            {it.note && (
              <p className="hl-note" dir="auto">
                {it.note}
              </p>
            )}
            <div className="hl-meta">
              <span>
                {it.kind.toUpperCase()} · {baseName(it.source)} · {whereLabel(it)}
              </span>
              {it.tags.map((x) => (
                <span key={x} className="hl-tag">
                  #{x}
                  {(it.kind === "pdf" || it.kind === "epub") && (
                    <button type="button" aria-label={t("hl.tag.remove", { tag: x })} onClick={() => void setTags(it, it.tags.filter((y) => y !== x))}>
                      ×
                    </button>
                  )}
                </span>
              ))}
              {(it.kind === "pdf" || it.kind === "epub") && (
                <input
                  className="hl-addtag"
                  dir="auto"
                  placeholder={t("hl.tag.add")}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter") return;
                    const v = cleanTag((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).value = "";
                    if (v && !it.tags.includes(v)) void setTags(it, [...it.tags, v]);
                  }}
                />
              )}
            </div>
          </li>
        ))}
        {results.length > limit && (
          <li>
            <button type="button" onClick={() => setLimit((l) => l + SHOWN)}>
              {t("hl.more", { n: results.length - limit })}
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

let close: (() => void) | null = null;

/** The palette's "All highlights" (run again to close). */
export function openHighlightsPanel(): void {
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
  root.render(<HighlightsPanel onClose={() => close?.()} />);
}

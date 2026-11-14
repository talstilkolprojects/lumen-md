/**
 * The book panel (plan W5.8): chapters in order with their word counts and
 * goals, the book's progress, today's words and the streak; reorder by drag
 * or with the arrow buttons; export EPUB or print to PDF. Opened from the
 * palette on the book's index note or on any of its chapters.
 */
import { createRoot } from "react-dom/client";
import { useCallback, useEffect, useState } from "react";
import { t } from "../i18n";
import { useToastStore } from "../store/useToastStore";
import type { BookState } from "./app";
import { explainError } from "../lib/userError";
import { HelpButton } from "../ui/HelpButton";

type App = typeof import("./app");

const btn: React.CSSProperties = { border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 10px", background: "transparent", color: "inherit", cursor: "pointer" };
const pct = (n: number) => Math.round(n * 100);

function Bar({ value, label }: { value: number; label: string }) {
  return (
    <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct(value)} style={{ height: 6, borderRadius: 3, background: "hsl(var(--border))", overflow: "hidden" }}>
      <div style={{ width: `${pct(value)}%`, height: "100%", background: "hsl(var(--accent, 250 80% 60%))" }} />
    </div>
  );
}

function BookPanel({ app, indexPath, close }: { app: App; indexPath: string; close: () => void }) {
  const [state, setState] = useState<BookState | null>(null);
  const [busy, setBusy] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const toast = useToastStore.getState().push;

  const reload = useCallback(async () => {
    const book = app.parseBookIndex(indexPath, await app.readIndex(indexPath));
    if (book) setState(await app.loadBookState(book));
  }, [app, indexPath]);
  useEffect(() => void reload(), [reload]);

  // Top-level chapters (a nested part moves with the chapter before it).
  const tops = state ? state.progress.chapters.map((c, i) => ({ c, i })).filter(({ c }) => c.ref.depth === 0) : [];
  const move = async (from: number, to: number) => {
    if (from === to || to < 0 || to >= tops.length) return;
    try {
      await app.saveIndex(indexPath, app.moveChapter(await app.readIndex(indexPath), from, to));
      await reload();
    } catch (e) {
      toast({ kind: "error", title: t("book.failed", { error: explainError(e) }) });
    }
  };
  const run = async (what: "epub" | "print") => {
    if (!state) return;
    setBusy(true);
    try {
      if (what === "epub") {
        const r = await app.exportEpub(state.book);
        toast({ kind: "success", title: t("book.exported", { name: state.book.title, chapters: r.chapters, seconds: (r.ms / 1000).toFixed(1) }), ...(r.missing.length ? { body: t("book.missing", { count: r.missing.length }) } : {}) });
      } else {
        const r = await app.printBook(state.book);
        if (r.missing.length) toast({ kind: "info", title: t("book.missing", { count: r.missing.length }) });
      }
    } catch (e) {
      toast({ kind: "error", title: t("book.failed", { error: explainError(e) }) });
    } finally {
      setBusy(false);
    }
  };

  if (!state) return <p>…</p>;
  const { book, progress, daily } = state;
  return (
    <div dir="auto">
      <h2 style={{ marginTop: 0 }}>
        {t("book.title")}: {book.title} <HelpButton topic="workspace/book" />
      </h2>
      <p style={{ margin: "4px 0" }}>{progress.goal ? t("book.total.ofGoal", { words: progress.words, goal: progress.goal, percent: pct(progress.share ?? 0) }) : t("book.total", { words: progress.words })}</p>
      {progress.share !== null && <Bar value={progress.share} label={t("book.total", { words: progress.words })} />}
      <p style={{ margin: "8px 0 4px" }}>
        {daily.goal ? t("book.today.ofGoal", { words: daily.today, goal: daily.goal }) : t("book.today", { words: daily.today })}
        {daily.goal ? ` · ${t("book.streak", { days: daily.streak })}` : ""}
      </p>
      <h3>{t("book.chapters")}</h3>
      <ol style={{ listStyle: "none", padding: 0, margin: 0 }} data-testid="book-chapters">
        {progress.chapters.map((c, i) => {
          const top = tops.findIndex((x) => x.i === i);
          return (
            <li
              key={`${c.ref.path}-${i}`}
              draggable={top >= 0}
              onDragStart={() => setDrag(top)}
              onDragOver={(e) => top >= 0 && e.preventDefault()}
              onDrop={() => drag !== null && top >= 0 && void move(drag, top)}
              style={{ padding: "6px 0", paddingInlineStart: c.ref.depth * 18, borderBottom: "1px solid hsl(var(--border))", display: "grid", gridTemplateColumns: "1fr auto", gap: 6, alignItems: "center" }}
            >
              <div>
                <button type="button" style={{ ...btn, border: "none", padding: 0, textDecoration: "underline" }} aria-label={t("book.chapter.open", { name: c.title })} onClick={() => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: c.ref.path } }))}>
                  {c.title}
                </button>
                <div style={{ fontSize: 12, opacity: 0.8 }}>{c.words === null ? t("book.chapter.missing") : c.goal ? t("book.chapter.ofGoal", { words: c.words, goal: c.goal }) : t("book.chapter.words", { words: c.words })}</div>
                {c.goal && c.words !== null ? <Bar value={Math.min(1, c.words / c.goal)} label={c.title} /> : null}
              </div>
              {top >= 0 && (
                <span style={{ display: "flex", gap: 4 }}>
                  <button type="button" style={btn} disabled={top === 0} aria-label={t("book.chapter.up")} onClick={() => void move(top, top - 1)}>
                    ↑
                  </button>
                  <button type="button" style={btn} disabled={top === tops.length - 1} aria-label={t("book.chapter.down")} onClick={() => void move(top, top + 1)}>
                    ↓
                  </button>
                </span>
              )}
            </li>
          );
        })}
      </ol>
      <p style={{ fontSize: 12, opacity: 0.8 }}>{t("book.goalHint")}</p>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" style={btn} disabled={busy} onClick={() => void run("epub")}>
          {t("book.exportEpub")}
        </button>
        <button type="button" style={btn} disabled={busy} onClick={() => void run("print")}>
          {t("book.print")}
        </button>
        <button type="button" style={btn} onClick={close} autoFocus>
          {t("book.close")}
        </button>
      </div>
    </div>
  );
}

/** Open the book panel for the book `indexPath`. */
export function openBookDialog(app: App, indexPath: string): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(
    <div role="dialog" aria-modal="true" aria-label={t("book.title")} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "hsl(0 0% 0%/0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div data-testid="book-dialog" style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 20, maxWidth: 640, width: "100%", maxHeight: "85vh", overflow: "auto", fontSize: 14 }}>
        <BookPanel app={app} indexPath={indexPath} close={close} />
      </div>
    </div>,
  );
}

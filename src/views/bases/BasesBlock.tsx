/**
 * BasesBlock — an Obsidian Bases file (plan W1.11) in a note: a ```base
 * block, `![[Books.base]]` (or `![[Books.base#View]]`), or a `.base` file
 * opened in the editor. Shows its views — table, cards, list, kanban, map —
 * over the whole workspace, with the file's filters, formulas, sort, groups,
 * limit and summaries (./base.ts).
 *
 * Plan W1.12 adds relations and rollups (./base.ts), calendar and timeline
 * views whose drag (or Alt + arrow keys) changes only the date property of
 * the note, a virtual table for big views, and CSV export / import.
 *
 * Clicking a column header sorts; for an embedded base, "Save this sort"
 * writes it back to the `.base` file with only that view's `sort:` changed.
 * Loaded lazily with the preview's code blocks (never in the startup
 * bundle); the map view loads Leaflet only when it is shown.
 */

import { lazy, Suspense, useEffect, useMemo, useRef, useState, type JSX, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { AlertCircle } from "lucide-react";
import { basesFileFromText, basesLatLng, parseBase, runBase, setViewSort, viewKind, type BaseModel, type BaseResult, type BaseRow, type BasesSort } from "./base";
import { parseBaseEmbedMeta } from "./embed";
import { isTagged, toText, type BasesFile, type BValue } from "./values";
import type { DatabaseRow } from "../database";
import { isOPFSAvailable, listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "../../storage/workspace";
import { onWorkspaceChanged } from "../../storage/workspaceEvents";
import { useAppStore } from "../../store/useStore";
import { editNote } from "../databaseEdit";
import { addDays, csvToNotes, daysBetween, monthWeeks, moveDateInText, pinnedProperties, resultToCsv, rowsByDay, timelineItems, visibleWindow, writableKey } from "./viewsData";
import { showAiToast } from "../../ui/AiToast";
import { log } from "../../lib/logger";
import { t } from "../../i18n";
import "./basesBlockStrings";
import { explainError } from "../../lib/userError";
import { EmptyState, learnHow } from "../../ui/EmptyState";

const DatabaseMapView = lazy(() => import("../DatabaseMapView"));

const muted = "hsl(var(--fg-muted))";
const danger = "hsl(var(--danger))";

/** Every file of the workspace, as Bases sees it (notes with their text, attachments without). */
async function loadVault(): Promise<BasesFile[]> {
  if (!isOPFSAvailable()) return [];
  const entries = await listWorkspace({ includeAssets: false });
  const out: BasesFile[] = [];
  for (const e of entries) {
    const isNote = /\.(md|markdown)$/i.test(e.path);
    let text: string | null = null;
    if (isNote) {
      try {
        text = await readWorkspaceFile(e.path);
      } catch {
        continue;
      }
    }
    out.push(basesFileFromText(e.path, text, { size: e.size, mtime: e.modified ? new Date(e.modified) : null }));
  }
  return out;
}

/** `Books.base` → the workspace path: exact, else by name (Obsidian resolves embeds by name). */
function findBase(files: readonly { path: string }[], target: string): string | null {
  const want = target.replace(/^\/+/, "").toLowerCase();
  const exact = files.find((f) => f.path.toLowerCase() === want);
  if (exact) return exact.path;
  const byName = files.find((f) => f.path.toLowerCase().endsWith(`/${want}`));
  return byName?.path ?? null;
}

function openFile(path: string) {
  window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
}

function FileLink({ path, label }: { path: string; label: string }) {
  return (
    <a
      href={`#${encodeURIComponent(path)}`}
      dir="auto"
      onClick={(e) => {
        e.preventDefault();
        openFile(path);
      }}
      style={{ color: "hsl(var(--accent))", textDecoration: "none", fontWeight: 500 }}
    >
      {label}
    </a>
  );
}

/** One value in a cell: files and links open, lists join, true / false as ✓ / ✗. */
function Cell({ value, files }: { value: BValue; files: readonly BasesFile[] }): JSX.Element | null {
  if (value === null) return null;
  if (typeof value === "boolean") return <span aria-label={String(value)}>{value ? "✓" : "✗"}</span>;
  if (Array.isArray(value))
    return (
      <>
        {value.map((v, i) => (
          <span key={i}>
            {i > 0 && ", "}
            <Cell value={v} files={files} />
          </span>
        ))}
      </>
    );
  if (isTagged(value)) {
    if (value.$ === "file") return <FileLink path={value.file.path} label={value.file.basename} />;
    if (value.$ === "link") {
      const target = files.find((f) => f.path === value.path || f.basename === value.path || f.path.replace(/\.md$/i, "") === value.path);
      return target ? <FileLink path={target.path} label={toText(value)} /> : <span dir="auto">{toText(value)}</span>;
    }
    if (value.$ === "image" && /^https:\/\//i.test(value.src)) return <img src={value.src} alt="" loading="lazy" style={{ maxInlineSize: 120, maxBlockSize: 80 }} />;
  }
  return <span dir="auto">{toText(value)}</span>;
}

function nameCell(row: BaseRow, id: string, files: readonly BasesFile[]): ReactNode {
  // file.name in the first column opens the note, as in Obsidian.
  if (id === "file.name" || id === "file.basename") return <FileLink path={row.file.path} label={row.file.ext === "md" ? row.file.basename : row.file.name} />;
  return <Cell value={row.cells[id]} files={files} />;
}

export default function BasesBlock({ source, meta }: { source: string; meta?: string }) {
  const embed = useMemo(() => parseBaseEmbedMeta(meta), [meta]);
  const activePath = useAppStore((s) => s.doc.workspaceName ?? null);
  const [files, setFiles] = useState<BasesFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [embedded, setEmbedded] = useState<{ path: string; text: string } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [viewIndex, setViewIndex] = useState<number | null>(null);
  const [sortOverride, setSortOverride] = useState<BasesSort[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const vault = await loadVault();
      if (cancelled) return;
      setFiles(vault);
      if (embed) {
        const all = isOPFSAvailable() ? await listWorkspace({ includeAssets: false }) : [];
        const path = findBase(all, embed.path);
        if (!path) {
          if (!cancelled) setLoadError(t("base.notFound", { path: embed.path }));
          return;
        }
        const text = await readWorkspaceFile(path);
        if (!cancelled) {
          setEmbedded({ path, text });
          setLoadError(null);
        }
      }
    };
    setLoading(true);
    load()
      .catch((e: Error) => {
        log.warn("base: load failed", e);
        if (!cancelled) setLoadError(explainError(e));
      })
      .finally(() => !cancelled && setLoading(false));
    const off = onWorkspaceChanged(() => void load().catch(() => undefined), { debounceMs: 500 });
    return () => {
      cancelled = true;
      off();
    };
  }, [embed]);

  const text = embed ? (embedded?.text ?? null) : source;
  const parsed = useMemo(() => (text === null ? null : parseBase(text)), [text]);
  const base: BaseModel | null = parsed?.ok ? parsed.base : null;
  const initialView = useMemo(() => {
    if (!base || !embed?.view) return 0;
    const i = base.views.findIndex((v) => v.name === embed.view);
    return i < 0 ? 0 : i;
  }, [base, embed]);
  const current = viewIndex ?? initialView;
  // `this`: the note that embeds the base, or the .base file itself when it is the open document.
  const thisFile = useMemo(() => files.find((f) => f.path === activePath) ?? null, [files, activePath]);

  const result: BaseResult | null = useMemo(() => {
    if (!base) return null;
    const views = sortOverride ? base.views.map((v, i) => (i === current ? { ...v, sort: sortOverride } : v)) : base.views;
    return runBase({ ...base, views }, files, { view: current, thisFile });
  }, [base, files, current, sortOverride, thisFile]);

  if (loadError || (parsed && !parsed.ok)) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }} data-testid="base-block">
        <div role="alert" style={{ color: danger, fontSize: 13, display: "flex", alignItems: "center", gap: 8 }} dir="auto">
          <AlertCircle size={14} />
          {loadError ?? t("base.error", { error: parsed && !parsed.ok ? parsed.error : "" })}
        </div>
      </div>
    );
  }
  if (!base || !result) {
    return (
      <div className="chart-block" style={{ padding: "1rem", color: muted, fontSize: 12 }} data-testid="base-block">
        {t("db.loading")}
      </div>
    );
  }

  const kind = viewKind(result.view);
  const clickSort = (id: string) => {
    const cur = (sortOverride ?? result.view.sort)[0];
    setSortOverride([{ property: id, direction: cur?.property === id && cur.direction === "ASC" ? "DESC" : "ASC" }]);
  };
  const canSave = !!embedded && !!sortOverride && embedded.path !== activePath;
  const save = async () => {
    if (!embedded || !sortOverride) return;
    const w = setViewSort(embedded.text, current, sortOverride);
    if (!w.ok) return showAiToast(t("base.error", { error: w.error }), "error");
    try {
      await writeWorkspaceFile(embedded.path, w.text);
      setEmbedded({ path: embedded.path, text: w.text });
      setSortOverride(null);
      showAiToast(t("base.saved", { file: embedded.path }));
    } catch (e) {
      showAiToast(t("base.error", { error: explainError(e) }), "error");
    }
  };
  const fileLabel = embedded?.path ?? (activePath?.toLowerCase().endsWith(".base") ? activePath : null);

  return (
    <div className="chart-block lumen-base" data-testid="base-block" data-view-kind={kind}>
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600 }} dir="auto">
            {fileLabel ? fileLabel.replace(/^.*\//, "").replace(/\.base$/i, "") : result.view.name}
          </span>
          <span style={{ fontSize: 11, color: muted }} data-testid="base-count">
            {result.total > result.rows.length ? t("base.limited", { count: result.rows.length, total: result.total }) : t("db.count", { count: result.rows.length })}
          </span>
          {loading && <span style={{ fontSize: 11, color: muted }}>· {t("db.loading")}</span>}
          <button type="button" onClick={() => downloadCsv(result, fileLabel ?? result.view.name)} style={{ fontSize: 11 }} data-testid="base-csv-export">
            {t("base.csv.export")}
          </button>
          <button type="button" onClick={() => void importCsv(base, fileLabel ?? result.view.name, files)} style={{ fontSize: 11 }} data-testid="base-csv-import">
            {t("base.csv.import")}
          </button>
        </span>
        {base.views.length > 1 && (
          <div className="chart-block-tabs" role="tablist" aria-label={t("db.views")}>
            {base.views.map((v, i) => (
              <button
                key={`${i}-${v.name}`}
                type="button"
                role="tab"
                aria-selected={i === current}
                className={i === current ? "active" : ""}
                onClick={() => {
                  setViewIndex(i);
                  setSortOverride(null);
                }}
                dir="auto"
              >
                {v.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {result.errors.length > 0 && (
        <div role="alert" style={{ paddingInline: 8, paddingBlockStart: 4, color: danger, fontSize: 11 }} data-testid="base-errors">
          <div>{t("base.problems")}</div>
          {result.errors.slice(0, 5).map((e) => (
            <div key={e} dir="auto">
              {e}
            </div>
          ))}
        </div>
      )}
      {canSave && (
        <div style={{ paddingInline: 8, paddingBlockStart: 4 }}>
          <button type="button" onClick={() => void save()} style={{ fontSize: 11 }}>
            {t("base.saveSort", { file: embedded!.path })}
          </button>
        </div>
      )}
      <div style={{ padding: 8 }}>
        {result.rows.length === 0 && !loading && <EmptyState style={{ padding: 24, alignItems: "center", fontSize: 13 }} message={t("db.empty")} action={learnHow("workspace/obsidian-bases#three-ways-to-show-a-base")} />}
        {result.rows.length > 0 && kind === "table" && <TableView result={result} files={files} sort={sortOverride ?? result.view.sort} onSort={clickSort} />}
        {result.rows.length > 0 && kind === "calendar" && <CalendarView result={result} files={files} />}
        {result.rows.length > 0 && kind === "timeline" && <TimelineView result={result} files={files} />}
        {result.rows.length > 0 && kind === "cards" && <CardsView result={result} files={files} />}
        {result.rows.length > 0 && kind === "list" && <ListView result={result} files={files} />}
        {result.rows.length > 0 && kind === "kanban" && <KanbanView result={result} files={files} />}
        {result.rows.length > 0 && kind === "map" && (
          <Suspense fallback={<div style={{ padding: 12, fontSize: 12, color: muted }}>{t("db.loading")}</div>}>
            <MapView result={result} />
          </Suspense>
        )}
      </div>
    </div>
  );
}

interface ViewProps {
  result: BaseResult;
  files: readonly BasesFile[];
}

function groupLabel(key: BValue): string {
  return key === null ? t("db.none") : toText(key);
}

/** Row height of the virtual table, and the number of rows above which it virtualizes. */
const ROW_H = 28;
const VIRTUAL_FROM = 200;

type TableItem = { kind: "group"; key: BValue; count: number } | { kind: "row"; row: BaseRow };

function TableView({ result, files, sort, onSort }: ViewProps & { sort: BasesSort[]; onSort: (id: string) => void }) {
  const cols = result.columns;
  const summaryIds = Object.keys(result.summaries);
  const items: TableItem[] = useMemo(() => {
    const out: TableItem[] = [];
    for (const g of result.groups ?? [{ key: null, rows: result.rows }]) {
      if (result.groups) out.push({ kind: "group", key: g.key, count: g.rows.length });
      for (const row of g.rows) out.push({ kind: "row", row });
    }
    return out;
  }, [result]);
  // Big views draw only the rows in sight (plan W1.12: 10,000 rows); spacer rows keep the scrollbar true.
  const virtual = items.length > VIRTUAL_FROM;
  const scroller = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const viewport = 480;
  const win = virtual ? visibleWindow(items.length, ROW_H, scrollTop, viewport) : { start: 0, end: items.length };
  const cell = { padding: "4px 6px", borderBlockEnd: "1px solid hsl(var(--border))", blockSize: virtual ? ROW_H - 9 : undefined, whiteSpace: virtual ? ("nowrap" as const) : undefined, overflow: "hidden", textOverflow: "ellipsis" };
  return (
    <div ref={scroller} style={{ overflow: "auto", maxBlockSize: virtual ? viewport : undefined }} onScroll={virtual ? (e) => setScrollTop(e.currentTarget.scrollTop) : undefined} data-testid="base-table-scroll" data-virtual={virtual || undefined}>
      <table style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: 12 }} aria-rowcount={virtual ? items.length + 1 : undefined}>
        <thead style={virtual ? { position: "sticky", insetBlockStart: 0, background: "hsl(var(--bg))", zIndex: 1 } : undefined}>
          <tr>
            {cols.map((c) => {
              const s = sort[0]?.property === c.id ? sort[0].direction : null;
              return (
                <th key={c.id} scope="col" aria-sort={s === "ASC" ? "ascending" : s === "DESC" ? "descending" : "none"} style={{ textAlign: "start", padding: "4px 6px", borderBlockEnd: "1px solid hsl(var(--border))" }}>
                  <button type="button" onClick={() => onSort(c.id)} style={{ all: "unset", cursor: "pointer", fontWeight: 600 }} dir="auto">
                    {c.label}
                    {s === "ASC" ? " ▲" : s === "DESC" ? " ▼" : ""}
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {virtual && win.start > 0 && <tr aria-hidden style={{ blockSize: win.start * ROW_H }} />}
          {items.slice(win.start, win.end).map((it, i) =>
            it.kind === "group" ? (
              <tr key={`g${win.start + i}`} aria-rowindex={virtual ? win.start + i + 2 : undefined}>
                <th colSpan={cols.length} scope="colgroup" style={{ textAlign: "start", fontSize: 11, color: muted, padding: "8px 4px 4px", blockSize: virtual ? ROW_H - 12 : undefined }} dir="auto">
                  {groupLabel(it.key)} <span style={{ fontWeight: 400, opacity: 0.7 }}>{it.count}</span>
                </th>
              </tr>
            ) : (
              <tr key={it.row.file.path} data-path={it.row.file.path} aria-rowindex={virtual ? win.start + i + 2 : undefined}>
                {cols.map((c) => (
                  <td key={c.id} style={cell}>
                    {nameCell(it.row, c.id, files)}
                  </td>
                ))}
              </tr>
            ),
          )}
          {virtual && win.end < items.length && <tr aria-hidden style={{ blockSize: (items.length - win.end) * ROW_H }} />}
        </tbody>
        {summaryIds.length > 0 && (
          <tfoot>
            <tr>
              {cols.map((c) => (
                <td key={c.id} style={{ padding: "4px 6px", fontWeight: 600 }} data-testid={summaryIds.includes(c.id) ? `base-summary-${c.id}` : undefined}>
                  {summaryIds.includes(c.id) ? toText(result.summaries[c.id]) : null}
                </td>
              ))}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function CardsView({ result, files }: ViewProps) {
  const image = result.view.image;
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))", gap: 8 }}>
      {result.rows.map((r) => {
        const img = image ? r.cells[image] : null;
        const src = typeof img === "string" ? img : isTagged(img) && img.$ === "image" ? img.src : null;
        return (
          <div key={r.file.path} data-path={r.file.path} style={{ border: "1px solid hsl(var(--border))", borderRadius: 6, padding: 8, fontSize: 12 }}>
            {src && /^https:\/\//i.test(src) && <img src={src} alt="" loading="lazy" style={{ inlineSize: "100%", maxBlockSize: 120, objectFit: "cover" }} />}
            {result.columns.map((c) => (
              <div key={c.id}>{nameCell(r, c.id, files)}</div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function ListView({ result, files }: ViewProps) {
  const [first, ...rest] = result.columns;
  return (
    <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }}>
      {result.rows.map((r) => (
        <li key={r.file.path} data-path={r.file.path}>
          {nameCell(r, first.id, files)}
          {rest.map((c) => (
            <span key={c.id} style={{ color: muted }}>
              {" · "}
              <Cell value={r.cells[c.id]} files={files} />
            </span>
          ))}
        </li>
      ))}
    </ul>
  );
}

function KanbanView({ result, files }: ViewProps) {
  if (!result.groups) return <div style={{ padding: 12, fontSize: 12, color: muted }}>{t("db.kanban.needGroup")}</div>;
  return (
    <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
      {result.groups.map((g, i) => (
        <section key={i} aria-label={groupLabel(g.key)} style={{ minInlineSize: 180, flex: "1 0 180px", background: "hsl(var(--bg-subtle))", borderRadius: 6, padding: 6 }}>
          <h4 style={{ margin: "0 0 6px", fontSize: 12 }} dir="auto">
            {groupLabel(g.key)} <span style={{ fontWeight: 400, color: muted }}>{g.rows.length}</span>
          </h4>
          {g.rows.map((r) => (
            <div key={r.file.path} data-path={r.file.path} style={{ background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", borderRadius: 4, padding: 6, marginBlockEnd: 6, fontSize: 12 }}>
              {result.columns.map((c) => (
                <div key={c.id}>{nameCell(r, c.id, files)}</div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

/** The database map view, fed with this view's rows (coordinates from `coordinates:`, else `location`). */
function MapView({ result }: { result: BaseResult }) {
  const rows: DatabaseRow[] = useMemo(
    () =>
      result.rows.map((r) => {
        const pt = basesLatLng(r.cells[result.view.coordinates ?? "note.location"] ?? null) ?? basesLatLng(r.file.fm.location as BValue);
        const fm: Record<string, unknown> = { title: r.file.basename };
        for (const c of result.columns) if (c.id !== "file.name") fm[c.label] = toText(r.cells[c.id]);
        if (pt) fm.location = [pt.lat, pt.lng];
        return { path: r.file.path, basename: r.file.basename, fm };
      }),
    [result],
  );
  const fields = result.columns.filter((c) => c.id !== "file.name").map((c) => c.label);
  return <DatabaseMapView rows={rows} spec={{ location: "location" }} fields={fields} />;
}

/* ─── CSV (W1.12) ────────────────────────────────────────────────────── */

function downloadCsv(result: BaseResult, name: string) {
  const blob = new Blob(["\uFEFF", resultToCsv(result)], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${name.replace(/^.*\//, "").replace(/\.base$/i, "") || "base"}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** Pick a CSV and add one note per row to a folder named after the base, with the properties its filter pins. */
async function importCsv(base: BaseModel, name: string, files: readonly BasesFile[]) {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,text/csv";
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
  if (!file) return;
  const folder = name.replace(/^.*\//, "").replace(/\.base$/i, "") || "Imported";
  try {
    const notes = csvToNotes(await file.text(), folder, { extra: pinnedProperties(base.filters), taken: new Set(files.map((f) => f.path)) });
    for (const n of notes) await writeWorkspaceFile(n.path, n.content);
    const { notifyWorkspaceChanged } = await import("../../storage/workspaceEvents");
    notifyWorkspaceChanged({ kind: "structure", paths: notes.map((n) => n.path) });
    showAiToast(t("base.csv.imported", { count: notes.length, folder }));
  } catch (e) {
    showAiToast(t("base.csv.failed", { error: explainError(e) }), "error");
  }
}

/* ─── Calendar and timeline (W1.12) ──────────────────────────────────── */

/** Move a row's date to `day`: only that property changes in the file. */
async function moveRow(row: BaseRow, dateId: string, day: string, endId?: string) {
  const key = writableKey(dateId);
  if (!key) return showAiToast(t("base.move.readOnly", { property: dateId }), "error");
  const oldStart = row.file.fm[key];
  try {
    await editNote(row.file.path, (text) => {
      let next = moveDateInText(text, key, oldStart, day);
      // A timeline item keeps its length: the end moves by as many days.
      const endKey = endId ? writableKey(endId) : null;
      const from = typeof oldStart === "string" ? oldStart.slice(0, 10) : oldStart instanceof Date ? oldStart.toISOString().slice(0, 10) : null;
      const oldEnd = endKey ? row.file.fm[endKey] : undefined;
      const endDay = typeof oldEnd === "string" ? oldEnd.slice(0, 10) : oldEnd instanceof Date ? oldEnd.toISOString().slice(0, 10) : null;
      if (endKey && from && endDay && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(endDay)) next = moveDateInText(next, endKey, oldEnd, addDays(endDay, daysBetween(from, day)));
      return next;
    });
    showAiToast(t("base.moved", { name: row.file.basename, date: day }));
  } catch (e) {
    showAiToast(t("base.moveFailed", { error: explainError(e) }), "error");
  }
}

/** Alt + arrow keys move an item a day (left / right, as the text runs) or a week (up / down). */
function keyShift(e: ReactKeyboardEvent, rtl: boolean): number {
  if (!e.altKey) return 0;
  if (e.key === "ArrowUp") return -7;
  if (e.key === "ArrowDown") return 7;
  if (e.key === "ArrowLeft") return rtl ? 1 : -1;
  if (e.key === "ArrowRight") return rtl ? -1 : 1;
  return 0;
}

const isRtl = () => typeof document !== "undefined" && document.documentElement.dir === "rtl";

function CalendarView({ result, files }: ViewProps) {
  const locale = (useAppStore((s) => s.locale) as string) || "en";
  const dateId = result.view.date ?? "note.date";
  const byDay = useMemo(() => rowsByDay(result.rows, dateId), [result, dateId]);
  const first = useMemo(() => [...byDay.keys()].sort()[0] ?? new Date().toISOString().slice(0, 10), [byDay]);
  const [month, setMonth] = useState(() => ({ y: Number(first.slice(0, 4)), m: Number(first.slice(5, 7)) }));
  const [over, setOver] = useState<string | null>(null);
  const firstDay = ["he", "en", "ja", "ar"].includes(locale) ? (locale === "ar" ? 6 : 7) : 1;
  const weeks = monthWeeks(month.y, month.m, firstDay);
  const title = new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(Date.UTC(month.y, month.m - 1, 1)));
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });
  const undated = result.rows.length - [...byDay.values()].reduce((n, r) => n + r.length, 0);
  const shift = (n: number) =>
    setMonth(({ y, m }) => {
      const k = y * 12 + m - 1 + n;
      return { y: Math.floor(k / 12), m: (k % 12) + 1 };
    });
  const rtl = isRtl();
  return (
    <div data-testid="base-calendar">
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBlockEnd: 6 }}>
        <button type="button" onClick={() => shift(-1)} aria-label={t("base.calendar.prev")}>
          {rtl ? "›" : "‹"}
        </button>
        <strong data-testid="base-calendar-title">{title}</strong>
        <button type="button" onClick={() => shift(1)} aria-label={t("base.calendar.next")}>
          {rtl ? "‹" : "›"}
        </button>
        {undated > 0 && <span style={{ fontSize: 11, color: muted }}>{t("base.calendar.undated", { count: undated })}</span>}
        <span id="base-move-hint" style={{ fontSize: 11, color: muted, marginInlineStart: "auto" }}>
          {t("base.move.hint")}
        </span>
      </div>
      <div role="grid" aria-label={title} style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 2, fontSize: 11 }}>
        {weeks[0].map((_, i) => (
          <div key={`h${i}`} role="columnheader" style={{ color: muted, textAlign: "center" }}>
            {weekday.format(new Date(Date.UTC(2024, 0, ((firstDay - 1 + i) % 7) + 1)))}
          </div>
        ))}
        {weeks.flat().map((day, i) =>
          day === null ? (
            <div key={`e${i}`} role="gridcell" aria-hidden />
          ) : (
            <div
              key={day}
              role="gridcell"
              data-day={day}
              aria-label={day}
              onDragOver={(e) => {
                e.preventDefault();
                setOver(day);
              }}
              onDragLeave={() => setOver((o) => (o === day ? null : o))}
              onDrop={(e) => {
                e.preventDefault();
                setOver(null);
                const path = e.dataTransfer.getData("text/x-lumen-path");
                const row = result.rows.find((r) => r.file.path === path);
                if (row) void moveRow(row, dateId, day);
              }}
              style={{ minBlockSize: 64, border: "1px solid hsl(var(--border))", borderRadius: 4, padding: 2, background: over === day ? "hsl(var(--accent) / 0.12)" : undefined }}
            >
              <div style={{ color: muted }}>{Number(day.slice(8))}</div>
              {(byDay.get(day) ?? []).map((r) => (
                <div
                  key={r.file.path}
                  data-path={r.file.path}
                  draggable
                  tabIndex={0}
                  aria-describedby="base-move-hint"
                  onDragStart={(e) => {
                    e.dataTransfer.setData("text/x-lumen-path", r.file.path);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onKeyDown={(e) => {
                    const n = keyShift(e, rtl);
                    if (!n) return;
                    e.preventDefault();
                    void moveRow(r, dateId, addDays(day, n));
                  }}
                  style={{ background: "hsl(var(--bg-subtle))", borderRadius: 3, paddingInline: 3, marginBlockStart: 2, cursor: "grab", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                >
                  {nameCell(r, result.columns[0]?.id ?? "file.name", files)}
                </div>
              ))}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

const DAY_PX = 24;

function TimelineView({ result, files }: ViewProps) {
  const startId = result.view.date ?? "note.date";
  const endId = result.view.end;
  const { items, from, to } = useMemo(() => timelineItems(result.rows, startId, endId), [result, startId, endId]);
  const [drag, setDrag] = useState<{ path: string; x: number; days: number } | null>(null);
  const rtl = isRtl();
  if (!from || !to) return <EmptyState style={{ padding: 12 }} message={t("base.timeline.empty", { property: startId })} action={learnHow("workspace/obsidian-bases#calendar-and-timeline-views-lumen")} />;
  const span = daysBetween(from, to) + 1;
  const months: Array<{ day: string; label: string }> = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (d.endsWith("-01") || d === from) months.push({ day: d, label: d.slice(0, 7) });
  return (
    <div data-testid="base-timeline" style={{ overflowX: "auto" }}>
      <div id="base-move-hint-tl" style={{ fontSize: 11, color: muted, marginBlockEnd: 4 }}>
        {t("base.move.hint")}
      </div>
      <div style={{ position: "relative", inlineSize: span * DAY_PX, minInlineSize: "100%", fontSize: 11 }}>
        <div style={{ position: "relative", blockSize: 16, color: muted }}>
          {months.map((m) => (
            <span key={m.day} style={{ position: "absolute", insetInlineStart: daysBetween(from, m.day) * DAY_PX }}>
              {m.label}
            </span>
          ))}
        </div>
        {items.map((it) => {
          const offset = daysBetween(from, it.start) + (drag?.path === it.row.file.path ? drag.days : 0);
          const len = daysBetween(it.start, it.end) + 1;
          return (
            <div key={it.row.file.path} style={{ position: "relative", blockSize: 24 }}>
              <div
                data-path={it.row.file.path}
                role="button"
                tabIndex={0}
                aria-describedby="base-move-hint-tl"
                aria-label={`${it.row.file.basename}: ${it.start}${it.end !== it.start ? ` – ${it.end}` : ""}`}
                onPointerDown={(e) => {
                  (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
                  setDrag({ path: it.row.file.path, x: e.clientX, days: 0 });
                }}
                onPointerMove={(e) => {
                  if (drag?.path !== it.row.file.path) return;
                  const dx = (e.clientX - drag.x) * (rtl ? -1 : 1);
                  setDrag({ ...drag, days: Math.round(dx / DAY_PX) });
                }}
                onPointerUp={() => {
                  if (drag?.path === it.row.file.path && drag.days) void moveRow(it.row, startId, addDays(it.start, drag.days), endId);
                  setDrag(null);
                }}
                onKeyDown={(e) => {
                  const n = keyShift(e, rtl);
                  if (!n) return;
                  e.preventDefault();
                  void moveRow(it.row, startId, addDays(it.start, n), endId);
                }}
                style={{
                  position: "absolute",
                  insetInlineStart: offset * DAY_PX,
                  inlineSize: Math.max(1, len) * DAY_PX - 2,
                  insetBlock: 2,
                  background: "hsl(var(--accent) / 0.25)",
                  border: "1px solid hsl(var(--accent))",
                  borderRadius: 4,
                  paddingInline: 4,
                  overflow: "hidden",
                  whiteSpace: "nowrap",
                  cursor: "grab",
                  touchAction: "none",
                }}
              >
                {nameCell(it.row, result.columns[0]?.id ?? "file.name", files)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

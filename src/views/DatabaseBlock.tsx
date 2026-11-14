/**
 * DatabaseBlock — renders a ```database fenced block (plan 4.10) as a
 * table, cards, a kanban board, a list or a calendar agenda over the
 * frontmatter of the notes it selects — and edits it:
 *
 *  - a table cell writes that one property of that one note (databaseEdit,
 *    through the properties API: the rest of the file stays byte for byte);
 *  - a kanban card dropped on another column writes the grouping property
 *    (dnd-kit, with the keyboard: Space, ← →, Space);
 *  - the toolbar filters (AND / OR expressions, databaseFilter), sorts and
 *    groups, live;
 *  - `formulas:` add computed columns (plan 4.11, ./formula), and the
 *    formula box tries one out — or writes one from a description with the
 *    local `formulator` agent;
 *  - the map view (Leaflet, lazy) shows the notes that have coordinates.
 *
 * Loaded lazily with the preview's code blocks; TanStack Table / Virtual and
 * dnd-kit come with it, never with the startup bundle. Re-runs the query on
 * `lumen-workspace-changed`.
 */

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Table2, Columns3, LayoutGrid, List as ListIcon, Calendar as CalendarIcon, AlertCircle, GripVertical, MapPin, Sparkles } from "lucide-react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type DragEndEvent,
  type KeyboardCoordinateGetter,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import {
  applyFormulas,
  applyQuery,
  compileFormulas,
  displayValue,
  groupRows,
  kanbanColumnValue,
  NO_VALUE,
  loadDatabaseRows,
  parseDatabaseSpec,
  parseSort,
  resolveFields,
  specView,
  type DatabaseRow,
  type DatabaseSpec,
  type CompiledFormula,
  type DatabaseView,
  type SortKey,
} from "./database";
import { formulaText, parseFormula } from "./formula";
import { parseFilter, type FilterNode } from "./databaseFilter";
import { cellInputText, columnType, parseCellInput, writeCell } from "./databaseEdit";
import type { PropertyValue } from "../properties/frontmatter";
import { log } from "../lib/logger";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";

// Leaflet comes with the map view only, when it is first picked.
const DatabaseMapView = lazy(() => import("./DatabaseMapView"));

interface Props {
  source: string;
  meta?: string;
}

const NONE = NO_VALUE;
const MATCH_NOTHING: FilterNode = { kind: "lit", value: false };

const titleOf = (row: DatabaseRow) => (typeof row.fm.title === "string" && row.fm.title) || row.basename;

/** Is this a value a cell can edit (not a map or a nested list)? */
const editableValue = (v: unknown) =>
  v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)));

export default function DatabaseBlock({ source, meta }: Props) {
  const { spec, error: parseError } = useMemo(() => parseDatabaseSpec(source), [source]);
  const [rows, setRows] = useState<DatabaseRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DatabaseView>(spec ? specView(spec) : "table");
  const [where, setWhere] = useState(spec?.where ?? "");
  const [sort, setSort] = useState<SortKey[]>(() => parseSort(spec?.sort ?? spec?.sortBy));
  const [groupBy, setGroupBy] = useState(spec?.groupBy ?? "");
  /** Formula columns tried out in the formula box (this session; the spec's `formulas:` keeps them). */
  const [extraFormulas, setExtraFormulas] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!spec) return;
    setView(specView(spec));
    setWhere(spec.where ?? "");
    setSort(parseSort(spec.sort ?? spec.sortBy));
    setGroupBy(spec.groupBy ?? "");
    setExtraFormulas({});
  }, [spec]);

  // Re-run the query when the spec changes OR the workspace changes.
  useEffect(() => {
    if (!spec) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = () =>
      loadDatabaseRows(spec).then((r) => {
        if (!cancelled) setRows(r);
      });
    load()
      .catch((e: Error) => {
        if (cancelled) return;
        log.warn("database query failed", e);
        setError(e.message);
      })
      .finally(() => !cancelled && setLoading(false));
    const off = onWorkspaceChanged(() => void load().catch(() => undefined), { debounceMs: 500 });
    return () => {
      cancelled = true;
      off();
    };
  }, [spec]);

  const filter = useMemo(() => parseFilter(where), [where]);
  // A filter that doesn't parse never shows more: the last one that did
  // stays in force (none yet — a broken `where:` — shows nothing).
  const lastValid = useRef<FilterNode | null | undefined>(undefined);
  if (filter.ok) lastValid.current = filter.tree;
  const tree = filter.ok ? filter.tree : (lastValid.current ?? MATCH_NOTHING);
  // Only a map merges with the formula box's columns: a scalar or a list under `formulas:` spread
  // into an object would turn into columns named 0, 1, … (review #267); such a value is ignored.
  const formulas = useMemo<CompiledFormula[]>(() => {
    const own: unknown = spec?.formulas;
    const isMap = !!own && typeof own === "object" && !Array.isArray(own);
    return isMap ? compileFormulas({ ...(own as Record<string, unknown>), ...extraFormulas }) : [...compileFormulas(own), ...compileFormulas(extraFormulas)];
  }, [spec, extraFormulas]);
  // Formula columns are computed before the filter, so `where:`, sort and group can use them.
  const computed = useMemo(() => applyFormulas(rows, formulas), [rows, formulas]);
  const shown = useMemo(() => applyQuery(computed.rows, { where: tree, sort }), [computed, tree, sort]);
  const fields = useMemo(() => {
    if (!spec) return [];
    // With `fields:`, those — then every formula column not already listed (the spec's `formulas:`
    // and the ones added in the formula box), so a formula never needs listing twice.
    if (spec.fields?.length) {
      const listed = spec.fields;
      return [...listed, ...formulas.map((f) => f.name).filter((f) => !listed.includes(f))];
    }
    // Without `fields:`: the notes' properties, then every formula column.
    const own = resolveFields(rows, spec).filter((f) => !formulas.some((x) => x.name === f));
    return [...own, ...formulas.map((f) => f.name)];
  }, [rows, spec, formulas]);
  const allKeys = useMemo(() => {
    const keys = new Set(fields);
    for (const r of computed.rows) for (const k of Object.keys(r.fm)) keys.add(k);
    return [...keys];
  }, [computed, fields]);
  const formulaNames = useMemo(() => new Set(formulas.map((f) => f.name)), [formulas]);
  /** What a new formula can read: the notes' properties and the formula columns already defined (review #267). */
  const propertyKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const r of rows) for (const k of Object.keys(r.fm)) keys.add(k);
    for (const f of formulas) keys.add(f.name);
    return [...keys];
  }, [rows, formulas]);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  /** Write one cell: shown at once, written behind; a failure puts the old value back. */
  const edit = useCallback(async (row: DatabaseRow, key: string, value: PropertyValue | undefined) => {
    // `row` carries the formula columns too: only the loaded property changes.
    const loaded = rowsRef.current.find((r) => r.path === row.path)?.fm ?? {};
    const had = Object.prototype.hasOwnProperty.call(loaded, key);
    const old = loaded[key];
    const put = (fm: Record<string, unknown>, v: unknown, present: boolean) => {
      const next = { ...fm };
      if (!present) delete next[key];
      else next[key] = v;
      return next;
    };
    setRows((rs) => rs.map((r) => (r.path === row.path ? { ...r, fm: put(r.fm, value, value !== undefined) } : r)));
    try {
      await writeCell(row.path, key, value);
    } catch (e) {
      setRows((rs) => rs.map((r) => (r.path === row.path ? { ...r, fm: put(r.fm, old, had) } : r)));
      showAiToast(t("db.saveFailed", { note: titleOf(row), error: (e as Error)?.message ?? String(e) }), "error");
    }
  }, []);

  if (parseError || !spec) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(0 80% 60%)", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
          <AlertCircle size={14} />
          {t("db.specError", { error: parseError ?? "invalid" })}
        </div>
      </div>
    );
  }

  const titleLabel = spec.title ?? `${spec.type ?? t("db.all")} · ${t("db.count", { count: shown.length })}`;
  const props: ViewProps = { rows: shown, allRows: computed.rows, spec, fields, groupBy, edit, formulaNames, formulaErrors: computed.errors };
  const badFormulas = formulas.filter((f) => f.error);

  return (
    <div className="chart-block lumen-database" data-testid="database-block">
      <div className="chart-block-header">
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontWeight: 600 }}>{titleLabel}</span>
          {loading && <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>· {t("db.loading")}</span>}
        </span>
        <div className="chart-block-tabs" role="tablist" aria-label={t("db.views")}>
          <ViewTab cur={view} v="table" set={setView}><Table2 size={12} /> {t("db.view.table")}</ViewTab>
          <ViewTab cur={view} v="cards" set={setView}><LayoutGrid size={12} /> {t("db.view.cards")}</ViewTab>
          <ViewTab cur={view} v="kanban" set={setView}><Columns3 size={12} /> {t("db.view.kanban")}</ViewTab>
          <ViewTab cur={view} v="list" set={setView}><ListIcon size={12} /> {t("db.view.list")}</ViewTab>
          <ViewTab cur={view} v="calendar" set={setView}><CalendarIcon size={12} /> {t("db.view.calendar")}</ViewTab>
          <ViewTab cur={view} v="map" set={setView}><MapPin size={12} /> {t("db.view.map")}</ViewTab>
        </div>
      </div>
      <Toolbar where={where} setWhere={setWhere} filterError={filter.ok ? null : filter} sort={sort} setSort={setSort} groupBy={groupBy} setGroupBy={setGroupBy} keys={allKeys} />
      <FormulaBox keys={propertyKeys} sample={computed.rows[0]} taken={formulaNames} onAdd={(name, formula) => setExtraFormulas((x) => ({ ...x, [name]: formula }))} />
      {badFormulas.length > 0 && (
        <div role="alert" style={{ paddingInline: 8, paddingBlockStart: 4, color: "hsl(0 80% 60%)", fontSize: 11 }} data-testid="database-formula-spec-error">
          {badFormulas.map((f) => (
            <div key={f.name} dir="auto">{t("db.formula.specError", { name: f.name, error: f.error?.message ?? "", at: (f.error?.at ?? 0) + 1 })}</div>
          ))}
        </div>
      )}
      <div style={{ padding: 8 }}>
        {error && <div style={{ padding: 12, color: "hsl(0 80% 60%)" }}>{error}</div>}
        {!error && shown.length === 0 && !loading && (
          <div style={{ padding: 24, textAlign: "center", color: "hsl(var(--fg-muted))", fontSize: 13 }}>
            {t("db.empty")}
            <br />
            <span style={{ fontSize: 11, opacity: 0.7 }}>{t("db.emptyHint", { type: spec.type ?? "…", source: spec.source ?? t("db.workspaceRoot") })}</span>
          </div>
        )}
        {!error && shown.length > 0 && view === "table" && <TableView {...props} />}
        {!error && shown.length > 0 && view === "cards" && <CardsView {...props} />}
        {!error && view === "kanban" && (shown.length > 0 || spec.columns?.length) ? <KanbanView {...props} /> : null}
        {!error && shown.length > 0 && view === "list" && <ListView {...props} />}
        {!error && shown.length > 0 && view === "calendar" && <CalendarView rows={shown} spec={spec} />}
        {!error && shown.length > 0 && view === "map" && (
          <Suspense fallback={<div style={{ padding: 12, fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("db.loading")}</div>}>
            <DatabaseMapView rows={shown} spec={spec} fields={fields} />
          </Suspense>
        )}
      </div>
      {meta && <div style={{ padding: "0 8px 6px", fontSize: 10, color: "hsl(var(--fg-muted))" }}>{meta}</div>}
    </div>
  );
}

interface ViewProps {
  rows: DatabaseRow[];
  /** Every loaded row, before the filter: column types come from all of them. */
  allRows: DatabaseRow[];
  spec: DatabaseSpec;
  fields: string[];
  groupBy: string;
  edit: (row: DatabaseRow, key: string, value: PropertyValue | undefined) => Promise<void>;
  /** Columns computed by a formula: read-only. */
  formulaNames: ReadonlySet<string>;
  /** path → formula → error message. */
  formulaErrors: ReadonlyMap<string, ReadonlyMap<string, string>>;
}

/* ─── Toolbar: filter, sort, group ───────────────────────────────────── */

function Toolbar({
  where,
  setWhere,
  filterError,
  sort,
  setSort,
  groupBy,
  setGroupBy,
  keys,
}: {
  where: string;
  setWhere: (s: string) => void;
  filterError: { error: string; at: number } | null;
  sort: SortKey[];
  setSort: (s: SortKey[]) => void;
  groupBy: string;
  setGroupBy: (s: string) => void;
  keys: string[];
}) {
  const [draft, setDraft] = useState(where);
  useEffect(() => setDraft(where), [where]);
  // Typing filters as you go, a beat after the last key.
  useEffect(() => {
    if (draft === where) return;
    const id = setTimeout(() => setWhere(draft), 200);
    return () => clearTimeout(id);
  }, [draft, where, setWhere]);
  const first = sort[0];
  const field: CSSProperties = { fontSize: 12, padding: "3px 6px", border: "1px solid hsl(var(--border))", borderRadius: 4, background: "hsl(var(--bg))", color: "hsl(var(--fg))" };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingInline: 8, paddingBlockStart: 8, fontSize: 12 }}>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "1 1 16em", minInlineSize: 0 }}>
        <span>{t("db.filter.label")}</span>
        <input
          type="text"
          dir="auto"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && setWhere(draft)}
          placeholder={t("db.filter.placeholder")}
          aria-invalid={filterError ? true : undefined}
          aria-describedby={filterError ? "db-filter-error" : undefined}
          data-testid="database-filter"
          style={{ ...field, flex: 1, minInlineSize: 0, fontFamily: "var(--font-mono, monospace)" }}
        />
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span>{t("db.sort.label")}</span>
        <select value={first?.key ?? ""} onChange={(e) => setSort(e.target.value ? [{ key: e.target.value, desc: first?.desc ?? false }] : [])} style={field} data-testid="database-sort">
          <option value="">{t("db.sort.none")}</option>
          {keys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
        {first && (
          <button type="button" style={field} onClick={() => setSort([{ ...first, desc: !first.desc }, ...sort.slice(1)])} aria-label={first.desc ? t("db.sort.desc") : t("db.sort.asc")} title={first.desc ? t("db.sort.desc") : t("db.sort.asc")}>
            {first.desc ? "↓" : "↑"}
          </button>
        )}
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span>{t("db.group.label")}</span>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={field} data-testid="database-group">
          <option value="">{t("db.group.none")}</option>
          {keys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>
      {filterError && (
        <div id="db-filter-error" role="alert" style={{ flexBasis: "100%", color: "hsl(0 80% 60%)", fontSize: 11 }}>
          {t("db.filter.error", { error: filterError.error, at: filterError.at + 1 })}
        </div>
      )}
    </div>
  );
}

/* ─── View toggle button ─────────────────────────────────────────────── */

function ViewTab({ cur, v, set, children }: { cur: DatabaseView; v: DatabaseView; set: (v: DatabaseView) => void; children: ReactNode }) {
  return (
    <button type="button" role="tab" aria-selected={cur === v} className={`chart-block-tab ${cur === v ? "active" : ""}`} onClick={() => set(v)} data-testid={`database-view-${v}`}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>{children}</span>
    </button>
  );
}

function RowLink({ row }: { row: DatabaseRow }) {
  return (
    <a
      href={`#${encodeURIComponent(row.path)}`}
      dir="auto"
      onClick={(e) => {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: row.path } }));
      }}
      style={{ color: "hsl(var(--accent))", textDecoration: "none", fontWeight: 500 }}
    >
      {titleOf(row)}
    </a>
  );
}

/** Rows in groups (by `groupBy`), in the order the rows come; no grouping: one unnamed group. */
function sections(rows: DatabaseRow[], groupBy: string): Array<{ key: string | null; rows: DatabaseRow[] }> {
  if (!groupBy) return [{ key: null, rows }];
  const groups = groupRows(rows, groupBy);
  return [...groups.keys()].sort(columnOrder).map((key) => ({ key, rows: groups.get(key)! }));
}

const columnOrder = (a: string, b: string) => (a === NONE ? 1 : b === NONE ? -1 : a.localeCompare(b));
const groupLabel = (key: string) => (key === NONE ? t("db.none") : key);

function SectionHeading({ label, count }: { label: string; count: number }) {
  return (
    <div style={{ fontSize: 11, fontWeight: 700, color: "hsl(var(--fg-muted))", textTransform: "uppercase", letterSpacing: "0.05em", margin: "8px 4px 4px" }} dir="auto">
      {label}
      <span style={{ marginInlineStart: 6, fontWeight: 400, opacity: 0.7 }}>{count}</span>
    </div>
  );
}

/* ─── Editable cell ──────────────────────────────────────────────────── */

function EditableCell({ row, field, type, edit }: { row: DatabaseRow; field: string; type: ReturnType<typeof columnType>; edit: ViewProps["edit"] }) {
  const value = row.fm[field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = t("db.cell.edit", { field, note: titleOf(row) });
  if (!editableValue(value)) {
    return (
      <span title={t("db.readOnly")} style={{ opacity: 0.7 }}>
        {displayValue(value)}
      </span>
    );
  }
  if (type === "checkbox") {
    return <input type="checkbox" checked={value === true} aria-label={label} onChange={(e) => void edit(row, field, e.target.checked)} />;
  }
  if (editing) {
    const commit = () => {
      setEditing(false);
      if (draft === cellInputText(value)) return;
      const next = parseCellInput(draft, type);
      // Clearing a property that wasn't there changes nothing.
      if (next === null && (value === undefined || value === null)) return;
      void edit(row, field, next);
    };
    return (
      <input
        autoFocus
        dir="auto"
        aria-label={label}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          else if (e.key === "Escape") setEditing(false);
        }}
        data-testid="database-cell-input"
        style={{ inlineSize: "100%", fontSize: 12, padding: "2px 4px", border: "1px solid hsl(var(--accent))", borderRadius: 3, background: "hsl(var(--bg))", color: "hsl(var(--fg))" }}
      />
    );
  }
  const start = () => {
    setDraft(cellInputText(value));
    setEditing(true);
  };
  return (
    <button
      type="button"
      dir="auto"
      aria-label={label}
      onClick={start}
      onKeyDown={(e) => e.key === "F2" && start()}
      data-testid="database-cell"
      data-field={field}
      data-note={row.path}
      style={{ all: "unset", display: "block", minBlockSize: "1.2em", inlineSize: "100%", cursor: "text", textAlign: "start", whiteSpace: "pre-wrap" }}
    >
      {displayValue(value)}
    </button>
  );
}

/* ─── Formula cell and formula box (plan 4.11) ───────────────────────── */

function FormulaCell({ value, error }: { value: unknown; error?: string }) {
  if (error) {
    return (
      <span title={error} style={{ color: "hsl(0 80% 60%)" }} data-testid="database-formula-error" dir="auto">
        <AlertCircle size={11} aria-hidden style={{ display: "inline", verticalAlign: "-1px", marginInlineEnd: 3 }} />
        {t("db.formula.cellError")}
        <span className="sr-only">{`: ${error}`}</span>
      </span>
    );
  }
  return (
    <span title={t("db.formula.computed")} dir="auto" data-testid="database-formula-cell" style={{ fontVariantNumeric: "tabular-nums" }}>
      {/* The formula formatter keeps a time that is not midnight (now(), dateadd(…, "hours")). */}
      {value instanceof Date || Array.isArray(value) ? formulaText(value as Parameters<typeof formulaText>[0]) : displayValue(value)}
    </span>
  );
}

/**
 * Try a formula column on this database, or describe one and let the local
 * `formulator` agent write it (its answer is checked by the same parser).
 */
function FormulaBox({ keys, sample, taken, onAdd }: { keys: string[]; sample?: DatabaseRow; taken: ReadonlySet<string>; onAdd: (name: string, formula: string) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);
  const parsed = useMemo(() => (draft.trim() ? parseFormula(draft) : null), [draft]);
  const cleanName = name.trim();
  const field: CSSProperties = { fontSize: 12, padding: "3px 6px", border: "1px solid hsl(var(--border))", borderRadius: 4, background: "hsl(var(--bg))", color: "hsl(var(--fg))" };

  const write = async () => {
    if (!draft.trim() || busy) return;
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    try {
      const { runAgentOrThrow } = await import("../agents/runtime");
      const { formulatorAgent } = await import("../agents/defs/formulator");
      const fields = keys.map((k) => ({ name: k, example: sample && sample.fm[k] !== undefined ? displayValue(sample.fm[k]).slice(0, 40) : undefined }));
      const formula = await runAgentOrThrow(formulatorAgent, { text: draft, extra: { fields } }, { signal: ctl.signal, ownPrompt: true });
      if (!ctl.signal.aborted) setDraft(formula);
    } catch (e) {
      if (!ctl.signal.aborted) {
        log.warn("formula agent failed", e);
        showAiToast(t("db.formula.aiFailed"), "error");
      }
    } finally {
      if (abort.current === ctl) setBusy(false);
    }
  };

  if (!open) {
    return (
      <div style={{ paddingInline: 8, paddingBlockStart: 6, fontSize: 12 }}>
        <button type="button" style={{ ...field, cursor: "pointer" }} onClick={() => setOpen(true)} data-testid="database-formula-open">
          ƒ {t("db.formula.open")}
        </button>
        {added && <span style={{ marginInlineStart: 8, color: "hsl(var(--fg-muted))", fontSize: 11 }} dir="auto">{t("db.formula.keepHint", { line: added })}</span>}
      </div>
    );
  }
  const error = parsed && !parsed.ok ? parsed.error : null;
  const canAdd = !!cleanName && !!parsed?.ok && !taken.has(cleanName);
  const submit = () => {
    if (!canAdd) return;
    onAdd(cleanName, draft.trim());
    // Both sides as quoted YAML scalars: a formula with `: ` or ` #` must survive the copy (review #267).
    setAdded(`${JSON.stringify(cleanName)}: ${JSON.stringify(draft.trim())}`);
    setName("");
    setDraft("");
    setOpen(false);
  };
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", paddingInline: 8, paddingBlockStart: 6, fontSize: 12 }} data-testid="database-formula-box">
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
        <span>{t("db.formula.name")}</span>
        <input type="text" dir="auto" value={name} onChange={(e) => setName(e.target.value)} placeholder={t("db.formula.namePlaceholder")} style={{ ...field, inlineSize: "9em" }} data-testid="database-formula-name" />
      </label>
      <label style={{ display: "inline-flex", alignItems: "center", gap: 4, flex: "1 1 16em", minInlineSize: 0 }}>
        <span>{t("db.formula.label")}</span>
        <input
          type="text"
          dir="auto"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder={t("db.formula.placeholder")}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "db-formula-error" : undefined}
          style={{ ...field, flex: 1, minInlineSize: 0, fontFamily: "var(--font-mono, monospace)" }}
          data-testid="database-formula-input"
        />
      </label>
      <button type="button" style={{ ...field, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 4 }} onClick={() => void write()} disabled={busy || !draft.trim()} title={t("db.formula.aiHint")} data-testid="database-formula-ai">
        <Sparkles size={12} aria-hidden /> {busy ? t("db.formula.aiRunning") : t("db.formula.ai")}
      </button>
      <button type="button" style={{ ...field, cursor: canAdd ? "pointer" : "default" }} onClick={submit} disabled={!canAdd} data-testid="database-formula-add">
        {t("db.formula.add")}
      </button>
      <button type="button" style={{ ...field, cursor: "pointer" }} onClick={() => setOpen(false)}>
        {t("db.formula.close")}
      </button>
      {error && (
        <div id="db-formula-error" role="alert" style={{ flexBasis: "100%", color: "hsl(0 80% 60%)", fontSize: 11 }} dir="auto">
          {t("db.formula.error", { error: error.message, at: error.at + 1 })}
        </div>
      )}
      {cleanName && taken.has(cleanName) && (
        <div role="alert" style={{ flexBasis: "100%", color: "hsl(0 80% 60%)", fontSize: 11 }} dir="auto">
          {t("db.formula.nameTaken", { name: cleanName })}
        </div>
      )}
    </div>
  );
}

/* ─── Table view ─────────────────────────────────────────────────────── */

type Item = { kind: "group"; key: string; count: number } | { kind: "row"; row: DatabaseRow };

/** Above this many lines the table renders only what is on screen. */
const VIRTUAL_FROM = 60;

function TableView({ rows, allRows, fields, groupBy, edit, formulaNames, formulaErrors }: ViewProps) {
  const types = useMemo(() => Object.fromEntries(fields.map((f) => [f, columnType(allRows.map((r) => r.fm[f]), f)])), [allRows, fields]);
  const columns = useMemo<ColumnDef<DatabaseRow>[]>(
    () => [
      { id: "__title", header: () => t("db.title"), cell: (c) => <RowLink row={c.row.original} /> },
      ...fields.map(
        (f): ColumnDef<DatabaseRow> => ({
          id: f,
          header: () => f,
          cell: (c) =>
            formulaNames.has(f) ? (
              <FormulaCell value={c.row.original.fm[f]} error={formulaErrors.get(c.row.original.path)?.get(f)} />
            ) : (
              <EditableCell row={c.row.original} field={f} type={types[f]} edit={edit} />
            ),
        }),
      ),
    ],
    [fields, types, edit, formulaNames, formulaErrors],
  );
  const table = useReactTable({ data: rows, columns, getCoreRowModel: getCoreRowModel(), getRowId: (r) => r.path });
  const byPath = new Map(table.getRowModel().rows.map((r) => [r.id, r]));
  const items: Item[] = sections(rows, groupBy).flatMap((s) => [
    ...(s.key === null ? [] : [{ kind: "group" as const, key: s.key, count: s.rows.length }]),
    ...s.rows.map((row) => ({ kind: "row" as const, row })),
  ]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtual = items.length > VIRTUAL_FROM;
  const virtualizer = useVirtualizer({
    count: items.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 31,
    overscan: 12,
    enabled: virtual,
    initialRect: { width: 800, height: 480 },
  });
  const visible = virtual ? virtualizer.getVirtualItems() : items.map((_, index) => ({ index, start: 0, end: 0 }));
  const padTop = virtual && visible.length ? visible[0].start : 0;
  const padBottom = virtual && visible.length ? virtualizer.getTotalSize() - visible[visible.length - 1].end : 0;
  const span = fields.length + 1;

  return (
    <div ref={scrollRef} style={{ overflow: "auto", maxBlockSize: virtual ? 480 : undefined }}>
      <table style={{ inlineSize: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead style={{ position: "sticky", insetBlockStart: 0, background: "hsl(var(--bg))", zIndex: 1 }}>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id}>
              {hg.headers.map((h) => (
                <th key={h.id} style={thStyle} scope="col">
                  {flexRender(h.column.columnDef.header, h.getContext())}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {padTop > 0 && <tr aria-hidden style={{ blockSize: padTop }} />}
          {visible.map(({ index }) => {
            const item = items[index];
            if (item.kind === "group") {
              return (
                <tr key={`g:${item.key}`}>
                  <th colSpan={span} scope="rowgroup" style={{ ...thStyle, background: "hsl(var(--bg-subtle))" }} dir="auto">
                    {groupLabel(item.key)} <span style={{ fontWeight: 400, opacity: 0.7 }}>{item.count}</span>
                  </th>
                </tr>
              );
            }
            const r = byPath.get(item.row.path);
            if (!r) return null;
            return (
              <tr key={r.id} data-note={r.id}>
                {r.getVisibleCells().map((cell) => (
                  <td key={cell.id} style={tdStyle}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            );
          })}
          {padBottom > 0 && <tr aria-hidden style={{ blockSize: padBottom }} />}
        </tbody>
      </table>
    </div>
  );
}

const thStyle: CSSProperties = {
  textAlign: "start",
  padding: "6px 10px",
  borderBlockEnd: "1px solid hsl(var(--border))",
  color: "hsl(var(--fg-muted))",
  fontWeight: 600,
  fontSize: 11,
  textTransform: "uppercase",
  letterSpacing: "0.03em",
};
const tdStyle: CSSProperties = {
  padding: "6px 10px",
  borderBlockEnd: "1px solid hsl(var(--border) / 0.5)",
  verticalAlign: "top",
};

/* ─── Kanban view ────────────────────────────────────────────────────── */

const cardStyle: CSSProperties = {
  background: "hsl(var(--bg))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  padding: "6px 8px",
  marginBlockEnd: 6,
  fontSize: 12,
  display: "flex",
  gap: 6,
  alignItems: "flex-start",
};

function KanbanView({ rows, allRows, spec, fields, groupBy, edit, formulaNames }: ViewProps) {
  const groups = useMemo(() => (groupBy ? groupRows(rows, groupBy) : new Map<string, DatabaseRow[]>()), [rows, groupBy]);
  // The spec's `columns:` come first and stay even when empty, so a card
  // can move into a status no note has yet.
  const columns = useMemo(() => {
    const listed = (spec.columns ?? []).map(String);
    const rest = [...groups.keys()].filter((k) => !listed.includes(k)).sort(columnOrder);
    return [...listed, ...rest];
  }, [groups, spec.columns]);
  const columnsRef = useRef(columns);
  columnsRef.current = columns;
  const rtlRef = useRef(false);
  const boardRef = useRef<HTMLDivElement | null>(null);

  /** ← / → jump to the neighbouring column (in reading order: → is "next" left-to-right, "previous" right-to-left). */
  const homeRef = useRef<(path: string) => string>(() => NONE);
  const targetRef = useRef<string | null>(null);
  const coordinateGetter = useCallback<KeyboardCoordinateGetter>((event, { active, context, currentCoordinates }) => {
    if (event.code !== "ArrowRight" && event.code !== "ArrowLeft") return undefined;
    event.preventDefault();
    const cols = columnsRef.current;
    // The column the last key aimed at: `over` catches up a frame later, so
    // two quick presses would otherwise both start from the same column.
    const from = targetRef.current ?? String(context.over?.id ?? homeRef.current(String(active)));
    const at = Math.max(0, cols.indexOf(from));
    const forward = (event.code === "ArrowRight") !== rtlRef.current;
    const next = cols[at + (forward ? 1 : -1)];
    if (next === undefined) return currentCoordinates;
    const rect = context.droppableRects.get(next);
    if (!rect) return currentCoordinates;
    targetRef.current = next;
    return { x: rect.left + 8, y: rect.top + 32 };
  }, []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter }));

  const byPath = useMemo(() => new Map(rows.map((r) => [r.path, r])), [rows]);
  const columnOf = (path: string) => {
    const v = byPath.get(path)?.fm[groupBy];
    return v === null || v === undefined || v === "" ? NONE : String(v);
  };
  homeRef.current = columnOf;
  /** The value a column stands for, in the type its notes use (`3`, not `"3"`). */
  const valueFor = (col: string) => kanbanColumnValue(col, groups.get(col)?.[0]?.fm[groupBy], columnType(allRows.map((r) => r.fm[groupBy]), groupBy));
  const noteName = (id: unknown) => {
    const r = byPath.get(String(id));
    return r ? titleOf(r) : String(id);
  };
  const announcements: Announcements = {
    onDragStart: ({ active }) => t("db.kanban.picked", { note: noteName(active.id) }),
    onDragOver: ({ active, over }) => (over ? t("db.kanban.over", { note: noteName(active.id), column: groupLabel(String(over.id)) }) : undefined),
    onDragEnd: ({ active, over }) => (over ? t("db.kanban.dropped", { note: noteName(active.id), column: groupLabel(String(over.id)) }) : t("db.kanban.cancelled", { note: noteName(active.id) })),
    onDragCancel: ({ active }) => t("db.kanban.cancelled", { note: noteName(active.id) }),
  };

  if (!groupBy) {
    return <div style={{ padding: 12, color: "hsl(var(--fg-muted))", fontSize: 12 }}>{t("db.kanban.needGroup")}</div>;
  }

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // A keyboard drop goes where the keys aimed, even if `over` lags a frame.
    const to = targetRef.current ?? (over ? String(over.id) : null);
    targetRef.current = null;
    if (to === null) return;
    const path = String(active.id);
    const row = byPath.get(path);
    if (!row || columnOf(path) === to) return;
    // A formula column is computed: there is no property to write.
    if (formulaNames.has(groupBy)) {
      showAiToast(t("db.formula.readOnly", { name: groupBy }), "info");
      return;
    }
    void edit(row, groupBy, valueFor(to));
  };

  return (
    <DndContext
      sensors={sensors}
      onDragStart={() => {
        targetRef.current = null;
        rtlRef.current = !!boardRef.current && getComputedStyle(boardRef.current).direction === "rtl";
      }}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t("db.kanban.instructions") } }}
    >
      <div ref={boardRef} data-testid="database-kanban" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 10 }}>
        {columns.map((col) => (
          <KanbanColumn key={col} id={col} count={groups.get(col)?.length ?? 0}>
            {(groups.get(col) ?? []).map((r) => (
              <KanbanCard key={r.path} row={r} fields={fields.filter((f) => f !== "title" && f !== groupBy).slice(0, 3)} />
            ))}
          </KanbanColumn>
        ))}
      </div>
    </DndContext>
  );
}

function KanbanColumn({ id, count, children }: { id: string; count: number; children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <section
      ref={setNodeRef}
      aria-label={groupLabel(id)}
      data-column={id}
      style={{
        background: isOver ? "hsl(var(--accent) / 0.12)" : "hsl(var(--bg-subtle))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 8,
        padding: 8,
        minBlockSize: 80,
      }}
    >
      <SectionHeading label={groupLabel(id)} count={count} />
      {children}
    </section>
  );
}

function KanbanCard({ row, fields }: { row: DatabaseRow; fields: string[] }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: row.path });
  return (
    <div ref={setNodeRef} data-note={row.path} style={{ ...cardStyle, transform: CSS.Translate.toString(transform), opacity: isDragging ? 0.85 : 1, position: "relative", zIndex: isDragging ? 2 : undefined }}>
      <button
        type="button"
        {...listeners}
        {...attributes}
        aria-label={t("db.kanban.move", { note: titleOf(row) })}
        data-testid="database-card-handle"
        style={{ all: "unset", cursor: "grab", color: "hsl(var(--fg-muted))", lineHeight: 0, paddingBlockStart: 2 }}
      >
        <GripVertical size={14} aria-hidden />
      </button>
      <div style={{ minInlineSize: 0 }}>
        <RowLink row={row} />
        {fields.map((f) => (
          <div key={f} style={{ fontSize: 11, color: "hsl(var(--fg-muted))", marginBlockStart: 2 }} dir="auto">
            <span style={{ opacity: 0.7 }}>{f}:</span> {displayValue(row.fm[f])}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Cards view ─────────────────────────────────────────────────────── */

function CardsView({ rows, spec, fields, groupBy }: ViewProps) {
  const coverField = spec.cover ?? "cover";
  return (
    <>
      {sections(rows, groupBy).map((s) => (
        <div key={s.key ?? ""}>
          {s.key !== null && <SectionHeading label={groupLabel(s.key)} count={s.rows.length} />}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
            {s.rows.map((r) => {
              const cover = r.fm[coverField];
              return (
                <div key={r.path} data-note={r.path} style={{ background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", borderRadius: 8, overflow: "hidden" }}>
                  {typeof cover === "string" && cover.startsWith("http") && (
                    <div style={{ aspectRatio: "16/9", background: `center / cover no-repeat url(${JSON.stringify(cover)})`, borderBlockEnd: "1px solid hsl(var(--border))" }} />
                  )}
                  <div style={{ padding: 8 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, marginBlockEnd: 4 }}>
                      <RowLink row={r} />
                    </div>
                    {fields
                      .filter((f) => f !== "title" && f !== coverField)
                      .slice(0, 4)
                      .map((f) => (
                        <div key={f} style={{ fontSize: 11, color: "hsl(var(--fg-muted))", marginBlockStart: 2 }} dir="auto">
                          <span style={{ opacity: 0.7 }}>{f}:</span> {displayValue(r.fm[f])}
                        </div>
                      ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </>
  );
}

/* ─── List view ──────────────────────────────────────────────────────── */

function ListView({ rows, fields, groupBy }: ViewProps) {
  return (
    <>
      {sections(rows, groupBy).map((s) => (
        <div key={s.key ?? ""}>
          {s.key !== null && <SectionHeading label={groupLabel(s.key)} count={s.rows.length} />}
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }}>
            {s.rows.map((r) => (
              <li key={r.path} data-note={r.path} style={{ marginBlock: 3 }}>
                <RowLink row={r} />
                {fields
                  .filter((f) => f !== "title" && f !== groupBy && r.fm[f] !== undefined && r.fm[f] !== null && r.fm[f] !== "")
                  .slice(0, 3)
                  .map((f) => (
                    <span key={f} style={{ color: "hsl(var(--fg-muted))", marginInlineStart: 8, fontSize: 11 }} dir="auto">
                      {f}: {displayValue(r.fm[f])}
                    </span>
                  ))}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </>
  );
}

/* ─── Calendar view (an agenda) ──────────────────────────────────────── */

function CalendarView({ rows, spec }: { rows: DatabaseRow[]; spec: DatabaseSpec }) {
  const dateField = spec.dateField;
  if (!dateField) {
    return <div style={{ padding: 12, color: "hsl(var(--fg-muted))", fontSize: 12 }}>{t("db.calendar.needDate")}</div>;
  }
  const buckets = new Map<string, DatabaseRow[]>();
  for (const r of rows) {
    const date = parseDate(r.fm[dateField]);
    if (!date) continue;
    const key = date.toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(r);
  }
  if (buckets.size === 0) {
    return <div style={{ padding: 12, color: "hsl(var(--fg-muted))", fontSize: 12 }}>{t("db.calendar.noDates", { field: dateField })}</div>;
  }
  const sorted = [...buckets.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {sorted.map(([date, items]) => (
        <div key={date} style={{ display: "grid", gridTemplateColumns: "100px 1fr", gap: 12, padding: 8, borderRadius: 6, background: "hsl(var(--bg-subtle))" }}>
          <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))", fontWeight: 600 }}>{date}</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {items.map((r) => (
              <div key={r.path}>
                <RowLink row={r} />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function parseDate(v: unknown): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "number") return new Date(v);
  if (typeof v === "string") {
    const d = new Date(v);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

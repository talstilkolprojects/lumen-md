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
import { Table2, Columns3, LayoutGrid, List as ListIcon, Calendar as CalendarIcon, AlertCircle, MapPin, Sparkles } from "lucide-react";
import { applyFormulas, applyQuery, compileFormulas, displayValue, loadDatabaseRows, parseDatabaseSpec, parseSort, resolveFields, specView, type DatabaseRow, type CompiledFormula, type DatabaseView, type SortKey } from "./database";
import { parseFormula } from "./formula";
import { parseFilter, type FilterNode } from "./databaseFilter";
import { writeCell } from "./databaseEdit";
import type { PropertyValue } from "../properties/frontmatter";
import { log } from "../lib/logger";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";
import "./databaseBlockStrings";
import "../daily/israeliTimeStrings";
import { explainError } from "../lib/userError";
import { EmptyState, learnHow } from "../ui/EmptyState";
import { TableView, KanbanView, CardsView, ListView, CalendarView, titleOf } from "./databaseViews";
import type { ViewProps } from "./databaseViews";

// Leaflet comes with the map view only, when it is first picked.
const DatabaseMapView = lazy(() => import("./DatabaseMapView"));

interface Props {
  source: string;
  meta?: string;
}
const MATCH_NOTHING: FilterNode = { kind: "lit", value: false };

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
        // raw-error-allow: names the part of the block's own query that is wrong
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
      showAiToast(t("db.saveFailed", { note: titleOf(row), error: explainError(e) }), "error");
    }
  }, []);

  if (parseError || !spec) {
    return (
      <div className="chart-block" style={{ padding: "1rem" }}>
        <div style={{ color: "hsl(var(--danger))", fontSize: 13, display: "flex", alignItems: "center", gap: 8 }}>
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
        <div role="alert" style={{ paddingInline: 8, paddingBlockStart: 4, color: "hsl(var(--danger))", fontSize: 11 }} data-testid="database-formula-spec-error">
          {badFormulas.map((f) => (
            <div key={f.name} dir="auto">{t("db.formula.specError", { name: f.name, error: f.error?.message ?? "", at: (f.error?.at ?? 0) + 1 })}</div>
          ))}
        </div>
      )}
      <div style={{ padding: 8 }}>
        {error && <div style={{ padding: 12, color: "hsl(var(--danger))" }}>{error}</div>}
        {!error && shown.length === 0 && !loading && (
          <EmptyState
            style={{ padding: 24, alignItems: "center", textAlign: "center", fontSize: 13 }}
            message={
              <>
                {t("db.empty")}
                <br />
                <span style={{ fontSize: 11, opacity: 0.7 }}>{t("db.emptyHint", { type: spec.type ?? "…", source: spec.source ?? t("db.workspaceRoot") })}</span>
              </>
            }
            action={learnHow("workspace/database-views#tag-your-notes")}
          />
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
          {/* empty-allow: a "sort: none" option */}
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
          {/* empty-allow: a "group: none" option */}
          <option value="">{t("db.group.none")}</option>
          {keys.map((k) => (
            <option key={k} value={k}>{k}</option>
          ))}
        </select>
      </label>
      {filterError && (
        <div id="db-filter-error" role="alert" style={{ flexBasis: "100%", color: "hsl(var(--danger))", fontSize: 11 }}>
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
        <div id="db-formula-error" role="alert" style={{ flexBasis: "100%", color: "hsl(var(--danger))", fontSize: 11 }} dir="auto">
          {t("db.formula.error", { error: error.message, at: error.at + 1 })}
        </div>
      )}
      {cleanName && taken.has(cleanName) && (
        <div role="alert" style={{ flexBasis: "100%", color: "hsl(var(--danger))", fontSize: 11 }} dir="auto">
          {t("db.formula.nameTaken", { name: cleanName })}
        </div>
      )}
    </div>
  );
}

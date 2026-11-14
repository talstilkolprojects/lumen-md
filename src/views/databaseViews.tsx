/**
 * The views of a database block (split out of DatabaseBlock.tsx, plan W4.11):
 * table, kanban, cards, list and calendar, with their cells. Loaded only with
 * DatabaseBlock, which registers their strings.
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AlertCircle, GripVertical } from "lucide-react";
import { flexRender, getCoreRowModel, useReactTable, type ColumnDef } from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import { DndContext, KeyboardSensor, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type Announcements, type DragEndEvent, type KeyboardCoordinateGetter } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { displayValue, groupKey, groupRows, kanbanColumnValue, NO_VALUE, type DatabaseRow, type DatabaseSpec } from "./database";
import { formulaText } from "./formula";
import { cellInputText, columnType, parseCellInput } from "./databaseEdit";
import type { PropertyValue } from "../properties/frontmatter";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";
import { useAppStore } from "../store/useStore";
import { dateCell, type DateCellOptions } from "../daily/dateCells";
import { deadlineText } from "../daily/deadlineText";
import { defaultIsrael, holidaysOn } from "../daily/hebrewCalendar";
import { holidayLabel, nameLang } from "../daily/hebrewCalendarNames";
import { dayOfValue } from "../daily/israeliTime";

const NONE = NO_VALUE;

export const titleOf = (row: DatabaseRow) => (typeof row.fm.title === "string" && row.fm.title) || row.basename;

/** Is this a value a cell can edit (not a map or a nested list)? */
const editableValue = (v: unknown) =>
  v === null || v === undefined || ["string", "number", "boolean"].includes(typeof v) || (Array.isArray(v) && v.every((x) => x === null || ["string", "number", "boolean"].includes(typeof x)));

export interface ViewProps {
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

function EditableCell({ row, field, type, edit, dates }: { row: DatabaseRow; field: string; type: ReturnType<typeof columnType>; edit: ViewProps["edit"]; dates: CellDates }) {
  const value = row.fm[field];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const label = t("db.cell.edit", { field, note: titleOf(row) });
  if (!editableValue(value)) {
    return (
      <span title={t("db.readOnly")} style={{ opacity: 0.7 }}>
        <CellValue value={value} dates={dates} />
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
      <CellValue value={value} dates={dates} />
    </button>
  );
}

/* ─── Date cells (plan W5.15) ────────────────────────────────────────── */

/** The date options of this block: the UI locale and the calendar settings. */
type DateOpts = Omit<DateCellOptions, "deadline">;
/** What a cell needs to show a date: the options, and whether its column is the block's deadline column. */
interface CellDates {
  opts: DateOpts;
  deadline: boolean;
}

function useDateOptions(spec: DatabaseSpec): DateOpts {
  const locale = useAppStore((s) => s.locale) as string;
  const settings = useAppStore((s) => s.dailyNotes);
  return useMemo(() => ({ locale, settings, hebrewDates: spec.hebrewDate }), [locale, settings, spec.hebrewDate]);
}

/** A cell's value: a date with its Hebrew date; the deadline column with its suggested working day and the working days left. */
function CellValue({ value, dates }: { value: unknown; dates: CellDates }) {
  const { opts, deadline } = dates;
  const cell = dateCell(value, { ...opts, deadline });
  if (!cell) return <>{displayValue(value)}</>;
  const d = cell.deadline && deadlineText(cell.deadline);
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", gap: 1 }}>
      <span>
        {cell.iso}
        {cell.hebrew && (
          <span lang="he" dir={opts.locale === "he" ? "rtl" : "auto"} style={{ marginInlineStart: 6, color: "hsl(var(--fg-muted))", fontSize: 11 }}>
            {cell.hebrew}
          </span>
        )}
      </span>
      {d?.moved && (
        <span role="note" data-testid="db-deadline-moved" style={{ fontSize: 11, color: "hsl(var(--warning, 35 90% 40%))" }}>
          ⚠ {d.moved}
        </span>
      )}
      {d && (
        <span data-testid="db-deadline-left" style={{ fontSize: 11, color: cell.deadline!.left < 0 ? "hsl(0 70% 50%)" : "hsl(var(--fg-muted))" }}>
          {d.left}
          {d.notes ? ` · ${d.notes}` : ""}
        </span>
      )}
    </span>
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

/* ─── Table view ─────────────────────────────────────────────────────── */

type Item = { kind: "group"; key: string; count: number } | { kind: "row"; row: DatabaseRow };

/** Above this many lines the table renders only what is on screen. */
const VIRTUAL_FROM = 60;

export function TableView({ rows, allRows, spec, fields, groupBy, edit, formulaNames, formulaErrors }: ViewProps) {
  const dateOpts = useDateOptions(spec);
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
              <EditableCell row={c.row.original} field={f} type={types[f]} edit={edit} dates={{ opts: dateOpts, deadline: f === spec.deadline }} />
            ),
        }),
      ),
    ],
    [fields, types, edit, formulaNames, formulaErrors, dateOpts, spec.deadline],
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

export function KanbanView({ rows, allRows, spec, fields, groupBy, edit, formulaNames }: ViewProps) {
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
  // The same key as groupRows, so a card's own column is recognised.
  const columnOf = (path: string) => groupKey(byPath.get(path)?.fm[groupBy]);
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
            {/* empty-allow: the name of a column without a value, not an empty state */}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─── Cards view ─────────────────────────────────────────────────────── */

export function CardsView({ rows, spec, fields, groupBy }: ViewProps) {
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

export function ListView({ rows, fields, groupBy }: ViewProps) {
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

export function CalendarView({ rows, spec }: { rows: DatabaseRow[]; spec: DatabaseSpec }) {
  const opts = useDateOptions(spec);
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
          <CalendarDayHeader iso={date} opts={opts} />
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {items.map((r) => (
              <div key={r.path}>
                <RowLink row={r} />
                {spec.deadline === dateField && <CalendarDeadline value={r.fm[dateField]} opts={opts} />}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A day in the agenda: the date, its Hebrew date and the day's holidays (plan W5.15). */
function CalendarDayHeader({ iso, opts }: { iso: string; opts: DateOpts }) {
  const cell = dateCell(iso, opts);
  const day = dayOfValue(iso);
  const israel = opts.settings.israel ?? defaultIsrael(opts.locale);
  const holidays = day ? holidaysOn(day, { israel }).filter((h) => h.kind !== "roshChodesh") : [];
  return (
    <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))", fontWeight: 600, display: "flex", flexDirection: "column", gap: 1 }}>
      <span>{iso}</span>
      {cell?.hebrew && (
        <span lang="he" dir={opts.locale === "he" ? "rtl" : "auto"} style={{ fontWeight: 400 }}>
          {cell.hebrew}
        </span>
      )}
      {holidays.length > 0 && <span style={{ fontWeight: 400 }}>{holidays.map((h) => holidayLabel(h, nameLang(opts.locale))).join(" · ")}</span>}
    </div>
  );
}

/** Under an item whose deadline is a day off: the suggested working day (plan W5.15). */
function CalendarDeadline({ value, opts }: { value: unknown; opts: DateOpts }) {
  const cell = dateCell(value, { ...opts, deadline: true });
  const d = cell?.deadline && deadlineText(cell.deadline);
  if (!d?.moved) return null;
  return (
    <div role="note" data-testid="db-deadline-moved" style={{ fontSize: 11, color: "hsl(var(--warning, 35 90% 40%))" }}>
      ⚠ {d.moved} · {d.left}
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

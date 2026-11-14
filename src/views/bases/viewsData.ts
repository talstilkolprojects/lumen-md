/**
 * The data side of the W1.12 views — calendar, timeline, the virtual table,
 * CSV out and in — kept pure so it is tested without a browser.
 */

import { setProperty } from "../../properties/frontmatter";
import type { BaseResult, BaseRow } from "./base";
import { toDate, toText, type BValue } from "./values";

/* ─── Dates ──────────────────────────────────────────────────────────── */

const pad = (n: number) => String(n).padStart(2, "0");
/** UTC day of a date, `YYYY-MM-DD` (Bases dates are UTC). */
export const dayKey = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** A cell as a UTC day, or null. */
export function cellDay(v: BValue): string | null {
  const first = Array.isArray(v) ? v[0] ?? null : v;
  const d = first instanceof Date || typeof first === "string" ? toDate(first) : null;
  return d ? dayKey(d) : null;
}

/** The frontmatter key behind a property id: only `note.*` properties can be written. */
export function writableKey(id: string): string | null {
  return id.startsWith("note.") ? id.slice(5) : null;
}

/**
 * The value to write when an item moves to `day`: a date stays a date
 * (`2026-03-05`), a date-time keeps its time and zone (`2026-03-05T09:30`).
 */
export function movedDateValue(old: unknown, day: string): string {
  if (typeof old === "string") {
    const m = /^\d{4}-\d{2}-\d{2}(T.*)?$/.exec(old.trim());
    if (m?.[1]) return `${day}${m[1]}`;
  }
  if (old instanceof Date && (old.getUTCHours() || old.getUTCMinutes() || old.getUTCSeconds())) return `${day}T${pad(old.getUTCHours())}:${pad(old.getUTCMinutes())}`;
  return day;
}

/** Days between two `YYYY-MM-DD` keys. */
export const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
export const addDays = (day: string, n: number) => dayKey(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/**
 * Move one note's date property to `day`: only that property's value
 * changes in the file (setProperty splices its source); the rest stays byte
 * for byte. Returns the new text.
 */
export function moveDateInText(text: string, key: string, oldValue: unknown, day: string): string {
  return setProperty(text, key, movedDateValue(oldValue, day));
}

/* ─── Calendar ───────────────────────────────────────────────────────── */

/** The rows of a month by day (`YYYY-MM-DD`), in the view's order. */
export function rowsByDay(rows: readonly BaseRow[], dateId: string): Map<string, BaseRow[]> {
  const out = new Map<string, BaseRow[]>();
  for (const r of rows) {
    const day = cellDay(r.cells[dateId] ?? null);
    if (!day) continue;
    if (!out.has(day)) out.set(day, []);
    out.get(day)!.push(r);
  }
  return out;
}

/** Weeks of a month (rows of 7 `YYYY-MM-DD` keys or null), starting on `firstDay` (1 = Monday … 7 = Sunday). */
export function monthWeeks(y: number, m: number, firstDay: number): Array<Array<string | null>> {
  const first = new Date(Date.UTC(y, m - 1, 1));
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const iso = first.getUTCDay() === 0 ? 7 : first.getUTCDay();
  const lead = (iso - firstDay + 7) % 7;
  const cells: Array<string | null> = Array.from({ length: lead }, () => null);
  for (let d = 1; d <= days; d++) cells.push(`${y}-${pad(m)}-${pad(d)}`);
  while (cells.length % 7) cells.push(null);
  const weeks: Array<Array<string | null>> = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/* ─── Timeline ───────────────────────────────────────────────────────── */

export interface TimelineItem {
  row: BaseRow;
  start: string;
  /** Inclusive; the start when the item has no end. */
  end: string;
}

/** Items with a start day (and an end ≥ start), and the span they cover. */
export function timelineItems(rows: readonly BaseRow[], startId: string, endId?: string): { items: TimelineItem[]; from: string | null; to: string | null } {
  const items: TimelineItem[] = [];
  for (const row of rows) {
    const start = cellDay(row.cells[startId] ?? null);
    if (!start) continue;
    const endRaw = endId ? cellDay(row.cells[endId] ?? null) : null;
    const end = endRaw && endRaw >= start ? endRaw : start;
    items.push({ row, start, end });
  }
  let from: string | null = null;
  let to: string | null = null;
  for (const it of items) {
    if (!from || it.start < from) from = it.start;
    if (!to || it.end > to) to = it.end;
  }
  return { items, from, to };
}

/* ─── Virtual table ──────────────────────────────────────────────────── */

/** Which of `count` fixed-height rows to draw for a scroll position (with `overscan` rows either side). */
export function visibleWindow(count: number, rowHeight: number, scrollTop: number, viewport: number, overscan = 8): { start: number; end: number } {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const end = Math.min(count, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { start, end: Math.max(start, end) };
}

/* ─── CSV ────────────────────────────────────────────────────────────── */

/** RFC 4180 rows: quoted fields with "" and line breaks; a BOM and blank lines are skipped. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const src = text.replace(/^\uFEFF/, "");
  const endRow = () => {
    row.push(field);
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
    field = "";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      endRow();
    } else field += c;
  }
  if (field !== "" || row.length) endRow();
  return rows;
}

const csvField = (s: string) => (/[",\n\r]/.test(s) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** The view as CSV: its column labels, then one line per row (the note name for file.name). */
export function resultToCsv(result: BaseResult): string {
  const lines = [result.columns.map((c) => csvField(c.label)).join(",")];
  for (const r of result.rows) {
    lines.push(
      result.columns
        .map((c) => {
          if (c.id === "file.name" || c.id === "file.basename") return csvField(r.file.ext === "md" ? r.file.basename : r.file.name);
          const v = r.cells[c.id] ?? null;
          return csvField(Array.isArray(v) ? v.map((x) => toText(x)).join("; ") : toText(v));
        })
        .join(","),
    );
  }
  return `${lines.join("\r\n")}\r\n`;
}

const safeName = (s: string) =>
  s
    .normalize("NFC")
    .replace(/[\\/:*?"<>|#^[\]\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .slice(0, 100)
    .trim();

/** A property key from a CSV header: `Due date` → `due_date`; Hebrew letters kept. */
export const headerKey = (h: string) =>
  h
    .trim()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}_-]+/gu, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase() || "column";

/**
 * Notes from a CSV: one per row, named by its first column, its other
 * columns as properties (numbers and true / false typed), plus `extra`
 * properties (so the rows match the base's filter). Names already taken (in
 * `taken` or earlier rows) get a number.
 */
export function csvToNotes(text: string, folder: string, opts: { extra?: Record<string, string>; taken?: ReadonlySet<string> } = {}): Array<{ path: string; content: string }> {
  const [header, ...rows] = parseCsvRows(text);
  if (!header?.length) return [];
  const keys = header.map(headerKey);
  const taken = new Set([...(opts.taken ?? [])].map((p) => p.toLowerCase()));
  const out: Array<{ path: string; content: string }> = [];
  const dir = folder.replace(/^\/+|\/+$/g, "");
  rows.forEach((row, i) => {
    const stem = safeName(String(row[0] ?? "")) || `Row ${i + 1}`;
    let path = `${dir ? `${dir}/` : ""}${stem}.md`;
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${dir ? `${dir}/` : ""}${stem} ${n}.md`;
    taken.add(path.toLowerCase());
    let content = `# ${stem}\n`;
    for (const [k, v] of Object.entries(opts.extra ?? {})) content = setProperty(content, k, v);
    for (let c = 1; c < header.length; c++) {
      const raw = (row[c] ?? "").trim();
      if (!raw) continue;
      const v = /^-?\d+(\.\d+)?$/.test(raw) && !/^0\d/.test(raw) ? Number(raw) : /^(true|false)$/i.test(raw) ? raw.toLowerCase() === "true" : raw;
      content = setProperty(content, keys[c], v);
    }
    out.push({ path, content });
  });
  return out;
}

/**
 * Properties a base's top-level filter pins to one value (`type == "book"`,
 * `note.status == "open"`), so imported rows land in the view.
 */
export function pinnedProperties(filter: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const visit = (f: unknown) => {
    if (typeof f === "string") {
      const m = /^\s*(?:note\.)?([A-Za-z_\p{L}][\w\p{L}-]*)\s*==\s*(["'])(.*)\2\s*$/u.exec(f);
      if (m && !["file", "formula", "this"].includes(m[1])) out[m[1]] = m[3];
    } else if (f && typeof f === "object" && "and" in f) for (const x of (f as { and: unknown[] }).and) visit(x);
  };
  visit(filter);
  return out;
}

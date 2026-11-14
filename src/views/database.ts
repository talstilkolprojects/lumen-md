/**
 * Database engine — turns a folder of markdown notes into a queryable
 * collection by reading each file's YAML frontmatter and rendering it
 * as Table / Kanban / Gallery / Calendar.
 *
 * Spec lives inside a fenced ```database block:
 *
 *     ```database
 *     source: books/         # folder under workspace root, or "" for whole vault
 *     type: book             # filter rows where frontmatter.type === "book"
 *     view: kanban           # table | cards | kanban | list | calendar
 *     where: status != "done" AND (rating >= 4 OR contains(tags, "fav"))
 *     groupBy: status        # kanban columns; sections in the other views
 *     sort: [-rating, title] # one or more columns ('-' or ' desc': descending)
 *     sortBy: rating         # the older, single-column form of `sort`
 *     fields: [title, author, rating]   # which columns to show in table/gallery
 *     dateField: due         # which frontmatter key is the date for calendar
 *     formulas:              # computed columns (plan 4.11, see ./formula)
 *       total: price * qty
 *     location: place        # coordinates for the map view ("32.08, 34.78", [lat, lng] or {lat, lng})
 *     deadline: due          # a deadline column: moved off Shabbat / chag, working days left (W5.15)
 *     hebrewDate: true       # Hebrew dates next to dates (default: the calendar setting)
 *     ```
 *
 * The query runs over OPFS — every .md / .markdown file under `source`
 * is scanned, frontmatter parsed, and the matching rows returned. The
 * engine is intentionally cheap (no inverted index): a workspace under
 * a few hundred notes rebuilds in <100ms.
 */

import YAML from "yaml";
import {
  isOPFSAvailable,
  listWorkspace,
  readWorkspaceFile,
} from "../storage/workspace";
import { extractFrontmatter } from "../renderer/pipeline";
import { matchesFilter, parseFilter, type FilterNode } from "./databaseFilter";
import type { PropertyType, PropertyValue } from "../properties/frontmatter";
import { evaluate, parseFormula, type FormulaNode } from "./formula";

export type DatabaseView = "table" | "cards" | "kanban" | "list" | "calendar" | "map";

export interface DatabaseSpec {
  source?: string;
  type?: string;
  /** `gallery` is the old name of `cards`. */
  view?: DatabaseView | "gallery";
  /** Filter expression (see databaseFilter.ts). */
  where?: string;
  groupBy?: string;
  /** Kanban columns to show even when no note is in them yet, in this order. */
  columns?: Array<string | number>;
  sort?: string | string[];
  sortBy?: string;
  fields?: string[];
  dateField?: string;
  /** Column that holds an image URL — used in gallery cards. */
  cover?: string;
  /** Optional custom title for the rendered block. */
  title?: string;
  /** Computed columns: name → formula, evaluated in this order (a formula may use the ones above it). */
  formulas?: Record<string, string>;
  /** Column with a note's coordinates, for the map view. Default: `location`, else `lat` + `lng`. */
  location?: string;
  /** A deadline column (plan W5.15): a date on Shabbat or a chag gets the suggested working day, and the working days left. */
  deadline?: string;
  /** Hebrew dates next to dates; unset: the calendar setting (on for a Hebrew UI). */
  hebrewDate?: boolean;
}

export interface DatabaseRow {
  /** Workspace path of the source file. */
  path: string;
  /** Filename minus extension, used as a default title. */
  basename: string;
  /** Parsed frontmatter; empty object when none. */
  fm: Record<string, unknown>;
}

/** The spec's view, with old names mapped (`gallery` → `cards`). */
export function specView(spec: DatabaseSpec): DatabaseView {
  const v = spec.view;
  if (v === "gallery") return "cards";
  return v === "table" || v === "cards" || v === "kanban" || v === "list" || v === "calendar" || v === "map" ? v : "table";
}

export interface SortKey {
  key: string;
  desc: boolean;
}

/** `[-rating, "title asc"]`, `"rating desc, title"` or `-rating` → sort keys. */
export function parseSort(sort: string | string[] | undefined): SortKey[] {
  if (!sort) return [];
  const parts = (Array.isArray(sort) ? sort.map(String) : String(sort).split(",")).map((x) => x.trim()).filter(Boolean);
  return parts.map((x) => {
    const m = /^(.*?)\s+(asc|desc)$/i.exec(x);
    if (m) return { key: m[1].trim(), desc: m[2].toLowerCase() === "desc" };
    return x.startsWith("-") ? { key: x.slice(1).trim(), desc: true } : { key: x, desc: false };
  });
}

const rowFilter = (r: DatabaseRow) => ({
  fm: r.fm,
  file: { name: r.basename, path: r.path, folder: r.path.includes("/") ? r.path.slice(0, r.path.lastIndexOf("/")) : "" },
});

/** Filter, then sort (ties: by name). Pure, so the toolbar can re-run it on every keystroke. */
export function applyQuery(rows: readonly DatabaseRow[], q: { where?: FilterNode | null; sort?: SortKey[] }): DatabaseRow[] {
  const out = q.where ? rows.filter((r) => matchesFilter(q.where ?? null, rowFilter(r))) : [...rows];
  const keys = q.sort ?? [];
  out.sort((a, b) => {
    for (const { key, desc } of keys) {
      const av = compareValue(a.fm[key]);
      const bv = compareValue(b.fm[key]);
      // Missing values last, either direction.
      if (av === "" && bv !== "") return 1;
      if (bv === "" && av !== "") return -1;
      const d = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      if (d) return desc ? -d : d;
    }
    return a.basename.localeCompare(b.basename);
  });
  return out;
}

export function parseDatabaseSpec(source: string): {
  spec: DatabaseSpec | null;
  error?: string;
} {
  const trimmed = source.trim();
  if (!trimmed) return { spec: null, error: "(empty database spec)" };
  try {
    const parsed = YAML.parse(trimmed);
    if (!parsed || typeof parsed !== "object") {
      return { spec: null, error: "Database spec must be a YAML object." };
    }
    return { spec: parsed as DatabaseSpec };
  } catch (e) {
    return { spec: null, error: (e as Error).message };
  }
}

/**
 * Run the query against the workspace and return matching rows.
 * Returns an empty array (not throw) when OPFS is unavailable so the
 * block degrades gracefully in restricted environments.
 */
export async function runDatabaseQuery(spec: DatabaseSpec): Promise<DatabaseRow[]> {
  const where = parseFilter(spec.where ?? "");
  if (!where.ok) throw new Error(`where: ${where.error} (at ${where.at + 1})`);
  // Formula columns first, so `where:` and `sort:` can use them.
  const { rows } = applyFormulas(await loadDatabaseRows(spec), compileFormulas(spec.formulas));
  return applyQuery(rows, { where: where.tree, sort: parseSort(spec.sort ?? spec.sortBy) });
}

/** The notes under `source` (of `type`, when set), by name — before `where` and `sort`. */
export async function loadDatabaseRows(spec: DatabaseSpec): Promise<DatabaseRow[]> {
  if (!isOPFSAvailable()) return [];
  const sourceRoot = (spec.source ?? "").replace(/^\/+|\/+$/g, "");
  const all = await listWorkspace({ includeAssets: false });
  const candidates = all.filter((f) => {
    if (!/\.(md|markdown)$/i.test(f.path)) return false;
    if (sourceRoot && !f.path.toLowerCase().startsWith(sourceRoot.toLowerCase() + "/") && f.path.toLowerCase() !== sourceRoot.toLowerCase()) {
      return false;
    }
    return true;
  });

  const rows: DatabaseRow[] = [];
  for (const file of candidates) {
    let body: string;
    try {
      body = await readWorkspaceFile(file.path);
    } catch {
      continue;
    }
    const fm = extractFrontmatter(body) ?? {};
    if (spec.type && fm.type !== spec.type) continue;
    rows.push({
      path: file.path,
      basename: file.name.replace(/\.(md|markdown)$/i, ""),
      fm,
    });
  }

  return rows.sort((a, b) => a.basename.localeCompare(b.basename));
}

function compareValue(v: unknown): string | number {
  if (v == null) return "";
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime();
  return String(v).toLowerCase();
}

/**
 * Group rows by the `groupBy` column. Empty / missing values land in the
 * `NO_VALUE` bucket so the Kanban view can render them under "(none)". It
 * can't be a frontmatter value (`_` is one), so moving a card there removes
 * the property and moving it to a real `_` column writes `_`.
 */
export const NO_VALUE = "\uFDD0none";

/**
 * The value a kanban column stands for, to write when a card is dropped
 * there: what a note in it already holds, in its type — a list stays a list
 * (`tags: [fav, sci-fi]`, not `"fav,sci-fi"`), `3` stays a number. An empty
 * column (from `columns:`) gets the column's type. `NO_VALUE`: remove it.
 */
export function kanbanColumnValue(col: string, sample: unknown, type: PropertyType): PropertyValue | undefined {
  if (col === NO_VALUE) return undefined;
  if (typeof sample === "number" || typeof sample === "boolean") return sample;
  if (Array.isArray(sample)) return sample.map((x) => String(x));
  // An empty `columns: [true, false]` column of a checkbox: a boolean, not the text "false" (W1.32, Codex on #231).
  if (type === "checkbox" && (col === "true" || col === "false")) return col === "true";
  if (type === "list") return [col];
  return type === "number" && Number.isFinite(Number(col)) ? Number(col) : col;
}

/**
 * The column a value belongs to. A list joins its items with "," (`fav,sci-fi`,
 * the column `columns:` names), unless an item has a comma of its own: then
 * `["a,b"]` and `[a, b]` would share a column, and a drop there would write
 * whichever list loaded first, so such a list keys by its JSON (W1.32, Codex on #231).
 */
export function groupKey(v: unknown): string {
  if (v == null || v === "") return NO_VALUE;
  if (Array.isArray(v)) {
    const items = v.map((x) => String(x));
    return items.some((x) => x.includes(",")) ? JSON.stringify(items) : items.join(",");
  }
  return String(v);
}

export function groupRows(
  rows: DatabaseRow[],
  groupBy: string,
): Map<string, DatabaseRow[]> {
  const out = new Map<string, DatabaseRow[]>();
  for (const r of rows) {
    const key = groupKey(r.fm[groupBy]);
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(r);
  }
  return out;
}

/** Friendly display string for a frontmatter value (handles arrays / dates). */
export function displayValue(v: unknown): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.map((x) => displayValue(x)).join(", ");
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Pick the columns to show in table / gallery. Falls back to the union of
 * all frontmatter keys (excluding internal `type`) so a user who didn't
 * specify `fields:` still gets useful output.
 */
export function resolveFields(
  rows: DatabaseRow[],
  spec: DatabaseSpec,
): string[] {
  if (spec.fields && spec.fields.length > 0) return spec.fields;
  const keys = new Set<string>();
  for (const r of rows) {
    for (const k of Object.keys(r.fm)) {
      if (k === "type") continue;
      keys.add(k);
    }
  }
  return [...keys].slice(0, 6);
}

/* ─── Formulas (plan 4.11) ───────────────────────────────────────────── */

export interface CompiledFormula {
  name: string;
  source: string;
  tree: FormulaNode | null;
  /** Why it does not parse, with the 0-based character. */
  error?: { message: string; at: number };
}

/** The spec's `formulas:` (a map of name → text), parsed once. Non-text entries are skipped. */
export function compileFormulas(formulas: unknown): CompiledFormula[] {
  if (!formulas || typeof formulas !== "object" || Array.isArray(formulas)) return [];
  const out: CompiledFormula[] = [];
  for (const [name, raw] of Object.entries(formulas as Record<string, unknown>)) {
    // `pair: [price, qty]` unquoted is a YAML list, not a formula: show it as a broken entry
    // with the fix, instead of dropping the column without a word (review #267).
    if (Array.isArray(raw)) {
      out.push({ name, source: JSON.stringify(raw), tree: null, error: { message: "this is a YAML list — put the formula in quotes", at: 0 } });
      continue;
    }
    // `blank: null` in YAML is the formula `null` (YAML already turned it into a value, as it does 3 and true).
    if (raw !== null && typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") continue;
    // An unquoted `value: 1e309` reaches us as Infinity, which would parse as a field name: say why instead (review #267).
    if (typeof raw === "number" && !Number.isFinite(raw)) {
      out.push({ name, source: String(raw), tree: null, error: { message: "the number is too large — put the formula in quotes", at: 0 } });
      continue;
    }
    const source = raw === null ? "null" : String(raw);
    const p = parseFormula(source);
    out.push(p.ok ? { name, source, tree: p.tree } : { name, source, tree: null, error: { message: p.error.message, at: p.error.at } });
  }
  return out;
}

export interface FormulaRows {
  rows: DatabaseRow[];
  /** path → formula name → error message, for the cells that could not be computed. */
  errors: Map<string, Map<string, string>>;
}

/**
 * Every row with its formula columns added to `fm` (so filter, sort, group
 * and the views treat them like any property). A formula that fails leaves
 * its column empty and records the message. `now` fixes today() for the run.
 */
export function applyFormulas(rows: readonly DatabaseRow[], formulas: readonly CompiledFormula[], now: Date = new Date()): FormulaRows {
  const errors = new Map<string, Map<string, string>>();
  if (!formulas.length) return { rows: [...rows], errors };
  const out = rows.map((r) => {
    const fm: Record<string, unknown> = { ...r.fm };
    const file = rowFilter(r).file;
    // An own data property even for a name like `__proto__` (plain assignment would hit the prototype setter).
    const put = (name: string, v: unknown) => Object.defineProperty(fm, name, { value: v, writable: true, enumerable: true, configurable: true });
    for (const f of formulas) {
      if (!f.tree) {
        put(f.name, null);
        continue;
      }
      const res = evaluate(f.tree, { fm, file }, { now });
      if (res.ok) put(f.name, res.value);
      else {
        put(f.name, null);
        if (!errors.has(r.path)) errors.set(r.path, new Map());
        errors.get(r.path)!.set(f.name, res.error.message);
      }
    }
    return { ...r, fm };
  });
  return { rows: out, errors };
}

/* ─── Coordinates, for the map view ──────────────────────────────────── */

export interface LatLng {
  lat: number;
  lng: number;
}

const inRange = (lat: number, lng: number) => Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

/** A coordinate member: a number, or numeric text — never empty, null or a boolean (which `Number` would make 0 or 1). */
function coord(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(v)) return Number(v);
  return Number.NaN;
}

/** `"32.08, 34.78"`, `[32.08, 34.78]`, `{lat, lng}` (or `lon` / `latitude` / `longitude`) → a point. */
export function parseLatLng(v: unknown): LatLng | null {
  let lat: number;
  let lng: number;
  if (typeof v === "string") {
    const m = /^\s*(-?\d+(?:\.\d+)?)\s*[,;\s]\s*(-?\d+(?:\.\d+)?)\s*$/.exec(v);
    if (!m) return null;
    lat = Number(m[1]);
    lng = Number(m[2]);
  } else if (Array.isArray(v) && v.length === 2) {
    lat = coord(v[0]);
    lng = coord(v[1]);
  } else if (v && typeof v === "object" && !(v instanceof Date)) {
    const o = v as Record<string, unknown>;
    lat = coord(o.lat ?? o.latitude);
    lng = coord(o.lng ?? o.lon ?? o.long ?? o.longitude);
  } else return null;
  return inRange(lat, lng) ? { lat, lng } : null;
}

/** A row's coordinates: the spec's `location:` column, else `location`, else `lat` + `lng` columns. */
export function rowLatLng(row: DatabaseRow, spec: Pick<DatabaseSpec, "location">): LatLng | null {
  if (spec.location) return parseLatLng(row.fm[spec.location]);
  // Each alias on its own: `location: Tel Aviv` (a place name) must not hide valid `coordinates`.
  for (const key of ["location", "coordinates"]) {
    const p = parseLatLng(row.fm[key]);
    if (p) return p;
  }
  for (const latKey of ["lat", "latitude"]) {
    for (const lngKey of ["lng", "lon", "longitude"]) {
      if (row.fm[latKey] === undefined || row.fm[lngKey] === undefined) continue;
      const p = parseLatLng([row.fm[latKey], row.fm[lngKey]]);
      if (p) return p;
    }
  }
  return null;
}

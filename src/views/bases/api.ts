/**
 * The local Bases API for scripts and plugins (plan W6.46), on #367's plugin
 * runtime: `lumen.bases.query(path, view?)` reads a view's rows, and
 * `lumen.bases.update(edits)` changes note properties — every edit of one
 * call behind one approval screen, and nothing written without it.
 *
 * Pure and injectable: the app wires it to the vault and to its confirm
 * dialog (src/plugins/runtime/manager.ts); tests pass an in-memory vault.
 */

import { setProperty, type PropertyValue } from "../../properties/frontmatter";
import { basesFileFromText, parseBase, runBase } from "./base";
import { isTagged, toText, type BValue } from "./values";

export interface BasesApiDeps {
  /** Every file path of the vault. */
  paths(): Promise<string[]>;
  readText(path: string): Promise<string>;
  write(path: string, text: string): Promise<void>;
  /** The approval screen: one call, one answer. */
  confirm(summary: UpdateSummary): Promise<boolean>;
  now?: Date;
}

/** The most rows one update may change (one approval covers them all). */
export const MAX_EDITS = 5000;
/** Rows a query returns at most (a plugin pages with `offset`). */
export const MAX_ROWS = 10_000;

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

/** A cell as JSON: dates as ISO text, links and files as their path. */
export function cellJson(v: BValue): JsonValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(cellJson);
  if (isTagged(v)) {
    if (v.$ === "file") return v.file.path;
    if (v.$ === "link") return v.path;
    if (v.$ === "object") return Object.fromEntries(Object.entries(v.map).map(([k, x]) => [k, cellJson(x)]));
  }
  return toText(v);
}

export interface QueryResult {
  view: string;
  columns: Array<{ id: string; label: string }>;
  rows: Array<{ path: string; cells: Record<string, JsonValue> }>;
  total: number;
  errors: string[];
}

const isBasePath = (p: string) => /\.base$/i.test(p) && !p.split("/").some((s) => s === ".." || s.startsWith("."));

/** A view's rows, as the app shows them. */
export async function queryBase(deps: Pick<BasesApiDeps, "paths" | "readText" | "now">, basePath: string, view?: string | number, page: { offset?: number; limit?: number } = {}): Promise<QueryResult> {
  if (!isBasePath(basePath)) throw new RangeError("a .base file in the vault");
  const p = parseBase(await deps.readText(basePath));
  if (!p.ok) throw new Error(p.error);
  const paths = await deps.paths();
  const files = await Promise.all(paths.map(async (path) => basesFileFromText(path, path.endsWith(".md") ? await deps.readText(path) : null)));
  const thisFile = files.find((f) => f.path === basePath) ?? null;
  const r = runBase(p.base, files, { view, thisFile, now: deps.now });
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  const limit = Math.min(MAX_ROWS, Math.max(0, Math.floor(page.limit ?? MAX_ROWS)));
  return {
    view: r.view.name,
    columns: r.columns,
    rows: r.rows.slice(offset, offset + limit).map((row) => ({ path: row.file.path, cells: Object.fromEntries(r.columns.map((c) => [c.id, cellJson(row.cells[c.id] ?? null)])) })),
    total: r.total,
    errors: r.errors,
  };
}

/** One row's edit: properties of one note (`note.status` or `status`). `null` removes nothing: it writes an empty value. */
export interface RowEdit {
  path: string;
  set: Record<string, PropertyValue>;
}

export interface UpdateSummary {
  /** Notes that would change. */
  notes: number;
  /** The properties written, by name. */
  properties: string[];
  /** The first few notes, to show. */
  sample: string[];
  /** Edits that change nothing (the value is already there). */
  unchanged: number;
}

export type UpdateResult = { written: number; unchanged: number; declined: false } | { written: 0; unchanged: number; declined: true };

const PROP = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,63}$/u;

function checkValue(v: unknown, depth = 0): v is PropertyValue {
  if (v === null || typeof v === "boolean" || typeof v === "string") return typeof v !== "string" || v.length <= 10_000;
  if (typeof v === "number") return Number.isFinite(v);
  if (Array.isArray(v) && depth === 0) return v.length <= 200 && v.every((x) => typeof x === "string" && x.length <= 10_000);
  return false;
}

/** Validate a plugin's edits: notes in the vault, property names, plain values. Throws on the first bad one. */
export function validateEdits(edits: unknown): RowEdit[] {
  if (!Array.isArray(edits)) throw new TypeError("edits: a list of { path, set }");
  if (edits.length > MAX_EDITS) throw new RangeError(`at most ${MAX_EDITS} rows in one update`);
  return edits.map((e, i) => {
    if (!e || typeof e !== "object") throw new TypeError(`edits[${i}]: { path, set }`);
    const { path, set } = e as { path?: unknown; set?: unknown };
    if (typeof path !== "string" || !/\.md$/i.test(path) || path.startsWith("/") || path.split("/").some((s) => s === ".." || s === "" || s.startsWith("."))) throw new RangeError(`edits[${i}].path: a note in the vault (.md)`);
    if (!set || typeof set !== "object" || Array.isArray(set)) throw new TypeError(`edits[${i}].set: { property: value }`);
    const out: Record<string, PropertyValue> = {};
    for (const [k0, v] of Object.entries(set)) {
      const k = k0.replace(/^note\./, "");
      if (!PROP.test(k)) throw new RangeError(`edits[${i}]: "${k0}" is not a property name`);
      if (!checkValue(v)) throw new TypeError(`edits[${i}].${k}: text, a number, true / false, null or a list of texts`);
      out[k] = v;
    }
    if (!Object.keys(out).length) throw new RangeError(`edits[${i}].set is empty`);
    return { path, set: out };
  });
}

/**
 * Apply property edits: the new text of every note is computed first (a
 * note that would not change is left out), then ONE approval covers them
 * all, then they are written. Declined: nothing is written.
 */
export async function updateRows(deps: BasesApiDeps, raw: unknown): Promise<UpdateResult> {
  const edits = validateEdits(raw);
  const next = new Map<string, { before: string; after: string }>();
  const props = new Set<string>();
  let unchanged = 0;
  for (const e of edits) {
    const cur = next.get(e.path)?.after ?? (await deps.readText(e.path));
    let after = cur;
    for (const [k, v] of Object.entries(e.set)) {
      after = setProperty(after, k, v);
      props.add(k);
    }
    if (after === cur) unchanged++;
    else next.set(e.path, { before: next.get(e.path)?.before ?? cur, after });
  }
  const changed = [...next.entries()].filter(([, x]) => x.after !== x.before);
  const summary: UpdateSummary = { notes: changed.length, properties: [...props].sort(), sample: changed.slice(0, 5).map(([p]) => p), unchanged };
  if (!changed.length) return { written: 0, unchanged, declined: false };
  if (!(await deps.confirm(summary))) return { written: 0, unchanged, declined: true };
  for (const [path, x] of changed) await deps.write(path, x.after);
  return { written: changed.length, unchanged, declined: false };
}

/**
 * Tabular-data parsers — convert any of these source formats to a `DataSet`
 * the existing DataTable / chart-suggester pipeline already understands.
 *
 *   • SQL    — `INSERT INTO ... VALUES (...)` statements (and CREATE TABLE
 *               definitions for the column types)
 *   • Pandas — the textual repr of a `DataFrame` (whitespace-aligned columns
 *               with optional row-index)
 *   • JS object / JSON5 — array of object literals using JS syntax
 *               (unquoted keys, single quotes, trailing commas)
 *
 * Each parser produces a row-array + column list; we then hand it off to
 * `buildDataset` from `csv.ts` so type inference, chart suggestions and the
 * DataTable component all work without changes.
 */

import { parseJSONTable } from "./csv";
import type { DataSet } from "./csv";

// ── SQL ─────────────────────────────────────────────────────────────────

/**
 * Parse a series of `INSERT INTO <table> (cols...) VALUES (...)` statements.
 * Multi-row inserts (`VALUES (a,b),(c,d)`) are supported. If a `CREATE TABLE`
 * statement precedes the inserts, we use its column order as a fallback.
 *
 * The parser is intentionally forgiving: unmatched quotes in the values
 * cause the row to be skipped rather than crashing the renderer.
 */
export function parseSQL(text: string): DataSet {
  const trimmed = text.trim();
  if (!trimmed) return parseJSONTable("[]");

  // Pull the column list from the most recent CREATE TABLE if present.
  let createCols: string[] | null = null;
  const create = /CREATE\s+TABLE\s+[^\s(]+\s*\(([\s\S]+?)\)\s*;/i.exec(trimmed);
  if (create) {
    createCols = create[1]
      .split(/,(?![^()]*\))/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split(/\s+/)[0].replace(/[`"\[\]]/g, ""));
  }

  const rows: Record<string, unknown>[] = [];
  let columns: string[] | null = createCols;

  // Match each INSERT statement (terminator is ; or end-of-string).
  const insertRe = /INSERT\s+INTO\s+([^\s(]+)\s*(?:\(([^)]+)\))?\s*VALUES\s*([\s\S]+?)\s*(?=;|$)/gi;
  let match: RegExpExecArray | null;
  while ((match = insertRe.exec(trimmed)) !== null) {
    const colList = match[2];
    const valuesBlock = match[3];
    if (colList) {
      columns = colList.split(",").map((c) => c.trim().replace(/[`"\[\]]/g, ""));
    }
    if (!columns) continue;
    for (const tuple of splitValueTuples(valuesBlock)) {
      const cells = splitTupleValues(tuple);
      if (cells.length !== columns.length) continue;
      const row: Record<string, unknown> = {};
      for (let i = 0; i < columns.length; i++) {
        row[columns[i]] = sqlValue(cells[i]);
      }
      rows.push(row);
    }
  }

  return parseJSONTable(JSON.stringify(rows));
}

function splitValueTuples(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === inString && text[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i));
        start = -1;
      }
    }
  }
  return out;
}

function splitTupleValues(tuple: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inString: string | null = null;
  for (let i = 0; i < tuple.length; i++) {
    const ch = tuple[i];
    if (inString) {
      buf += ch;
      if (ch === inString && tuple[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      buf += ch;
      continue;
    }
    if (ch === "," && !inString) {
      out.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

function sqlValue(raw: string): unknown {
  if (raw == null) return null;
  const v = raw.trim();
  if (!v) return null;
  if (/^null$/i.test(v)) return null;
  if (/^true$/i.test(v)) return true;
  if (/^false$/i.test(v)) return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) {
    return v.slice(1, -1).replace(/''/g, "'").replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  return v;
}

// ── JS / JSON5 object literal ──────────────────────────────────────────

/**
 * Parse JavaScript-flavoured object array literals — accepts unquoted keys,
 * single-quoted strings, trailing commas, comments. Falls back to
 * standard JSON if the input is already valid JSON.
 *
 * Implementation detail: rather than using `eval`, we coerce the source into
 * legal JSON via a small set of rewrites and parse it.
 */
export function parseObjectLiteral(text: string): DataSet {
  const trimmed = text.trim();
  if (!trimmed) return parseJSONTable("[]");
  try {
    return parseJSONTable(trimmed);
  } catch {
    /* why: fall through to relaxed parser */
  }
  const rewritten = relaxedJsonToJson(trimmed);
  return parseJSONTable(rewritten);
}

function relaxedJsonToJson(input: string): string {
  // Strip line and block comments outside strings.
  let out = "";
  let inString: string | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const next = input[i + 1];
    if (inString) {
      out += ch;
      if (ch === inString && input[i - 1] !== "\\") inString = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < input.length && input[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < input.length && !(input[i] === "*" && input[i + 1] === "/")) i++;
      i += 1;
      continue;
    }
    out += ch;
  }
  // Convert single-quoted strings → double-quoted, handling escapes.
  out = out.replace(/'((?:[^'\\]|\\.)*)'/g, (_match, body: string) => {
    return '"' + body.replace(/\\'/g, "'").replace(/"/g, '\\"') + '"';
  });
  // Quote unquoted keys: { key: value } → { "key": value }
  out = out.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  // Strip trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, "$1");
  return out;
}

// ── Pandas DataFrame textual repr ──────────────────────────────────────

/**
 * Convert the standard `print(df)` output into a DataSet.
 * Recognises whitespace-aligned columns plus an optional leading row index.
 *
 *     date       region   revenue
 *  0  2026-01-01 North    1240
 *  1  2026-01-02 South    980
 */
export function parsePandas(text: string): DataSet {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.trimEnd()).filter((l) => l.trim());
  if (lines.length < 2) return parseJSONTable("[]");

  const header = lines[0];
  const headerParts = header.trim().split(/\s{2,}|\t/).filter(Boolean);
  if (headerParts.length === 0) return parseJSONTable("[]");

  // Detect a leading numeric index column. If every body row starts with a
  // pure integer that the header doesn't include, drop it.
  const bodyRows = lines.slice(1).filter((l) => !/^\s*$/.test(l));
  const firstColIsIndex = bodyRows.every((l) => /^\s*\d+\s/.test(l));
  const columns = headerParts;

  const rows: Record<string, unknown>[] = [];
  for (const line of bodyRows) {
    const cells = line.trim().split(/\s{2,}|\t/);
    const sliced = firstColIsIndex ? cells.slice(1) : cells;
    if (sliced.length !== columns.length) continue;
    const row: Record<string, unknown> = {};
    for (let i = 0; i < columns.length; i++) {
      const v = sliced[i].trim();
      row[columns[i]] = /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v === "NaN" ? null : v;
    }
    rows.push(row);
  }

  return parseJSONTable(JSON.stringify(rows));
}

// ── Auto-detect ────────────────────────────────────────────────────────

/**
 * Best-effort sniffer used by the generic `data` block. The first matching
 * shape wins.
 */
export function detectAndParse(text: string): DataSet {
  const trimmed = text.trim();
  if (!trimmed) return parseJSONTable("[]");
  if (/^\s*INSERT\s+INTO|^\s*CREATE\s+TABLE/i.test(trimmed)) return parseSQL(trimmed);
  if (/^\s*\[\s*\{/.test(trimmed) || /^\s*\{[^}]*\}\s*$/.test(trimmed)) return parseObjectLiteral(trimmed);
  // Pandas-ish: header row of words separated by ≥2 spaces and at least one
  // body row with a leading integer index.
  if (/^[^\n]+\n\s*\d+\s/.test(trimmed)) return parsePandas(trimmed);
  // Fallback: treat as JSON table.
  return parseObjectLiteral(trimmed);
}

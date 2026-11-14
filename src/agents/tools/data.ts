/**
 * Data tools — turn tabular text into columns and rows a model can chart
 * without guessing at delimiters or number formats. Local and read-only.
 */

import Papa from "papaparse";
import { defineTool, optionalNumber, ToolError } from "./define";
import { coerce, inferType, type ColType } from "../../data/csv";

const MAX_ROWS = 500;

export interface CsvParseResult {
  columns: Array<{ name: string; type: ColType; filled: number; min?: number; max?: number }>;
  /** One array per row, in column order. Numbers and booleans are typed; everything else stays text. */
  rows: Array<Array<string | number | boolean | null>>;
  rowCount: number;
  truncated: boolean;
  delimiter: string;
  format: "csv" | "markdown-table";
  errors: string[];
}

/** GFM's delimiter row (`|---|:---:|`, outer pipes optional; at least one pipe, else it is a rule). */
const DELIMITER_ROW = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;

/**
 * Cells of a Markdown pipe table, or null when the text is not one: a
 * header row, then the delimiter row, then data rows — with or without the
 * optional outer pipes (`Name | Count` / `--- | ---` / `A | 1`).
 */
function markdownTable(text: string): string[][] | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !lines[1].includes("|") || !DELIMITER_ROW.test(lines[1])) return null;
  if (!lines.every((l) => /(?<!\\)\|/.test(l))) return null;
  const cells = (l: string) => l.replace(/^\|/, "").replace(/(?<!\\)\|$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  return lines.filter((_, i) => i !== 1).map(cells);
}

/** Min and max without spreading the values into arguments (a large column exceeds the engine's argument limit). */
function extent(values: readonly number[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  return { min, max };
}

/** Parse CSV / TSV / a Markdown table; `header: false` names the columns c1, c2, … */
export function parseTable(text: string, opts: { delimiter?: string; header?: boolean; maxRows?: number } = {}): CsvParseResult {
  const maxRows = Math.min(MAX_ROWS, Math.max(1, opts.maxRows ?? 200));
  const header = opts.header !== false;
  const md = markdownTable(text);
  let grid: string[][];
  let delimiter = "|";
  const errors: string[] = [];
  if (md) grid = md;
  else {
    const r = Papa.parse<string[]>(text.trim(), { delimiter: opts.delimiter, skipEmptyLines: "greedy", dynamicTyping: false });
    grid = r.data.map((row) => row.map((c) => String(c ?? "").trim()));
    delimiter = r.meta.delimiter;
    for (const e of r.errors.slice(0, 5)) errors.push(`row ${(e.row ?? 0) + 1}: ${e.message}`);
  }
  if (!grid.length) throw new ToolError("bad-args", "No rows found in the text");
  const width = grid.reduce((w, r) => Math.max(w, r.length), 0);
  const names = header ? grid[0].map((h, i) => h || `c${i + 1}`) : Array.from({ length: width }, (_, i) => `c${i + 1}`);
  while (names.length < width) names.push(`c${names.length + 1}`);
  const body = header ? grid.slice(1) : grid;
  const columns = names.map((name, i) => {
    const raw = body.map((r) => r[i] ?? "");
    const type = inferType(raw);
    const values = raw.map((v) => coerce(v, type));
    const nums = type === "number" ? (values.filter((v) => typeof v === "number") as number[]) : [];
    return {
      name,
      type,
      filled: values.filter((v) => v !== null).length,
      ...(nums.length ? extent(nums) : {}),
    };
  });
  const rows = body.slice(0, maxRows).map((r) =>
    columns.map((c, i) => {
      const v = r[i] ?? "";
      if (v === "") return null;
      // Numbers and booleans typed; dates and text verbatim (a chart axis wants the label, not a timestamp).
      return c.type === "number" || c.type === "boolean" ? (coerce(v, c.type) as number | boolean | null) : v;
    }),
  );
  return { columns, rows, rowCount: body.length, truncated: body.length > maxRows, delimiter, format: md ? "markdown-table" : "csv", errors };
}

export const csvParseTool = defineTool<{ text?: string; delimiter?: string; header?: boolean; maxRows?: number }, CsvParseResult>({
  name: "csv_parse",
  description:
    "Parse CSV, TSV or a Markdown table into typed columns (number / date / boolean / string, with min and max) and rows. " +
    "Without `text` it parses the user's selection.",
  parameters: {
    type: "object",
    properties: {
      text: { type: "string", description: "The table; default: the selection" },
      delimiter: { type: "string", minLength: 1, maxLength: 1 },
      header: { type: "boolean", description: "First row holds the column names (default true)" },
      maxRows: { type: "integer", minimum: 1, maximum: MAX_ROWS },
    },
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const text = typeof args.text === "string" && args.text.trim() ? args.text : (ctx.selection ?? "");
    if (!text.trim()) throw new ToolError("bad-args", "Nothing to parse: no text and no selection");
    return parseTable(text, {
      delimiter: typeof args.delimiter === "string" && args.delimiter ? args.delimiter : undefined,
      header: typeof args.header === "boolean" ? args.header : true,
      maxRows: optionalNumber(args, "maxRows", 200),
    });
  },
});

export const DATA_TOOLS = [csvParseTool];

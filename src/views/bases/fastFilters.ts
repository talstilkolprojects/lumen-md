/**
 * Bases' fast filters and built-in summaries (W6.46; plan W6.25: moved out
 * of base.ts unchanged, base.ts re-exports compileFilter and builtinSummary).
 */
import { inFolder, tagMatches } from "./evaluate";
import type { BasesNode } from "./expr";
import { compareValues, equalValues, fromYaml, isEmptyValue, toDate, type BasesFile, type BValue } from "./values";

/* ─── Fast filters (W6.46) ───────────────────────────────────────────── */

type Getter = (file: BasesFile) => BValue;
const FILE_FIELDS: Record<string, Getter> = {
  name: (f) => f.name,
  basename: (f) => f.basename,
  path: (f) => f.path,
  folder: (f) => f.folder,
  ext: (f) => f.ext,
  size: (f) => f.size,
  ctime: (f) => f.ctime,
  mtime: (f) => f.mtime,
};
const noteGetter = (key: string): Getter => (f) => (Object.prototype.hasOwnProperty.call(f.fm, key) ? fromYaml(f.fm[key]) : null);
const RESERVED = new Set(["file", "note", "this", "formula"]);

function getterOf(n: BasesNode): Getter | null {
  if (n.kind === "name") return RESERVED.has(n.name) ? null : noteGetter(n.name);
  if (n.kind === "member" && n.object.kind === "name") {
    if (n.object.name === "note") return noteGetter(n.name);
    if (n.object.name === "file") return FILE_FIELDS[n.name] ?? null;
  }
  return null;
}

function literalOf(n: BasesNode): { v: BValue } | null {
  if (n.kind === "num" || n.kind === "str" || n.kind === "bool") return { v: n.value };
  if (n.kind === "null") return { v: null };
  return null;
}

const FLIP: Record<string, string> = { "<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!=" };

/**
 * The filter statements most real views are made of — a property compared
 * with a literal, `file.inFolder("x")`, `file.hasTag("x")`, and `&&`, `||`,
 * `!` of those — as plain functions, with the interpreter's own comparison
 * rules (equalValues, compareValues). 10,000 rows: no interpreter, no budget
 * object per row. Anything else returns null and goes through the interpreter.
 */
export function compileFilter(n: BasesNode): ((file: BasesFile) => boolean) | null {
  if (n.kind === "binary") {
    if (n.op === "&&" || n.op === "||") {
      const a = compileFilter(n.left);
      const b = compileFilter(n.right);
      if (!a || !b) return null;
      return n.op === "&&" ? (f) => a(f) && b(f) : (f) => a(f) || b(f);
    }
    if (!(n.op in FLIP)) return null;
    let get = getterOf(n.left);
    let lit = literalOf(n.right);
    let op: string = n.op;
    if (!get || !lit) {
      get = getterOf(n.right);
      lit = literalOf(n.left);
      op = FLIP[n.op];
    }
    if (!get || !lit) return null;
    const g = get;
    const v = lit.v;
    switch (op) {
      case "==":
        return (f) => equalValues(g(f), v);
      case "!=":
        return (f) => !equalValues(g(f), v);
      default: {
        const want = op === "<" ? (d: number) => d < 0 : op === "<=" ? (d: number) => d <= 0 : op === ">" ? (d: number) => d > 0 : (d: number) => d >= 0;
        return (f) => {
          const d = compareValues(g(f), v);
          return d !== null && want(d);
        };
      }
    }
  }
  if (n.kind === "unary" && n.op === "!") {
    const a = compileFilter(n.arg);
    return a ? (f) => !a(f) : null;
  }
  if (n.kind === "method" && n.object.kind === "name" && n.object.name === "file" && n.args.every((x) => x.kind === "str")) {
    const args = n.args.map((x) => (x as { value: string }).value);
    if (n.name === "inFolder" && args.length === 1) return (f) => inFolder(f, args[0]);
    if (n.name === "hasTag" && args.length >= 1) return (f) => args.some((a) => f.tags.some((t) => tagMatches(t, a)));
  }
  return null;
}

/** A value's time for sorting, when sortCompare would order it as a date (a Date, or ISO date text). */
export function sortDate(v: BValue): number | null {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const d = toDate(v);
  return d ? d.getTime() : null;
}

const numbersOf = (values: BValue[]) => values.map((v) => (typeof v === "number" ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null)).filter((x): x is number => x !== null);
const round15 = (n: number) => (Number.isInteger(n) ? n : Number(n.toPrecision(15)));

/** Obsidian's default summaries. `undefined`: not one of them. */
export function builtinSummary(name: string, values: BValue[]): BValue | undefined {
  const ns = numbersOf(values);
  const dates = values.map((v) => (v instanceof Date || typeof v === "string" ? toDate(v) : null)).filter((d): d is Date => !!d);
  const sum = ns.reduce((s, x) => s + x, 0);
  switch (name) {
    case "Sum":
      return round15(sum);
    case "Average":
      return ns.length ? round15(sum / ns.length) : null;
    case "Min":
      return ns.length ? Math.min(...ns) : null;
    case "Max":
      return ns.length ? Math.max(...ns) : null;
    case "Range":
      return ns.length ? round15(Math.max(...ns) - Math.min(...ns)) : null;
    case "Median": {
      if (!ns.length) return null;
      const s = [...ns].sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : round15((s[mid - 1] + s[mid]) / 2);
    }
    case "Stddev": {
      if (!ns.length) return null;
      const mean = sum / ns.length;
      return round15(Math.sqrt(ns.reduce((s, x) => s + (x - mean) ** 2, 0) / ns.length));
    }
    case "Earliest":
      return dates.length ? dates.reduce((a, b) => (a.getTime() <= b.getTime() ? a : b)) : null;
    case "Latest":
      return dates.length ? dates.reduce((a, b) => (a.getTime() >= b.getTime() ? a : b)) : null;
    case "Checked":
      return values.filter((v) => v === true).length;
    case "Unchecked":
      return values.filter((v) => v === false).length;
    case "Empty":
      return values.filter(isEmptyValue).length;
    case "Filled":
      return values.filter((v) => !isEmptyValue(v)).length;
    case "Unique": {
      const seen: BValue[] = [];
      for (const v of values) if (!isEmptyValue(v) && !seen.some((s) => equalValues(s, v))) seen.push(v);
      return seen.length;
    }
  }
  return undefined;
}

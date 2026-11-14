/**
 * Stage 1 of the chart-suggestion engine (split out of suggest.ts, plan
 * W4.11; it re-exports profileColumns and parseLooseNumber): classify every
 * column semantically on top of the parser's storage type.
 */
import type { DataColumn, DataSet } from "./csv";
import type { TimeFormat, ColumnProfile } from "./suggestTypes";

const PERCENT_RE = /^[-+]?\d[\d,]*(\.\d+)?\s?%$/;
const CURRENCY_RE = /^\(?[-+]?\s?(?:[$€£¥₪₹]|USD|EUR|GBP|ILS)\s?\d[\d,]*(\.\d+)?\)?$|^\(?[-+]?\d[\d,]*(\.\d+)?\s?(?:[$€£¥₪₹]|USD|EUR|GBP|ILS)\)?$/i;
const GROUPED_NUM_RE = /^\(?[-+]?\d{1,3}([,  ]\d{3})+(\.\d+)?\)?$/;
const PLAIN_NUM_RE = /^\(?[-+]?\d+(\.\d+)?(e[+-]?\d+)?\)?$/i;
const QUARTER_RE = /^(?:(\d{4})\s*[-/ ]?\s*Q([1-4])|Q([1-4])\s*[-/ ]?\s*(\d{4}))$/i;
const CLOCK_RE = /^([01]?\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
const LAT_NAME_RE = /^(lat|latitude)$|[_\s-](lat|latitude)$/i;
const LON_NAME_RE = /^(lon|lng|long|longitude)$|[_\s-](lon|lng|long|longitude)$/i;
const ID_NAME_RE = /^(id|#|idx|index|row|rownum|row_?id|no\.?)$|[_\s-]id$/i;
const YEAR_NAME_RE = /^(year|yr|fy|fiscal[_\s]?year|שנה|سنة|jahr|année|annee|年|год)$/i;

function nonNull(values: unknown[]): unknown[] {
  return values.filter((v) => v !== null && v !== undefined && v !== "");
}

/** Parse "12%", "$1,200", "(300)", "1 234.5", "€ 9" → number (or null). */
export function parseLooseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;
  let s = raw.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/(?:[$€£¥₪₹]|USD|EUR|GBP|ILS)/gi, "").replace(/%$/, "").trim();
  if (!GROUPED_NUM_RE.test(s) && !PLAIN_NUM_RE.test(s)) return null;
  const n = Number(s.replace(/[,  ]/g, ""));
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** Sort key for ordinal time strings (quarters, months, clock times). */
export function timeKey(raw: unknown, fmt: TimeFormat): number | null {
  if (fmt === "date" || fmt === "year") return typeof raw === "number" ? raw : null;
  const s = String(raw).trim();
  if (fmt === "quarter") {
    const m = QUARTER_RE.exec(s);
    if (!m) return null;
    const year = Number(m[1] ?? m[4]);
    const q = Number(m[2] ?? m[3]);
    return year * 4 + (q - 1);
  }
  if (fmt === "month") {
    const i = MONTHS.indexOf(s.slice(0, 3).toLowerCase());
    return i === -1 ? null : i;
  }
  const m = CLOCK_RE.exec(s);
  if (!m) return null;
  const [h, mi, se] = s.split(":").map(Number);
  return h * 3600 + mi * 60 + (se ?? 0);
}

function isMonthName(s: string): boolean {
  const lower = s.toLowerCase();
  return MONTHS.some((m) => lower === m || (lower.startsWith(m) && /^[a-z]+\.?$/.test(lower) && lower.length <= 9));
}

function share(values: unknown[], pred: (s: string) => boolean): number {
  if (values.length === 0) return 0;
  let n = 0;
  for (const v of values) if (pred(String(v).trim())) n++;
  return n / values.length;
}

function numericStats(nums: number[]) {
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  for (const n of nums) {
    if (n < min) min = n;
    if (n > max) max = n;
    sum += n;
  }
  return { min, max, sum, nonNegative: min >= 0 };
}

function profileOne(col: DataColumn, rows: DataSet["rows"]): ColumnProfile {
  const values = nonNull(rows.map((r) => r[col.key]));
  const base = { key: col.key, name: col.name, distinct: col.distinct, filled: values.length };
  if (values.length === 0) return { ...base, semantic: "empty" };

  if (col.type === "date") {
    return { ...base, semantic: "time", timeFormat: "date", min: col.minDate, max: col.maxDate };
  }

  if (col.type === "number") {
    const nums = values as number[];
    const stats = numericStats(nums);
    const integers = nums.every((n) => Number.isInteger(n));
    if (LAT_NAME_RE.test(col.name) && stats.min >= -90 && stats.max <= 90) {
      return { ...base, ...stats, semantic: "latitude" };
    }
    if (LON_NAME_RE.test(col.name) && stats.min >= -180 && stats.max <= 180) {
      return { ...base, ...stats, semantic: "longitude" };
    }
    // Years: integers in 1800–2100 that are either named like a year or
    // form a strictly monotonic, unique sequence (1999, 2000, 2001…).
    const monotonic =
      nums.length >= 3 &&
      (nums.every((n, i) => i === 0 || n > nums[i - 1]) || nums.every((n, i) => i === 0 || n < nums[i - 1]));
    if (integers && stats.min >= 1800 && stats.max <= 2100 && (YEAR_NAME_RE.test(col.name) || monotonic)) {
      return { ...base, ...stats, semantic: "time", timeFormat: "year" };
    }
    if (integers && ID_NAME_RE.test(col.name) && col.distinct === values.length) {
      return { ...base, ...stats, semantic: "id" };
    }
    return { ...base, ...stats, semantic: "numeric" };
  }

  if (col.type === "boolean") return { ...base, semantic: "categorical" };

  // String column — look for numbers the CSV parser left as text.
  if (share(values, (s) => PERCENT_RE.test(s)) >= 0.9) {
    const nums = values.map(parseLooseNumber).filter((n): n is number => n !== null);
    return { ...base, ...numericStats(nums), semantic: "percent" };
  }
  if (share(values, (s) => CURRENCY_RE.test(s)) >= 0.9) {
    const nums = values.map(parseLooseNumber).filter((n): n is number => n !== null);
    return { ...base, ...numericStats(nums), semantic: "currency" };
  }
  if (share(values, (s) => GROUPED_NUM_RE.test(s) || PLAIN_NUM_RE.test(s)) >= 0.9) {
    const nums = values.map(parseLooseNumber).filter((n): n is number => n !== null);
    return { ...base, ...numericStats(nums), semantic: "numeric" };
  }
  for (const [fmt, pred] of [
    ["quarter", (s: string) => QUARTER_RE.test(s)],
    ["month", isMonthName],
    ["clock", (s: string) => CLOCK_RE.test(s)],
  ] as const) {
    if (share(values, pred) >= 0.9) return { ...base, semantic: "time", timeFormat: fmt };
  }
  return { ...base, semantic: col.distinct <= 50 ? "categorical" : "text" };
}

export function profileColumns(ds: DataSet): ColumnProfile[] {
  return ds.columns.map((c) => profileOne(c, ds.rows));
}

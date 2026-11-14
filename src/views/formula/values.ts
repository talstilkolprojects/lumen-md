/**
 * Formula values (plan 4.11): how frontmatter becomes a formula value, how
 * values convert, compare and print. The semantics follow the database
 * filter (databaseFilter.ts): numbers stay numbers, `YYYY-MM-DD` text is a
 * date when compared, a list equals a value it holds, empty is `null`.
 * All dates are UTC, so a formula gives the same answer in every time zone.
 */

import { FormulaError, type FormulaValue } from "./ast";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NUMERIC = /^\s*-?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?\s*$/i;

/** A frontmatter value as a formula value. Maps (and anything else) are `null`. */
export function fromFrontmatter(v: unknown, depth = 0): FormulaValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (Array.isArray(v) && depth < 4) return v.map((x) => fromFrontmatter(x, depth + 1));
  return null;
}

export const isEmpty = (v: FormulaValue): boolean => v === null || v === "" || (Array.isArray(v) && v.length === 0);

export function truthy(v: FormulaValue): boolean {
  return !isEmpty(v) && v !== false && v !== 0;
}

/** A date, from a Date or ISO text; null when it is not one. */
export function asDate(v: FormulaValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string" && ISO_DATE.test(v.trim())) {
    const s = v.trim().replace(" ", "T");
    // A bare date is midnight UTC, and a time without an offset is UTC too:
    // Date.parse would read "2026-10-20T12:00" in the machine's time zone.
    const t = Date.parse(s.length === 10 ? `${s}T00:00:00Z` : /(?:Z|[+-]\d{2}:?\d{2})$/.test(s) ? s : `${s}Z`);
    if (Number.isNaN(t)) return null;
    const d = new Date(t);
    // Date.parse rolls 2026-02-30 over to March 2: a day that does not exist is not a date.
    const [y, m, day] = s.slice(0, 10).split("-").map(Number);
    if (/(?:Z|[+-]\d{2}:?\d{2})$/.test(s) && s.length > 10) {
      const local = utcDate(y, m - 1, day);
      if (local.getUTCFullYear() !== y || local.getUTCMonth() !== m - 1 || local.getUTCDate() !== day) return null;
    } else if (d.getUTCFullYear() !== y || d.getUTCMonth() !== m - 1 || d.getUTCDate() !== day) return null;
    return d;
  }
  return null;
}

/**
 * A UTC date from its parts. Not `Date.UTC`, which maps years 0–99 to 1900–1999:
 * `0099-01-15` is in the year 99. Months and days out of range roll over as usual.
 */
export function utcDate(y: number, m: number, d: number, h = 0, mi = 0, s = 0, ms = 0): Date {
  const out = new Date(0);
  out.setUTCFullYear(y, m, d);
  out.setUTCHours(h, mi, s, ms);
  return out;
}

/** Number for arithmetic; `null` stays null (an empty property empties the result). */
export function toNumber(v: FormulaValue, what: string, at: number): number | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (typeof v === "string" && NUMERIC.test(v)) {
    // "1e999" is numeric text but not a finite number: never let Infinity through.
    const n = Number(v);
    if (!Number.isFinite(n)) throw new FormulaError("math", `${what}: the number is too large`, at);
    return n;
  }
  throw new FormulaError("type", `${what} needs a number, not ${describe(v)}`, at);
}

export function describe(v: FormulaValue): string {
  if (v === null) return "empty";
  if (v instanceof Date) return "a date";
  if (Array.isArray(v)) return "a list";
  if (typeof v === "string") return `the text "${v.length > 20 ? v.slice(0, 20) + "…" : v}"`;
  return `the ${typeof v} ${String(v)}`;
}

/**
 * Floating-point noise off: 0.1 + 0.2 is 0.3. An integer is kept exactly as
 * it is — 1000000000000001 + 0 stays 1000000000000001 (review #267); only a
 * fractional result is rounded to 15 significant digits.
 */
export function clean(n: number, at: number): number {
  if (!Number.isFinite(n)) throw new FormulaError("math", "the result is not a finite number", at);
  if (n === 0) return 0;
  if (Number.isInteger(n)) return n;
  return Number(n.toPrecision(15));
}

/** `YYYY-MM-DD`, or with the time (UTC) when it is not midnight. */
export function formatDate(d: Date): string {
  const iso = d.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso.slice(0, 16).replace("T", " ");
}

/** How a value reads in a cell and in text joins. */
export function toText(v: FormulaValue): string {
  if (v === null) return "";
  if (v instanceof Date) return formatDate(v);
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (typeof v === "number") return String(v);
  return String(v);
}

/** Numbers stay numbers; dates (and ISO date text) compare by time; the rest as text. */
function comparable(v: FormulaValue): number | string | null {
  if (v === null || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    const d = asDate(v);
    if (d) return d.getTime();
    if (NUMERIC.test(v)) {
      // "1e999" and "1e998" would both be Infinity, and equal: an overflow is a math error, as in arithmetic.
      const n = Number(v);
      if (!Number.isFinite(n)) throw new FormulaError("math", "the number is too large to compare");
      return n;
    }
    return v;
  }
  return toText(v);
}

export function equal(a: FormulaValue, b: FormulaValue): boolean {
  // A list equals a value it holds (`tags = "fav"`), as in the filter.
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => equal(x, b));
  if (Array.isArray(b) && !Array.isArray(a)) return equal(b, a);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return x === y;
  if (typeof x === "number" && typeof y === "number") return x === y;
  return String(x).toLowerCase() === String(y).toLowerCase();
}

/** -1 / 0 / 1, or null when either side is empty (an empty value is never < or >). */
export function order(a: FormulaValue, b: FormulaValue): number | null {
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return null;
  if (typeof x === "number" && typeof y === "number") return x < y ? -1 : x > y ? 1 : 0;
  // Code-point order, not localeCompare: the same answer in every locale (and alphabetical for Hebrew).
  const a2 = String(x);
  const b2 = String(y);
  return a2 < b2 ? -1 : a2 > b2 ? 1 : 0;
}

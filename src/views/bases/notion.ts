/**
 * Notion's formula functions (formulas 2.0) in the Bases interpreter (plan
 * W6.46), so a database imported from Notion keeps its formulas, and a Bases
 * user can write `dateBetween(due, today(), "days")` or
 * `relation.tasks.map(current.prop("Estimate")).sum()`.
 *
 * Chosen from Notion's reference (notion.com/help/formula-syntax) by what
 * real formulas use most: dates, text, numbers, logic and lists with
 * `current` / `index`. Plus two for Hebrew: `hebrewDate()` (the Hebrew
 * calendar, from the platform's Intl) and `stripNikud()`.
 *
 * Where a Notion name is already an Obsidian global (`if`, `min`, `max`,
 * `empty`, `now`, `today`, `link`, `date`, `list`, `number`) Obsidian's
 * meaning stays: a `.base` file must mean what it means in Obsidian. Notion's
 * `date()` (day of the month) is `dayOfMonth()` here; `link(label, url)` and
 * `style()` have no Bases equivalent and are not offered.
 *
 * Semantics follow Notion's documentation: `day()` is 1 (Monday) … 7
 * (Sunday); `week()` the ISO week; `month()` 1 … 12; `dateBetween(a, b, u)`
 * is a − b in whole units, toward zero; `round(n, places)`; `replace()` the
 * first match and `replaceAll()` every match of a regular expression;
 * indexes are 0-based and a negative index counts from the end.
 */

import { FormulaError } from "../formula/ast";
import { utcDate } from "../formula/values";
import { equalValues, isEmptyValue, isTagged, sortCompare, toDate, toText, type BValue } from "./values";

/** Notion functions whose arguments are evaluated lazily (conditions, names, per-item expressions). */
export const NOTION_LAZY = ["ifs", "let", "lets", "map", "filter", "find", "findIndex", "some", "every", "count"] as const;

/** Notion functions with ordinary arguments. */
export const NOTION_EAGER = [
  // logic
  "equal", "unequal",
  // text
  "length", "substring", "contains", "test", "match", "replace", "replaceAll", "lower", "upper", "trim", "repeat", "split", "join", "format", "concat",
  // numbers
  "add", "subtract", "multiply", "divide", "mod", "pow", "abs", "round", "ceil", "floor", "sqrt", "cbrt", "sign", "exp", "ln", "log10", "log2", "sum", "mean", "median", "toNumber", "pi", "e",
  // dates
  "dateAdd", "dateSubtract", "dateBetween", "formatDate", "parseDate", "timestamp", "fromTimestamp", "year", "month", "week", "day", "dayOfMonth", "hour", "minute",
  // lists
  "at", "first", "last", "slice", "sort", "reverse", "unique", "includes", "flat",
  // properties and lookups through relations
  "prop", "lookup",
  // Hebrew
  "hebrewDate", "stripNikud",
] as const;

export const NOTION_FUNCTIONS: readonly string[] = [...NOTION_LAZY, ...NOTION_EAGER];

const UNITS: Record<string, string> = {
  year: "years", years: "years", quarter: "quarters", quarters: "quarters", month: "months", months: "months", week: "weeks", weeks: "weeks",
  day: "days", days: "days", hour: "hours", hours: "hours", minute: "minutes", minutes: "minutes", second: "seconds", seconds: "seconds", millisecond: "milliseconds", milliseconds: "milliseconds",
};
const MS: Record<string, number> = { weeks: 7 * 86_400_000, days: 86_400_000, hours: 3_600_000, minutes: 60_000, seconds: 1000, milliseconds: 1 };

function unitOf(v: BValue, what: string, at: number): string {
  const u = UNITS[toText(v).trim().toLowerCase()];
  if (!u) throw new FormulaError("type", `${what}: the unit is one of years, quarters, months, weeks, days, hours, minutes, seconds, milliseconds`, at);
  return u;
}

function dateArg(v: BValue | undefined, what: string, at: number): Date {
  const d = v === undefined || v === null ? null : toDate(v);
  if (!d) throw new FormulaError("type", `${what} needs a date`, at);
  return d;
}

function num(v: BValue | undefined, what: string, at: number): number {
  const n = typeof v === "number" ? v : typeof v === "boolean" ? (v ? 1 : 0) : typeof v === "string" && v.trim() !== "" ? Number(v) : v instanceof Date ? v.getTime() : Number.NaN;
  if (!Number.isFinite(n)) throw new FormulaError("type", `${what} needs a number, not "${toText(v ?? null)}"`, at);
  return n;
}

const clean = (n: number, at: number) => {
  if (!Number.isFinite(n)) throw new FormulaError("math", "the result is not a finite number", at);
  return Number.isInteger(n) ? n : Number(n.toPrecision(15));
};

/** Months added the way calendars do: Jan 31 + 1 month is the last day of February. */
function addMonths(d: Date, n: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + n;
  const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return utcDate(y, m, Math.min(d.getUTCDate(), last), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

export function dateAdd(d: Date, amount: number, unit: string): Date {
  if (unit === "years") return addMonths(d, 12 * amount);
  if (unit === "quarters") return addMonths(d, 3 * amount);
  if (unit === "months") return addMonths(d, amount);
  return new Date(d.getTime() + amount * MS[unit]);
}

/** a − b in whole `unit`s, toward zero (Notion's dateBetween). */
export function dateBetween(a: Date, b: Date, unit: string): number {
  if (unit === "years" || unit === "quarters" || unit === "months") {
    const sign = a.getTime() >= b.getTime() ? 1 : -1;
    const [hi, lo] = sign > 0 ? [a, b] : [b, a];
    let months = (hi.getUTCFullYear() - lo.getUTCFullYear()) * 12 + (hi.getUTCMonth() - lo.getUTCMonth());
    if (addMonths(lo, months).getTime() > hi.getTime()) months--;
    const per = unit === "years" ? 12 : unit === "quarters" ? 3 : 1;
    return sign * Math.floor(months / per);
  }
  return Math.trunc((a.getTime() - b.getTime()) / MS[unit]);
}

/** ISO 8601 week number (weeks start on Monday; week 1 holds the year's first Thursday). */
export function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - y0.getTime()) / 86_400_000 + 1) / 7);
}

const NIKUD = /[֑-ׇֽֿׁׂׅׄ]/g;

/** A number in Hebrew letters (gematria), as dates are written: 5 → ה׳, 15 → ט״ו, 5787 → תשפ״ז (thousands left out). */
export function hebrewNumeral(n: number): string {
  let v = Math.floor(Math.abs(n)) % 1000;
  if (!v) return "";
  const out: string[] = [];
  for (const [k, l] of [[400, "ת"], [300, "ש"], [200, "ר"], [100, "ק"]] as const) while (v >= k) (out.push(l), (v -= k));
  if (v === 15 || v === 16) out.push("ט", v === 15 ? "ו" : "ז");
  else {
    const tens = "יכלמנסעפצ";
    const ones = "אבגדהוזחט";
    if (v >= 10) out.push(tens[Math.floor(v / 10) - 1]);
    if (v % 10) out.push(ones[(v % 10) - 1]);
  }
  return out.length === 1 ? `${out[0]}׳` : `${out.slice(0, -1).join("")}״${out[out.length - 1]}`;
}

/**
 * A date in the Hebrew calendar, in Hebrew ("ב׳ בכסלו תשפ״ז"); `part`: day,
 * month or year alone. The calendar comes from the platform's Intl; the
 * numerals are written here, since Intl gives Latin digits.
 */
export function hebrewDate(d: Date, part = "full"): string {
  const parts = new Intl.DateTimeFormat("he-IL-u-ca-hebrew", { timeZone: "UTC", day: "numeric", month: "long", year: "numeric" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = hebrewNumeral(Number(get("day")));
  const month = get("month");
  const year = hebrewNumeral(Number(get("year")));
  if (part === "day") return day;
  if (part === "month") return month;
  if (part === "year") return year;
  return `${day} ב${month} ${year}`;
}

function regexOf(v: BValue, global: boolean, at: number): RegExp {
  try {
    if (isTagged(v) && v.$ === "regex") return new RegExp(v.re.source, global ? (v.re.flags.includes("g") ? v.re.flags : `${v.re.flags}g`) : v.re.flags.replace("g", ""));
    return new RegExp(toText(v), global ? "g" : "");
  } catch {
    throw new FormulaError("type", `not a regular expression: "${toText(v)}"`, at);
  }
}

const EMPTY_IN_EMPTY_OUT: ReadonlySet<string> = new Set([
  "add", "subtract", "multiply", "divide", "mod", "pow", "abs", "round", "ceil", "floor", "sqrt", "cbrt", "sign", "exp", "ln", "log10", "log2",
  "dateAdd", "dateSubtract", "dateBetween", "formatDate", "timestamp", "fromTimestamp", "year", "month", "week", "day", "dayOfMonth", "hour", "minute", "hebrewDate",
]);

const listOf = (v: BValue): BValue[] => (Array.isArray(v) ? v : v === null ? [] : [v]);
const indexIn = (n: number, len: number) => (n < 0 ? len + n : n);

/** What a Notion function needs from the interpreter. */
export interface NotionHost {
  text(s: string, at: number): string;
  list(items: BValue[], at: number): BValue[];
  formatDate(d: Date, fmt: string): string;
  /** A note property of the current row (`prop("Status")`), or of a file value (`current.prop("Status")`). */
  prop(of: BValue | undefined, name: string, at: number): BValue;
}

/** Call an eager Notion function. Throws for a name that is not one. */
export function callNotion(name: string, args: BValue[], at: number, host: NotionHost): BValue {
  const arity = (min: number, max: number) => {
    if (args.length < min || args.length > max) throw new FormulaError("arity", `${name}() takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, not ${args.length}`, at);
  };
  const a0 = args[0] ?? null;
  // An empty number or date gives an empty result, as Bases arithmetic does (a row without the property shows nothing).
  if (EMPTY_IN_EMPTY_OUT.has(name) && args.some((x) => isEmptyValue(x))) return null;
  switch (name) {
    case "equal":
      arity(2, 2);
      return equalValues(args[0], args[1]);
    case "unequal":
      arity(2, 2);
      return !equalValues(args[0], args[1]);
    case "length":
      arity(1, 1);
      return Array.isArray(a0) ? a0.length : [...toText(a0)].length;
    case "substring": {
      arity(2, 3);
      const chars = [...toText(a0)];
      return chars.slice(num(args[1], "substring()", at), args[2] === undefined ? undefined : num(args[2], "substring()", at)).join("");
    }
    case "contains":
      arity(2, 2);
      return Array.isArray(a0) ? a0.some((x) => equalValues(x, args[1])) : toText(a0).includes(toText(args[1]));
    case "test":
      arity(2, 2);
      return regexOf(args[1], false, at).test(host.text(toText(a0), at));
    case "match":
      arity(2, 2);
      return host.list(toText(a0).match(regexOf(args[1], true, at)) ?? [], at);
    case "replace":
      arity(3, 3);
      return host.text(toText(a0).replace(regexOf(args[1], false, at), toText(args[2])), at);
    case "replaceAll":
      arity(3, 3);
      return host.text(toText(a0).replace(regexOf(args[1], true, at), toText(args[2])), at);
    case "lower":
      arity(1, 1);
      return toText(a0).toLowerCase();
    case "upper":
      arity(1, 1);
      return toText(a0).toUpperCase();
    case "trim":
      arity(1, 1);
      return toText(a0).trim();
    case "repeat": {
      arity(2, 2);
      const n = num(args[1], "repeat()", at);
      if (!Number.isInteger(n) || n < 0) throw new FormulaError("type", "repeat() needs a count of 0 or more", at);
      return host.text(toText(a0).repeat(Math.min(n, 1_000_000)), at);
    }
    case "split":
      arity(2, 2);
      return host.list(toText(a0).split(toText(args[1])), at);
    case "join":
      arity(2, 2);
      return host.text(listOf(a0).map(toText).join(toText(args[1])), at);
    case "format":
      arity(1, 1);
      return toText(a0);
    case "concat":
      return host.list(args.flatMap(listOf), at);
    case "add":
      arity(2, 2);
      if (typeof args[0] === "string" || typeof args[1] === "string") return host.text(toText(args[0]) + toText(args[1]), at);
      return clean(num(args[0], "add()", at) + num(args[1], "add()", at), at);
    case "subtract":
      arity(2, 2);
      return clean(num(args[0], "subtract()", at) - num(args[1], "subtract()", at), at);
    case "multiply":
      arity(2, 2);
      return clean(num(args[0], "multiply()", at) * num(args[1], "multiply()", at), at);
    case "divide": {
      arity(2, 2);
      const d = num(args[1], "divide()", at);
      if (d === 0) throw new FormulaError("math", "division by zero", at);
      return clean(num(args[0], "divide()", at) / d, at);
    }
    case "mod": {
      arity(2, 2);
      const d = num(args[1], "mod()", at);
      if (d === 0) throw new FormulaError("math", "division by zero", at);
      return clean(num(args[0], "mod()", at) % d, at);
    }
    case "pow":
      arity(2, 2);
      return clean(num(args[0], "pow()", at) ** num(args[1], "pow()", at), at);
    case "abs":
      arity(1, 1);
      return Math.abs(num(a0, "abs()", at));
    case "round": {
      arity(1, 2);
      const places = args[1] === undefined ? 0 : num(args[1], "round()", at);
      if (!Number.isInteger(places) || places < 0 || places > 15) throw new FormulaError("type", "round() places must be a whole number from 0 to 15", at);
      const f = 10 ** places;
      return clean(Math.round(num(a0, "round()", at) * f + Number.EPSILON * Math.sign(num(a0, "round()", at))) / f, at);
    }
    case "ceil":
      arity(1, 1);
      return Math.ceil(num(a0, "ceil()", at));
    case "floor":
      arity(1, 1);
      return Math.floor(num(a0, "floor()", at));
    case "sqrt":
      arity(1, 1);
      return clean(Math.sqrt(num(a0, "sqrt()", at)), at);
    case "cbrt":
      arity(1, 1);
      return clean(Math.cbrt(num(a0, "cbrt()", at)), at);
    case "sign":
      arity(1, 1);
      return Math.sign(num(a0, "sign()", at));
    case "exp":
      arity(1, 1);
      return clean(Math.exp(num(a0, "exp()", at)), at);
    case "ln":
      arity(1, 1);
      return clean(Math.log(num(a0, "ln()", at)), at);
    case "log10":
      arity(1, 1);
      return clean(Math.log10(num(a0, "log10()", at)), at);
    case "log2":
      arity(1, 1);
      return clean(Math.log2(num(a0, "log2()", at)), at);
    case "pi":
      arity(0, 0);
      return Math.PI;
    case "e":
      arity(0, 0);
      return Math.E;
    case "sum":
    case "mean":
    case "median": {
      const ns = args.flatMap(listOf).filter((x) => !isEmptyValue(x)).map((x) => num(x, `${name}()`, at));
      if (name === "sum") return clean(ns.reduce((s, x) => s + x, 0), at);
      if (!ns.length) return null;
      if (name === "mean") return clean(ns.reduce((s, x) => s + x, 0) / ns.length, at);
      const s = [...ns].sort((x, y) => x - y);
      const mid = s.length >> 1;
      return clean(s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2, at);
    }
    case "toNumber": {
      arity(1, 1);
      if (a0 === null || a0 === "") return null;
      if (a0 instanceof Date) return a0.getTime();
      if (typeof a0 === "boolean") return a0 ? 1 : 0;
      const n = Number(toText(a0).trim());
      return Number.isFinite(n) ? n : null;
    }
    case "dateAdd":
    case "dateSubtract": {
      arity(3, 3);
      const d = dateArg(args[0], `${name}()`, at);
      const n = num(args[1], `${name}()`, at);
      return dateAdd(d, name === "dateAdd" ? n : -n, unitOf(args[2], `${name}()`, at));
    }
    case "dateBetween":
      arity(3, 3);
      return dateBetween(dateArg(args[0], "dateBetween()", at), dateArg(args[1], "dateBetween()", at), unitOf(args[2], "dateBetween()", at));
    case "formatDate":
      arity(2, 2);
      return host.text(host.formatDate(dateArg(args[0], "formatDate()", at), toText(args[1])), at);
    case "parseDate": {
      arity(1, 1);
      const d = toDate(toText(a0));
      if (!d) throw new FormulaError("type", `parseDate() needs an ISO date like "2026-11-12", not "${toText(a0)}"`, at);
      return d;
    }
    case "timestamp":
      arity(1, 1);
      return dateArg(a0, "timestamp()", at).getTime();
    case "fromTimestamp":
      arity(1, 1);
      return new Date(num(a0, "fromTimestamp()", at));
    case "year":
      arity(1, 1);
      return dateArg(a0, "year()", at).getUTCFullYear();
    case "month":
      arity(1, 1);
      return dateArg(a0, "month()", at).getUTCMonth() + 1;
    case "week":
      arity(1, 1);
      return isoWeek(dateArg(a0, "week()", at));
    case "day":
      arity(1, 1);
      return dateArg(a0, "day()", at).getUTCDay() || 7;
    case "dayOfMonth":
      arity(1, 1);
      return dateArg(a0, "dayOfMonth()", at).getUTCDate();
    case "hour":
      arity(1, 1);
      return dateArg(a0, "hour()", at).getUTCHours();
    case "minute":
      arity(1, 1);
      return dateArg(a0, "minute()", at).getUTCMinutes();
    case "at": {
      arity(2, 2);
      const l = listOf(a0);
      const i = indexIn(num(args[1], "at()", at), l.length);
      return Number.isInteger(i) && i >= 0 && i < l.length ? l[i] : null;
    }
    case "first":
      arity(1, 1);
      return listOf(a0)[0] ?? null;
    case "last": {
      arity(1, 1);
      const l = listOf(a0);
      return l.length ? l[l.length - 1] : null;
    }
    case "slice": {
      arity(2, 3);
      const l = listOf(a0);
      return l.slice(num(args[1], "slice()", at), args[2] === undefined ? undefined : num(args[2], "slice()", at));
    }
    case "sort":
      arity(1, 1);
      return [...listOf(a0)].sort(sortCompare);
    case "reverse":
      arity(1, 1);
      return Array.isArray(a0) ? [...a0].reverse() : [...toText(a0)].reverse().join("");
    case "unique": {
      arity(1, 1);
      const out: BValue[] = [];
      for (const x of listOf(a0)) if (!out.some((y) => equalValues(x, y))) out.push(x);
      return out;
    }
    case "includes":
      arity(2, 2);
      return listOf(a0).some((x) => equalValues(x, args[1]));
    case "flat":
      arity(1, 1);
      return host.list(listOf(a0).flatMap(listOf), at);
    case "prop":
      arity(1, 1);
      return host.prop(undefined, toText(a0), at);
    case "lookup": {
      arity(2, 2);
      const key = toText(args[1]);
      return host.list(listOf(a0).map((x) => host.prop(x, key, at)), at);
    }
    case "hebrewDate":
      arity(1, 2);
      return hebrewDate(dateArg(a0, "hebrewDate()", at), args[1] === undefined ? "full" : toText(args[1]));
    case "stripNikud":
      arity(1, 1);
      return toText(a0).replace(NIKUD, "");
  }
  throw new FormulaError("unknown-function", `unknown function "${name}"`, at);
}


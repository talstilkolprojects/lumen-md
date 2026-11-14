/**
 * The closed function table for database formulas (plan 4.11). A formula
 * can call these and nothing else; the parser rejects any other name.
 *
 * Every function takes already-evaluated values (except `if`, `and`, `or`,
 * `coalesce`, which the interpreter evaluates lazily) and returns a value or
 * throws `FormulaError`. Work proportional to the size of a value (walking a
 * list, building text) is charged to the evaluation's step budget.
 *
 * Extension point (plan 11.2 — plugin formulas in QuickJS): a plugin host
 * builds a `FunctionTable` that adds entries next to `BUILTIN_FUNCTIONS` and
 * passes it as `functions` to `parseFormula` / `evaluateFormula`. Plugin
 * code still never runs in this interpreter: its `call` would post to the
 * QuickJS sandbox. The built-in table itself is frozen.
 */

import { FormulaError, type Budget, type FormulaValue } from "./ast";
import { asDate, clean, describe, equal, isEmpty, toNumber, toText, truthy, utcDate } from "./values";

export interface CallContext {
  budget: Budget;
  /** Source offset of the call, for errors. */
  at: number;
  /** "Now" for today() / now(): fixed per evaluation, injectable for tests. */
  now: Date;
}

export interface FormulaFunction {
  min: number;
  /** `Infinity` for variadic functions. */
  max: number;
  /** Evaluated by the interpreter itself (lazy arguments): `if`, `and`, `or`, `coalesce`, `prop`. */
  special?: true;
  call?: (args: FormulaValue[], ctx: CallContext) => FormulaValue;
  /** One-line English description, for the docs and the formula agent's prompt. */
  doc: string;
}

export type FunctionTable = Readonly<Record<string, FormulaFunction>>;

const DAY = 86_400_000;

function text(v: FormulaValue, ctx: CallContext): string {
  const s = toText(v);
  if (s.length > ctx.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${ctx.budget.limits.maxText} characters`, ctx.at);
  ctx.budget.tick(Math.ceil(s.length / 64), ctx.at);
  return s;
}

function result(s: string, ctx: CallContext): string {
  if (s.length > ctx.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${ctx.budget.limits.maxText} characters`, ctx.at);
  return s;
}

function num(v: FormulaValue, name: string, ctx: CallContext): number | null {
  return toNumber(v, `${name}()`, ctx.at);
}

function int(v: FormulaValue, name: string, ctx: CallContext, fallback: number): number {
  const n = v === undefined ? fallback : num(v, name, ctx);
  if (n === null) return fallback;
  if (!Number.isInteger(n)) throw new FormulaError("type", `${name}() needs a whole number, not ${n}`, ctx.at);
  return n;
}

function date(v: FormulaValue, name: string, ctx: CallContext): Date | null {
  if (v === null || v === "") return null;
  const d = asDate(v);
  if (!d) throw new FormulaError("type", `${name}() needs a date, not ${describe(v)}`, ctx.at);
  return d;
}

/** Every number in the arguments, lists flattened one level; empty values skipped. */
function numbers(args: FormulaValue[], name: string, ctx: CallContext): number[] {
  const out: number[] = [];
  for (const a of args) {
    const items = Array.isArray(a) ? a : [a];
    ctx.budget.tick(items.length, ctx.at);
    for (const x of items) {
      if (Array.isArray(x)) throw new FormulaError("type", `${name}() takes numbers or a list of numbers`, ctx.at);
      const n = num(x, name, ctx);
      if (n !== null) out.push(n);
    }
  }
  return out;
}

function list(items: FormulaValue[], ctx: CallContext): FormulaValue[] {
  if (items.length > ctx.budget.limits.maxList) throw new FormulaError("limit", `list longer than ${ctx.budget.limits.maxList} items`, ctx.at);
  ctx.budget.tick(items.length, ctx.at);
  return items;
}

const UNITS = ["days", "weeks", "months", "years", "hours", "minutes"] as const;
type Unit = (typeof UNITS)[number];

function unit(v: FormulaValue, name: string, ctx: CallContext): Unit {
  const raw = (v === undefined || v === null ? "days" : toText(v)).toLowerCase().trim();
  const u = (raw.endsWith("s") ? raw : `${raw}s`) as Unit;
  if (!UNITS.includes(u)) throw new FormulaError("type", `${name}() unit must be one of ${UNITS.join(", ")}`, ctx.at);
  return u;
}

function addMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const target = utcDate(y, m, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
  // Clamp the day: Jan 31 + 1 month is Feb 28 (29), not Mar 3.
  const last = utcDate(target.getUTCFullYear(), target.getUTCMonth() + 1, 0).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), last));
  return target;
}

function checkedDate(ms: number, ctx: CallContext): Date {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new FormulaError("math", "the date is out of range", ctx.at);
  return d;
}

const startOfDay = (d: Date) => utcDate(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()).getTime();

const BUILTINS: Record<string, FormulaFunction> = {
  /* ─── logic ─── */
  if: { min: 2, max: 3, special: true, doc: "if(condition, then, else?) — `then` when the condition holds, else `else` (empty when left out)" },
  and: { min: 1, max: Infinity, special: true, doc: "and(a, b, …) — true when every argument holds" },
  or: { min: 1, max: Infinity, special: true, doc: "or(a, b, …) — true when any argument holds" },
  coalesce: { min: 1, max: Infinity, special: true, doc: "coalesce(a, b, …) — the first argument that is not empty" },
  prop: { min: 1, max: 1, special: true, doc: 'prop("name") — the property called name (for names with spaces or symbols)' },
  not: { min: 1, max: 1, doc: "not(x) — true when x does not hold", call: ([a]) => !truthy(a) },
  empty: { min: 1, max: 1, doc: "empty(x) — true when x is empty (no value, empty text or empty list)", call: ([a]) => isEmpty(a) },

  /* ─── text ─── */
  concat: { min: 0, max: Infinity, doc: "concat(a, b, …) — the arguments joined as text", call: (args, ctx) => result(args.map((a) => text(a, ctx)).join(""), ctx) },
  len: { min: 1, max: 1, doc: "len(x) — characters in text, or items in a list", call: ([a], ctx) => (Array.isArray(a) ? a.length : [...text(a, ctx)].length) },
  upper: { min: 1, max: 1, doc: "upper(text) — in capitals", call: ([a], ctx) => text(a, ctx).toUpperCase() },
  lower: { min: 1, max: 1, doc: "lower(text) — in small letters", call: ([a], ctx) => text(a, ctx).toLowerCase() },
  trim: { min: 1, max: 1, doc: "trim(text) — without spaces at either end", call: ([a], ctx) => text(a, ctx).trim() },
  contains: {
    min: 2,
    max: 2,
    doc: "contains(textOrList, value) — text holds the value (ignoring case), or a list has it",
    call: ([a, b], ctx) => {
      if (Array.isArray(a)) {
        ctx.budget.tick(a.length, ctx.at);
        return a.some((x) => equal(x, b));
      }
      return text(a, ctx).toLowerCase().includes(text(b, ctx).toLowerCase());
    },
  },
  startswith: { min: 2, max: 2, doc: "startswith(text, prefix) — ignoring case", call: ([a, b], ctx) => text(a, ctx).toLowerCase().startsWith(text(b, ctx).toLowerCase()) },
  endswith: { min: 2, max: 2, doc: "endswith(text, suffix) — ignoring case", call: ([a, b], ctx) => text(a, ctx).toLowerCase().endsWith(text(b, ctx).toLowerCase()) },
  replace: {
    min: 3,
    max: 3,
    doc: "replace(text, find, with) — every occurrence of find (plain text, not a pattern) replaced",
    call: ([a, b, c], ctx) => {
      const s = text(a, ctx);
      const find = text(b, ctx);
      if (!find) return s;
      const by = text(c, ctx);
      const parts = s.split(find);
      ctx.budget.tick(parts.length, ctx.at);
      // Check the size of the result before building it: replace(repeat("a", 20000), "a", repeat("b", 20000))
      // would otherwise allocate ~400 million characters first.
      const projected = s.length + (parts.length - 1) * (by.length - find.length);
      if (projected > ctx.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${ctx.budget.limits.maxText} characters`, ctx.at);
      ctx.budget.tick(Math.ceil(projected / 64), ctx.at);
      return parts.join(by);
    },
  },
  slice: {
    min: 2,
    max: 3,
    doc: "slice(text, start, end?) — characters from start (0-based) up to end; negative counts from the end",
    call: ([a, b, c], ctx) => {
      const chars = [...text(a, ctx)];
      return chars.slice(int(b, "slice", ctx, 0), c === undefined ? undefined : int(c, "slice", ctx, chars.length)).join("");
    },
  },
  left: { min: 2, max: 2, doc: "left(text, n) — the first n characters", call: ([a, b], ctx) => [...text(a, ctx)].slice(0, Math.max(0, int(b, "left", ctx, 0))).join("") },
  right: {
    min: 2,
    max: 2,
    doc: "right(text, n) — the last n characters",
    call: ([a, b], ctx) => {
      const n = Math.max(0, int(b, "right", ctx, 0));
      return n === 0 ? "" : [...text(a, ctx)].slice(-n).join("");
    },
  },
  repeat: {
    min: 2,
    max: 2,
    doc: "repeat(text, n) — the text n times",
    call: ([a, b], ctx) => {
      const s = text(a, ctx);
      const n = int(b, "repeat", ctx, 0);
      if (n < 0) throw new FormulaError("type", "repeat() needs a count of 0 or more", ctx.at);
      if (s.length * n > ctx.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${ctx.budget.limits.maxText} characters`, ctx.at);
      ctx.budget.tick(Math.ceil((s.length * n) / 64), ctx.at);
      return s.repeat(n);
    },
  },
  join: {
    min: 1,
    max: 2,
    doc: 'join(list, separator?) — the items as one text, separated by ", " unless given',
    call: ([a, b], ctx) => {
      const items = Array.isArray(a) ? a : [a];
      ctx.budget.tick(items.length, ctx.at);
      const parts = items.map((x) => text(x, ctx));
      const sep = b === undefined ? ", " : text(b, ctx);
      // Check the size of the result before building it: 2000 items joined by a 20000-character
      // separator would otherwise allocate ~40 million characters first.
      const projected = parts.reduce((n, p) => n + p.length, 0) + Math.max(0, parts.length - 1) * sep.length;
      if (projected > ctx.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${ctx.budget.limits.maxText} characters`, ctx.at);
      ctx.budget.tick(Math.ceil(projected / 64), ctx.at);
      return parts.join(sep);
    },
  },
  split: {
    min: 2,
    max: 2,
    doc: "split(text, separator) — a list of the parts",
    call: ([a, b], ctx) => {
      const s = text(a, ctx);
      const sep = text(b, ctx);
      return list(sep ? s.split(sep) : [...s], ctx);
    },
  },
  text: { min: 1, max: 1, doc: "text(x) — x as text (dates as YYYY-MM-DD, lists comma-separated)", call: ([a], ctx) => text(a, ctx) },
  number: {
    min: 1,
    max: 1,
    doc: "number(x) — x as a number (text like \"12.5\", true → 1, a date → milliseconds); empty when it is not one, a math error when it is too large",
    call: ([a]) => {
      if (a instanceof Date) return a.getTime();
      if (Array.isArray(a)) return null;
      try {
        return toNumber(a, "number()", -1);
      } catch (e) {
        // Too large to be a number is a math error, as in arithmetic — not "empty" (review #267).
        if (e instanceof FormulaError && e.code === "math") throw e;
        return null;
      }
    },
  },

  /* ─── math ─── */
  abs: { min: 1, max: 1, doc: "abs(x) — without its sign", call: ([a], ctx) => nullable(num(a, "abs", ctx), Math.abs) },
  round: {
    min: 1,
    max: 2,
    doc: "round(x, digits?) — to the nearest whole number, or to that many decimal places (halves away from zero)",
    call: ([a, b], ctx) => {
      const n = num(a, "round", ctx);
      if (n === null) return null;
      const d = int(b, "round", ctx, 0);
      if (d < -15 || d > 15) throw new FormulaError("type", "round() digits must be between -15 and 15", ctx.at);
      // A whole number has nothing to round to the right of the point.
      if (Number.isInteger(n) && d >= 0) return n;
      // Shift by the decimal exponent, not by multiplying, so 1.005 rounds to 1.01. The value is
      // written in exponential form first, so 1e308 shifts its exponent instead of getting a
      // second one ("1e+308e1") (review #267).
      const shift = (v: number, k: number) => {
        const [m, e] = v.toExponential().split("e");
        return Number(`${m}e${Number(e) + k}`);
      };
      const shifted = shift(Math.abs(n), d);
      if (!Number.isFinite(shifted)) throw new FormulaError("math", "round(): the number is too large", ctx.at);
      const r = shift(Math.round(shifted), -d);
      return clean(Math.sign(n) * r, ctx.at);
    },
  },
  floor: { min: 1, max: 1, doc: "floor(x) — down to a whole number", call: ([a], ctx) => nullable(num(a, "floor", ctx), Math.floor) },
  ceil: { min: 1, max: 1, doc: "ceil(x) — up to a whole number", call: ([a], ctx) => nullable(num(a, "ceil", ctx), Math.ceil) },
  sqrt: {
    min: 1,
    max: 1,
    doc: "sqrt(x) — the square root",
    call: ([a], ctx) => {
      const n = num(a, "sqrt", ctx);
      if (n === null) return null;
      if (n < 0) throw new FormulaError("math", "sqrt() of a negative number", ctx.at);
      return clean(Math.sqrt(n), ctx.at);
    },
  },
  pow: {
    min: 2,
    max: 2,
    doc: "pow(x, y) — x to the power y (same as x ^ y)",
    call: ([a, b], ctx) => {
      const x = num(a, "pow", ctx);
      const y = num(b, "pow", ctx);
      return x === null || y === null ? null : clean(x ** y, ctx.at);
    },
  },
  mod: {
    min: 2,
    max: 2,
    doc: "mod(x, y) — the remainder of x / y, with the sign of y",
    call: ([a, b], ctx) => {
      const x = num(a, "mod", ctx);
      const y = num(b, "mod", ctx);
      if (x === null || y === null) return null;
      if (y === 0) throw new FormulaError("math", "mod() by zero", ctx.at);
      return clean(((x % y) + y) % y, ctx.at);
    },
  },
  min: { min: 1, max: Infinity, doc: "min(a, b, … or a list) — the smallest number; empty values skipped", call: (args, ctx) => pick(numbers(args, "min", ctx), Math.min) },
  max: { min: 1, max: Infinity, doc: "max(a, b, … or a list) — the largest number; empty values skipped", call: (args, ctx) => pick(numbers(args, "max", ctx), Math.max) },
  sum: { min: 1, max: Infinity, doc: "sum(a, b, … or a list) — the total; empty values skipped", call: (args, ctx) => clean(numbers(args, "sum", ctx).reduce((s, x) => s + x, 0), ctx.at) },
  avg: {
    min: 1,
    max: Infinity,
    doc: "avg(a, b, … or a list) — the average; empty values skipped, empty when there are none",
    call: (args, ctx) => {
      const ns = numbers(args, "avg", ctx);
      return ns.length ? clean(ns.reduce((s, x) => s + x, 0) / ns.length, ctx.at) : null;
    },
  },
  count: {
    min: 1,
    max: Infinity,
    doc: "count(a, b, … or a list) — how many values are not empty",
    call: (args, ctx) => {
      let n = 0;
      for (const a of args) {
        const items = Array.isArray(a) ? a : [a];
        ctx.budget.tick(items.length, ctx.at);
        n += items.filter((x) => !isEmpty(x)).length;
      }
      return n;
    },
  },

  /* ─── dates (UTC) ─── */
  today: { min: 0, max: 0, doc: "today() — today's date", call: (_args, ctx) => new Date(startOfDay(ctx.now)) },
  now: { min: 0, max: 0, doc: "now() — the current date and time", call: (_args, ctx) => new Date(ctx.now.getTime()) },
  date: {
    min: 1,
    max: 3,
    doc: 'date("YYYY-MM-DD") or date(year, month, day) — a date',
    call: (args, ctx) => {
      if (args.length === 1) return date(args[0], "date", ctx);
      if (args.length !== 3) throw new FormulaError("arity", "date() takes one text or year, month, day", ctx.at);
      const [y, m, d] = args.map((x) => int(x, "date", ctx, Number.NaN));
      if ([y, m, d].some(Number.isNaN)) return null;
      const out = checkedDate(utcDate(y, m - 1, d).getTime(), ctx);
      // A day that does not exist (2026-02-30 would roll over to March 2) is an error, as for date("2026-02-30").
      if (out.getUTCFullYear() !== y || out.getUTCMonth() !== m - 1 || out.getUTCDate() !== d) throw new FormulaError("type", `date(): ${y}-${m}-${d} is not a day`, ctx.at);
      return out;
    },
  },
  year: { min: 1, max: 1, doc: "year(date)", call: ([a], ctx) => nullable(date(a, "year", ctx), (d) => d.getUTCFullYear()) },
  month: { min: 1, max: 1, doc: "month(date) — 1 to 12", call: ([a], ctx) => nullable(date(a, "month", ctx), (d) => d.getUTCMonth() + 1) },
  day: { min: 1, max: 1, doc: "day(date) — day of the month, 1 to 31", call: ([a], ctx) => nullable(date(a, "day", ctx), (d) => d.getUTCDate()) },
  weekday: { min: 1, max: 1, doc: "weekday(date) — 1 (Sunday) to 7 (Saturday)", call: ([a], ctx) => nullable(date(a, "weekday", ctx), (d) => d.getUTCDay() + 1) },
  dateadd: {
    min: 2,
    max: 3,
    doc: 'dateadd(date, amount, unit?) — the date moved by amount days (or "weeks", "months", "years", "hours", "minutes")',
    call: ([a, b, c], ctx) => {
      const d = date(a, "dateadd", ctx);
      const n = num(b, "dateadd", ctx);
      if (d === null || n === null) return null;
      const u = unit(c, "dateadd", ctx);
      if (u === "months" || u === "years") {
        if (!Number.isInteger(n)) throw new FormulaError("type", `dateadd() needs whole ${u}`, ctx.at);
        if (Math.abs(n) > 120_000) throw new FormulaError("math", "the date is out of range", ctx.at);
        const r = addMonths(d, u === "years" ? n * 12 : n);
        return checkedDate(r.getTime(), ctx);
      }
      const ms = u === "weeks" ? 7 * DAY : u === "hours" ? 3_600_000 : u === "minutes" ? 60_000 : DAY;
      return checkedDate(d.getTime() + n * ms, ctx);
    },
  },
  datediff: {
    min: 2,
    max: 3,
    doc: 'datediff(later, earlier, unit?) — whole days (or "weeks", "months", "years", "hours", "minutes") from earlier to later',
    call: ([a, b, c], ctx) => {
      const x = date(a, "datediff", ctx);
      const y = date(b, "datediff", ctx);
      if (x === null || y === null) return null;
      const u = unit(c, "datediff", ctx);
      if (u === "months" || u === "years") {
        // Counted from the earlier date to the later, then signed: swapping the dates only
        // flips the sign (month-end clamping made it depend on the order — review #267).
        const [lo, hi, sign] = x.getTime() >= y.getTime() ? [y, x, 1] : [x, y, -1];
        let months = (hi.getUTCFullYear() - lo.getUTCFullYear()) * 12 + (hi.getUTCMonth() - lo.getUTCMonth());
        // A month is complete only when the day of the month has been reached.
        if (months > 0 && addMonths(lo, months).getTime() > hi.getTime()) months--;
        const signed = sign * months;
        return u === "years" ? Math.trunc(signed / 12) : signed;
      }
      const ms = u === "weeks" ? 7 * DAY : u === "hours" ? 3_600_000 : u === "minutes" ? 60_000 : DAY;
      return Math.trunc((x.getTime() - y.getTime()) / ms);
    },
  },
};

function nullable<T, R extends FormulaValue>(v: T | null, f: (x: T) => R): R | null {
  return v === null ? null : f(v);
}

function pick(ns: number[], f: (...xs: number[]) => number): number | null {
  return ns.length ? ns.reduce((acc, x) => f(acc, x)) : null;
}

/** Aliases, so a formula reads naturally (`length`, `average`, `substring`, `ifempty`). */
const ALIASES: Record<string, string> = { length: "len", average: "avg", substring: "slice", ifempty: "coalesce", tonumber: "number", totext: "text", string: "text" };

const table: Record<string, FormulaFunction> = { ...BUILTINS };
for (const [alias, target] of Object.entries(ALIASES)) table[alias] = BUILTINS[target];
for (const f of Object.values(table)) Object.freeze(f);

/** The built-in functions, frozen. Keys are lowercase. */
export const BUILTIN_FUNCTIONS: FunctionTable = Object.freeze(table);

/** Own-property lookup only: `constructor`, `__proto__` and friends are never functions. */
export function lookupFunction(name: string, functions: FunctionTable = BUILTIN_FUNCTIONS): FormulaFunction | undefined {
  return Object.prototype.hasOwnProperty.call(functions, name) ? functions[name] : undefined;
}

export function hasFunction(name: string, functions: FunctionTable = BUILTIN_FUNCTIONS): boolean {
  return lookupFunction(name, functions) !== undefined;
}

export function checkArity(name: string, n: number, at: number, functions: FunctionTable = BUILTIN_FUNCTIONS): void {
  const f = lookupFunction(name, functions);
  if (!f) throw new FormulaError("unknown-function", `unknown function "${name}"`, at);
  if (n < f.min || n > f.max) {
    const want = f.min === f.max ? `${f.min}` : f.max === Infinity ? `at least ${f.min}` : `${f.min} to ${f.max}`;
    throw new FormulaError("arity", `${name}() takes ${want} argument${f.min === 1 && f.max === 1 ? "" : "s"}, not ${n}`, at);
  }
}

/** Names of the built-in functions (without aliases), for docs and prompts. */
export function functionNames(): string[] {
  return Object.keys(BUILTINS);
}

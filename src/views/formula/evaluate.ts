/**
 * The formula interpreter (plan 4.11): walks a `FormulaNode` tree over one
 * database row. It switches over the closed set of node kinds in ast.ts and
 * calls only functions from the table (functions.ts) — no `eval`, no
 * `Function`, no property access on host objects: a field reads the row's
 * own frontmatter keys and nothing else.
 *
 * Every evaluation has a step budget (one step per node visited, plus the
 * work functions report), so a formula always finishes, deterministically.
 * Errors are `FormulaError`; `evaluateFormula` returns them instead of
 * throwing, so a cell can show the message.
 */

import { Budget, DEFAULT_LIMITS, FormulaError, type FormulaLimits, type FormulaNode, type FormulaValue } from "./ast";
import { BUILTIN_FUNCTIONS, lookupFunction, type CallContext, type FunctionTable } from "./functions";
import { parseFormula } from "./parse";
import { asDate, clean, equal, fromFrontmatter, order, toNumber, toText, truthy } from "./values";

/** What a formula reads: the frontmatter, and `file.*` for the note itself. */
export interface FormulaRow {
  fm: Record<string, unknown>;
  file?: { name: string; path: string; folder: string };
}

export interface EvalOptions {
  limits?: Partial<FormulaLimits>;
  functions?: FunctionTable;
  /** "Now" for today() / now(). Default: the current time. */
  now?: Date;
}

export type FormulaResult = { ok: true; value: FormulaValue } | { ok: false; error: FormulaError };

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** `guard` sees the raw frontmatter value before it is copied, so an oversized list fails before any copy (review #267). */
function lookup(row: FormulaRow, path: string[], guard?: (raw: unknown) => void): FormulaValue {
  if (path[0] === "file" && path.length === 2 && row.file && own(row.file, path[1])) return row.file[path[1] as keyof NonNullable<FormulaRow["file"]>];
  let v: unknown = row.fm;
  for (const k of path) {
    if (v === null || typeof v !== "object" || Array.isArray(v) || v instanceof Date) return null;
    if (!own(v, k)) return null;
    v = (v as Record<string, unknown>)[k];
  }
  guard?.(v);
  return fromFrontmatter(v);
}

function arith(op: "+" | "-" | "*" | "/" | "%" | "^", a: FormulaValue, b: FormulaValue, at: number): FormulaValue {
  // Date ± days, date - date (days). ISO text (`due: 2026-11-01` from YAML) is a date here too.
  if (op === "+" || op === "-") {
    const da = typeof a === "string" || a instanceof Date ? asDate(a) : null;
    const db = typeof b === "string" || b instanceof Date ? asDate(b) : null;
    if (da && db) {
      if (op === "+") throw new FormulaError("type", "two dates cannot be added", at);
      return clean((da.getTime() - db.getTime()) / 86_400_000, at);
    }
    if (da) {
      const n = toNumber(b, `date ${op}`, at);
      if (n === null) return null;
      const d = new Date(da.getTime() + (op === "+" ? n : -n) * 86_400_000);
      if (Number.isNaN(d.getTime())) throw new FormulaError("math", "the date is out of range", at);
      return d;
    }
    if (db) throw new FormulaError("type", `a number ${op === "+" ? "plus" : "minus"} a date is not a value; put the date first`, at);
  }
  const what = { "+": "+", "-": "-", "*": "*", "/": "/", "%": "%", "^": "^" }[op];
  const x = toNumber(a, what, at);
  const y = toNumber(b, what, at);
  if (x === null || y === null) return null;
  switch (op) {
    case "+":
      return clean(x + y, at);
    case "-":
      return clean(x - y, at);
    case "*":
      return clean(x * y, at);
    case "/":
      if (y === 0) throw new FormulaError("math", "division by zero", at);
      return clean(x / y, at);
    case "%":
      if (y === 0) throw new FormulaError("math", "remainder of a division by zero", at);
      return clean(x % y, at);
    case "^":
      return clean(x ** y, at);
  }
}

/** Plain text: not a number, not a date. Numeric text too large to be a number is an error, not text. */
const isText = (v: FormulaValue, at: number) => typeof v === "string" && toNumberOrNull(v, at) === null && asDate(v) === null;

function toNumberOrNull(v: string, at: number): number | null {
  try {
    return toNumber(v, "+", at);
  } catch (e) {
    // "abc" is text; "1e999" is a number that overflows — that stays a math error.
    if (e instanceof FormulaError && e.code === "math") throw e;
    return null;
  }
}

class Interpreter {
  readonly budget: Budget;
  readonly now: Date;
  constructor(
    readonly row: FormulaRow,
    readonly functions: FunctionTable,
    limits: FormulaLimits,
    now: Date,
  ) {
    this.budget = new Budget(limits);
    this.now = now;
  }

  /**
   * The raw YAML list sizes, checked (and paid for in steps) before the value
   * is converted — the conversion copies every nested item (depth ≤ 4, as fromFrontmatter).
   */
  checkRaw(raw: unknown, at: number, depth = 0): void {
    if (!Array.isArray(raw) || depth >= 4) return;
    if (raw.length > this.budget.limits.maxList) throw new FormulaError("limit", `list longer than ${this.budget.limits.maxList} items`, at);
    this.budget.tick(raw.length, at);
    for (const x of raw) this.checkRaw(x, at, depth + 1);
  }

  /** A value read from the note obeys the same text / list limits, and costs steps by its size. */
  checkValue(v: FormulaValue, at: number): FormulaValue {
    if (typeof v === "string") {
      this.textLimit(v, at);
      this.budget.tick(Math.ceil(v.length / 64), at);
    } else if (Array.isArray(v)) {
      if (v.length > this.budget.limits.maxList) throw new FormulaError("limit", `list longer than ${this.budget.limits.maxList} items`, at);
      this.budget.tick(v.length, at);
      for (const x of v) this.checkValue(x, at);
    }
    return v;
  }

  textLimit(s: string, at: number): string {
    if (s.length > this.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${this.budget.limits.maxText} characters`, at);
    return s;
  }

  run(n: FormulaNode): FormulaValue {
    this.budget.tick(1, n.at);
    switch (n.kind) {
      case "num":
        return n.value;
      case "str":
        return n.value;
      case "bool":
        return n.value;
      case "null":
        return null;
      case "field":
        return this.checkValue(lookup(this.row, n.path, (raw) => this.checkRaw(raw, n.at)), n.at);
      case "list": {
        if (n.items.length > this.budget.limits.maxList) throw new FormulaError("limit", `list longer than ${this.budget.limits.maxList} items`, n.at);
        return n.items.map((x) => this.run(x));
      }
      case "unary": {
        const v = this.run(n.arg);
        if (n.op === "not") return !truthy(v);
        const x = toNumber(v, `${n.op}`, n.at);
        return x === null ? null : n.op === "-" ? clean(-x, n.at) : x;
      }
      case "binary":
        return this.binary(n);
      case "call":
        return this.call(n);
    }
  }

  binary(n: Extract<FormulaNode, { kind: "binary" }>): FormulaValue {
    if (n.op === "and") return truthy(this.run(n.left)) && truthy(this.run(n.right));
    if (n.op === "or") return truthy(this.run(n.left)) || truthy(this.run(n.right));
    const a = this.run(n.left);
    const b = this.run(n.right);
    switch (n.op) {
      case "=":
        return equal(a, b);
      case "!=":
        return !equal(a, b);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const d = order(a, b);
        if (d === null) return false;
        return n.op === "<" ? d < 0 : n.op === "<=" ? d <= 0 : n.op === ">" ? d > 0 : d >= 0;
      }
      case "&":
        return this.join(a, b, n.at);
      case "+":
        // `+` joins when either side is plain text (not a number or a date), as people expect.
        if (isText(a, n.at) || isText(b, n.at) || Array.isArray(a) || Array.isArray(b)) return this.join(a, b, n.at);
        return arith("+", a, b, n.at);
      default:
        return arith(n.op, a, b, n.at);
    }
  }

  join(a: FormulaValue, b: FormulaValue, at: number): string {
    const s = toText(a) + toText(b);
    this.budget.tick(Math.ceil(s.length / 64), at);
    return this.textLimit(s, at);
  }

  call(n: Extract<FormulaNode, { kind: "call" }>): FormulaValue {
    const f = lookupFunction(n.name, this.functions);
    if (!f) throw new FormulaError("unknown-function", `unknown function "${n.name}"`, n.at);
    if (n.args.length < f.min || n.args.length > f.max) throw new FormulaError("arity", `${n.name}() takes ${f.min === f.max ? f.min : `${f.min}+`} arguments`, n.at);
    // Lazy built-ins: only the branch that is taken runs.
    switch (f.special ? n.name : "") {
      case "if":
        return truthy(this.run(n.args[0])) ? this.run(n.args[1]) : n.args[2] ? this.run(n.args[2]) : null;
      case "and":
        return n.args.every((x) => truthy(this.run(x)));
      case "or":
        return n.args.some((x) => truthy(this.run(x)));
      case "coalesce":
      case "ifempty": {
        for (const x of n.args) {
          const v = this.run(x);
          if (v !== null && v !== "" && !(Array.isArray(v) && v.length === 0)) return v;
        }
        return null;
      }
      case "prop": {
        const a = this.run(n.args[0]);
        return this.checkValue(lookup(this.row, [toText(a)], (raw) => this.checkRaw(raw, n.at)), n.at);
      }
    }
    if (!f.call) throw new FormulaError("unknown-function", `"${n.name}" cannot be called here`, n.at);
    const args = n.args.map((x) => this.run(x));
    const ctx: CallContext = { budget: this.budget, at: n.at, now: this.now };
    const out = f.call(args, ctx);
    if (typeof out === "string") this.textLimit(out, n.at);
    if (Array.isArray(out) && out.length > this.budget.limits.maxList) throw new FormulaError("limit", `list longer than ${this.budget.limits.maxList} items`, n.at);
    if (typeof out === "number" && !Number.isFinite(out)) throw new FormulaError("math", "the result is not a finite number", n.at);
    return out;
  }
}

/** Evaluate a parsed formula over a row. Throws `FormulaError` (and nothing else). */
export function evaluateOrThrow(tree: FormulaNode, row: FormulaRow, opts: EvalOptions = {}): FormulaValue {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const it = new Interpreter(row, opts.functions ?? BUILTIN_FUNCTIONS, limits, opts.now ?? new Date());
  try {
    return it.run(tree);
  } catch (e) {
    if (e instanceof FormulaError) throw e;
    // Nothing else should escape; if it does (a RangeError on a host limit), it is still a typed error.
    throw new FormulaError("limit", (e as Error)?.message ?? "the formula could not be evaluated");
  }
}

/** Evaluate a parsed formula; the value, or the error. Never throws. */
export function evaluate(tree: FormulaNode, row: FormulaRow, opts: EvalOptions = {}): FormulaResult {
  try {
    return { ok: true, value: evaluateOrThrow(tree, row, opts) };
  } catch (e) {
    return { ok: false, error: e instanceof FormulaError ? e : new FormulaError("limit", String(e)) };
  }
}

/** Parse and evaluate in one go. Never throws. */
export function evaluateFormula(src: string, row: FormulaRow, opts: EvalOptions = {}): FormulaResult {
  const p = parseFormula(src, { limits: opts.limits, functions: opts.functions });
  if (!p.ok) return p;
  return evaluate(p.tree, row, opts);
}

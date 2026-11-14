/**
 * Formula parser (plan 4.11): source text → `FormulaNode` tree, by
 * precedence climbing (Pratt). Hand-written and self-contained — no parser
 * dependency — over a closed grammar:
 *
 *   or            a or b, a || b
 *   and           a and b, a && b
 *   not           not a, !a
 *   comparison    =  ==  !=  <>  <  <=  >  >=
 *   concatenation a & b            (text join)
 *   additive      a + b, a - b     (+ also joins when either side is text)
 *   multiplicative a * b, a / b, a % b
 *   unary         -a, +a
 *   power         a ^ b            (right-associative, binds tighter than unary minus on its left)
 *   primary       123  1.5  1e3  "text"  'text'  true  false  null
 *                 field  dotted.field  prop("any name")  [a, b, c]  f(x, y)  ( … )
 *
 * Keywords are case-insensitive; field names may be in any script
 * (`מחיר * כמות`). Parsing never throws anything but `FormulaError`, and
 * enforces the source-length, depth and node-count limits.
 */

import { DEFAULT_LIMITS, FormulaError, type BinaryOp, type FormulaLimits, type FormulaNode } from "./ast";
import { BUILTIN_FUNCTIONS, checkArity, hasFunction, type FunctionTable } from "./functions";

type Tok =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const OPS2 = ["==", "!=", "<>", "<=", ">=", "&&", "||"];
const OPS1 = "+-*/%^&=<>!(),[]";
const ID_START = /[\p{L}\p{M}_]/u;
const ID_PART = /[\p{L}\p{M}\p{N}_]/u;
const DIGIT = /[0-9]/;

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r" || c === " ") {
      i++;
      continue;
    }
    if (c === '"' || c === "'" || c === "“" || c === "”") {
      const close = c === "“" ? "”" : c;
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== close) {
        if (src[j] === "\\" && j + 1 < src.length) {
          j++;
          const e = src[j];
          v += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j++;
          continue;
        }
        v += src[j++];
      }
      if (j >= src.length) throw new FormulaError("syntax", "unclosed text", i);
      out.push({ t: "str", v, at: i });
      i = j + 1;
      continue;
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? ""))) {
      let j = i;
      while (j < src.length && DIGIT.test(src[j])) j++;
      if (src[j] === "." && DIGIT.test(src[j + 1] ?? "")) {
        j++;
        while (j < src.length && DIGIT.test(src[j])) j++;
      }
      if ((src[j] === "e" || src[j] === "E") && (DIGIT.test(src[j + 1] ?? "") || ((src[j + 1] === "+" || src[j + 1] === "-") && DIGIT.test(src[j + 2] ?? "")))) {
        j += 2;
        while (j < src.length && DIGIT.test(src[j])) j++;
      }
      if (j < src.length && ID_START.test(src[j])) throw new FormulaError("syntax", `unexpected "${src[j]}" after a number`, j);
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new FormulaError("math", "the number is too large", i);
      out.push({ t: "num", v, at: i });
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      for (;;) {
        while (j < src.length && ID_PART.test(src[j])) j++;
        // Dotted names (`file.name`); a dot followed by a digit is not one.
        if (src[j] === "." && j + 1 < src.length && ID_START.test(src[j + 1])) {
          j++;
          continue;
        }
        break;
      }
      out.push({ t: "id", v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      out.push({ t: "op", v: two, at: i });
      i += 2;
      continue;
    }
    if (OPS1.includes(c)) {
      out.push({ t: "op", v: c, at: i });
      i++;
      continue;
    }
    throw new FormulaError("syntax", `unexpected "${c}"`, i);
  }
  out.push({ t: "end", at: src.length });
  return out;
}

/** Binding power of each infix operator (higher binds tighter). */
const INFIX: Record<string, { bp: number; op: BinaryOp; right?: boolean }> = {
  or: { bp: 1, op: "or" },
  "||": { bp: 1, op: "or" },
  and: { bp: 2, op: "and" },
  "&&": { bp: 2, op: "and" },
  "=": { bp: 4, op: "=" },
  "==": { bp: 4, op: "=" },
  "!=": { bp: 4, op: "!=" },
  "<>": { bp: 4, op: "!=" },
  "<": { bp: 4, op: "<" },
  "<=": { bp: 4, op: "<=" },
  ">": { bp: 4, op: ">" },
  ">=": { bp: 4, op: ">=" },
  "&": { bp: 5, op: "&" },
  "+": { bp: 6, op: "+" },
  "-": { bp: 6, op: "-" },
  "*": { bp: 7, op: "*" },
  "/": { bp: 7, op: "/" },
  "%": { bp: 7, op: "%" },
  "^": { bp: 9, op: "^", right: true },
};
const NOT_BP = 3;
const UNARY_BP = 8;
const KEYWORDS = new Set(["and", "or", "not", "true", "false", "null"]);

export interface ParseOptions {
  limits?: Partial<FormulaLimits>;
  /** The functions a formula may call (default: the built-ins). See functions.ts for the extension point. */
  functions?: FunctionTable;
}

export type FormulaParse = { ok: true; tree: FormulaNode } | { ok: false; error: FormulaError };

/** Parse a formula. Throws `FormulaError` (and nothing else). */
export function parseFormulaOrThrow(src: string, opts: ParseOptions = {}): FormulaNode {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  const functions = opts.functions ?? BUILTIN_FUNCTIONS;
  if (typeof src !== "string") throw new FormulaError("type", "a formula is text");
  if (src.length > limits.maxLength) throw new FormulaError("limit", `the formula is longer than ${limits.maxLength} characters`, limits.maxLength);
  if (!src.trim()) throw new FormulaError("syntax", "the formula is empty", 0);
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  const peek = () => toks[p];
  const word = (tok: Tok) => (tok.t === "id" ? tok.v.toLowerCase() : null);
  const isOp = (tok: Tok, v: string) => tok.t === "op" && tok.v === v;
  const describe = (tok: Tok) => (tok.t === "end" ? "the formula ends too early" : `unexpected "${tok.t === "num" ? tok.v : tok.t === "str" ? `"${tok.v}"` : tok.v}"`);
  const expect = (v: string) => {
    const tok = toks[p];
    if (!isOp(tok, v)) throw new FormulaError("syntax", tok.t === "end" ? `expected "${v}" before the end` : `expected "${v}"`, tok.at);
    p++;
  };
  const node = <N extends FormulaNode>(n: N, depth: number): N => {
    if (++nodes > limits.maxNodes) throw new FormulaError("limit", `the formula has more than ${limits.maxNodes} parts`, n.at);
    if (depth > limits.maxDepth) throw new FormulaError("limit", `the formula is nested more than ${limits.maxDepth} deep`, n.at);
    return n;
  };

  const args = (close: string, depth: number): FormulaNode[] => {
    const out: FormulaNode[] = [];
    if (isOp(peek(), close)) {
      p++;
      return out;
    }
    for (;;) {
      out.push(expr(0, depth + 1));
      if (isOp(peek(), ",")) {
        p++;
        continue;
      }
      expect(close);
      return out;
    }
  };

  const prefix = (depth: number): FormulaNode => {
    if (depth > limits.maxDepth) throw new FormulaError("limit", `the formula is nested more than ${limits.maxDepth} deep`, peek().at);
    const tok = peek();
    if (tok.t === "num") {
      p++;
      return node({ kind: "num", value: tok.v, at: tok.at }, depth);
    }
    if (tok.t === "str") {
      p++;
      return node({ kind: "str", value: tok.v, at: tok.at }, depth);
    }
    if (tok.t === "op") {
      if (tok.v === "(") {
        p++;
        const inner = expr(0, depth + 1);
        expect(")");
        return inner;
      }
      if (tok.v === "[") {
        p++;
        return node({ kind: "list", items: args("]", depth), at: tok.at }, depth);
      }
      if (tok.v === "-" || tok.v === "+") {
        p++;
        return node({ kind: "unary", op: tok.v, arg: expr(UNARY_BP, depth + 1), at: tok.at }, depth);
      }
      if (tok.v === "!") {
        p++;
        return node({ kind: "unary", op: "not", arg: expr(NOT_BP, depth + 1), at: tok.at }, depth);
      }
      throw new FormulaError("syntax", describe(tok), tok.at);
    }
    if (tok.t === "id") {
      p++;
      const lower = tok.v.toLowerCase();
      if (isOp(peek(), "(")) {
        if (!hasFunction(lower, functions)) throw new FormulaError("unknown-function", `unknown function "${tok.v}"`, tok.at);
        p++;
        const list = args(")", depth);
        checkArity(lower, list.length, tok.at, functions);
        // prop("name") is a field whose name is not a valid identifier.
        if (lower === "prop") {
          const a = list[0];
          if (a.kind !== "str") throw new FormulaError("type", 'prop() takes the property name as text: prop("due date")', tok.at);
          return node({ kind: "field", path: [a.value], at: tok.at }, depth);
        }
        return node({ kind: "call", name: lower, args: list, at: tok.at }, depth);
      }
      if (lower === "true" || lower === "false") return node({ kind: "bool", value: lower === "true", at: tok.at }, depth);
      if (lower === "null") return node({ kind: "null", at: tok.at }, depth);
      if (lower === "not") return node({ kind: "unary", op: "not", arg: expr(NOT_BP, depth + 1), at: tok.at }, depth);
      if (KEYWORDS.has(lower)) throw new FormulaError("syntax", `expected a value before "${tok.v}"`, tok.at);
      return node({ kind: "field", path: tok.v.split("."), at: tok.at }, depth);
    }
    throw new FormulaError("syntax", describe(tok), tok.at);
  };

  const infixOf = (tok: Tok) => {
    if (tok.t === "op") return INFIX[tok.v];
    const w = word(tok);
    return w === "and" || w === "or" ? INFIX[w] : undefined;
  };

  function expr(minBp: number, depth: number): FormulaNode {
    let left = prefix(depth);
    for (;;) {
      const tok = peek();
      const info = infixOf(tok);
      if (!info || info.bp <= minBp) {
        // Comparisons do not chain: `a < b < c` is a mistake, not `(a < b) < c`.
        if (info && info.bp === 4 && minBp === 4) throw new FormulaError("syntax", "comparisons cannot be chained; use and", tok.at);
        break;
      }
      p++;
      const right = expr(info.right ? info.bp - 1 : info.bp, depth + 1);
      left = node({ kind: "binary", op: info.op, left, right, at: tok.at }, depth);
    }
    return left;
  }

  const tree = expr(0, 0);
  const rest = peek();
  if (rest.t !== "end") throw new FormulaError("syntax", describe(rest), rest.at);
  // A left-associative chain (`1+1+1…`) is deep without deep recursion here,
  // but the interpreter recurses along it: bound the real height too.
  if (height(tree, limits.maxDepth) > limits.maxDepth) throw new FormulaError("limit", `the formula is nested more than ${limits.maxDepth} deep`, tree.at);
  return tree;
}

/** Height of the tree, counting stops once it passes `cap`. */
function height(n: FormulaNode, cap: number, d = 1): number {
  if (d > cap) return d;
  let best = d;
  const kids = n.kind === "binary" ? [n.left, n.right] : n.kind === "unary" ? [n.arg] : n.kind === "call" ? n.args : n.kind === "list" ? n.items : [];
  for (const k of kids) {
    best = Math.max(best, height(k, cap, d + 1));
    if (best > cap) return best;
  }
  return best;
}

/** Parse a formula without throwing: the tree, or the error with its position. */
export function parseFormula(src: string, opts: ParseOptions = {}): FormulaParse {
  try {
    return { ok: true, tree: parseFormulaOrThrow(src, opts) };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e };
    // A RangeError from a pathological input is still a formula error to the caller.
    return { ok: false, error: new FormulaError("limit", (e as Error)?.message ?? "the formula could not be parsed") };
  }
}

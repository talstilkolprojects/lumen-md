/**
 * Obsidian Bases expressions (plan W1.11) — the text of a `.base` filter or
 * formula (`file.hasTag("book") && note.rating >= 4`,
 * `(price * qty).toFixed(2)`, `list(tags).map(value.upper())`) parsed into
 * a closed tree. Hand-written, no `eval`, the same limits as the database
 * formulas of plan 4.11 (source length, depth, node count).
 *
 *   or        a || b
 *   and       a && b
 *   equality  ==  !=
 *   compare   <  <=  >  >=
 *   additive  a + b, a - b
 *   multiply  a * b, a / b, a % b
 *   unary     !a, -a
 *   postfix   a.b   a.f(x)   a["key"]   a[0]
 *   primary   123  "text"  'text'  true  false  null  /regex/flags
 *             name  f(x)  [a, b]  {"k": v}  ( … )
 *
 * A call to a global function the table does not know, or a method no type
 * has, is a parse error that names it ("Bases function icon() is not
 * supported here yet"), so a migrated base says exactly what is missing.
 */

import { DEFAULT_LIMITS, FormulaError, type FormulaLimits } from "../formula/ast";

export type BasesBinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/" | "%";

export type BasesNode =
  | { kind: "num"; value: number; at: number }
  | { kind: "str"; value: string; at: number }
  | { kind: "bool"; value: boolean; at: number }
  | { kind: "null"; at: number }
  | { kind: "regex"; source: string; flags: string; at: number }
  | { kind: "name"; name: string; at: number }
  | { kind: "list"; items: BasesNode[]; at: number }
  | { kind: "object"; entries: Array<[string, BasesNode]>; at: number }
  | { kind: "member"; object: BasesNode; name: string; at: number }
  | { kind: "index"; object: BasesNode; index: BasesNode; at: number }
  | { kind: "call"; name: string; args: BasesNode[]; at: number }
  | { kind: "method"; object: BasesNode; name: string; args: BasesNode[]; at: number }
  | { kind: "unary"; op: "!" | "-"; arg: BasesNode; at: number }
  | { kind: "binary"; op: BasesBinaryOp; left: BasesNode; right: BasesNode; at: number };

type Tok =
  | { t: "num"; v: number; at: number }
  | { t: "str"; v: string; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "regex"; source: string; flags: string; at: number }
  | { t: "end"; at: number };

const OPS2 = ["==", "!=", "<=", ">=", "&&", "||"];
const OPS1 = "+-*/%<>!()[]{},.:";
const ID_START = /[\p{L}\p{M}_$]/u;
const ID_PART = /[\p{L}\p{M}\p{N}_$]/u;
const DIGIT = /[0-9]/;

/** A `/` starts a regular expression where a value is expected, else it divides. */
function valueExpected(prev: Tok | undefined): boolean {
  if (!prev) return true;
  if (prev.t === "op") return prev.v !== ")" && prev.v !== "]" && prev.v !== "}";
  return false;
}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let v = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          const e = src[j + 1];
          v += e === "n" ? "\n" : e === "t" ? "\t" : e;
          j += 2;
          continue;
        }
        v += src[j++];
      }
      if (j >= src.length) throw new FormulaError("syntax", "unclosed text", i);
      out.push({ t: "str", v, at: i });
      i = j + 1;
      continue;
    }
    if (c === "/" && valueExpected(out[out.length - 1])) {
      let j = i + 1;
      let inClass = false;
      let source = "";
      while (j < src.length && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\" && j + 1 < src.length) {
          source += src[j] + src[j + 1];
          j += 2;
          continue;
        }
        if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "\n") break;
        source += src[j++];
      }
      if (src[j] !== "/") throw new FormulaError("syntax", "unclosed regular expression", i);
      j++;
      let flags = "";
      while (j < src.length && /[a-z]/i.test(src[j])) flags += src[j++];
      if (!/^[gimsuy]*$/.test(flags)) throw new FormulaError("syntax", `unknown regular expression flag in "${flags}"`, i);
      out.push({ t: "regex", source, flags, at: i });
      i = j;
      continue;
    }
    if (DIGIT.test(c) || (c === "." && DIGIT.test(src[i + 1] ?? "") && valueExpected(out[out.length - 1]))) {
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
      const v = Number(src.slice(i, j));
      if (!Number.isFinite(v)) throw new FormulaError("math", "the number is too large", i);
      out.push({ t: "num", v, at: i });
      i = j;
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && ID_PART.test(src[j])) j++;
      out.push({ t: "id", v: src.slice(i, j), at: i });
      i = j;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (OPS2.includes(two)) {
      // `===` and `!==` read as `==` / `!=` (people paste JavaScript).
      const three = src[i + 2] === "=" && (two === "==" || two === "!=");
      out.push({ t: "op", v: two, at: i });
      i += three ? 3 : 2;
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

const INFIX: Record<string, { bp: number; op: BasesBinaryOp }> = {
  "||": { bp: 1, op: "||" },
  "&&": { bp: 2, op: "&&" },
  "==": { bp: 3, op: "==" },
  "!=": { bp: 3, op: "!=" },
  "<": { bp: 4, op: "<" },
  "<=": { bp: 4, op: "<=" },
  ">": { bp: 4, op: ">" },
  ">=": { bp: 4, op: ">=" },
  "+": { bp: 5, op: "+" },
  "-": { bp: 5, op: "-" },
  "*": { bp: 6, op: "*" },
  "/": { bp: 6, op: "/" },
  "%": { bp: 6, op: "%" },
};
const UNARY_BP = 7;

export interface BasesParseOptions {
  limits?: Partial<FormulaLimits>;
  /** Global function names that may be called (lowercase not required: Bases names are case-sensitive). */
  globals: ReadonlySet<string>;
  /** Every method name some value type has. */
  methods: ReadonlySet<string>;
  /** Names Bases documents but this implementation does not run: a clear error instead of "unknown". */
  unsupported?: ReadonlySet<string>;
}

export type BasesParse = { ok: true; tree: BasesNode } | { ok: false; error: FormulaError };

const unsupportedError = (name: string, at: number) => new FormulaError("unknown-function", `Bases function ${name}() is not supported here yet`, at);

export function parseBasesExpr(src: string, opts: BasesParseOptions): BasesParse {
  try {
    return { ok: true, tree: parseOrThrow(src, opts) };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e };
    return { ok: false, error: new FormulaError("limit", (e as Error)?.message ?? "the expression could not be parsed") };
  }
}

function parseOrThrow(src: string, opts: BasesParseOptions): BasesNode {
  const limits = { ...DEFAULT_LIMITS, ...opts.limits };
  if (typeof src !== "string") throw new FormulaError("type", "an expression is text");
  if (src.length > limits.maxLength) throw new FormulaError("limit", `the expression is longer than ${limits.maxLength} characters`, limits.maxLength);
  if (!src.trim()) throw new FormulaError("syntax", "the expression is empty", 0);
  const toks = tokenize(src);
  let p = 0;
  let nodes = 0;
  const peek = () => toks[p];
  const isOp = (tok: Tok, v: string) => tok.t === "op" && tok.v === v;
  const describe = (tok: Tok) =>
    tok.t === "end" ? "the expression ends too early" : `unexpected "${tok.t === "num" ? tok.v : tok.t === "str" ? `"${tok.v}"` : tok.t === "regex" ? `/${tok.source}/` : tok.v}"`;
  const expect = (v: string) => {
    const tok = toks[p];
    if (!isOp(tok, v)) throw new FormulaError("syntax", tok.t === "end" ? `expected "${v}" before the end` : `expected "${v}"`, tok.at);
    p++;
  };
  const node = <N extends BasesNode>(n: N, depth: number): N => {
    if (++nodes > limits.maxNodes) throw new FormulaError("limit", `the expression has more than ${limits.maxNodes} parts`, n.at);
    if (depth > limits.maxDepth) throw new FormulaError("limit", `the expression is nested more than ${limits.maxDepth} deep`, n.at);
    return n;
  };
  const args = (close: string, depth: number): BasesNode[] => {
    const out: BasesNode[] = [];
    if (isOp(peek(), close)) {
      p++;
      return out;
    }
    for (;;) {
      out.push(expr(0, depth + 1));
      if (isOp(peek(), ",")) {
        p++;
        if (isOp(peek(), close)) {
          p++;
          return out;
        }
        continue;
      }
      expect(close);
      return out;
    }
  };

  const primary = (depth: number): BasesNode => {
    const tok = peek();
    if (tok.t === "num") {
      p++;
      return node({ kind: "num", value: tok.v, at: tok.at }, depth);
    }
    if (tok.t === "str") {
      p++;
      return node({ kind: "str", value: tok.v, at: tok.at }, depth);
    }
    if (tok.t === "regex") {
      p++;
      try {
        new RegExp(tok.source, tok.flags);
      } catch {
        throw new FormulaError("syntax", `not a regular expression: /${tok.source}/`, tok.at);
      }
      return node({ kind: "regex", source: tok.source, flags: tok.flags, at: tok.at }, depth);
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
      if (tok.v === "{") {
        p++;
        const entries: Array<[string, BasesNode]> = [];
        while (!isOp(peek(), "}")) {
          const k = peek();
          if (k.t !== "str" && k.t !== "id") throw new FormulaError("syntax", "an object key is a name or text", k.at);
          p++;
          expect(":");
          entries.push([k.v, expr(0, depth + 1)]);
          if (isOp(peek(), ",")) p++;
          else break;
        }
        expect("}");
        return node({ kind: "object", entries, at: tok.at }, depth);
      }
      if (tok.v === "!" || tok.v === "-") {
        p++;
        return node({ kind: "unary", op: tok.v, arg: expr(UNARY_BP, depth + 1), at: tok.at }, depth);
      }
      if (tok.v === "+") {
        p++;
        return expr(UNARY_BP, depth + 1);
      }
      throw new FormulaError("syntax", describe(tok), tok.at);
    }
    if (tok.t === "id") {
      p++;
      if (isOp(peek(), "(")) {
        if (!opts.globals.has(tok.v)) {
          if (opts.unsupported?.has(tok.v)) throw unsupportedError(tok.v, tok.at);
          throw new FormulaError("unknown-function", `unknown function "${tok.v}"`, tok.at);
        }
        p++;
        return node({ kind: "call", name: tok.v, args: args(")", depth), at: tok.at }, depth);
      }
      if (tok.v === "true" || tok.v === "false") return node({ kind: "bool", value: tok.v === "true", at: tok.at }, depth);
      if (tok.v === "null") return node({ kind: "null", at: tok.at }, depth);
      return node({ kind: "name", name: tok.v, at: tok.at }, depth);
    }
    throw new FormulaError("syntax", describe(tok), tok.at);
  };

  const postfix = (depth: number): BasesNode => {
    let left = primary(depth);
    for (;;) {
      const tok = peek();
      if (isOp(tok, ".")) {
        p++;
        const name = peek();
        if (name.t !== "id") throw new FormulaError("syntax", "expected a name after \".\"", name.at);
        p++;
        if (isOp(peek(), "(")) {
          if (!opts.methods.has(name.v)) {
            if (opts.unsupported?.has(name.v)) throw unsupportedError(name.v, name.at);
            throw new FormulaError("unknown-function", `unknown function "${name.v}"`, name.at);
          }
          p++;
          left = node({ kind: "method", object: left, name: name.v, args: args(")", depth), at: name.at }, depth);
        } else left = node({ kind: "member", object: left, name: name.v, at: name.at }, depth);
        continue;
      }
      if (isOp(tok, "[")) {
        p++;
        const index = expr(0, depth + 1);
        expect("]");
        left = node({ kind: "index", object: left, index, at: tok.at }, depth);
        continue;
      }
      return left;
    }
  };

  function expr(minBp: number, depth: number): BasesNode {
    if (depth > limits.maxDepth) throw new FormulaError("limit", `the expression is nested more than ${limits.maxDepth} deep`, peek().at);
    let left = unaryOrPostfix(depth);
    for (;;) {
      const tok = peek();
      const info = tok.t === "op" ? INFIX[tok.v] : undefined;
      if (!info || info.bp <= minBp) break;
      p++;
      const right = expr(info.bp, depth + 1);
      left = node({ kind: "binary", op: info.op, left, right, at: tok.at }, depth);
    }
    return left;
  }

  function unaryOrPostfix(depth: number): BasesNode {
    const tok = peek();
    if (tok.t === "op" && (tok.v === "!" || tok.v === "-" || tok.v === "+")) return primary(depth);
    return postfix(depth);
  }

  const tree = expr(0, 0);
  const rest = peek();
  if (rest.t !== "end") throw new FormulaError("syntax", describe(rest), rest.at);
  if (height(tree, limits.maxDepth) > limits.maxDepth) throw new FormulaError("limit", `the expression is nested more than ${limits.maxDepth} deep`, tree.at);
  return tree;
}

function children(n: BasesNode): BasesNode[] {
  switch (n.kind) {
    case "binary":
      return [n.left, n.right];
    case "unary":
      return [n.arg];
    case "call":
      return n.args;
    case "method":
      return [n.object, ...n.args];
    case "member":
      return [n.object];
    case "index":
      return [n.object, n.index];
    case "list":
      return n.items;
    case "object":
      return n.entries.map((e) => e[1]);
    default:
      return [];
  }
}

function height(n: BasesNode, cap: number, d = 1): number {
  if (d > cap) return d;
  let best = d;
  for (const k of children(n)) {
    best = Math.max(best, height(k, cap, d + 1));
    if (best > cap) return best;
  }
  return best;
}

/** Every `formula.x` (and `formula["x"]`) the tree reads — for ordering and cycle errors. */
export function formulaRefs(n: BasesNode, out: Set<string> = new Set()): Set<string> {
  if (n.kind === "member" && n.object.kind === "name" && n.object.name === "formula") out.add(n.name);
  if (n.kind === "index" && n.object.kind === "name" && n.object.name === "formula" && n.index.kind === "str") out.add(n.index.value);
  for (const k of children(n)) formulaRefs(k, out);
  return out;
}

/**
 * The database view's filter (plan 4.10): a small expression language over
 * a note's frontmatter, after Dataview's `WHERE` (MIT; the grammar is the
 * reference, none of its code is used).
 *
 *   status = "done" AND (rating >= 4 OR contains(tags, "fav"))
 *   !archived and file.folder = "books"
 *   due < "2026-11-01" || priority != "low"
 *
 * Operators, loosest first: `OR` / `||`, `AND` / `&&`, `NOT` / `!`, then
 * `=` (`==`) `!=` `<` `<=` `>` `>=`. Values: "strings" or 'strings',
 * numbers, `true` `false` `null`, field names (letters of any script,
 * digits, `_` `-`, dotted: `file.name`), and the functions `contains`,
 * `startswith`, `endswith`, `empty`. Keywords are case-insensitive.
 *
 * Parsing never throws: `parseFilter` returns the tree or an error with
 * its position, so the toolbar can point at the mistake.
 */

export type FilterValue = string | number | boolean | null | Date | unknown[] | Record<string, unknown>;

export type FilterNode =
  | { kind: "or" | "and"; items: FilterNode[] }
  | { kind: "not"; item: FilterNode }
  | { kind: "cmp"; op: CmpOp; left: FilterNode; right: FilterNode }
  | { kind: "call"; name: FilterFunction; args: FilterNode[] }
  | { kind: "field"; path: string[] }
  | { kind: "lit"; value: string | number | boolean | null };

export type CmpOp = "=" | "!=" | "<" | "<=" | ">" | ">=";
export type FilterFunction = "contains" | "startswith" | "endswith" | "empty";

export type FilterParse = { ok: true; tree: FilterNode | null } | { ok: false; error: string; at: number };

type Tok =
  | { t: "str"; v: string; at: number }
  | { t: "num"; v: number; at: number }
  | { t: "id"; v: string; at: number }
  | { t: "op"; v: string; at: number }
  | { t: "end"; at: number };

const FUNCTIONS = new Set<FilterFunction>(["contains", "startswith", "endswith", "empty"]);

class FilterSyntaxError extends Error {
  constructor(message: string, readonly at: number) {
    super(message);
  }
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
        if (src[j] === "\\" && j + 1 < src.length) j++;
        v += src[j++];
      }
      if (j >= src.length) throw new FilterSyntaxError("unclosed string", i);
      out.push({ t: "str", v, at: i });
      i = j + 1;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two === "==" ? "=" : two, at: i });
      i += 2;
      continue;
    }
    if ("=<>!(),".includes(c)) {
      out.push({ t: "op", v: c, at: i });
      i++;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?(?![\p{L}\p{N}_])/u.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]), at: i });
      i += num[0].length;
      continue;
    }
    const id = /^[\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}_-]*(?:\.[\p{L}\p{M}\p{N}_][\p{L}\p{M}\p{N}_-]*)*/u.exec(src.slice(i));
    if (id) {
      out.push({ t: "id", v: id[0], at: i });
      i += id[0].length;
      continue;
    }
    throw new FilterSyntaxError(`unexpected "${c}"`, i);
  }
  out.push({ t: "end", at: src.length });
  return out;
}

/** Parse a filter expression; an empty one is no filter (`tree: null`). */
export function parseFilter(src: string): FilterParse {
  if (!src.trim()) return { ok: true, tree: null };
  try {
    const toks = tokenize(src);
    let p = 0;
    const peek = () => toks[p];
    const isWord = (tok: Tok, w: string) => tok.t === "id" && tok.v.toLowerCase() === w;
    const isOp = (tok: Tok, v: string) => tok.t === "op" && tok.v === v;
    const expect = (v: string) => {
      const tok = toks[p];
      if (!isOp(tok, v)) throw new FilterSyntaxError(`expected "${v}"`, tok.at);
      p++;
    };

    const or = (): FilterNode => {
      const items = [and()];
      while (isWord(peek(), "or") || isOp(peek(), "||")) {
        p++;
        items.push(and());
      }
      return items.length === 1 ? items[0] : { kind: "or", items };
    };
    const and = (): FilterNode => {
      const items = [not()];
      while (isWord(peek(), "and") || isOp(peek(), "&&")) {
        p++;
        items.push(not());
      }
      return items.length === 1 ? items[0] : { kind: "and", items };
    };
    const not = (): FilterNode => {
      if (isWord(peek(), "not") || isOp(peek(), "!")) {
        p++;
        return { kind: "not", item: not() };
      }
      return cmp();
    };
    const cmp = (): FilterNode => {
      const left = value();
      const tok = peek();
      if (tok.t === "op" && ["=", "!=", "<", "<=", ">", ">="].includes(tok.v)) {
        p++;
        return { kind: "cmp", op: tok.v as CmpOp, left, right: value() };
      }
      return left;
    };
    const value = (): FilterNode => {
      const tok = peek();
      if (isOp(tok, "(")) {
        p++;
        const inner = or();
        expect(")");
        return inner;
      }
      if (tok.t === "str") {
        p++;
        return { kind: "lit", value: tok.v };
      }
      if (tok.t === "num") {
        p++;
        return { kind: "lit", value: tok.v };
      }
      if (tok.t === "id") {
        p++;
        const lower = tok.v.toLowerCase();
        if (isOp(peek(), "(")) {
          if (!FUNCTIONS.has(lower as FilterFunction)) throw new FilterSyntaxError(`unknown function "${tok.v}"`, tok.at);
          p++;
          const args: FilterNode[] = [];
          if (!isOp(peek(), ")")) {
            args.push(or());
            while (isOp(peek(), ",")) {
              p++;
              args.push(or());
            }
          }
          expect(")");
          const want = lower === "empty" ? 1 : 2;
          if (args.length !== want) throw new FilterSyntaxError(`${lower}() takes ${want} argument${want > 1 ? "s" : ""}`, tok.at);
          return { kind: "call", name: lower as FilterFunction, args };
        }
        if (lower === "true" || lower === "false") return { kind: "lit", value: lower === "true" };
        if (lower === "null") return { kind: "lit", value: null };
        if (["and", "or", "not"].includes(lower)) throw new FilterSyntaxError(`expected a value before "${tok.v}"`, tok.at);
        return { kind: "field", path: tok.v.split(".") };
      }
      throw new FilterSyntaxError(tok.t === "end" ? "expression ends too early" : `unexpected "${(tok as { v: unknown }).v}"`, tok.at);
    };

    const tree = or();
    const rest = peek();
    if (rest.t !== "end") throw new FilterSyntaxError(`unexpected "${(rest as { v: unknown }).v}"`, rest.at);
    return { ok: true, tree };
  } catch (e) {
    if (e instanceof FilterSyntaxError) return { ok: false, error: e.message, at: e.at };
    throw e;
  }
}

/** What a filter reads: the frontmatter, and `file.*` for the note itself. */
export interface FilterRow {
  fm: Record<string, unknown>;
  file: { name: string; path: string; folder: string };
}

function lookup(row: FilterRow, path: string[]): unknown {
  // `file.name` / `file.path` / `file.folder` are the note's own, whatever its frontmatter holds.
  if (path[0] === "file" && path.length === 2 && Object.prototype.hasOwnProperty.call(row.file, path[1])) return row.file[path[1] as keyof FilterRow["file"]];
  let v: unknown = row.fm;
  for (const k of path) {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

/** Numbers stay numbers; dates (and ISO date strings) compare by time; the rest as text. */
function comparable(v: unknown): number | string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const t = Date.parse(v);
      if (!Number.isNaN(t)) return t;
    }
    if (/^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v);
    return v;
  }
  return String(v);
}

function equal(a: unknown, b: unknown): boolean {
  // A list equals a value it holds (`tags = "fav"`), as people mean it.
  if (Array.isArray(a) && !Array.isArray(b)) return a.some((x) => equal(x, b));
  if (Array.isArray(b) && !Array.isArray(a)) return equal(b, a);
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return x === y;
  if (typeof x === "number" && typeof y === "number") return x === y;
  return String(a) === String(b);
}

function compare(op: CmpOp, a: unknown, b: unknown): boolean {
  if (op === "=") return equal(a, b);
  if (op === "!=") return !equal(a, b);
  const x = comparable(a);
  const y = comparable(b);
  if (x === null || y === null) return false;
  const d = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
  return op === "<" ? d < 0 : op === "<=" ? d <= 0 : op === ">" ? d > 0 : d >= 0;
}

const isEmpty = (v: unknown) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
const text = (v: unknown) => (v === null || v === undefined ? "" : String(v)).toLowerCase();

function evalNode(n: FilterNode, row: FilterRow): unknown {
  switch (n.kind) {
    case "lit":
      return n.value;
    case "field":
      return lookup(row, n.path);
    case "not":
      return !truthy(evalNode(n.item, row));
    case "and":
      return n.items.every((x) => truthy(evalNode(x, row)));
    case "or":
      return n.items.some((x) => truthy(evalNode(x, row)));
    case "cmp":
      return compare(n.op, evalNode(n.left, row), evalNode(n.right, row));
    case "call": {
      const [a, b] = n.args.map((x) => evalNode(x, row));
      if (n.name === "empty") return isEmpty(a);
      if (n.name === "contains") return Array.isArray(a) ? a.some((x) => equal(x, b)) : text(a).includes(text(b));
      if (n.name === "startswith") return text(a).startsWith(text(b));
      return text(a).endsWith(text(b));
    }
  }
}

function truthy(v: unknown): boolean {
  return !isEmpty(v) && v !== false && v !== 0;
}

/** Does the row pass? No filter passes everything. */
export function matchesFilter(tree: FilterNode | null, row: FilterRow): boolean {
  return tree === null || truthy(evalNode(tree, row));
}

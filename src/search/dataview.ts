/**
 * A subset of Obsidian Dataview's query language (plan W2.12), so the
 * ```dataview blocks in vaults that come from Obsidian render here too:
 *
 *   LIST [expr] | TABLE [WITHOUT ID] expr [AS "name"], …
 *   [FROM #tag | "folder" | [[note]] | -source, combined with AND / OR / ( )]
 *   [WHERE expr]
 *   [SORT expr [ASC|DESC], …]
 *   [LIMIT n]
 *
 * Expressions: numbers, "strings", true/false/null, fields (`status`,
 * `file.name`, `file.mtime`, nested `a.b`), comparisons (= != < > <= >=),
 * + - * /, and / or / !, and the common functions (contains, icontains,
 * startswith, endswith, length, lower, upper, date, default, choice, round,
 * number, string, regexmatch, join, list).
 *
 * A hand-written tokenizer, parser and interpreter: no eval, no Function,
 * nothing from the query reaches JavaScript as code (a static check in the
 * tests holds this). DOM-free and pure: notes in, rows out.
 */

/* ─── Values ─────────────────────────────────────────────────────── */

export class DateValue {
  constructor(readonly ms: number) {}
  toString(): string {
    const d = new Date(this.ms);
    const iso = d.toISOString();
    return d.getUTCHours() || d.getUTCMinutes() ? iso.slice(0, 16).replace("T", " ") : iso.slice(0, 10);
  }
}

export interface LinkValue {
  link: string;
  /** Shown text. */
  display: string;
}

export type Value = null | boolean | number | string | DateValue | LinkValue | Value[] | { [k: string]: Value };

const isLink = (v: Value): v is LinkValue => !!v && typeof v === "object" && !Array.isArray(v) && !(v instanceof DateValue) && typeof (v as LinkValue).link === "string" && typeof (v as LinkValue).display === "string" && Object.keys(v).length === 2;

/** A note as the queries see it. */
export interface DvNote {
  path: string;
  /** Basename with extension. */
  name: string;
  content: string;
  modified: number;
  created?: number;
}

/* ─── Front matter and inline fields ─────────────────────────────── */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function scalar(raw: string): Value {
  const s = raw.trim();
  if (!s) return null;
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === "true" || s === "false") return s === "true";
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(s)) return Number(s);
  if (ISO_DATE.test(s)) {
    const ms = Date.parse(s.length === 10 ? s + "T00:00:00Z" : s.replace(" ", "T"));
    if (!Number.isNaN(ms)) return new DateValue(ms);
  }
  const wiki = /^\[\[([^\]|]+)(?:\|([^\]]*))?\]\]$/.exec(s);
  if (wiki) return { link: wiki[1], display: wiki[2] ?? wiki[1] };
  if (s.startsWith("[") && s.endsWith("]")) {
    return s
      .slice(1, -1)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .map(scalar);
  }
  return s;
}

/** Front matter `key: value` (scalars, inline lists, `- item` lists, one level of nesting). */
export function frontMatter(content: string): Record<string, Value> {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
  const out: Record<string, Value> = {};
  if (!m) return out;
  const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z\p{L}_][\w\p{L}\- ]*?)\s*:(?:\s+(.*))?$/u.exec(lines[i]);
    if (!kv) continue;
    const key = kv[1];
    const rest = (kv[2] ?? "").trim();
    if (rest) {
      out[key] = scalar(rest.replace(/\s+#.*$/, ""));
      continue;
    }
    const list: Value[] = [];
    const obj: Record<string, Value> = {};
    let j = i + 1;
    for (; j < lines.length; j++) {
      const item = /^\s+-\s+(.*)$/.exec(lines[j]);
      const sub = /^\s+([A-Za-z\p{L}_][\w\p{L}\-]*)\s*:\s*(.*)$/u.exec(lines[j]);
      if (item) list.push(scalar(item[1]));
      else if (sub) obj[sub[1]] = scalar(sub[2]);
      else if (!lines[j].trim()) continue;
      else break;
    }
    out[key] = list.length ? list : Object.keys(obj).length ? obj : null;
    i = j - 1;
  }
  return out;
}

/** Dataview inline fields: `key:: value` on its own line, or `[key:: value]` / `(key:: value)` in text. */
export function inlineFields(content: string): Record<string, Value> {
  const out: Record<string, Value> = {};
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "").replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|(?![\s\S]))/gm, "");
  const add = (k: string, v: string) => {
    const key = k.trim();
    if (!key || key in out) return;
    out[key] = scalar(v);
  };
  for (const m of body.matchAll(/^[ \t]*(?:[-*+][ \t]+)?([\p{L}\w][\p{L}\w \-]*?)::[ \t]*(.*)$/gmu)) add(m[1], m[2]);
  for (const m of body.matchAll(/[[(]([\p{L}\w][\p{L}\w \-]*?)::\s*([^\])]*)[\])]/gu)) add(m[1], m[2]);
  return out;
}

/** Tags in front matter and `#tags` in the text (outside code), with their `#`. */
export function dvTags(content: string): string[] {
  const fm = frontMatter(content);
  const out = new Set<string>();
  const fmTags = fm.tags ?? fm.tag;
  const push = (t: string) => {
    const v = t.trim().replace(/^#+/, "");
    if (v) out.add("#" + v);
  };
  if (Array.isArray(fmTags)) fmTags.forEach((t) => typeof t === "string" && push(t));
  else if (typeof fmTags === "string") fmTags.split(/[,\s]+/).forEach(push);
  const body = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|(?![\s\S]))/gm, " ")
    .replace(/`+[^`\n]*`+/g, " ");
  for (const m of body.matchAll(/(^|[\s([{>"',;])#([\p{L}\p{M}\p{N}_/-]*[\p{L}\p{M}_][\p{L}\p{M}\p{N}_/-]*)/gu)) push(m[2]);
  return [...out];
}

/** Outgoing wiki-link targets. */
function outlinks(content: string): string[] {
  return [...content.matchAll(/\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]/g)].map((m) => m[1].trim());
}

/** The page object of a note: its fields, and `file`. */
export function pageOf(note: DvNote): Record<string, Value> {
  const name = note.name.replace(/\.md$/i, "");
  const folder = note.path.includes("/") ? note.path.slice(0, note.path.lastIndexOf("/")) : "";
  const tags = dvTags(note.content);
  const file: Record<string, Value> = {
    name,
    path: note.path,
    folder,
    link: { link: note.path, display: name },
    mtime: new DateValue(note.modified),
    ctime: new DateValue(note.created ?? note.modified),
    mday: new DateValue(Math.floor(note.modified / 86_400_000) * 86_400_000),
    size: note.content.length,
    ext: (/\.([^.]+)$/.exec(note.name)?.[1] ?? "").toLowerCase(),
    tags,
    etags: tags,
    outlinks: outlinks(note.content).map((l) => ({ link: l, display: l })),
  };
  const fields = { ...inlineFields(note.content), ...frontMatter(note.content) };
  const page: Record<string, Value> = {};
  for (const [k, v] of Object.entries(fields)) {
    page[k] = v;
    // Dataview also answers a field by its lower-case, dash-separated name.
    const norm = k.toLowerCase().replace(/\s+/g, "-");
    if (!(norm in page)) page[norm] = v;
  }
  page.file = file;
  return page;
}

/* ─── Tokens ─────────────────────────────────────────────────────── */

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "tag"; v: string }
  | { t: "link"; v: string }
  | { t: "op"; v: string };

export class DataviewError extends Error {}

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
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) {
          s += src[j + 1];
          j += 2;
          continue;
        }
        s += src[j++];
      }
      if (j >= src.length) throw new DataviewError("unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (src.startsWith("[[", i)) {
      const j = src.indexOf("]]", i);
      if (j < 0) throw new DataviewError("unterminated link");
      out.push({ t: "link", v: src.slice(i + 2, j).split("|")[0].trim() });
      i = j + 2;
      continue;
    }
    if (c === "#") {
      const m = /^#([\p{L}\p{M}\p{N}_/-]+)/u.exec(src.slice(i));
      if (m) {
        out.push({ t: "tag", v: m[1] });
        i += m[0].length;
        continue;
      }
    }
    const num = /^\d+(?:\.\d+)?/.exec(src.slice(i));
    if (num) {
      out.push({ t: "num", v: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["<=", ">=", "!=", "==", "&&", "||"].includes(two)) {
      out.push({ t: "op", v: two === "==" ? "=" : two === "&&" ? "and" : two === "||" ? "or" : two });
      i += 2;
      continue;
    }
    if ("()[],.=<>!+-*/%".includes(c)) {
      out.push({ t: "op", v: c });
      i++;
      continue;
    }
    const id = /^[\p{L}_][\p{L}\p{N}_-]*/u.exec(src.slice(i));
    if (id) {
      // Field names may hold dashes ("due-date"); subtraction needs spaces ("a - b").
      out.push({ t: "id", v: id[0] });
      i += id[0].length;
      continue;
    }
    throw new DataviewError(`unexpected "${c}"`);
  }
  return out;
}

/* ─── Syntax ─────────────────────────────────────────────────────── */

export type Expr =
  | { k: "lit"; v: Value }
  | { k: "field"; path: string[] }
  | { k: "call"; fn: string; args: Expr[] }
  | { k: "un"; op: "!" | "-"; e: Expr }
  | { k: "bin"; op: string; a: Expr; b: Expr }
  | { k: "list"; items: Expr[] };

export type Source =
  | { k: "tag"; v: string }
  | { k: "folder"; v: string }
  | { k: "link"; v: string }
  | { k: "not"; s: Source }
  | { k: "and" | "or"; a: Source; b: Source };

export interface DvQuery {
  type: "list" | "table";
  /** LIST's value, or TABLE's columns. */
  fields: Array<{ e: Expr; name: string }>;
  withoutId: boolean;
  from: Source | null;
  where: Expr | null;
  sort: Array<{ e: Expr; desc: boolean }>;
  limit: number | null;
}

const KEYWORDS = new Set(["from", "where", "sort", "limit", "flatten", "group"]);

class Parser {
  i = 0;
  constructor(readonly toks: Tok[]) {}
  peek(): Tok | undefined {
    return this.toks[this.i];
  }
  isKw(word: string): boolean {
    const p = this.peek();
    return !!p && p.t === "id" && p.v.toLowerCase() === word;
  }
  isOp(op: string): boolean {
    const p = this.peek();
    return !!p && p.t === "op" && p.v === op;
  }
  eatOp(op: string): void {
    if (!this.isOp(op)) throw new DataviewError(`expected "${op}"`);
    this.i++;
  }
  atClauseEnd(): boolean {
    const p = this.peek();
    return !p || (p.t === "id" && KEYWORDS.has(p.v.toLowerCase()));
  }

  expr(): Expr {
    return this.or();
  }
  or(): Expr {
    let a = this.and();
    while (this.isKw("or") || this.isOp("or")) {
      this.i++;
      a = { k: "bin", op: "or", a, b: this.and() };
    }
    return a;
  }
  and(): Expr {
    let a = this.cmp();
    while (this.isKw("and") || this.isOp("and")) {
      this.i++;
      a = { k: "bin", op: "and", a, b: this.cmp() };
    }
    return a;
  }
  cmp(): Expr {
    const a = this.add();
    const p = this.peek();
    if (p && p.t === "op" && ["=", "!=", "<", ">", "<=", ">="].includes(p.v)) {
      this.i++;
      return { k: "bin", op: p.v, a, b: this.add() };
    }
    return a;
  }
  add(): Expr {
    let a = this.mul();
    for (let p = this.peek(); p && p.t === "op" && (p.v === "+" || p.v === "-"); p = this.peek()) {
      this.i++;
      a = { k: "bin", op: p.v, a, b: this.mul() };
    }
    return a;
  }
  mul(): Expr {
    let a = this.unary();
    for (let p = this.peek(); p && p.t === "op" && (p.v === "*" || p.v === "/" || p.v === "%"); p = this.peek()) {
      this.i++;
      a = { k: "bin", op: p.v, a, b: this.unary() };
    }
    return a;
  }
  unary(): Expr {
    if (this.isOp("!")) {
      this.i++;
      return { k: "un", op: "!", e: this.unary() };
    }
    if (this.isOp("-")) {
      this.i++;
      return { k: "un", op: "-", e: this.unary() };
    }
    return this.postfix(this.primary());
  }
  postfix(e: Expr): Expr {
    let out = e;
    for (;;) {
      if (this.isOp(".") && out.k === "field") {
        this.i++;
        const p = this.peek();
        if (!p || p.t !== "id") throw new DataviewError("expected a field name after .");
        this.i++;
        out = { k: "field", path: [...out.path, p.v] };
        continue;
      }
      if (this.isOp("[")) {
        this.i++;
        const idx = this.expr();
        this.eatOp("]");
        out = { k: "call", fn: "__index", args: [out, idx] };
        continue;
      }
      return out;
    }
  }
  primary(): Expr {
    const p = this.peek();
    if (!p) throw new DataviewError("unexpected end of query");
    this.i++;
    switch (p.t) {
      case "num":
        return { k: "lit", v: p.v };
      case "str":
        return { k: "lit", v: p.v };
      case "link":
        return { k: "lit", v: { link: p.v, display: p.v } };
      case "tag":
        return { k: "lit", v: "#" + p.v };
      case "op":
        if (p.v === "(") {
          const e = this.expr();
          this.eatOp(")");
          return e;
        }
        if (p.v === "[") {
          const items: Expr[] = [];
          while (!this.isOp("]")) {
            items.push(this.expr());
            if (!this.isOp("]")) this.eatOp(",");
          }
          this.eatOp("]");
          return { k: "list", items };
        }
        throw new DataviewError(`unexpected "${p.v}"`);
      case "id": {
        const low = p.v.toLowerCase();
        if (low === "true" || low === "false") return { k: "lit", v: low === "true" };
        if (low === "null") return { k: "lit", v: null };
        if (this.isOp("(") && (low === "date" || low === "dur") && this.toks[this.i + 1]?.t !== "str") {
          // date(today), dur(1 day): Dataview takes these as bare words, not expressions.
          this.i++;
          const words: string[] = [];
          while (this.peek() && !this.isOp(")")) {
            const w = this.peek()!;
            words.push(w.t === "tag" ? "#" + w.v : String(w.v));
            this.i++;
          }
          this.eatOp(")");
          const raw = words.join(low === "dur" ? " " : "");
          // date(file.name) and the like: a real expression after all.
          if (low === "date" && /^[A-Za-z_][\w]*\.[\w.]+$/.test(raw)) {
            return { k: "call", fn: "date", args: [{ k: "field", path: raw.split(".") }] };
          }
          return { k: "call", fn: low, args: [{ k: "lit", v: raw }] };
        }
        if (this.isOp("(")) {
          this.i++;
          const args: Expr[] = [];
          while (!this.isOp(")")) {
            args.push(this.expr());
            if (!this.isOp(")")) this.eatOp(",");
          }
          this.eatOp(")");
          return { k: "call", fn: low, args };
        }
        return { k: "field", path: [p.v] };
      }
    }
  }

  source(): Source {
    let a = this.sourceAnd();
    while (this.isKw("or")) {
      this.i++;
      a = { k: "or", a, b: this.sourceAnd() };
    }
    return a;
  }
  sourceAnd(): Source {
    let a = this.sourceAtom();
    while (this.isKw("and")) {
      this.i++;
      a = { k: "and", a, b: this.sourceAtom() };
    }
    return a;
  }
  sourceAtom(): Source {
    const p = this.peek();
    if (!p) throw new DataviewError("expected a source after FROM");
    if (p.t === "op" && (p.v === "-" || p.v === "!")) {
      this.i++;
      return { k: "not", s: this.sourceAtom() };
    }
    if (p.t === "op" && p.v === "(") {
      this.i++;
      const s = this.source();
      this.eatOp(")");
      return s;
    }
    this.i++;
    if (p.t === "tag") return { k: "tag", v: p.v.toLowerCase() };
    if (p.t === "str") return { k: "folder", v: p.v.replace(/^\/+|\/+$/g, "") };
    if (p.t === "link") return { k: "link", v: p.v };
    throw new DataviewError("FROM takes #tags, \"folders\" and [[links]]");
  }
}

/** Parse a ```dataview block. Throws DataviewError on what it does not support. */
export function parseDataview(src: string): DvQuery {
  const text = src.replace(/\/\/[^\n]*$/gm, "").trim();
  const p = new Parser(tokenize(text));
  const head = p.peek();
  if (!head || head.t !== "id") throw new DataviewError("a query starts with LIST or TABLE");
  const kind = head.v.toLowerCase();
  if (kind !== "list" && kind !== "table") throw new DataviewError(`${head.v} queries are not supported (LIST and TABLE are)`);
  p.i++;
  const q: DvQuery = { type: kind, fields: [], withoutId: false, from: null, where: null, sort: [], limit: null };
  if (p.isKw("without")) {
    p.i++;
    if (!p.isKw("id")) throw new DataviewError("expected WITHOUT ID");
    p.i++;
    q.withoutId = true;
  }
  if (!p.atClauseEnd()) {
    for (;;) {
      const start = p.i;
      const e = p.expr();
      let name = p.toks
        .slice(start, p.i)
        .map((tk) => (tk.t === "str" ? JSON.stringify(tk.v) : tk.t === "tag" ? "#" + tk.v : tk.t === "link" ? `[[${tk.v}]]` : String(tk.v)))
        .join("")
        .replace(/\s+/g, "");
      if (p.isKw("as")) {
        p.i++;
        const n = p.peek();
        if (!n || (n.t !== "str" && n.t !== "id")) throw new DataviewError("expected a name after AS");
        p.i++;
        name = String(n.v);
      }
      q.fields.push({ e, name });
      if (kind === "list" || !p.isOp(",")) break;
      p.i++;
    }
  }
  while (p.peek()) {
    const kw = p.peek()!;
    if (kw.t !== "id") throw new DataviewError(`unexpected "${String(kw.v)}"`);
    const low = kw.v.toLowerCase();
    p.i++;
    if (low === "from") q.from = p.source();
    else if (low === "where") q.where = q.where ? { k: "bin", op: "and", a: q.where, b: p.expr() } : p.expr();
    else if (low === "sort") {
      for (;;) {
        const e = p.expr();
        let desc = false;
        if (p.isKw("desc") || p.isKw("descending")) {
          desc = true;
          p.i++;
        } else if (p.isKw("asc") || p.isKw("ascending")) p.i++;
        q.sort.push({ e, desc });
        if (!p.isOp(",")) break;
        p.i++;
      }
    } else if (low === "limit") {
      const n = p.peek();
      if (!n || n.t !== "num") throw new DataviewError("LIMIT takes a number");
      p.i++;
      q.limit = n.v;
    } else throw new DataviewError(`${kw.v} is not supported`);
  }
  return q;
}

/* ─── Evaluation ─────────────────────────────────────────────────── */

function truthy(v: Value): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function toNum(v: Value): number | null {
  if (typeof v === "number") return v;
  if (v instanceof DateValue) return v.ms;
  if (typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v.trim())) return Number(v);
  if (typeof v === "boolean") return v ? 1 : 0;
  return null;
}

export function show(v: Value): string {
  if (v === null) return "";
  if (Array.isArray(v)) return v.map(show).join(", ");
  if (v instanceof DateValue) return v.toString();
  if (isLink(v)) return v.display;
  if (typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(", ");
  return String(v);
}

/** Order of two values (numbers, dates, then text; null first). */
export function compare(a: Value, b: Value): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1;
  const na = toNum(a);
  const nb = toNum(b);
  if (na !== null && nb !== null && typeof a !== "string" && typeof b !== "string") return na - nb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof DateValue && typeof b === "string") {
    const d = scalar(b);
    if (d instanceof DateValue) return a.ms - d.ms;
  }
  if (b instanceof DateValue && typeof a === "string") {
    const d = scalar(a);
    if (d instanceof DateValue) return d.ms - b.ms;
  }
  return show(a).localeCompare(show(b), undefined, { numeric: true, sensitivity: "base" });
}

function equal(a: Value, b: Value): boolean {
  if (isLink(a) || isLink(b)) return linkKey(a) === linkKey(b);
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => equal(x, b[i]));
  if (a === null || b === null) return a === b;
  if (typeof a === "boolean" || typeof b === "boolean") return a === b;
  return compare(a, b) === 0 && (typeof a !== "string" || typeof b !== "string" || a.toLowerCase() === b.toLowerCase());
}

function linkKey(v: Value): string {
  const s = isLink(v) ? v.link : show(v);
  return s.replace(/\.md$/i, "").split("/").pop()!.toLowerCase();
}

function contains(hay: Value, needle: Value, ci: boolean): boolean {
  if (Array.isArray(hay)) return hay.some((x) => (typeof x === "string" && typeof needle === "string" ? (ci ? x.toLowerCase() === needle.toLowerCase() : x === needle) || (ci ? x.toLowerCase().includes(needle.toLowerCase()) : x.includes(needle)) : equal(x, needle)));
  if (typeof hay === "string") return ci ? hay.toLowerCase().includes(show(needle).toLowerCase()) : hay.includes(show(needle));
  if (isLink(hay)) return linkKey(hay) === linkKey(needle);
  if (hay && typeof hay === "object" && !(hay instanceof DateValue)) return typeof needle === "string" && needle in hay;
  return false;
}

const DAY = 86_400_000;

function call(fn: string, args: Value[], now: number): Value {
  const [a, b, c] = args;
  switch (fn) {
    case "contains":
      return contains(a ?? null, b ?? null, false);
    case "icontains":
      return contains(a ?? null, b ?? null, true);
    case "econtains":
      return Array.isArray(a) ? a.some((x) => equal(x, b ?? null)) : equal(a ?? null, b ?? null);
    case "startswith":
      return typeof a === "string" && typeof b === "string" && a.startsWith(b);
    case "endswith":
      return typeof a === "string" && typeof b === "string" && a.endsWith(b);
    case "length":
      return Array.isArray(a) ? a.length : typeof a === "string" ? a.length : a && typeof a === "object" && !(a instanceof DateValue) ? Object.keys(a).length : 0;
    case "lower":
      return typeof a === "string" ? a.toLowerCase() : a ?? null;
    case "upper":
      return typeof a === "string" ? a.toUpperCase() : a ?? null;
    case "default":
      return a === null || a === undefined ? (b ?? null) : a;
    case "choice":
      return truthy(a ?? null) ? (b ?? null) : (c ?? null);
    case "round": {
      const n = toNum(a ?? null);
      const d = toNum(b ?? null) ?? 0;
      return n === null ? null : Math.round(n * 10 ** d) / 10 ** d;
    }
    case "number": {
      if (typeof a === "number") return a;
      const m = typeof a === "string" ? /-?\d+(?:\.\d+)?/.exec(a) : null;
      return m ? Number(m[0]) : null;
    }
    case "string":
      return show(a ?? null);
    case "join":
      return Array.isArray(a) ? a.map(show).join(typeof b === "string" ? b : ", ") : show(a ?? null);
    case "list":
      return args;
    case "regexmatch": {
      // A pattern the reader wrote, matched as data: RegExp only, never code.
      if (typeof a !== "string" || typeof b !== "string") return false;
      try {
        return new RegExp(`^(?:${a})$`, "u").test(b);
      } catch {
        return false;
      }
    }
    case "date": {
      if (a instanceof DateValue) return a;
      const s = typeof a === "string" ? a.trim().toLowerCase() : isLink(a ?? null) ? (a as LinkValue).link : "";
      const today = Math.floor(now / DAY) * DAY;
      if (s === "today") return new DateValue(today);
      if (s === "now") return new DateValue(now);
      if (s === "tomorrow") return new DateValue(today + DAY);
      if (s === "yesterday") return new DateValue(today - DAY);
      const d = scalar(s.replace(/\.md$/, "").split("/").pop() ?? "");
      return d instanceof DateValue ? d : null;
    }
    case "dur": {
      const m = typeof a === "string" ? /^(\d+)\s*(d|day|days|w|week|weeks|h|hour|hours|m|min|minutes)$/.exec(a.trim()) : null;
      if (!m) return null;
      const n = Number(m[1]);
      const unit = m[2][0] === "w" ? 7 * DAY : m[2][0] === "d" ? DAY : m[2][0] === "h" ? 3_600_000 : 60_000;
      return n * unit;
    }
    case "__index": {
      if (Array.isArray(a) && typeof b === "number") return a[b] ?? null;
      if (a && typeof a === "object" && !Array.isArray(a) && !(a instanceof DateValue) && typeof b === "string") return (a as Record<string, Value>)[b] ?? null;
      return null;
    }
    default:
      throw new DataviewError(`unknown function ${fn}()`);
  }
}

function field(page: Record<string, Value>, path: string[]): Value {
  let v: Value = page;
  for (const part of path) {
    if (Array.isArray(v)) {
      // Dataview maps a field over a list: file.outlinks.display.
      v = v.map((x) => (x && typeof x === "object" && !Array.isArray(x) && !(x instanceof DateValue) ? ((x as Record<string, Value>)[part] ?? null) : null));
      continue;
    }
    if (!v || typeof v !== "object" || v instanceof DateValue) return null;
    const obj = v as Record<string, Value>;
    v = part in obj ? obj[part] : (obj[part.toLowerCase()] ?? null);
  }
  return v;
}

export function evaluate(e: Expr, page: Record<string, Value>, now: number): Value {
  switch (e.k) {
    case "lit":
      return e.v;
    case "field":
      return field(page, e.path);
    case "list":
      return e.items.map((x) => evaluate(x, page, now));
    case "un": {
      const v = evaluate(e.e, page, now);
      if (e.op === "!") return !truthy(v);
      const n = toNum(v);
      return n === null ? null : -n;
    }
    case "call":
      return call(e.fn, e.args.map((x) => evaluate(x, page, now)), now);
    case "bin": {
      if (e.op === "and") return truthy(evaluate(e.a, page, now)) && truthy(evaluate(e.b, page, now));
      if (e.op === "or") return truthy(evaluate(e.a, page, now)) || truthy(evaluate(e.b, page, now));
      const a = evaluate(e.a, page, now);
      const b = evaluate(e.b, page, now);
      switch (e.op) {
        case "=":
          return equal(a, b);
        case "!=":
          return !equal(a, b);
        case "<":
          return a !== null && b !== null && compare(a, b) < 0;
        case ">":
          return a !== null && b !== null && compare(a, b) > 0;
        case "<=":
          return a !== null && b !== null && compare(a, b) <= 0;
        case ">=":
          return a !== null && b !== null && compare(a, b) >= 0;
      }
      if (e.op === "+" && (typeof a === "string" || typeof b === "string")) return show(a) + show(b);
      if (a instanceof DateValue && typeof b === "number" && (e.op === "+" || e.op === "-")) return new DateValue(e.op === "+" ? a.ms + b : a.ms - b);
      const na = toNum(a);
      const nb = toNum(b);
      if (na === null || nb === null) return null;
      switch (e.op) {
        case "+":
          return na + nb;
        case "-":
          return na - nb;
        case "*":
          return na * nb;
        case "/":
          return nb === 0 ? null : na / nb;
        case "%":
          return nb === 0 ? null : na % nb;
      }
      return null;
    }
  }
}

function inSource(s: Source, page: Record<string, Value>): boolean {
  const file = page.file as Record<string, Value>;
  switch (s.k) {
    case "tag": {
      const tags = (file.tags as string[]).map((t) => t.slice(1).toLowerCase());
      return tags.some((t) => t === s.v || t.startsWith(s.v + "/"));
    }
    case "folder": {
      const path = String(file.path);
      if (!s.v) return true;
      // A folder, or a note given by its path.
      return path === s.v || path === s.v + ".md" || path.startsWith(s.v + "/");
    }
    case "link": {
      const key = s.v.replace(/\.md$/i, "").split("/").pop()!.toLowerCase();
      return (file.outlinks as LinkValue[]).some((l) => linkKey(l) === key);
    }
    case "not":
      return !inSource(s.s, page);
    case "and":
      return inSource(s.a, page) && inSource(s.b, page);
    case "or":
      return inSource(s.a, page) || inSource(s.b, page);
  }
}

export interface DvResult {
  type: "list" | "table";
  /** Column headers (TABLE: "File" first unless WITHOUT ID). */
  headers: string[];
  rows: Array<{ path: string; name: string; cells: Value[] }>;
}

/** Run a parsed query over the notes. `now` makes date(today) deterministic in tests. */
export function runDataview(q: DvQuery, notes: readonly DvNote[], now = Date.now()): DvResult {
  const pages = notes.filter((n) => /\.md$/i.test(n.name)).map((n) => ({ n, page: pageOf(n) }));
  let hits = pages.filter(({ page }) => (!q.from || inSource(q.from, page)) && (!q.where || truthy(evaluate(q.where, page, now))));
  if (q.sort.length) {
    const keyed = hits.map((h) => ({ h, keys: q.sort.map((s) => evaluate(s.e, h.page, now)) }));
    keyed.sort((x, y) => {
      for (let i = 0; i < q.sort.length; i++) {
        const c = compare(x.keys[i], y.keys[i]);
        if (c) return q.sort[i].desc ? -c : c;
      }
      return x.h.n.path < y.h.n.path ? -1 : 1;
    });
    hits = keyed.map((k) => k.h);
  } else hits.sort((x, y) => (x.n.path < y.n.path ? -1 : x.n.path > y.n.path ? 1 : 0));
  if (q.limit !== null) hits = hits.slice(0, q.limit);
  const headers = q.type === "table" ? [...(q.withoutId ? [] : ["File"]), ...q.fields.map((f) => f.name)] : [];
  return {
    type: q.type,
    headers,
    rows: hits.map(({ n, page }) => ({
      path: n.path,
      name: n.name.replace(/\.md$/i, ""),
      cells: q.fields.map((f) => evaluate(f.e, page, now)),
    })),
  };
}

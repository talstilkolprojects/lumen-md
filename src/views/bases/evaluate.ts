/**
 * The Obsidian Bases interpreter (plan W1.11): walks a `BasesNode` tree
 * (./expr.ts) over one file of the vault. Like the database formulas of
 * plan 4.11 — whose step budget, limits and error type it reuses — it
 * switches over a closed set of node kinds and calls only the functions in
 * the tables below: no `eval`, no `Function`, no host property access.
 *
 * The function tables follow the Bases reference (Obsidian 1.9–1.14):
 * global functions, and methods per value type (any, text, number, date,
 * list, link, file, object, regular expression). `BASES_DOCUMENTED` lists
 * every documented function, `BASES_UNSUPPORTED` the ones that are not
 * run here; a test keeps the supported share at ≥ 90 %.
 */

import { FormulaError, type FormulaLimits } from "../formula/ast";
import { utcDate } from "../formula/values";
import { type BasesNode } from "./expr";
import { callNotion, type NotionHost } from "./notion";
import {
  addDuration,
  compareValues,
  durationMs,
  equalValues,
  fromYaml,
  isEmptyValue,
  isTagged,
  parseDuration,
  parseWikiLink,
  tagOf,
  toDate,
  toText,
  truthy,
  type BasesFile,
  type BDuration,
  type BValue,
} from "./values";
import { BASES_DOCUMENTED, BASES_UNSUPPORTED } from "./catalogue";
export { BASES_DOCUMENTED, BASES_UNSUPPORTED, BASES_LEGACY_GLOBALS, BASES_MAX_LENGTH, parseBases, BASES_GLOBALS } from "./catalogue";
import { fileValue, toNumberOrNull, clean, formatMoment, escapeHtml } from "./evalHelpers";
import { InterpreterBase } from "./evalBase";
export { inFolder } from "./evalBase";
export { formatMoment, tagMatches } from "./evalHelpers";

/** What an expression can reach besides its own row. */
export interface BasesVault {
  /** A note by link text or path (`Note`, `folder/Note.md`), as Obsidian resolves `[[Note]]`. */
  resolve(target: string): BasesFile | null;
  /** The files that link to this one. */
  backlinks(file: BasesFile): BasesFile[];
}

export interface BasesScope {
  file: BasesFile;
  /** `formula.x`: computed on demand (cycles are the caller's to report). */
  formula?: (name: string) => BValue;
  /** `this`: the base file, or the note that embeds it. */
  thisFile?: BasesFile | null;
  vault?: BasesVault;
  /** Extra names: `value`, `index`, `acc` inside map / filter / reduce; `values` in a summary. */
  locals?: Readonly<Record<string, BValue>>;
  /** W6.46: `relation.<name>` — the related notes, as file values; `rollup.<name>` — the rollup. */
  relation?: (name: string) => BValue;
  rollup?: (name: string) => BValue;
}

export interface BasesEvalOptions {
  now?: Date;
  limits?: Partial<FormulaLimits>;
  /** Locale for `relative()`. Default English. */
  locale?: string;
  /** For `random()`: tests pass a fixed source. */
  random?: () => number;
}

export type BasesResult = { ok: true; value: BValue } | { ok: false; error: FormulaError };

/* ─── The interpreter ────────────────────────────────────────────────── */

class Interpreter extends InterpreterBase {
  fileField(file: BasesFile, name: string, at: number): BValue {
    switch (name) {
      case "name":
        return file.name;
      case "basename":
        return file.basename;
      case "path":
        return file.path;
      case "folder":
        return file.folder;
      case "ext":
        return file.ext;
      case "size":
        return file.size;
      case "ctime":
        return file.ctime;
      case "mtime":
        return file.mtime;
      case "tags":
        return this.list([...file.tags], at);
      case "links":
        return this.list(file.links.map((p) => ({ $: "link", path: p })), at);
      case "embeds":
        return this.list(file.embeds.map((p) => ({ $: "link", path: p })), at);
      case "backlinks":
        return this.list((this.scope.vault?.backlinks(file) ?? []).map((f) => ({ $: "link", path: f.path })), at);
      case "properties":
        return fromYaml(file.fm);
      case "file":
        return fileValue(file);
      default:
        return null;
    }
  }

  run(n: BasesNode): BValue {
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
      case "regex":
        return { $: "regex", re: new RegExp(n.source, n.flags) };
      case "name":
        return this.name(n.name, n.at);
      case "list":
        return this.list(
          n.items.map((x) => this.run(x)),
          n.at,
        );
      case "object": {
        const map: Record<string, BValue> = Object.create(null);
        for (const [k, v] of n.entries) map[k] = this.run(v);
        return { $: "object", map };
      }
      case "member":
        return this.member(n.object, n.name, n.at);
      case "index": {
        const key = this.run(n.index);
        return this.memberByKey(n.object, key, n.at);
      }
      case "unary": {
        const v = this.run(n.arg);
        if (n.op === "!") return !truthy(v);
        const x = toNumberOrNull(v);
        if (isTagged(v) && v.$ === "duration") return { $: "duration", months: -v.months, ms: -v.ms };
        return x === null ? null : clean(-x, n.at);
      }
      case "binary":
        return this.binary(n);
      case "call":
        return this.call(n);
      case "method":
        return this.method(n);
    }
  }

  name(name: string, at: number): BValue {
    const locals = this.scope.locals;
    if (locals && Object.prototype.hasOwnProperty.call(locals, name)) return locals[name];
    if (name === "file") return fileValue(this.scope.file);
    if (name === "note") return fromYaml(this.scope.file.fm);
    if (name === "this") return this.scope.thisFile ? fileValue(this.scope.thisFile) : null;
    if (name === "formula") throw new FormulaError("syntax", "formula needs a name: formula.total", at);
    // A bare name is a note property (`status` is `note.status`).
    return this.noteProp(this.scope.file, name);
  }

  /** `a.b` where `a` is a namespace (`note`, `file`, `formula`, `this`) or a value. */
  member(objNode: BasesNode, name: string, at: number): BValue {
    if (objNode.kind === "name" && !(this.scope.locals && Object.prototype.hasOwnProperty.call(this.scope.locals, objNode.name))) {
      switch (objNode.name) {
        case "note":
          return this.noteProp(this.scope.file, name);
        case "file":
          return this.fileField(this.scope.file, name, at);
        case "formula":
          return this.scope.formula ? this.scope.formula(name) : null;
        case "relation":
          return this.scope.relation ? this.scope.relation(name) : null;
        case "rollup":
          return this.scope.rollup ? this.scope.rollup(name) : null;
        case "this": {
          const t = this.scope.thisFile;
          if (!t) return null;
          if (name === "file") return fileValue(t);
          if (name === "note") return fromYaml(t.fm);
          return this.noteProp(t, name);
        }
      }
    }
    return this.field(this.run(objNode), name, at);
  }

  memberByKey(objNode: BasesNode, key: BValue, at: number): BValue {
    if (typeof key === "string") return this.member(objNode, key, at);
    const obj = this.run(objNode);
    if (Array.isArray(obj) && typeof key === "number") {
      const i = key < 0 ? obj.length + key : key;
      return Number.isInteger(i) && i >= 0 && i < obj.length ? obj[i] : null;
    }
    return this.field(obj, toText(key), at);
  }

  /** Fields of a value: `file.name`, `date.year`, `list.length`, `object.key`. */
  field(v: BValue, name: string, at: number): BValue {
    if (v === null) return null;
    if (isTagged(v)) {
      if (v.$ === "file") return this.fileField(v.file, name, at);
      if (v.$ === "object") return Object.prototype.hasOwnProperty.call(v.map, name) ? v.map[name] : null;
      if (v.$ === "link") {
        const f = this.scope.vault?.resolve(v.path);
        if (name === "display") return v.display ?? null;
        return f ? this.fileField(f, name, at) : null;
      }
      if (v.$ === "duration") return this.durationField(v, name);
      return null;
    }
    if (name === "length" && (typeof v === "string" || Array.isArray(v))) return Array.isArray(v) ? v.length : [...v].length;
    const d = toDate(v);
    if (d) {
      switch (name) {
        case "year":
          return d.getUTCFullYear();
        case "month":
          return d.getUTCMonth() + 1;
        case "day":
          return d.getUTCDate();
        case "hour":
          return d.getUTCHours();
        case "minute":
          return d.getUTCMinutes();
        case "second":
          return d.getUTCSeconds();
        case "millisecond":
          return d.getUTCMilliseconds();
      }
    }
    return null;
  }

  durationField(d: BDuration, name: string): BValue {
    const ms = durationMs(d);
    const by: Record<string, number> = { milliseconds: 1, seconds: 1000, minutes: 60_000, hours: 3_600_000, days: 86_400_000, weeks: 7 * 86_400_000 };
    if (name === "months") return d.months;
    if (name === "years") return Math.trunc(d.months / 12);
    return by[name] ? Math.trunc(ms / by[name]) : null;
  }

  binary(n: Extract<BasesNode, { kind: "binary" }>): BValue {
    if (n.op === "&&") return truthy(this.run(n.left)) && truthy(this.run(n.right));
    if (n.op === "||") {
      // `a || b` gives the first value that holds (JavaScript), so `note.title || file.name` works.
      const a = this.run(n.left);
      return truthy(a) ? a : this.run(n.right);
    }
    const a = this.run(n.left);
    const b = this.run(n.right);
    switch (n.op) {
      case "==":
        return equalValues(a, b);
      case "!=":
        return !equalValues(a, b);
      case "<":
      case "<=":
      case ">":
      case ">=": {
        const d = compareValues(a, b);
        if (d === null) return false;
        return n.op === "<" ? d < 0 : n.op === "<=" ? d <= 0 : n.op === ">" ? d > 0 : d >= 0;
      }
      case "+":
      case "-":
        return this.addSub(n.op, a, b, n.at);
      default: {
        const x = toNumberOrNull(a);
        const y = toNumberOrNull(b);
        if (x === null || y === null) return null;
        if ((n.op === "/" || n.op === "%") && y === 0) throw new FormulaError("math", "division by zero", n.at);
        return clean(n.op === "*" ? x * y : n.op === "/" ? x / y : x % y, n.at);
      }
    }
  }

  asDuration(v: BValue): BDuration | null {
    if (isTagged(v) && v.$ === "duration") return v;
    if (typeof v === "string") return parseDuration(v);
    return null;
  }

  addSub(op: "+" | "-", a: BValue, b: BValue, at: number): BValue {
    // Date ± duration ("1d", duration("2w")); date − date is a duration.
    const da = a instanceof Date ? a : typeof a === "string" ? toDate(a) : null;
    if (da && (a instanceof Date || this.asDuration(b) || b instanceof Date)) {
      const db = b instanceof Date ? b : typeof b === "string" && !this.asDuration(b) ? toDate(b) : null;
      if (db) {
        if (op === "+") throw new FormulaError("type", "two dates cannot be added", at);
        return { $: "duration", months: 0, ms: da.getTime() - db.getTime() };
      }
      const dur = this.asDuration(b);
      if (dur) return addDuration(da, dur, op === "+" ? 1 : -1);
      if (b === null) return null;
      if (typeof b === "number") return new Date(da.getTime() + (op === "+" ? b : -b));
    }
    const durA = isTagged(a) && a.$ === "duration" ? a : null;
    const durB = this.asDuration(b);
    if (durA && durB) {
      const s = op === "+" ? 1 : -1;
      return { $: "duration", months: durA.months + s * durB.months, ms: durA.ms + s * durB.ms };
    }
    if (op === "+") {
      if (Array.isArray(a) && Array.isArray(b)) return this.list([...a, ...b], at);
      if (typeof a === "string" || typeof b === "string" || isTagged(a) || isTagged(b)) {
        if (a === null || b === null) return a === null ? b : a;
        return this.text(toText(a) + toText(b), at);
      }
    }
    const x = toNumberOrNull(a);
    const y = toNumberOrNull(b);
    if (x === null || y === null) return null;
    return clean(op === "+" ? x + y : x - y, at);
  }

  call(n: Extract<BasesNode, { kind: "call" }>): BValue {
    const at = n.at;
    if (n.name === "if") {
      if (n.args.length < 2 || n.args.length > 3) throw new FormulaError("arity", "if() takes 2 or 3 arguments", at);
      return truthy(this.run(n.args[0])) ? this.run(n.args[1]) : n.args[2] ? this.run(n.args[2]) : null;
    }
    const lazy = this.notionLazy(n);
    if (lazy !== undefined) return lazy;
    const args = n.args.map((x) => this.run(x));
    const arity = (min: number, max: number) => {
      if (args.length < min || args.length > max) throw new FormulaError("arity", `${n.name}() takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, not ${args.length}`, at);
    };
    switch (n.name) {
      case "escapeHTML":
        arity(1, 1);
        return this.text(escapeHtml(toText(args[0])), at);
      case "html":
        arity(1, 1);
        return { $: "html", html: this.text(toText(args[0]), at) };
      case "date": {
        arity(1, 1);
        const v = args[0];
        if (v === null || v === "") return null;
        const d = toDate(v);
        if (!d) throw new FormulaError("type", `date() needs a date like "2026-11-10", not "${toText(v)}"`, at);
        return d;
      }
      case "duration": {
        arity(1, 1);
        if (isTagged(args[0]) && (args[0] as BDuration).$ === "duration") return args[0];
        const d = parseDuration(toText(args[0]));
        if (!d) throw new FormulaError("type", `duration() needs a length like "3d" or "2 weeks", not "${toText(args[0])}"`, at);
        return d;
      }
      case "file": {
        arity(1, 1);
        const v = args[0];
        if (isTagged(v) && v.$ === "file") return v;
        const target = isTagged(v) && v.$ === "link" ? v.path : toText(v);
        const f = this.scope.vault?.resolve(target) ?? null;
        return f ? fileValue(f) : null;
      }
      case "image": {
        arity(1, 1);
        const v = args[0];
        const src = isTagged(v) && v.$ === "file" ? v.file.path : isTagged(v) && v.$ === "link" ? v.path : toText(v);
        return src ? { $: "image", src } : null;
      }
      case "link": {
        arity(1, 2);
        const v = args[0];
        const path = isTagged(v) && v.$ === "file" ? v.file.path : isTagged(v) && v.$ === "link" ? v.path : toText(v);
        const display = args[1] === undefined || args[1] === null ? undefined : toText(args[1]);
        return display === undefined ? { $: "link", path } : { $: "link", path, display };
      }
      case "list":
        arity(1, 1);
        return Array.isArray(args[0]) ? args[0] : args[0] === null ? [] : [args[0]];
      case "max":
      case "min": {
        const ns: number[] = [];
        for (const a of args) for (const x of Array.isArray(a) ? a : [a]) {
          const v = toNumberOrNull(x);
          if (v !== null) ns.push(v);
        }
        this.budget.tick(ns.length, at);
        if (!ns.length) return null;
        return ns.reduce((p, x) => (n.name === "max" ? Math.max(p, x) : Math.min(p, x)));
      }
      case "now":
        arity(0, 0);
        return new Date(this.now.getTime());
      case "today":
        arity(0, 0);
        return utcDate(this.now.getUTCFullYear(), this.now.getUTCMonth(), this.now.getUTCDate());
      case "number": {
        arity(1, 1);
        return toNumberOrNull(args[0]);
      }
      case "random":
        arity(0, 0);
        return this.random();
      case "not":
        arity(1, 1);
        return !truthy(args[0]);
      case "empty":
        arity(1, 1);
        return isEmptyValue(args[0]);
    }
    return callNotion(n.name, args, at, this.notionHost);
  }

  /** What Notion's functions need from here (W6.46). */
  readonly notionHost: NotionHost = {
    text: (s, at) => this.text(s, at),
    list: (items, at) => this.list(items, at),
    formatDate: (d, fmt) => formatMoment(d, fmt),
    prop: (of, name) => {
      if (of === undefined) return this.noteProp(this.scope.file, name);
      if (isTagged(of) && of.$ === "file") return this.noteProp(of.file, name);
      const f = isTagged(of) && of.$ === "link" ? this.scope.vault?.resolve(of.path) : typeof of === "string" ? this.scope.vault?.resolve(parseWikiLink(of)?.path ?? of) : null;
      return f ? this.noteProp(f, name) : null;
    },
  };

  /**
   * Notion's functions with lazy arguments (W6.46): `ifs`, `let`, `lets`,
   * and the list functions whose expression runs per item with `current`
   * and `index`. `undefined`: not one of them.
   */
  notionLazy(n: Extract<BasesNode, { kind: "call" }>): BValue | undefined {
    const at = n.at;
    const args = n.args;
    const need = (min: number, max: number) => {
      if (args.length < min || args.length > max) throw new FormulaError("arity", `${n.name}() takes ${min === max ? min : `${min} to ${max}`} arguments, not ${args.length}`, at);
    };
    const nameOf = (x: BasesNode) => {
      if (x.kind !== "name") throw new FormulaError("syntax", `${n.name}() needs a name, like let(x, 2, x + 1)`, x.at);
      return x.name;
    };
    switch (n.name) {
      case "ifs": {
        if (args.length < 3 || args.length % 2 === 0) throw new FormulaError("arity", "ifs() takes pairs of condition, value, and a last value", at);
        for (let i = 0; i + 1 < args.length; i += 2) if (truthy(this.run(args[i]))) return this.run(args[i + 1]);
        return this.run(args[args.length - 1]);
      }
      case "let":
        need(3, 3);
        return this.withLocals({ [nameOf(args[0])]: this.run(args[1]) }, args[2]);
      case "lets": {
        if (args.length < 3 || args.length % 2 === 0) throw new FormulaError("arity", "lets() takes pairs of name, value, and an expression", at);
        const locals: Record<string, BValue> = {};
        const saved = this.scope.locals;
        try {
          for (let i = 0; i + 1 < args.length; i += 2) {
            locals[nameOf(args[i])] = this.run(args[i + 1]);
            this.scope = { ...this.scope, locals: { ...saved, ...locals } };
          }
          return this.run(args[args.length - 1]);
        } finally {
          this.scope = { ...this.scope, locals: saved };
        }
      }
      case "map":
      case "filter":
      case "find":
      case "findIndex":
      case "some":
      case "every":
      case "count": {
        need(n.name === "count" ? 1 : 2, 2);
        const v = this.run(args[0]);
        const items = this.list(Array.isArray(v) ? v : v === null ? [] : [v], at);
        if (n.name === "count" && args.length === 1) return items.length;
        const each = (i: number) => this.withLocals({ current: items[i], index: i }, args[1]);
        switch (n.name) {
          case "map":
            return this.list(items.map((_, i) => each(i)), at);
          case "filter":
            return this.list(items.filter((_, i) => truthy(each(i))), at);
          case "find": {
            for (let i = 0; i < items.length; i++) if (truthy(each(i))) return items[i];
            return null;
          }
          case "findIndex": {
            for (let i = 0; i < items.length; i++) if (truthy(each(i))) return i;
            return -1;
          }
          case "some":
            return items.some((_, i) => truthy(each(i)));
          case "every":
            return items.every((_, i) => truthy(each(i)));
          default:
            return items.filter((_, i) => truthy(each(i))).length;
        }
      }
    }
    return undefined;
  }

  /** Lazy arguments: map / filter / reduce run their expression once per item. */
  withLocals(locals: Record<string, BValue>, node: BasesNode): BValue {
    const saved = this.scope.locals;
    this.scope = { ...this.scope, locals: { ...saved, ...locals } };
    try {
      return this.run(node);
    } finally {
      this.scope = { ...this.scope, locals: saved };
    }
  }

  method(n: Extract<BasesNode, { kind: "method" }>): BValue {
    const at = n.at;
    const name = n.name;
    const recv = this.run(n.object);
    const lazy = name === "map" || name === "filter" || name === "reduce";
    if (lazy && Array.isArray(recv)) return this.listLambda(recv, n);
    const args = lazy ? [] : n.args.map((x) => this.run(x));
    const arity = (min: number, max: number) => {
      if (args.length < min || args.length > max) throw new FormulaError("arity", `${name}() takes ${min === max ? min : `${min} to ${max}`} argument${max === 1 ? "" : "s"}, not ${args.length}`, at);
    };
    // Methods every type has.
    switch (name) {
      case "isTruthy":
        arity(0, 0);
        return truthy(recv);
      case "isType": {
        arity(1, 1);
        const want = toText(args[0]).toLowerCase();
        const t = tagOf(recv);
        return want === t || (want === "regexp" && t === "regex") || (want === "string" && t === "link");
      }
      case "toString":
        arity(0, 0);
        return toText(recv);
      case "isEmpty":
        arity(0, 0);
        return isEmptyValue(recv);
    }
    if (recv === null) return null;
    if (Array.isArray(recv)) return this.listMethod(recv, name, args, arity, at);
    if (typeof recv === "number") return this.numberMethod(recv, name, args, arity, at);
    if (recv instanceof Date) return this.dateMethod(recv, name, args, arity, at);
    if (isTagged(recv)) {
      switch (recv.$) {
        case "file":
          return this.fileMethod(recv.file, name, args, arity, at);
        case "link":
          return this.linkMethod(recv, name, args, arity, at);
        case "object":
          if (name === "keys") return this.list(Object.keys(recv.map), at);
          if (name === "values") return this.list(Object.values(recv.map), at);
          break;
        case "regex":
          if (name === "matches") {
            arity(1, 1);
            recv.re.lastIndex = 0;
            return recv.re.test(this.text(toText(args[0]), at));
          }
          break;
        default:
          return this.stringMethod(toText(recv), name, args, arity, at);
      }
      throw new FormulaError("type", `${name}() does not apply to ${recv.$ === "object" ? "an object" : `a ${recv.$}`}`, at);
    }
    if (typeof recv === "boolean") throw new FormulaError("type", `${name}() does not apply to true / false`, at);
    // Text: a date in ISO form takes the date methods; a [[link]] the link ones.
    const asDate = toDate(recv);
    if (asDate && (name === "format" || name === "date" || name === "time" || name === "relative")) return this.dateMethod(asDate, name, args, arity, at);
    if (name === "asFile" || name === "linksTo" || name === "prop") return this.linkMethod(parseWikiLink(recv) ?? { $: "link", path: recv }, name, args, arity, at);
    return this.stringMethod(recv, name, args, arity, at);
  }

  listLambda(items: BValue[], n: Extract<BasesNode, { kind: "method" }>): BValue {
    const at = n.at;
    this.list(items, at);
    if (n.name === "map" || n.name === "filter") {
      if (n.args.length !== 1) throw new FormulaError("arity", `${n.name}() takes 1 argument, not ${n.args.length}`, at);
      const out: BValue[] = [];
      items.forEach((value, index) => {
        const r = this.withLocals({ value, index }, n.args[0]);
        if (n.name === "map") out.push(r);
        else if (truthy(r)) out.push(value);
      });
      return this.list(out, at);
    }
    if (n.args.length !== 2) throw new FormulaError("arity", `reduce() takes 2 arguments (expression, start), not ${n.args.length}`, at);
    let acc = this.run(n.args[1]);
    items.forEach((value, index) => {
      acc = this.withLocals({ value, index, acc }, n.args[0]);
    });
    return acc;
  }
}

/** Evaluate a parsed expression over one file. Never throws. */
export function evaluateBases(tree: BasesNode, scope: BasesScope, opts: BasesEvalOptions = {}): BasesResult {
  try {
    return { ok: true, value: new Interpreter(scope, opts).run(tree) };
  } catch (e) {
    if (e instanceof FormulaError) return { ok: false, error: e };
    return { ok: false, error: new FormulaError("limit", (e as Error)?.message ?? "the expression could not be evaluated") };
  }
}

/** The share of documented Bases functions this interpreter runs (for the docs and the coverage test). */
export function basesCoverage(): { supported: number; documented: number } {
  return { supported: BASES_DOCUMENTED.filter((n) => !BASES_UNSUPPORTED.has(n)).length, documented: BASES_DOCUMENTED.length };
}

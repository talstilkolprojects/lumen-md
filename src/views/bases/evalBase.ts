/**
 * The Bases interpreter's budget, options and methods per value type — link,
 * list, number, date, file, text — and `file.inFolder` (plan W6.25: moved out
 * of evaluate.ts unchanged; its Interpreter extends InterpreterBase, and
 * evaluate.ts re-exports inFolder).
 */
import { Budget, DEFAULT_LIMITS, FormulaError } from "../formula/ast";
import { formatDate, utcDate } from "../formula/values";
import { equalValues, fromYaml, isTagged, sortCompare, toText, type BasesFile, type BLink, type BValue } from "./values";
import { fileValue, textArg, numArg, clean, formatMoment, relativeText, titleCase, tagMatches, normFolder } from "./evalHelpers";
import type { BasesEvalOptions, BasesScope } from "./evaluate";

/** `file.inFolder(folder)`: the folder or one under it ("" is the whole vault). */
export function inFolder(file: BasesFile, folder: string): boolean {
  const want = normFolder(folder);
  const have = normFolder(file.folder);
  return want === "" || have === want || have.startsWith(`${want}/`);
}

/** The interpreter's budget and options, and its methods per value type. */
export class InterpreterBase {
  readonly budget: Budget;
  readonly now: Date;
  readonly locale: string;
  readonly random: () => number;
  constructor(
    public scope: BasesScope,
    opts: BasesEvalOptions,
  ) {
    this.budget = new Budget({ ...DEFAULT_LIMITS, ...opts.limits });
    this.now = opts.now ?? new Date();
    this.locale = opts.locale ?? "en";
    this.random = opts.random ?? Math.random;
  }

  list(items: BValue[], at: number): BValue[] {
    if (items.length > this.budget.limits.maxList) throw new FormulaError("limit", `list longer than ${this.budget.limits.maxList} items`, at);
    this.budget.tick(items.length, at);
    return items;
  }

  text(s: string, at: number): string {
    if (s.length > this.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${this.budget.limits.maxText} characters`, at);
    this.budget.tick(Math.ceil(s.length / 64), at);
    return s;
  }

  noteProp(file: BasesFile, key: string): BValue {
    if (!Object.prototype.hasOwnProperty.call(file.fm, key)) return null;
    return fromYaml(file.fm[key]);
  }

  linkMethod(l: BLink, name: string, args: BValue[], arity: (a: number, b: number) => void, at: number): BValue {
    if (name === "prop") {
      arity(1, 1);
      const f = this.scope.vault?.resolve(l.path);
      return f ? this.noteProp(f, toText(args[0])) : null;
    }
    if (name === "asFile") {
      arity(0, 0);
      const f = this.scope.vault?.resolve(l.path);
      return f ? fileValue(f) : null;
    }
    if (name === "linksTo") {
      arity(1, 1);
      const f = this.scope.vault?.resolve(l.path);
      return f ? this.fileMethod(f, "hasLink", args, arity, at) : false;
    }
    return this.stringMethod(toText(l), name, args, arity, at);
  }

  listMethod(v: BValue[], name: string, args: BValue[], arity: (a: number, b: number) => void, at: number): BValue {
    this.budget.tick(v.length, at);
    switch (name) {
      case "contains":
        arity(1, 1);
        return v.some((x) => equalValues(x, args[0]));
      case "includes":
        arity(1, 1);
        return v.some((x) => equalValues(x, args[0]));
      case "containsAll":
        return args.every((a) => v.some((x) => equalValues(x, a)));
      case "containsAny":
        return args.some((a) => v.some((x) => equalValues(x, a)));
      case "flat": {
        arity(0, 0);
        const out: BValue[] = [];
        for (const x of v) {
          if (Array.isArray(x)) out.push(...x);
          else out.push(x);
        }
        return this.list(out, at);
      }
      case "join": {
        arity(0, 1);
        const sep = args[0] === undefined ? "," : toText(args[0]);
        return this.text(v.map(toText).join(sep), at);
      }
      case "reverse":
        arity(0, 0);
        return [...v].reverse();
      case "slice": {
        arity(1, 2);
        const s = numArg(args[0], "slice()", at);
        return v.slice(s, args[1] === undefined ? undefined : numArg(args[1], "slice()", at));
      }
      case "sort":
        arity(0, 0);
        return [...v].sort(sortCompare);
      case "unique": {
        arity(0, 0);
        const out: BValue[] = [];
        for (const x of v) if (!out.some((y) => equalValues(x, y))) out.push(x);
        return out;
      }
      case "length":
        return v.length;
    }
    throw new FormulaError("type", `${name}() does not apply to a list`, at);
  }

  numberMethod(v: number, name: string, args: BValue[], arity: (a: number, b: number) => void, at: number): BValue {
    switch (name) {
      case "abs":
        arity(0, 0);
        return Math.abs(v);
      case "ceil":
        arity(0, 0);
        return Math.ceil(v);
      case "floor":
        arity(0, 0);
        return Math.floor(v);
      case "round": {
        arity(0, 1);
        const d = numArg(args[0], "round()", at, 0);
        if (!Number.isInteger(d) || d < 0 || d > 15) throw new FormulaError("type", "round() digits must be a whole number from 0 to 15", at);
        const f = 10 ** d;
        return clean(Math.round((v + Math.sign(v) * Number.EPSILON) * f) / f, at);
      }
      case "toFixed": {
        arity(1, 1);
        const d = numArg(args[0], "toFixed()", at);
        if (!Number.isInteger(d) || d < 0 || d > 20) throw new FormulaError("type", "toFixed() precision must be a whole number from 0 to 20", at);
        return v.toFixed(d);
      }
    }
    return this.stringMethod(String(v), name, args, arity, at);
  }

  dateMethod(v: Date, name: string, args: BValue[], arity: (a: number, b: number) => void, at: number): BValue {
    switch (name) {
      case "date":
        arity(0, 0);
        return utcDate(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate());
      case "format":
        arity(1, 1);
        return this.text(formatMoment(v, toText(args[0])), at);
      case "time":
        arity(0, 0);
        return formatMoment(v, "HH:mm:ss");
      case "relative":
        arity(0, 0);
        return relativeText(v, this.now, this.locale);
    }
    return this.stringMethod(formatDate(v), name, args, arity, at);
  }

  fileMethod(f: BasesFile, name: string, args: BValue[], arity: (a: number, b: number) => void, at: number): BValue {
    switch (name) {
      case "asLink":
        arity(0, 1);
        return args[0] === undefined || args[0] === null ? { $: "link", path: f.path } : { $: "link", path: f.path, display: toText(args[0]) };
      case "hasLink": {
        arity(1, 1);
        const o = args[0];
        const target = isTagged(o) && o.$ === "file" ? o.file : isTagged(o) && o.$ === "link" ? this.scope.vault?.resolve(o.path) : this.scope.vault?.resolve(toText(o));
        const want: BValue = target ? { $: "file", file: target } : toText(o);
        return f.links.some((l) => equalValues({ $: "link", path: l }, want));
      }
      case "hasProperty":
        arity(1, 1);
        return Object.prototype.hasOwnProperty.call(f.fm, toText(args[0]));
      case "hasTag":
        if (!args.length) throw new FormulaError("arity", "hasTag() needs at least one tag", at);
        return args.some((a) => f.tags.some((t) => tagMatches(t, toText(a))));
      case "inFolder":
        arity(1, 1);
        return inFolder(f, toText(args[0]));
      case "prop":
        // W6.46, Notion's `current.prop("Estimate")` on a related note.
        arity(1, 1);
        return this.noteProp(f, toText(args[0]));
    }
    return this.stringMethod(f.basename, name, args, arity, at);
  }

  stringMethod(s: string, name: string, args: BValue[], arity: (a: number, b: number) => void, at: number): BValue {
    this.text(s, at);
    const pattern = (v: BValue): string | RegExp => (isTagged(v) && v.$ === "regex" ? new RegExp(v.re.source, v.re.flags) : toText(v));
    switch (name) {
      case "contains":
      case "includes":
        arity(1, 1);
        return s.includes(textArg(args[0], name, at));
      case "containsAll":
        return args.every((a) => s.includes(toText(a)));
      case "containsAny":
        return args.some((a) => s.includes(toText(a)));
      case "startsWith":
        arity(1, 1);
        return s.startsWith(textArg(args[0], name, at));
      case "endsWith":
        arity(1, 1);
        return s.endsWith(textArg(args[0], name, at));
      case "lower":
      case "toLowerCase":
        arity(0, 0);
        return s.toLowerCase();
      case "upper":
      case "toUpperCase":
        arity(0, 0);
        return s.toUpperCase();
      case "title":
        arity(0, 0);
        return titleCase(s);
      case "trim":
        arity(0, 0);
        return s.trim();
      case "reverse":
        arity(0, 0);
        return [...s].reverse().join("");
      case "repeat": {
        arity(1, 1);
        const n = numArg(args[0], "repeat()", at);
        if (!Number.isInteger(n) || n < 0) throw new FormulaError("type", "repeat() needs a count of 0 or more", at);
        if (s.length * n > this.budget.limits.maxText) throw new FormulaError("limit", `text longer than ${this.budget.limits.maxText} characters`, at);
        return this.text(s.repeat(n), at);
      }
      case "replace": {
        arity(2, 2);
        const p = pattern(args[0]);
        const out = s.replace(p, toText(args[1]));
        return this.text(out, at);
      }
      case "slice": {
        arity(1, 2);
        const chars = [...s];
        return chars.slice(numArg(args[0], "slice()", at), args[1] === undefined ? undefined : numArg(args[1], "slice()", at)).join("");
      }
      case "split": {
        arity(1, 2);
        const p = pattern(args[0]);
        const limit = args[1] === undefined ? undefined : numArg(args[1], "split()", at);
        return this.list(s.split(p, limit), at);
      }
      case "matches": {
        arity(1, 1);
        const re = args[0];
        if (!(isTagged(re) && re.$ === "regex")) throw new FormulaError("type", "matches() takes a regular expression: /pattern/", at);
        return new RegExp(re.re.source, re.re.flags).test(s);
      }
      case "length":
        return [...s].length;
    }
    throw new FormulaError("type", `${name}() does not apply to text`, at);
  }
}

/**
 * Note properties — the YAML frontmatter at the top of a note (plan 4.9).
 *
 * A small pure API for the properties panel (and, later, the database view
 * that edits cells, plan 4.10):
 *
 *   readProperties(text)              → [{ key, value, type, editable }]
 *   setProperty(text, key, value)     → text with that one value written
 *   removeProperty(text, key)         → text without that property
 *   renameProperty(text, from, to)    → text with the key renamed
 *
 * The YAML is parsed with the `yaml` Document API (`parseDocument`), which
 * gives every node its source range. Writes do not re-serialize the
 * document: only the edited value's range is replaced, with the value
 * stringified by `yaml` in the style the old value had (plain, single or
 * double quotes; block or flow list). Everything else — comments, key order,
 * quoting, blank lines, indentation, CRLF line endings, a BOM — stays byte
 * for byte. A frontmatter that does not parse is never written: the write
 * functions throw `FrontmatterError` and the caller asks the user to fix it
 * in the editor.
 */

import { Document, isMap, isNode, isScalar, isSeq, parseDocument, Scalar, YAMLSeq, type Pair } from "yaml";

export type PropertyType = "text" | "number" | "date" | "list" | "checkbox" | "link";
export type PropertyValue = string | number | boolean | string[] | null;

export interface Property {
  key: string;
  /** The parsed value (a map or nested list is returned as is, but is not editable). */
  value: unknown;
  type: PropertyType;
  /** False for values the panel cannot edit (maps, nested lists). */
  editable: boolean;
}

export class FrontmatterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FrontmatterError";
  }
}

interface Block {
  /** Offset where the YAML body starts (after the opening `---` line). */
  bodyStart: number;
  /** Offset of the closing `---` line (= the body's end). */
  closeStart: number;
  eol: string;
}

/**
 * Locate the frontmatter block: `---` on the first line (after a BOM), up
 * to the next `---` line. "unterminated" when the opening fence has no
 * closing one — that note must not get a second block prepended.
 */
function findBlock(text: string): Block | null | "unterminated" {
  const open = /^(?:﻿)?---[ \t]*(\r?\n)/.exec(text);
  if (!open) return null;
  const bodyStart = open[0].length;
  const close = /^---[ \t]*(?:\r?\n|$)/gm;
  close.lastIndex = bodyStart;
  let m: RegExpExecArray | null;
  while ((m = close.exec(text)) !== null) {
    if (m.index >= bodyStart && (m.index === bodyStart || text[m.index - 1] === "\n")) {
      return { bodyStart, closeStart: m.index, eol: open[1] };
    }
    if (close.lastIndex === m.index) close.lastIndex++;
  }
  return "unterminated";
}

type ParsedYaml = { block: Block; body: string; doc: Document.Parsed; pairs: Pair[] };

function parse(text: string): ParsedYaml | null | { error: string } {
  const block = findBlock(text);
  if (!block) return null;
  if (block === "unterminated") return { error: "the frontmatter has no closing ---" };
  const body = text.slice(block.bodyStart, block.closeStart);
  const doc = parseDocument(body, { uniqueKeys: false, keepSourceTokens: false });
  if (doc.errors.length) return { error: doc.errors[0].message.split("\n")[0] };
  const c = doc.contents;
  if (c === null) return { block, body, doc, pairs: [] };
  if (!isMap(c)) return { error: "the frontmatter is not a list of key: value pairs" };
  if (c.flow) return { error: "a `{ … }` frontmatter can't be edited here" };
  return { block, body, doc, pairs: c.items as Pair[] };
}

const keyOf = (p: Pair): string | null => (isScalar(p.key) ? String(p.key.value) : null);

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const LIST_KEYS = new Set(["tags", "aliases", "cssclasses", "keywords"]);
const DATE_KEYS = new Set(["date", "created", "updated", "modified", "due"]);

/** The type a value reads as (known keys decide for empty values). */
export function inferType(value: unknown, key = ""): PropertyType {
  if (typeof value === "boolean") return "checkbox";
  if (typeof value === "number") return "number";
  if (Array.isArray(value)) return "list";
  if (typeof value === "string") {
    if (DATE.test(value.trim())) return "date";
    if (/^\[\[[^\]]+\]\]$/.test(value.trim()) || /^https?:\/\/\S+$/.test(value.trim())) return "link";
    return "text";
  }
  const k = key.toLowerCase();
  if (LIST_KEYS.has(k)) return "list";
  if (DATE_KEYS.has(k)) return "date";
  return "text";
}

export interface ParsedProperties {
  status: "none" | "ok" | "invalid";
  error?: string;
  properties: Property[];
}

/** Every top-level property, in file order, and whether the frontmatter could be read. */
export function parseProperties(text: string): ParsedProperties {
  const p = parse(text);
  if (p === null) return { status: "none", properties: [] };
  if ("error" in p) return { status: "invalid", error: p.error, properties: [] };
  const out: Property[] = [];
  for (const pair of p.pairs) {
    const key = keyOf(pair);
    if (key === null) continue;
    const value = isNode(pair.value) ? pair.value.toJS(p.doc) : pair.value ?? null;
    const scalarList = Array.isArray(value) && value.every((v) => v === null || ["string", "number", "boolean"].includes(typeof v));
    const editable = value === null || ["string", "number", "boolean"].includes(typeof value) || scalarList;
    out.push({ key, value, type: inferType(value, key), editable });
  }
  return { status: "ok", properties: out };
}

/** Every property (empty when there is no frontmatter or it doesn't parse). */
export function readProperties(text: string): Property[] {
  return parseProperties(text).properties;
}

// ── stringifying ────────────────────────────────────────────────────────

type ScalarStyle = Scalar.Type | undefined;

/** One scalar as YAML source on one line, in `style` when it can be. */
function scalarText(value: string | number | boolean | null, style: ScalarStyle): string {
  if (value === null) return "";
  const node = new Scalar(value);
  if (typeof value === "string") {
    // Multi-line strings stay on one line, escaped; block scalars would
    // need the surrounding indentation.
    if (/[\r\n]/.test(value)) node.type = Scalar.QUOTE_DOUBLE;
    else if (style === Scalar.QUOTE_DOUBLE || style === Scalar.QUOTE_SINGLE) node.type = style;
  }
  return new Document(node).toString({ lineWidth: 0 }).replace(/\r?\n$/, "");
}

function flowListText(items: string[], style: ScalarStyle, padding: boolean): string {
  if (!items.length) return "[]";
  const seq = new YAMLSeq();
  seq.flow = true;
  for (const item of items) {
    const s = new Scalar(item);
    if (style === Scalar.QUOTE_DOUBLE || style === Scalar.QUOTE_SINGLE) s.type = style;
    seq.items.push(s);
  }
  return new Document(seq).toString({ lineWidth: 0, flowCollectionPadding: padding }).replace(/\r?\n$/, "");
}

/** `- a`, `- b` lines; the first without indentation (it continues a line that has it). */
function blockListLines(items: string[], style: ScalarStyle, indent: string, eol: string): string {
  return items.map((item, i) => `${i ? indent : ""}- ${scalarText(item, style)}`).join(eol);
}

function keyText(key: string): string {
  return scalarText(key, undefined);
}

const lineStart = (s: string, i: number) => s.lastIndexOf("\n", i - 1) + 1;
const columnOf = (s: string, i: number) => i - lineStart(s, i);

/** Where a value's own source ends: the last list item's end, not the newline or comment after it. */
function valueEnd(v: unknown, body: string): number {
  if (isSeq(v) && !v.flow && v.items.length) {
    const last = v.items[v.items.length - 1];
    if (isNode(last) && last.range) return last.range[1];
  }
  if (isNode(v) && v.range) {
    let end = v.range[1];
    while (end > v.range[0] && /\s/.test(body[end - 1])) end--;
    return end;
  }
  return -1;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function normalize(value: PropertyValue): PropertyValue {
  if (Array.isArray(value)) return value.map((v) => String(v));
  if (typeof value === "number" && !Number.isFinite(value)) throw new FrontmatterError("not a finite number");
  return value;
}

/** Text of a new frontmatter for a note that has none. */
function addFrontmatter(text: string, key: string, value: PropertyValue): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const bom = text.startsWith("﻿") ? "﻿" : "";
  const rest = bom ? text.slice(1) : text;
  return `${bom}---${eol}${newPairText(key, value, eol)}---${eol}${rest}`;
}

/** `key: value` (or a block list) as complete lines. */
function newPairText(key: string, value: PropertyValue, eol: string): string {
  if (Array.isArray(value)) {
    if (!value.length) return `${keyText(key)}: []${eol}`;
    return `${keyText(key)}:${eol}  ${blockListLines(value, undefined, "  ", eol)}${eol}`;
  }
  const v = scalarText(value, undefined);
  return `${keyText(key)}:${v ? " " + v : ""}${eol}`;
}

/**
 * Write one property. An existing value is replaced in place — in the style
 * it had — a new key is appended to the frontmatter (created when there is
 * none). Lists are string lists; `null` writes an empty value (`key:`).
 */
export function setProperty(text: string, key: string, value: PropertyValue): string {
  if (!key.trim()) throw new FrontmatterError("empty property name");
  const next = normalize(value);
  const p = parse(text);
  if (p === null) return addFrontmatter(text, key, next);
  if ("error" in p) throw new FrontmatterError(p.error);
  const { block, body } = p;
  const pair = p.pairs.find((x) => keyOf(x) === key);
  const at = (start: number, end: number, insert: string) =>
    text.slice(0, block.bodyStart + start) + insert + text.slice(block.bodyStart + end);

  if (!pair) return at(body.length, body.length, newPairText(key, next, block.eol));

  const v = pair.value;
  const old = isNode(v) ? v.toJS(p.doc) : v ?? null;
  if (sameValue(old, next)) return text;
  const keyRange = isNode(pair.key) ? pair.key.range : null;
  if (!keyRange) throw new FrontmatterError("unsupported key");
  const colon = body.indexOf(":", keyRange[1]);
  const end = valueEnd(v, body);
  const hasSource = isNode(v) && v.range && v.range[0] !== v.range[1];
  const indent = " ".repeat(columnOf(body, keyRange[0]) + 2);

  // Same shape: replace only the value's own source.
  if (hasSource && isScalar(v) && !Array.isArray(next) && v.type !== Scalar.BLOCK_FOLDED && v.type !== Scalar.BLOCK_LITERAL) {
    if (next === null) return at(colon + 1, end, "");
    return at(v.range![0], end, scalarText(next, v.type));
  }
  if (hasSource && isSeq(v) && Array.isArray(next)) {
    const first = v.items[0];
    const style = isScalar(first) ? first.type : undefined;
    if (v.flow) {
      const src = body.slice(v.range![0], end);
      return at(v.range![0], end, flowListText(next, style, /^\[\s/.test(src)));
    }
    if (next.length) {
      const listIndent = " ".repeat(columnOf(body, v.range![0]));
      return at(v.range![0], end, blockListLines(next, style, listIndent, block.eol));
    }
  }
  // A different shape (or an empty value): rewrite everything after the colon.
  const from = colon + 1;
  const to = hasSource ? end : from;
  if (Array.isArray(next)) {
    if (!next.length) return at(from, to, " []");
    return at(from, to, `${block.eol}${indent}${blockListLines(next, undefined, indent, block.eol)}`);
  }
  const s = scalarText(next, undefined);
  return at(from, to, s ? " " + s : "");
}

/** Remove a property: its lines, from the key to the end of its value. Unchanged when absent. */
export function removeProperty(text: string, key: string): string {
  const p = parse(text);
  if (p === null) return text;
  if ("error" in p) throw new FrontmatterError(p.error);
  const pair = p.pairs.find((x) => keyOf(x) === key);
  if (!pair) return text;
  const { body, block } = p;
  const keyRange = isNode(pair.key) ? pair.key.range : null;
  if (!keyRange) throw new FrontmatterError("unsupported key");
  const end = Math.max(valueEnd(pair.value, body), body.indexOf(":", keyRange[1]) + 1);
  const start = lineStart(body, keyRange[0]);
  const nl = body.indexOf("\n", end);
  const stop = nl < 0 ? body.length : nl + 1;
  return text.slice(0, block.bodyStart + start) + text.slice(block.bodyStart + stop);
}

/** Rename a property's key; its value and position stay. */
export function renameProperty(text: string, from: string, to: string): string {
  if (from === to) return text;
  if (!to.trim()) throw new FrontmatterError("empty property name");
  const p = parse(text);
  if (p === null) return text;
  if ("error" in p) throw new FrontmatterError(p.error);
  if (p.pairs.some((x) => keyOf(x) === to)) throw new FrontmatterError(`"${to}" already exists`);
  const pair = p.pairs.find((x) => keyOf(x) === from);
  const range = pair && isNode(pair.key) ? pair.key.range : null;
  if (!range) return text;
  const { block } = p;
  return text.slice(0, block.bodyStart + range[0]) + keyText(to) + text.slice(block.bodyStart + range[1]);
}

/** Convert a value for a new type (the panel's type picker). */
export function convertValue(value: unknown, to: PropertyType): PropertyValue {
  const str = Array.isArray(value) ? value.join(", ") : value === null || value === undefined ? "" : String(value);
  switch (to) {
    case "text":
      return str || null;
    case "number": {
      const n = Number(str);
      return str && Number.isFinite(n) ? n : 0;
    }
    case "date":
      return typeof value === "string" && DATE.test(value) ? value : new Date().toISOString().slice(0, 10);
    case "list":
      return Array.isArray(value) ? value.map(String) : str.split(",").map((s) => s.trim()).filter(Boolean);
    case "checkbox":
      return value === true || /^(true|yes|1|on)$/i.test(str);
    case "link":
      return !str || /^\[\[.*\]\]$/.test(str) || /^https?:\/\//.test(str) ? str || null : `[[${str}]]`;
  }
}

// ── vault-wide suggestions ──────────────────────────────────────────────

export interface PropertySuggestions {
  /** Property names, with how many notes use them. */
  keys: Map<string, number>;
  /** For each name, the values used (list items one by one), with counts. */
  values: Map<string, Map<string, number>>;
}

/** Collect the property names and values used across `files` (notes without frontmatter cost one regex). */
export function collectPropertySuggestions(files: Iterable<{ path: string; content: string }>): PropertySuggestions {
  const keys = new Map<string, number>();
  const values = new Map<string, Map<string, number>>();
  for (const f of files) {
    if (!/\.(md|markdown)$/i.test(f.path) || !/^(?:﻿)?---/.test(f.content)) continue;
    for (const prop of readProperties(f.content)) {
      keys.set(prop.key, (keys.get(prop.key) ?? 0) + 1);
      const items = Array.isArray(prop.value) ? prop.value : [prop.value];
      for (const item of items) {
        if (item === null || item === undefined || typeof item === "object") continue;
        const s = String(item).trim();
        if (!s) continue;
        let m = values.get(prop.key);
        if (!m) values.set(prop.key, (m = new Map()));
        m.set(s, (m.get(s) ?? 0) + 1);
      }
    }
  }
  return { keys, values };
}

/** Most used first, then alphabetical; without `exclude`. */
export function rankSuggestions(counts: Map<string, number> | undefined, exclude: Iterable<string> = [], limit = 50): string[] {
  if (!counts) return [];
  const skip = new Set(exclude);
  return [...counts.entries()]
    .filter(([v]) => !skip.has(v))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([v]) => v);
}

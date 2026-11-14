/**
 * A fast path for bulk property edits (plan W7.4): a YAML parse costs about
 * a millisecond, and 1,000 notes must change in under 3 seconds. Most real
 * frontmatter is a handful of `key: value` lines, so for exactly that shape
 * this edits the lines directly, writing what the YAML path writes, byte for
 * byte (a differential test in bulkEdit.test.ts holds them together).
 *
 * Anything else, such as quotes with escapes, nested maps, multi-line
 * strings, anchors, a value YAML would read as a number, a boolean or null,
 * returns null, and the caller takes the YAML path.
 */
import type { BulkOp, BulkResult } from "./bulkEdit";

interface Line {
  /** Index in the frontmatter's lines. */
  at: number;
  key: string;
  /** The value's source, without the comment. */
  value: string;
  /** `   # comment` after the value, with its spaces, or "". */
  comment: string;
  style: "plain" | "double" | "flow" | "block" | "empty";
  /** Block list: its item lines' indent and the item texts; flow list: the items. */
  items: string[];
  indent: string;
  /** Lines the pair spans (block lists span their items). */
  span: number;
  /** A value this path can step over but not edit (a number, a boolean, an item YAML would type). */
  opaque: boolean;
}

const KEY = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u;
/** A plain scalar YAML reads as a string, and writes back as it is. */
const PLAIN = /^[\p{L}\p{N}_][\p{L}\p{N}_ .,/()'’\u05F3\u05F4-]*$/u;
const NOT_STRING = /^(?:[-+]?(?:\d[\d_]*|\d*\.\d+|\d+\.\d*)(?:[eE][-+]?\d+)?|0x[0-9a-fA-F]+|0o[0-7]+|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN)|true|True|TRUE|false|False|FALSE|null|Null|NULL|~|y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;
const ITEM = /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]*$/u;
/** A one-line scalar YAML reads without surprises (no colon, quote, flow or anchor syntax). */
const OPAQUE = /^[^\s'"[\]{}&*!|>%@`#,?:-][^:#[\]{}]*$/;
const opaqueOk = (s: string) => OPAQUE.test(s) && !/\s$/.test(s);

function plainOk(s: string): boolean {
  return PLAIN.test(s) && !NOT_STRING.test(s) && !/\s$/.test(s) && !/ #|: /.test(s);
}

/** Split a value from its trailing comment. */
function splitComment(rest: string): [string, string] {
  const m = /^(.*?)(\s+#.*)?$/.exec(rest)!;
  return [m[1], m[2] ?? ""];
}

interface Parsed {
  eol: string;
  head: string;
  lines: string[];
  pairs: Line[];
  tail: string;
}

function parseSimple(text: string): Parsed | null {
  const m = /^---(\r?\n)/.exec(text);
  if (!m) return null;
  const eol = m[1];
  const close = text.indexOf(`${eol}---`, 3);
  if (close < 0) return null;
  const afterClose = close + eol.length + 3;
  // The closing fence ends the line (or the file).
  if (afterClose < text.length && !text.startsWith(eol, afterClose)) return null;
  const bodyText = text.slice(m[0].length, close);
  if (bodyText.includes("\r") !== (eol === "\r\n")) return null;
  const lines = bodyText === "" ? [] : bodyText.split(eol);
  if (lines.some((l) => l.includes("\r") || l.includes("\t"))) return null;
  const pairs: Line[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l === "" || /^#/.test(l)) continue;
    const km = /^([^:]+):(?: (.*))?$/.exec(l);
    if (!km || !KEY.test(km[1]) || /\s$/.test(km[1])) return null;
    const key = km[1];
    if (seen.has(key)) return null;
    seen.add(key);
    const [value, comment] = splitComment(km[2] ?? "");
    const pair: Line = { at: i, key, value, comment, style: "plain", items: [], indent: "", span: 1, opaque: false };
    if (value === "") {
      // A block list may follow.
      let j = i + 1;
      let indent: string | null = null;
      for (; j < lines.length; j++) {
        const im = /^( *)- (.*)$/.exec(lines[j]);
        if (!im) break;
        if (indent === null) indent = im[1];
        if (im[1] !== indent) return null;
        if (!ITEM.test(im[2]) || NOT_STRING.test(im[2]) || /\s$/.test(im[2])) {
          if (!opaqueOk(im[2])) return null;
          pair.opaque = true;
        }
        pair.items.push(im[2]);
      }
      if (pair.items.length) {
        if (comment) return null;
        pair.style = "block";
        pair.indent = indent ?? "";
        pair.span = j - i;
        i = j - 1;
      } else pair.style = "empty";
      if (comment && pair.style === "empty") return null;
    } else if (/^\[.*\]$/.test(value)) {
      const inner = value.slice(1, -1);
      if (/^\s|\s$/.test(inner)) return null;
      const items = inner === "" ? [] : inner.split(", ");
      if (items.some((x) => !ITEM.test(x) || NOT_STRING.test(x) || /\s$/.test(x))) {
        if (!items.every(opaqueOk)) return null;
        pair.opaque = true;
      }
      pair.style = "flow";
      pair.items = items;
    } else if (/^"[^"\\]*"$/.test(value)) {
      pair.style = "double";
      if (!plainOk(value.slice(1, -1))) pair.opaque = true;
    } else if (!plainOk(value)) {
      if (!opaqueOk(value)) return null;
      pair.opaque = true;
    }
    // A line indented under a key that is not a list item: a nested map, not this shape.
    if (i + 1 < lines.length && /^ +[^ -]/.test(lines[i + 1])) return null;
    pairs.push(pair);
  }
  return { eol, head: m[0], lines, pairs, tail: text.slice(close) };
}

function join(p: Parsed, lines: string[]): string {
  // No line left: the fences meet (`---` then `---`), as the YAML path leaves them.
  if (!lines.length) return p.head + p.tail.slice(p.eol.length);
  return p.head + lines.join(p.eol) + p.tail;
}

const keyOk = (k: string) => KEY.test(k) && !/\s$/.test(k);

/** The edit, or null when the YAML path must decide. */
export function fastBulkOp(text: string, op: BulkOp): BulkResult | null {
  const p = parseSimple(text);
  if (!p || !keyOk(op.key)) return null;
  const pair = p.pairs.find((x) => x.key === op.key);
  if (pair?.opaque) return null;
  const lines = [...p.lines];
  const unchanged: BulkResult = { text, skip: "unchanged" };
  const replace = (from: number, count: number, insert: string[]) => {
    lines.splice(from, count, ...insert);
    return { text: join(p, lines) };
  };
  const append = (insert: string[]) => {
    // A new key goes after the last line (as the YAML path appends it).
    if (p.lines.length === 0) return null;
    return replace(lines.length, 0, insert);
  };
  switch (op.kind) {
    case "set": {
      const v = op.value;
      if (typeof v !== "string" || !plainOk(v)) return null;
      if (!pair) return append([`${op.key}: ${v}`]);
      if (pair.style === "plain") return pair.value === v ? unchanged : replace(pair.at, 1, [`${op.key}: ${v}${pair.comment}`]);
      if (pair.style === "double") return pair.value === `"${v}"` ? unchanged : replace(pair.at, 1, [`${op.key}: "${v}"${pair.comment}`]);
      return null;
    }
    case "clear":
      if (!pair) return unchanged;
      return replace(pair.at, pair.span, []);
    case "addTag":
    case "removeTag": {
      const tag = op.tag.trim().replace(/^#+/, "").trim();
      if (!ITEM.test(tag) || NOT_STRING.test(tag) || /\s$/.test(tag)) return null;
      if (!pair) {
        if (op.kind === "removeTag") return unchanged;
        return append([`${op.key}:`, `  - ${tag}`]);
      }
      if (pair.style !== "flow" && pair.style !== "block") return null;
      const has = pair.items.some((x) => x.toLowerCase() === tag.toLowerCase());
      const items = op.kind === "addTag" ? (has ? null : [...pair.items, tag]) : has ? pair.items.filter((x) => x.toLowerCase() !== tag.toLowerCase()) : null;
      if (!items) return unchanged;
      if (pair.style === "flow") return replace(pair.at, 1, [`${op.key}: [${items.join(", ")}]${pair.comment}`]);
      // An emptied block list becomes `key: []`, as the YAML path writes it.
      if (!items.length) return replace(pair.at, pair.span, [`${op.key}: []`]);
      return replace(pair.at + 1, pair.span - 1, items.map((x) => `${pair.indent}- ${x}`));
    }
    case "convert":
      return null;
  }
}

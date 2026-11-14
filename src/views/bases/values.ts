/**
 * Values of Obsidian Bases expressions (plan W1.11): what `note.x`,
 * `file.x` and the functions produce, how they compare, sort and print.
 *
 * Plain JSON-like values (null, boolean, number, text, Date, list) are kept
 * as they are; the Bases-only types are small tagged objects, so nothing
 * from the host (no DOM, no prototype) is ever reachable from a formula.
 * Dates are UTC, as in the database formulas (plan 4.11), so a base gives
 * the same answer in every time zone.
 */

import { FormulaError } from "../formula/ast";
import { asDate as isoDate, formatDate, utcDate } from "../formula/values";

/** One file of the vault, as Bases sees it (`file.*`). */
export interface BasesFile {
  path: string;
  /** With the extension, as Obsidian's `file.name`. */
  name: string;
  basename: string;
  /** Without the dot: `md`, `png`. */
  ext: string;
  /** "" at the vault root. */
  folder: string;
  size: number;
  ctime: Date | null;
  mtime: Date | null;
  /** Frontmatter `tags` and inline `#tags`, without `#`. */
  tags: string[];
  /** Link targets as written (`[[Note]]`, `[x](Note.md)`, frontmatter links), without `#heading` / `|alias`. */
  links: string[];
  embeds: string[];
  /** Parsed frontmatter; `{}` when none (or not a note). */
  fm: Record<string, unknown>;
}

export interface BObject {
  $: "object";
  map: Record<string, BValue>;
}
export interface BLink {
  $: "link";
  path: string;
  display?: string;
}
export interface BFileValue {
  $: "file";
  file: BasesFile;
}
export interface BRegex {
  $: "regex";
  re: RegExp;
}
/** A length of time: whole months (for `1M`, `1y`) plus milliseconds. */
export interface BDuration {
  $: "duration";
  months: number;
  ms: number;
}
export interface BHtml {
  $: "html";
  html: string;
}
export interface BImage {
  $: "image";
  src: string;
}

export type BTagged = BObject | BLink | BFileValue | BRegex | BDuration | BHtml | BImage;
export type BValue = null | boolean | number | string | Date | BValue[] | BTagged;

export const isTagged = (v: BValue): v is BTagged => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date);
export const tagOf = (v: BValue): string => {
  if (v === null) return "null";
  if (Array.isArray(v)) return "list";
  if (v instanceof Date) return "date";
  if (isTagged(v)) return v.$;
  return typeof v === "number" ? "number" : typeof v === "boolean" ? "boolean" : "string";
};

const WIKI = /^\s*!?\[\[([^\]|#]*)(#[^\]|]*)?(?:\|([^\]]*))?\]\]\s*$/;

/** `[[Note|label]]` text → a link; anything else → null. */
export function parseWikiLink(s: string): BLink | null {
  const m = WIKI.exec(s);
  if (!m) return null;
  const path = m[1].trim();
  return m[3] !== undefined ? { $: "link", path, display: m[3].trim() } : { $: "link", path };
}

/** A frontmatter value as a Bases value: links in text become links, maps become objects. */
export function fromYaml(v: unknown, depth = 0): BValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return parseWikiLink(v) ?? v;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (depth >= 6) return null;
  if (Array.isArray(v)) return v.map((x) => fromYaml(x, depth + 1));
  if (typeof v === "object") {
    const map: Record<string, BValue> = Object.create(null);
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) map[k] = fromYaml(x, depth + 1);
    return { $: "object", map };
  }
  return null;
}

/** A date from a Date or ISO text (`2026-11-01`, `2026-11-01T10:00`); null otherwise. */
export function toDate(v: BValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === "string") return isoDate(v);
  return null;
}

const DURATION_PART = /(-?\d+(?:\.\d+)?)\s*(years?|y|months?|M|weeks?|w|days?|d|hours?|h|minutes?|m|seconds?|s|milliseconds?|ms)\b/g;

/** `"1d"`, `"2 weeks"`, `"1y 2M"`, `"-3h"` → a duration; null when it is not one. */
export function parseDuration(s: string): BDuration | null {
  const text = s.trim();
  if (!text) return null;
  let months = 0;
  let ms = 0;
  let consumed = "";
  DURATION_PART.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DURATION_PART.exec(text)) !== null) {
    consumed += m[0];
    const n = Number(m[1]);
    const u = m[2];
    if (u === "M" || u.startsWith("month")) months += n;
    else if (u === "y" || u.startsWith("year")) months += n * 12;
    else if (u === "w" || u.startsWith("week")) ms += n * 7 * 86_400_000;
    else if (u === "d" || u.startsWith("day")) ms += n * 86_400_000;
    else if (u === "h" || u.startsWith("hour")) ms += n * 3_600_000;
    else if (u === "ms" || u.startsWith("millisecond")) ms += n;
    else if (u === "m" || u.startsWith("minute")) ms += n * 60_000;
    else ms += n * 1000;
  }
  // Every non-space character must belong to a part: "1d tomorrow" is not a duration.
  if (!consumed || consumed.replace(/\s/g, "").length !== text.replace(/\s/g, "").length) return null;
  if (!Number.isInteger(months)) return null;
  return { $: "duration", months, ms };
}

export function addDuration(d: Date, dur: BDuration, sign: 1 | -1): Date {
  let out = d;
  if (dur.months) {
    const y = d.getUTCFullYear();
    const target = utcDate(y, d.getUTCMonth() + sign * dur.months, 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
    const last = utcDate(target.getUTCFullYear(), target.getUTCMonth() + 1, 0).getUTCDate();
    target.setUTCDate(Math.min(d.getUTCDate(), last));
    out = target;
  }
  const r = new Date(out.getTime() + sign * dur.ms);
  if (Number.isNaN(r.getTime())) throw new FormulaError("math", "the date is out of range");
  return r;
}

/** A duration's length in milliseconds (a month counted as 30 days, for comparing). */
export const durationMs = (d: BDuration) => d.ms + d.months * 30 * 86_400_000;

function durationText(d: BDuration): string {
  const parts: string[] = [];
  if (d.months) parts.push(`${d.months} month${Math.abs(d.months) === 1 ? "" : "s"}`);
  let ms = Math.abs(d.ms);
  const sign = d.ms < 0 ? "-" : "";
  const units: Array<[number, string]> = [
    [86_400_000, "day"],
    [3_600_000, "hour"],
    [60_000, "minute"],
    [1000, "second"],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(ms / size);
    if (n) {
      parts.push(`${sign}${n} ${name}${n === 1 ? "" : "s"}`);
      ms -= n * size;
    }
  }
  return parts.join(" ") || "0 seconds";
}

const basenameOf = (p: string) => {
  const name = p.slice(p.lastIndexOf("/") + 1);
  return name.replace(/\.(md|markdown)$/i, "");
};

/** How a value reads in a cell and when joined into text. */
export function toText(v: BValue): string {
  if (v === null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v instanceof Date) return formatDate(v);
  if (Array.isArray(v)) return v.map(toText).join(", ");
  switch (v.$) {
    case "link":
      return v.display ?? basenameOf(v.path);
    case "file":
      return v.file.basename;
    case "regex":
      return String(v.re);
    case "duration":
      return durationText(v);
    case "html":
      return v.html.replace(/<[^>]*>/g, "");
    case "image":
      return v.src;
    case "object":
      return JSON.stringify(toPlain(v));
  }
}

/** A value as plain JSON (for objects in text, and for tests). */
export function toPlain(v: BValue): unknown {
  if (v === null || typeof v !== "object") return v;
  if (v instanceof Date) return formatDate(v);
  if (Array.isArray(v)) return v.map(toPlain);
  if (v.$ === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v.map)) o[k] = toPlain(x);
    return o;
  }
  return toText(v);
}

export function isEmptyValue(v: BValue): boolean {
  if (v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (isTagged(v) && v.$ === "object") return Object.keys(v.map).length === 0;
  return false;
}

/** JavaScript truthiness, as Obsidian's `isTruthy()`: an empty list is still a value. */
export function truthy(v: BValue): boolean {
  if (v === null || v === false || v === 0 || v === "") return false;
  if (typeof v === "number") return !Number.isNaN(v);
  return true;
}

/** Two links, files or a link and text point at the same note when their paths (or names) match. */
function samePlace(a: string, b: string): boolean {
  const x = a.replace(/\.md$/i, "").toLowerCase();
  const y = b.replace(/\.md$/i, "").toLowerCase();
  return x === y || basenameOf(x) === y || x === basenameOf(y);
}

function placeOf(v: BValue): string | null {
  if (isTagged(v) && v.$ === "link") return v.path;
  if (isTagged(v) && v.$ === "file") return v.file.path;
  return null;
}

export function equalValues(a: BValue, b: BValue): boolean {
  if (a === null || b === null) return a === b || (a === null && b === "") || (b === null && a === "");
  const pa = placeOf(a);
  const pb = placeOf(b);
  if (pa !== null || pb !== null) {
    const x = pa ?? (typeof a === "string" ? a : null);
    const y = pb ?? (typeof b === "string" ? b : null);
    return x !== null && y !== null && samePlace(x, y);
  }
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => equalValues(x, b[i]));
  const da = toDate(a);
  const db = toDate(b);
  if (da && db && (a instanceof Date || b instanceof Date)) return da.getTime() === db.getTime();
  if (isTagged(a) && a.$ === "duration") return isTagged(b) && b.$ === "duration" ? durationMs(a) === durationMs(b) : typeof b === "number" && durationMs(a) === b;
  if (typeof a === "number" && typeof b === "string" && b.trim() !== "" && Number.isFinite(Number(b))) return a === Number(b);
  if (typeof b === "number" && typeof a === "string" && a.trim() !== "" && Number.isFinite(Number(a))) return b === Number(a);
  if (isTagged(a) || isTagged(b)) return toText(a) === toText(b);
  return a === b;
}

/** Numbers, dates and durations by size; text by code point. null when the two cannot be ordered. */
export function compareValues(a: BValue, b: BValue): number | null {
  if (a === null || b === null) return null;
  const num = (v: BValue): number | null => {
    if (typeof v === "number") return v;
    if (typeof v === "boolean") return v ? 1 : 0;
    if (isTagged(v) && v.$ === "duration") return durationMs(v);
    return null;
  };
  const da = toDate(a);
  const db = toDate(b);
  if (da && db) return Math.sign(da.getTime() - db.getTime());
  const na = num(a);
  const nb = num(b);
  if (na !== null && nb !== null) return Math.sign(na - nb);
  if (na !== null && typeof b === "string" && Number.isFinite(Number(b)) && b.trim()) return Math.sign(na - Number(b));
  if (nb !== null && typeof a === "string" && Number.isFinite(Number(a)) && a.trim()) return Math.sign(Number(a) - nb);
  const x = toText(a);
  const y = toText(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

/** Sort order for a column: empty last, then numbers / dates by size, text in natural order. */
export function sortCompare(a: BValue, b: BValue): number {
  const ea = isEmptyValue(a);
  const eb = isEmptyValue(b);
  if (ea || eb) return ea === eb ? 0 : ea ? 1 : -1;
  const da = a instanceof Date ? a : null;
  const db = b instanceof Date ? b : null;
  if (da && db) return Math.sign(da.getTime() - db.getTime());
  if (typeof a === "number" && typeof b === "number") return Math.sign(a - b);
  if (typeof a === "boolean" && typeof b === "boolean") return a === b ? 0 : a ? 1 : -1;
  if (isTagged(a) && a.$ === "duration" && isTagged(b) && b.$ === "duration") return Math.sign(durationMs(a) - durationMs(b));
  const ta = toDate(a);
  const tb = toDate(b);
  if (ta && tb) return Math.sign(ta.getTime() - tb.getTime());
  return collator.compare(toText(a), toText(b));
}

/**
 * Edit one property of many notes at once (plan W7.4, Capacities v71): set a
 * value, add or remove a tag, clear a field, or change its type, for every
 * selected row of a database view.
 *
 * The pure part: what one operation does to one note's text. It goes through
 * the properties API (plan 4.9), which splices only the value's own source,
 * so the body and every other line of the frontmatter stay byte for byte.
 */
import { fastBulkOp } from "./bulkFast";
import { convertValue, FrontmatterError, parseProperties, removeProperty, setProperty, type PropertyType, type PropertyValue } from "../properties/frontmatter";

export type BulkOp =
  | { kind: "set"; key: string; value: PropertyValue }
  | { kind: "addTag"; key: string; tag: string }
  | { kind: "removeTag"; key: string; tag: string }
  | { kind: "clear"; key: string }
  | { kind: "convert"; key: string; to: PropertyType };

/** Why a note is left as it is. */
export type BulkSkip = "unchanged" | "invalid" | "lossy";

export interface BulkResult {
  text: string;
  /** Set when the text did not change. */
  skip?: BulkSkip;
}

const DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

/** A tag as notes store it: no leading `#`, no spaces at the ends. */
export function cleanTag(tag: string): string {
  return tag.trim().replace(/^#+/, "").trim();
}

function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined).map(String);
  if (value === null || value === undefined || value === "") return [];
  // `tags: a, b` and `tags: "#a #b"`: one string, several tags.
  return String(value).split(/[,\s]+/).map(cleanTag).filter(Boolean);
}

/** Converting would lose what the note holds: such notes are skipped, not overwritten. */
function lossless(value: unknown, to: PropertyType): boolean {
  if (value === null || value === undefined || value === "") return true;
  const str = Array.isArray(value) ? value.join(", ") : String(value);
  switch (to) {
    case "number":
      return Number.isFinite(Number(str.trim())) && str.trim() !== "";
    case "date":
      return typeof value === "string" && DATE.test(value.trim());
    case "checkbox":
      return typeof value === "boolean" || /^(true|false|yes|no|1|0|on|off)$/i.test(str.trim());
    default:
      return true;
  }
}

/** One operation on one note's text. Never throws: a frontmatter that doesn't parse is skipped. */
export function applyBulkOp(text: string, op: BulkOp): BulkResult {
  // Plain `key: value` frontmatter: edited line by line, as the YAML path would (./bulkFast).
  return fastBulkOp(text, op) ?? applyBulkOpYaml(text, op);
}

/** The same through the YAML parser: any frontmatter. */
export function applyBulkOpYaml(text: string, op: BulkOp): BulkResult {
  const parsed = parseProperties(text);
  if (parsed.status === "invalid") return { text, skip: "invalid" };
  const prop = parsed.properties.find((p) => p.key === op.key);
  if (prop && !prop.editable) return { text, skip: "invalid" };
  let next = text;
  try {
    switch (op.kind) {
      case "set":
        next = setProperty(text, op.key, op.value);
        break;
      case "clear":
        next = prop ? removeProperty(text, op.key) : text;
        break;
      case "addTag": {
        const tag = cleanTag(op.tag);
        const list = asList(prop?.value);
        if (!tag || list.some((x) => cleanTag(x).toLowerCase() === tag.toLowerCase())) break;
        next = setProperty(text, op.key, [...list, tag]);
        break;
      }
      case "removeTag": {
        const tag = cleanTag(op.tag).toLowerCase();
        const list = asList(prop?.value);
        const kept = list.filter((x) => cleanTag(x).toLowerCase() !== tag);
        if (!prop || kept.length === list.length) break;
        next = setProperty(text, op.key, kept);
        break;
      }
      case "convert": {
        if (!prop) break;
        if (!lossless(prop.value, op.to)) return { text, skip: "lossy" };
        next = setProperty(text, op.key, convertValue(prop.value, op.to));
        break;
      }
    }
  } catch (e) {
    if (e instanceof FrontmatterError) return { text, skip: "invalid" };
    throw e;
  }
  return next === text ? { text, skip: "unchanged" } : { text: next };
}

export interface BulkChange {
  path: string;
  before: string;
  after: string;
}

export interface BulkPlan {
  changes: BulkChange[];
  skipped: Array<{ path: string; why: BulkSkip }>;
}

/** What `op` does to each note: the changes to write, and the notes left alone (with why). */
export function planBulkEdit(notes: ReadonlyArray<{ path: string; text: string }>, op: BulkOp): BulkPlan {
  const plan: BulkPlan = { changes: [], skipped: [] };
  for (const n of notes) {
    const r = applyBulkOp(n.text, op);
    if (r.skip) plan.skipped.push({ path: n.path, why: r.skip });
    else plan.changes.push({ path: n.path, before: n.text, after: r.text });
  }
  return plan;
}

/** The frontmatter block, or "" (what a bulk edit may change). */
export function frontmatterOf(text: string): string {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(text)?.[0] ?? "";
}

/** The text after the frontmatter (what a bulk edit must never change). */
export function bodyOf(text: string): string {
  return text.slice(frontmatterOf(text).length);
}

/**
 * Selection in a list of row ids, as file managers do it: a plain click
 * selects one, Ctrl/⌘ toggles one, Shift extends from the anchor (adding to
 * the selection when Ctrl/⌘ is held too).
 */
export function selectRows(
  order: readonly string[],
  current: ReadonlySet<string>,
  anchor: string | null,
  id: string,
  mods: { shift?: boolean; toggle?: boolean },
): { selected: Set<string>; anchor: string } {
  if (mods.shift && anchor !== null && order.includes(anchor)) {
    const a = order.indexOf(anchor);
    const b = order.indexOf(id);
    const range = order.slice(Math.min(a, b), Math.max(a, b) + 1);
    const base = mods.toggle ? new Set(current) : new Set<string>();
    for (const r of range) base.add(r);
    return { selected: base, anchor };
  }
  if (mods.toggle) {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return { selected: next, anchor: id };
  }
  return { selected: new Set([id]), anchor: id };
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => String(x) === String(b[i]));
  if ((a === null || a === undefined || a === "") && (b === null || b === undefined || b === "")) return true;
  return a instanceof Date || b instanceof Date ? String(a instanceof Date ? a.toISOString().slice(0, 10) : a) === String(b instanceof Date ? b.toISOString().slice(0, 10) : b) : a === b;
}

/** Whether `op` would change a note whose frontmatter reads as `fm` (the preview's count, before any file is read). */
export function wouldChange(fm: Readonly<Record<string, unknown>>, op: BulkOp): boolean {
  const has = Object.prototype.hasOwnProperty.call(fm, op.key);
  const v = fm[op.key];
  switch (op.kind) {
    case "set":
      return !has || !same(v, op.value);
    case "clear":
      return has;
    case "addTag": {
      const tag = cleanTag(op.tag).toLowerCase();
      return !!tag && !asList(v).some((x) => cleanTag(x).toLowerCase() === tag);
    }
    case "removeTag": {
      const tag = cleanTag(op.tag).toLowerCase();
      return asList(v).some((x) => cleanTag(x).toLowerCase() === tag);
    }
    case "convert":
      return has && lossless(v, op.to) && !same(v, convertValue(v, op.to));
  }
}

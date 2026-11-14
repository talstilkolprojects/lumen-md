/**
 * The one merge engine (plan W1.9): every place where two versions of a
 * note meet — the encrypted sync (3.4), a git pull (3.3), and a note
 * changed outside Lumen while it had unsaved edits (4.4) — merges here
 * first, and only what this cannot merge reaches a conflict dialog.
 *
 *   1. Front matter merges by key: a key one side changed takes that side;
 *      a list both sides changed (tags, aliases) takes both sets of
 *      additions and removals; the same key changed two ways is a conflict.
 *      The merged front matter must parse as YAML, or the merge is refused.
 *   2. The body merges line by line (diff3: lines both sides kept anchor
 *      the merge; a chunk only one side changed takes that side).
 *   3. A chunk both sides changed is merged again word by word, so two
 *      edits to different words of one line or paragraph both survive.
 *   4. Whatever still overlaps — the same words changed two ways — is a
 *      conflict: the result is not clean, and `text` holds both versions
 *      between `<<<<<<<` / `=======` / `>>>>>>>` markers.
 *
 * A clean merge never drops a character either side wrote: every chunk is
 * either kept from base, or taken whole from the side that changed it.
 */
import { parse as parseYaml } from "yaml";

export interface MergeLabels {
  ours: string;
  theirs: string;
}

export interface TextMergeResult {
  /** True when nothing overlapped: `text` is the merge. */
  clean: boolean;
  /** The merge; when not clean, with conflict markers around each overlap. */
  text: string;
  /** Overlapping chunks left (0 when clean). */
  conflicts: number;
}

/* ─── diff3 over any tokens ─────────────────────────────────────────── */

/** Pairs [i, j] of equal tokens in a longest common subsequence of a and b, or null when too big to align. */
function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> | null {
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const n = a.length - head - tail;
  const m = b.length - head - tail;
  if (n * m > 16_000_000) return null;
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[head + i] === b[head + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs: Array<[number, number]> = [];
  for (let k = 0; k < head; k++) pairs.push([k, k]);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[head + i] === b[head + j]) {
      pairs.push([head + i, head + j]);
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  for (let k = tail; k > 0; k--) pairs.push([a.length - k, b.length - k]);
  return pairs;
}

export type Chunk =
  | { stable: true; tokens: string[] }
  | { stable: false; base: string[]; ours: string[]; theirs: string[] };

const same = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((t, i) => t === y[i]);

/** diff3: stable runs (kept by both sides) and the chunks between them. Null when the inputs are too big to align. */
export function diff3(base: readonly string[], ours: readonly string[], theirs: readonly string[]): Chunk[] | null {
  const po = lcsPairs(base, ours);
  const pt = lcsPairs(base, theirs);
  if (!po || !pt) return null;
  const inO = new Map(po);
  const inT = new Map(pt);
  const out: Chunk[] = [];
  let b0 = 0;
  let o0 = 0;
  let t0 = 0;
  const flush = (b1: number, o1: number, t1: number) => {
    const cb = base.slice(b0, b1);
    const co = ours.slice(o0, o1);
    const ct = theirs.slice(t0, t1);
    if (cb.length || co.length || ct.length) out.push({ stable: false, base: cb, ours: co, theirs: ct });
  };
  for (let i = 0; i < base.length; i++) {
    const oi = inO.get(i);
    const ti = inT.get(i);
    // Kept by both sides, in order (no crossing with what came before).
    if (oi === undefined || ti === undefined || oi < o0 || ti < t0) continue;
    flush(i, oi, ti);
    const prev = out[out.length - 1];
    if (prev?.stable) prev.tokens.push(base[i]);
    else out.push({ stable: true, tokens: [base[i]] });
    b0 = i + 1;
    o0 = oi + 1;
    t0 = ti + 1;
  }
  flush(base.length, ours.length, theirs.length);
  return out;
}

/** One unstable chunk settled without asking, or null when both sides changed it differently. */
function settle(c: Extract<Chunk, { stable: false }>): string[] | null {
  if (same(c.ours, c.theirs)) return c.ours;
  if (same(c.ours, c.base)) return c.theirs;
  if (same(c.theirs, c.base)) return c.ours;
  return null;
}

/* ─── body: lines, then words ───────────────────────────────────────── */

/** Words with the space after them; runs of space alone. Joining the tokens gives the text back. */
const words = (s: string) => s.match(/[^\s]+\s*|\s+/g) ?? [];

/** Merge one chunk both sides changed, word by word. */
function mergeWords(base: string, ours: string, theirs: string): string | null {
  const chunks = diff3(words(base), words(ours), words(theirs));
  if (!chunks) return null;
  let out = "";
  for (const c of chunks) {
    if (c.stable) out += c.tokens.join("");
    else {
      const s = settle(c);
      if (!s) return null;
      out += s.join("");
    }
  }
  return out;
}

/** A chunk whose three sides have the same number of lines, merged line by line; null when a line overlaps. */
function mergeAligned(c: Extract<Chunk, { stable: false }>): string | null {
  const n = c.base.length;
  if (n < 2 || c.ours.length !== n || c.theirs.length !== n) return null;
  let out = "";
  for (let i = 0; i < n; i++) {
    const [b, o, t] = [c.base[i], c.ours[i], c.theirs[i]];
    const s = o === t || t === b ? o : o === b ? t : mergeWords(b, o, t);
    if (s === null) return null;
    out += s;
  }
  return out;
}

function mergeBody(base: string, ours: string, theirs: string, labels: MergeLabels): TextMergeResult {
  if (ours === theirs) return { clean: true, text: ours, conflicts: 0 };
  if (ours === base) return { clean: true, text: theirs, conflicts: 0 };
  if (theirs === base) return { clean: true, text: ours, conflicts: 0 };
  // Lines keep their end so a merge never changes CRLF / LF or the last newline.
  const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const chunks = diff3(lines(base), lines(ours), lines(theirs));
  if (!chunks) return conflictWhole(ours, theirs, labels);
  let out = "";
  let conflicts = 0;
  for (const c of chunks) {
    if (c.stable) {
      out += c.tokens.join("");
      continue;
    }
    const s = settle(c);
    if (s) {
      out += s.join("");
      continue;
    }
    // The same number of lines on all three sides (lines edited in place,
    // next to each other): settle line by line, each line word by word.
    const aligned = mergeAligned(c);
    if (aligned !== null) {
      out += aligned;
      continue;
    }
    const w = mergeWords(c.base.join(""), c.ours.join(""), c.theirs.join(""));
    if (w !== null) {
      out += w;
      continue;
    }
    conflicts++;
    const o = c.ours.join("");
    const t = c.theirs.join("");
    out += `<<<<<<< ${labels.ours}\n${o}${o.endsWith("\n") || !o ? "" : "\n"}=======\n${t}${t.endsWith("\n") || !t ? "" : "\n"}>>>>>>> ${labels.theirs}\n`;
  }
  return { clean: conflicts === 0, text: out, conflicts };
}

function conflictWhole(ours: string, theirs: string, labels: MergeLabels): TextMergeResult {
  const nl = (s: string) => (s.endsWith("\n") ? s : `${s}\n`);
  return { clean: false, text: `<<<<<<< ${labels.ours}\n${nl(ours)}=======\n${nl(theirs)}>>>>>>> ${labels.theirs}\n`, conflicts: 1 };
}

/* ─── front matter, by key ──────────────────────────────────────────── */

const FM = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/;

/** The front matter block (between the fences, with its line ends) and the rest; null `fm` when there is none. */
export function splitFrontmatter(text: string): { fm: string | null; open: string; close: string; body: string } {
  const m = FM.exec(text);
  if (!m) return { fm: null, open: "", close: "", body: text };
  const open = /^---[ \t]*\r?\n/.exec(text)![0];
  const inner = m[1] ?? "";
  return { fm: inner, open, close: m[0].slice(open.length + inner.length), body: text.slice(m[0].length) };
}

/** Does `fm` (the text between the fences) parse as a YAML map (or nothing)? */
export function frontmatterValid(fm: string): boolean {
  try {
    const v: unknown = parseYaml(fm);
    return v === null || v === undefined || (typeof v === "object" && !Array.isArray(v));
  } catch {
    return false;
  }
}

/** Top-level entries of a front matter block: key → its lines (the key line and what is indented under it). */
function entries(fm: string): { order: string[]; map: Map<string, string>; head: string } | null {
  const lines = fm.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const order: string[] = [];
  const map = new Map<string, string>();
  let head = "";
  let key: string | null = null;
  for (const line of lines) {
    const m = /^([^\s#'"\-?:][^:]*?|'[^']*'|"[^"]*"):(?:[ \t]|\r?\n|$)/.exec(line);
    if (m) {
      key = m[1];
      if (map.has(key)) return null; // a duplicated key: leave it to the line merge
      order.push(key);
      map.set(key, line);
    } else if (key === null) head += line;
    else map.set(key, map.get(key)! + line);
  }
  return { order, map, head };
}

/** A list value's items (flow `[a, b]` or block `- a` lines), or null when the value is not a plain list. */
function listItems(entry: string): { items: string[]; flow: boolean } | null {
  const keyLine = entry.split(/\r?\n/)[0];
  const first = keyLine.slice(keyLine.indexOf(":") + 1);
  const flow = /^[ \t]*\[(.*)\][ \t]*$/.exec(first);
  if (flow) return { items: flow[1].split(",").map((s) => s.trim()).filter(Boolean), flow: true };
  const lines = entry.split(/\r?\n/).slice(1).filter((l) => l.trim());
  if (first.trim() || !lines.length || !lines.every((l) => /^[ \t]*- /.test(l))) return null;
  return { items: lines.map((l) => l.replace(/^[ \t]*- /, "").trim()), flow: false };
}

function renderList(key: string, items: string[], flow: boolean, eol: string): string {
  return flow ? `${key}: [${items.join(", ")}]${eol}` : `${key}:${eol}${items.map((i) => `  - ${i}${eol}`).join("")}`;
}

/** Merge two front matter blocks by key; null when a key was changed two ways. */
function mergeFrontmatterBlocks(base: string, ours: string, theirs: string): string | null {
  const b = entries(base);
  const o = entries(ours);
  const t = entries(theirs);
  if (!b || !o || !t) return null;
  if (o.head !== t.head && o.head !== b.head && t.head !== b.head) return null;
  const head = o.head === b.head ? t.head : o.head;
  const eol = ours.includes("\r\n") ? "\r\n" : "\n";
  const keys = [...o.order];
  for (const k of t.order) if (!keys.includes(k) && !b.map.has(k)) keys.splice(after(keys, t.order, k), 0, k);
  let out = head;
  for (const k of keys) {
    const bv = b.map.get(k);
    const ov = o.map.get(k);
    const tv = t.map.get(k);
    let v: string | undefined;
    if (ov === tv) v = ov;
    else if (ov === bv) v = tv;
    else if (tv === bv) v = ov;
    else {
      const ol = ov === undefined ? null : listItems(ov);
      const tl = tv === undefined ? null : listItems(tv);
      const bl = bv === undefined ? { items: [], flow: true } : listItems(bv);
      if (!ol || !tl || !bl) return null;
      const removed = new Set([...bl.items.filter((x) => !ol.items.includes(x)), ...bl.items.filter((x) => !tl.items.includes(x))]);
      const items = [...ol.items, ...tl.items.filter((x) => !ol.items.includes(x))].filter((x) => !removed.has(x));
      v = renderList(k, items, ol.flow, eol);
    }
    if (v !== undefined) out += v.endsWith("\n") ? v : v + eol;
  }
  return out;
}

/** Where a key new on one side goes: right after the key it follows there. */
function after(keys: string[], order: string[], k: string): number {
  for (let i = order.indexOf(k) - 1; i >= 0; i--) {
    const at = keys.indexOf(order[i]);
    if (at >= 0) return at + 1;
  }
  return 0;
}

/* ─── the merge ─────────────────────────────────────────────────────── */

const DEFAULT_LABELS: MergeLabels = { ours: "this device", theirs: "the other version" };

/**
 * Three-way merge of a note: `base` is the last version both sides had,
 * `ours` the one here, `theirs` the other one. See the module comment.
 */
export function mergeText(base: string, ours: string, theirs: string, labels: MergeLabels = DEFAULT_LABELS): TextMergeResult {
  if (ours === theirs) return { clean: true, text: ours, conflicts: 0 };
  if (ours === base) return { clean: true, text: theirs, conflicts: 0 };
  if (theirs === base) return { clean: true, text: ours, conflicts: 0 };
  const [b, o, t] = [splitFrontmatter(base), splitFrontmatter(ours), splitFrontmatter(theirs)];
  const keyed = (o.fm !== null || t.fm !== null) && [b, o, t].every((x) => x.fm === null || frontmatterValid(x.fm));
  if (!keyed) {
    const r = mergeBody(base, ours, theirs, labels);
    // A plain line merge must not leave front matter broken that both sides had valid.
    if (r.clean) {
      const fm = splitFrontmatter(r.text).fm;
      const wasValid = [o, t].every((x) => x.fm === null || frontmatterValid(x.fm));
      if (fm !== null && wasValid && !frontmatterValid(fm)) return conflictWhole(ours, theirs, labels);
    }
    return r;
  }
  const fmText = mergeFrontmatterBlocks(b.fm ?? "", o.fm ?? "", t.fm ?? "");
  const body = mergeBody(b.body, o.body, t.body, labels);
  if (fmText === null || !frontmatterValid(fmText)) {
    // The front matter itself overlaps: one conflict for the block, the body as merged.
    const fmConflict = conflictWhole(`${o.open}${o.fm ?? ""}${o.close}`, `${t.open}${t.fm ?? ""}${t.close}`, labels);
    return { clean: false, text: fmConflict.text + body.text, conflicts: body.conflicts + 1 };
  }
  const fence = o.fm !== null ? o : t;
  // A block both sides emptied or one side removed (and the other left alone) goes; otherwise it stays.
  const keep = fmText.trim() !== "" || (o.fm !== null && t.fm !== null);
  const block = keep ? `${fence.open}${fmText}${fence.close || "---\n"}` : "";
  return { clean: body.clean, text: block + body.text, conflicts: body.conflicts };
}

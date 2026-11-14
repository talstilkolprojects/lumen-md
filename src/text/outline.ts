/**
 * Outline mode and block operations on plain Markdown (plan W2.13).
 *
 * Logseq, Tana and Workflowy make writing in an outline its own way of
 * working; here it works on an ordinary Markdown file, without a format of
 * its own. A "block" is what an outliner moves around:
 *
 * - a heading together with its section (everything up to the next heading
 *   of the same or a higher level),
 * - a list item together with its children (the lines indented under it),
 * - any other top-level block: a paragraph, a fenced code block, a table, a
 *   quote (a run of non-blank lines; a fence counts as one unit).
 *
 * Everything here is pure: text in, text out. Folding and zoom never touch
 * the text — they are views over the ranges computed here, and the fold
 * state is kept per note outside the file (see `foldKey`).
 *
 * Moving a block swaps it with its sibling and keeps the blank lines where
 * they were, so a heading moved to the end of the note doesn't end up
 * glued to the text before it.
 */

export type BlockKind = "heading" | "item" | "block";

export interface OutlineBlock {
  kind: BlockKind;
  /** First line (0-based). */
  start: number;
  /** One past the last line of the block's content (trailing blank lines are not part of it). */
  end: number;
  /** Heading level (1–6) or the item's indent in columns; 0 for other blocks. */
  level: number;
}

export type OutlineOp = "moveUp" | "moveDown" | "indent" | "outdent" | "duplicate" | "delete";

export const OUTLINE_OPS: readonly OutlineOp[] = ["moveUp", "moveDown", "indent", "outdent", "duplicate", "delete"];

export interface OpResult {
  text: string;
  /** Where the cursor goes: an offset in the new text. */
  cursor: number;
}

interface LineInfo {
  /** "fm" = frontmatter; "code" = inside a fence (or the fence lines). */
  kind: "fm" | "code" | "heading" | "item" | "blank" | "text";
  indent: number;
  level: number;
  /** For a fence open line: the index of its closing line (or the last line). */
  fenceEnd?: number;
  /** For lines inside a fence: the index of its opening line. */
  fenceStart?: number;
}

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]|$)/;
const ITEM = /^(\s*)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+|$)/;
const FENCE = /^(\s*)(`{3,}|~{3,})/;

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4 - (n % 4);
    else break;
  }
  return n;
}

/** Classify every line once: frontmatter, fences, headings, list items. */
export function analyse(lines: readonly string[]): LineInfo[] {
  const out: LineInfo[] = [];
  let i = 0;
  if (lines[0] !== undefined && /^---\s*$/.test(lines[0])) {
    let close = -1;
    for (let j = 1; j < lines.length; j++) {
      if (/^(---|\.\.\.)\s*$/.test(lines[j])) {
        close = j;
        break;
      }
    }
    if (close > 0) {
      for (; i <= close; i++) out.push({ kind: "fm", indent: 0, level: 0 });
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2];
      let close = lines.length - 1;
      for (let j = i + 1; j < lines.length; j++) {
        const m = FENCE.exec(lines[j]);
        if (m && m[2][0] === marker[0] && m[2].length >= marker.length && lines[j].trim() === m[2].trim()) {
          close = j;
          break;
        }
      }
      const indent = indentOf(line);
      out.push({ kind: "code", indent, level: 0, fenceEnd: close });
      for (let j = i + 1; j <= close; j++) out.push({ kind: "code", indent: Math.max(indent, indentOf(lines[j])), level: 0, fenceStart: i });
      i = close + 1;
      continue;
    }
    if (!line.trim()) out.push({ kind: "blank", indent: 0, level: 0 });
    else {
      const h = HEADING.exec(line);
      const it = ITEM.exec(line);
      if (h) out.push({ kind: "heading", indent: 0, level: h[1].length });
      else if (it) out.push({ kind: "item", indent: indentOf(it[1]), level: 0 });
      else out.push({ kind: "text", indent: indentOf(line), level: 0 });
    }
    i++;
  }
  return out;
}

/** Index of the last non-blank line in [start, end), or start - 1. */
function trimEnd(info: readonly LineInfo[], start: number, end: number): number {
  let e = end;
  while (e > start && info[e - 1].kind === "blank") e--;
  return e;
}

function headingEnd(info: readonly LineInfo[], start: number): number {
  const level = info[start].level;
  let j = start + 1;
  while (j < info.length && !(info[j].kind === "heading" && info[j].level <= level)) j++;
  return trimEnd(info, start + 1, j);
}

function itemEnd(info: readonly LineInfo[], start: number): number {
  const k = info[start].indent;
  let j = start + 1;
  while (j < info.length) {
    const li = info[j];
    if (li.kind === "fm" || li.kind === "heading") break;
    if (li.kind === "blank") {
      j++;
      continue;
    }
    if (li.indent > k) {
      j++;
      continue;
    }
    // A lazy continuation line (no indent, straight after the item text) belongs to it.
    if (li.kind === "text" && info[j - 1].kind !== "blank" && (info[j - 1].kind === "item" || info[j - 1].kind === "text")) {
      j++;
      continue;
    }
    break;
  }
  return trimEnd(info, start + 1, j);
}

function plainEnd(info: readonly LineInfo[], start: number): number {
  let j = start;
  while (j < info.length) {
    const li = info[j];
    if (li.kind === "blank" || li.kind === "heading" || li.kind === "fm") break;
    if (li.fenceEnd !== undefined) {
      j = li.fenceEnd + 1;
      continue;
    }
    if (j > start && li.kind === "item") break;
    j++;
  }
  return Math.max(j, start + 1);
}

function blockFrom(info: readonly LineInfo[], start: number): OutlineBlock {
  const li = info[start];
  if (li.kind === "heading") return { kind: "heading", start, end: headingEnd(info, start), level: li.level };
  if (li.kind === "item") return { kind: "item", start, end: itemEnd(info, start), level: li.indent };
  return { kind: "block", start, end: plainEnd(info, start), level: 0 };
}

/** Start line of the plain (non-heading, non-item) block holding `line`. */
function plainStart(info: readonly LineInfo[], line: number): number {
  let s = line;
  if (info[s].fenceStart !== undefined) s = info[s].fenceStart!;
  while (s > 0) {
    const p = info[s - 1];
    if (p.kind === "blank" || p.kind === "heading" || p.kind === "fm" || p.kind === "item") break;
    s = p.fenceStart ?? s - 1;
  }
  return s;
}

/**
 * The block the cursor's line belongs to: the innermost list item whose
 * subtree holds the line, else the heading line itself, else the plain block
 * around it. Blank lines, frontmatter and lines past the end have none.
 */
export function blockAt(lines: readonly string[], line: number, info: readonly LineInfo[] = analyse(lines)): OutlineBlock | null {
  if (line < 0 || line >= info.length) return null;
  const li = info[line];
  if (li.kind === "fm" || li.kind === "blank") return null;
  if (li.kind === "heading" || li.kind === "item") return blockFrom(info, line);
  // Indented content (or a fence) under a list item belongs to that item:
  // the innermost item above whose subtree reaches this line.
  for (let j = line - 1; j >= 0; j--) {
    const p = info[j];
    if (p.kind === "heading" || p.kind === "fm") break;
    if (p.kind !== "item") continue;
    if (blockFrom(info, j).end > line) return blockFrom(info, j);
    if (p.indent === 0) break;
  }
  return blockFrom(info, plainStart(info, line));
}

/** The enclosing heading section or parent item (for breadcrumbs), or null. */
export function parentOf(lines: readonly string[], b: OutlineBlock, info: readonly LineInfo[] = analyse(lines)): OutlineBlock | null {
  for (let j = b.start - 1; j >= 0; j--) {
    const p = info[j];
    if (b.kind === "item" && p.kind === "item" && p.indent < b.level) {
      const pb = blockFrom(info, j);
      if (pb.end >= b.end) return pb;
    }
    if (p.kind === "heading" && (b.kind !== "heading" || p.level < b.level)) return blockFrom(info, j);
    if (p.kind === "fm") break;
  }
  return null;
}

function prevSibling(info: readonly LineInfo[], b: OutlineBlock): OutlineBlock | null {
  if (b.kind === "heading") {
    for (let j = b.start - 1; j >= 0; j--) {
      const p = info[j];
      if (p.kind === "heading") {
        if (p.level < b.level) return null;
        if (p.level === b.level) return blockFrom(info, j);
      }
      if (p.kind === "fm") return null;
    }
    return null;
  }
  if (b.kind === "item") {
    for (let j = b.start - 1; j >= 0; j--) {
      const p = info[j];
      if (p.kind === "blank" || p.kind === "code" || p.indent > b.level) continue;
      if (p.kind === "item" && p.indent === b.level) return blockFrom(info, j);
      if (p.kind === "text" && p.indent <= b.level && j > 0 && info[j - 1].kind !== "blank") continue; // lazy continuation
      return null;
    }
    return null;
  }
  // A plain block: the block before it, unless a heading or the frontmatter is
  // in between. Next to a list, the sibling is the whole list.
  let j = b.start - 1;
  while (j >= 0 && info[j].kind === "blank") j--;
  if (j < 0 || info[j].kind === "heading" || info[j].kind === "fm") return null;
  return neighbourAt(info, j);
}

/** The top-level block holding line `j`: a whole list if it is in one. */
function neighbourAt(info: readonly LineInfo[], j: number): OutlineBlock | null {
  const at = blockAt([], j, info);
  if (!at) return null;
  if (at.kind !== "item") return at.kind === "heading" ? null : at;
  let top = at;
  for (let up = parentOfInfo(info, top); up; up = parentOfInfo(info, top)) top = up;
  let first = top;
  for (let p = prevSibling(info, first); p && p.kind === "item"; p = prevSibling(info, first)) first = p;
  let last = top;
  for (let n = nextSibling(info, last); n && n.kind === "item"; n = nextSibling(info, last)) last = n;
  return { kind: "block", start: first.start, end: last.end, level: 0 };
}

function parentOfInfo(info: readonly LineInfo[], b: OutlineBlock): OutlineBlock | null {
  for (let j = b.start - 1; j >= 0; j--) {
    const p = info[j];
    if (p.kind === "item" && p.indent < b.level) return blockFrom(info, j);
    if (p.kind === "heading" || p.kind === "fm") return null;
  }
  return null;
}

function nextSibling(info: readonly LineInfo[], b: OutlineBlock): OutlineBlock | null {
  let j = b.end;
  while (j < info.length && info[j].kind === "blank") j++;
  if (j >= info.length) return null;
  const n = info[j];
  if (b.kind === "heading") {
    // The section ends at the next heading of the same or a higher level.
    return n.kind === "heading" && n.level === b.level ? blockFrom(info, j) : null;
  }
  if (b.kind === "item") return n.kind === "item" && n.indent === b.level ? blockFrom(info, j) : null;
  if (n.kind === "heading" || n.kind === "fm") return null;
  return neighbourAt(info, j);
}

function lineOffsets(lines: readonly string[]): number[] {
  const off: number[] = [];
  let o = 0;
  for (const l of lines) {
    off.push(o);
    o += l.length + 1;
  }
  off.push(o);
  return off;
}

/** Line number (0-based) of `offset`. */
export function lineOfOffset(text: string, offset: number): number {
  let n = 0;
  const end = Math.min(offset, text.length);
  for (let i = 0; i < end; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
}

/** Swap two adjacent blocks a (first) and b, keeping the blank lines between and after them in place. */
function swap(lines: string[], a: OutlineBlock, b: OutlineBlock): string[] {
  const coreA = lines.slice(a.start, a.end);
  const gap = lines.slice(a.end, b.start);
  const coreB = lines.slice(b.start, b.end);
  return [...lines.slice(0, a.start), ...coreB, ...gap, ...coreA, ...lines.slice(b.end)];
}

function shiftLines(lines: readonly string[], by: number): string[] {
  if (by > 0) {
    const pad = " ".repeat(by);
    return lines.map((l) => (l.trim() ? pad + l : l));
  }
  return lines.map((l) => {
    let n = 0;
    while (n < -by && l[n] === " ") n++;
    return l.slice(n);
  });
}

/** The column where an item's text starts ("- " → indent + 2, "10. " → indent + 4). */
function contentColumn(line: string): number {
  const m = ITEM.exec(line);
  if (!m) return indentOf(line);
  return indentOf(line) + (m[0].length - m[1].length);
}

/**
 * Apply one block operation at `cursor`. Returns null when it doesn't apply
 * (no block there, first sibling moved up, a heading already at level 6…),
 * so callers can leave the key to the editor.
 */
export function applyOutlineOp(text: string, op: OutlineOp, cursor: number): OpResult | null {
  const lines = text.split("\n");
  const info = analyse(lines);
  const line = lineOfOffset(text, cursor);
  const b = blockAt(lines, line, info);
  if (!b) return null;
  const off = lineOffsets(lines);
  const inBlock = cursor - off[b.start];
  const at = (ls: string[], start: number) => lineOffsets(ls)[start] + inBlock;

  switch (op) {
    case "moveUp": {
      const p = prevSibling(info, b);
      if (!p) return null;
      const out = swap(lines, p, b);
      return { text: out.join("\n"), cursor: at(out, p.start) };
    }
    case "moveDown": {
      const n = nextSibling(info, b);
      if (!n) return null;
      const out = swap(lines, b, n);
      const newStart = b.start + (n.end - n.start) + (n.start - b.end);
      return { text: out.join("\n"), cursor: at(out, newStart) };
    }
    case "indent":
    case "outdent": {
      const sign = op === "indent" ? 1 : -1;
      if (b.kind === "heading") {
        const core = lines.slice(b.start, b.end);
        const coreInfo = info.slice(b.start, b.end);
        if (coreInfo.some((li) => li.kind === "heading" && (li.level + sign < 1 || li.level + sign > 6))) return null;
        const out = core.map((l, k) => {
          if (coreInfo[k].kind !== "heading") return l;
          return sign > 0 ? l.replace(/#/, "##") : l.replace(/#/, "");
        });
        const res = [...lines.slice(0, b.start), ...out, ...lines.slice(b.end)];
        return { text: res.join("\n"), cursor: Math.max(off[b.start], cursor + (line === b.start ? sign : 0)) };
      }
      if (b.kind !== "item") return null;
      let by: number;
      if (sign > 0) {
        // An item becomes the last child of the sibling before it.
        const p = prevSibling(info, b);
        if (!p) return null;
        by = contentColumn(lines[p.start]) - b.level;
      } else {
        if (b.level === 0) return null;
        const parent = parentOfInfo(info, b);
        by = -(b.level - (parent ? parent.level : 0));
      }
      if (by === 0) return null;
      const shifted = shiftLines(lines.slice(b.start, b.end), by);
      const res = [...lines.slice(0, b.start), ...shifted, ...lines.slice(b.end)];
      const removed = lines[line].length - (shifted[line - b.start] ?? "").length;
      const col = cursor - off[line];
      const newCol = Math.max(0, by > 0 ? col + by : col - removed);
      return { text: res.join("\n"), cursor: lineOffsets(res)[line] + newCol };
    }
    case "duplicate": {
      const core = lines.slice(b.start, b.end);
      const copy = b.kind === "item" ? core : ["", ...core];
      const res = [...lines.slice(0, b.end), ...copy, ...lines.slice(b.end)];
      const copyStart = b.end + (b.kind === "item" ? 0 : 1);
      return { text: res.join("\n"), cursor: at(res, copyStart) };
    }
    case "delete": {
      let from = b.start;
      let to = b.end;
      // Take the blank lines after it with it; at the end of the note, the ones before.
      while (to < lines.length && info[to].kind === "blank") to++;
      if (to >= lines.length) {
        to = lines.length;
        while (from > 0 && info[from - 1].kind === "blank") from--;
      }
      const res = [...lines.slice(0, from), ...lines.slice(to)];
      if (res.length === 0) res.push("");
      const ro = lineOffsets(res);
      return { text: res.join("\n"), cursor: Math.min(ro[Math.min(from, res.length - 1)], res.join("\n").length) };
    }
  }
}

/**
 * The foldable range of the block that starts on `line`: from the end of its
 * first line to the end of its content. Null if it starts no block, or the
 * block is a single line.
 */
export function foldRangeAt(lines: readonly string[], line: number, info: readonly LineInfo[] = analyse(lines)): { from: number; to: number } | null {
  const li = info[line];
  if (!li || (li.kind !== "heading" && li.kind !== "item")) return null;
  const b = blockFrom(info, line);
  if (b.end - b.start < 2) return null;
  const off = lineOffsets(lines);
  return { from: off[b.start] + lines[b.start].length, to: off[b.end - 1] + lines[b.end - 1].length };
}

/** Every line that starts a foldable block. */
export function foldableLines(lines: readonly string[], info: readonly LineInfo[] = analyse(lines)): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) if (foldRangeAt(lines, i, info)) out.push(i);
  return out;
}

/** Text range of the block at `cursor` (for zoom): start of its first line to end of its last. */
export function zoomRange(text: string, cursor: number): { from: number; to: number; title: string } | null {
  const lines = text.split("\n");
  const b = blockAt(lines, lineOfOffset(text, cursor));
  if (!b) return null;
  const off = lineOffsets(lines);
  return { from: off[b.start], to: off[b.end - 1] + lines[b.end - 1].length, title: blockTitle(lines[b.start]) };
}

/** A block's first line as a reader sees it: no #, list marker, emphasis or link URLs. */
export function blockTitle(line: string): string {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(ITEM, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_m, a: string, b?: string) => b ?? a)
    .replace(/[*_~`]/g, "")
    .replace(/\s+#+\s*$/, "")
    .trim();
}

/**
 * A stable name for a foldable block, the same in both editors: its kind,
 * its title in letters and digits only, and which occurrence of that title
 * it is. Survives edits elsewhere in the note; kept per note outside the file.
 */
export function foldKey(kind: "heading" | "item", title: string, occurrence: number): string {
  const norm = title.normalize("NFC").replace(/[^\p{L}\p{N}]+/gu, " ").trim().toLowerCase();
  return `${kind === "heading" ? "h" : "i"}:${norm}#${occurrence}`;
}

/** Fold keys for every foldable line of the text, in order. */
export function foldKeysOf(text: string): Array<{ line: number; key: string }> {
  const lines = text.split("\n");
  const info = analyse(lines);
  const seen = new Map<string, number>();
  const out: Array<{ line: number; key: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const li = info[i];
    if (li.kind !== "heading" && li.kind !== "item") continue;
    const kind = li.kind;
    const base = foldKey(kind, blockTitle(lines[i]), 0).replace(/#0$/, "");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    if (foldRangeAt(lines, i, info)) out.push({ line: i, key: `${base}#${n}` });
  }
  return out;
}

/* ─── Fold state per note (kept out of the file) ─────────────────── */

const FOLDS_KEY = "lumen-outline-folds";
const MODE_KEY = "lumen-outline-mode";
const MAX_NOTES = 500;

function readMap(key: string): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as unknown) : null;
    return v && typeof v === "object" ? (v as Record<string, string[]>) : {};
  } catch {
    return {};
  }
}

function writeMap(key: string, map: Record<string, string[]>): void {
  try {
    const keys = Object.keys(map);
    // Keep the newest entries only (insertion order = last written last).
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_NOTES))) delete map[k];
    localStorage.setItem(key, JSON.stringify(map));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode / quota: folds just don't persist */
  }
}

export function loadFolds(note: string): string[] {
  const v = readMap(FOLDS_KEY)[note];
  return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
}

export function saveFolds(note: string, keys: readonly string[]): void {
  const map = readMap(FOLDS_KEY);
  delete map[note];
  if (keys.length) map[note] = [...new Set(keys)];
  writeMap(FOLDS_KEY, map);
}

export function outlineModeOn(note: string): boolean {
  return Boolean(readMap(MODE_KEY)[note]);
}

export function setOutlineMode(note: string, on: boolean): void {
  const map = readMap(MODE_KEY);
  delete map[note];
  if (on) map[note] = ["1"];
  writeMap(MODE_KEY, map);
}

/** The palette / keyboard event both editors listen to. */
export const OUTLINE_EVENT = "lumen-outline";

export type OutlineCommand = OutlineOp | "fold" | "unfold" | "foldAll" | "unfoldAll" | "zoomIn" | "zoomOut" | "toggleMode";

export const OUTLINE_COMMANDS: readonly OutlineCommand[] = [
  "moveUp",
  "moveDown",
  "indent",
  "outdent",
  "duplicate",
  "delete",
  "fold",
  "unfold",
  "foldAll",
  "unfoldAll",
  "zoomIn",
  "zoomOut",
  "toggleMode",
];

export function runOutlineCommand(cmd: OutlineCommand): void {
  window.dispatchEvent(new CustomEvent(OUTLINE_EVENT, { detail: { cmd } }));
}

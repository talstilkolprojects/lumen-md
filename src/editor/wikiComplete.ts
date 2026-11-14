/**
 * `[[` link completion (MASTER_PLAN 4.5) — the part both editors share.
 *
 * Pure: the source editor (CodeMirror) and the WYSIWYG editor (Milkdown)
 * pass the text of the line up to the caret and the notes of the shared
 * workspace index; this says what is being completed, what to offer and
 * what to insert.
 *
 *   `[[que`                     → notes, and their front-matter aliases
 *   `[[Note#que`                → headings of Note (`[[#que`: of this note)
 *   `[[Note#^que`, `[[Note^que` → nothing yet: the preview neither renders
 *                                 `^id` anchors nor scrolls to them, so a
 *                                 block link would stop at the note. 4.8
 *                                 (block references) adds both and turns
 *                                 `suggestBlocks` on.
 *
 * Names match by `noteKey` — the key wiki links resolve by — so case,
 * niqqud, final letters and spacing don't matter. When no note has the
 * typed name, the last option creates it.
 */

import { headingSlug, headingSlugger, noteKey } from "../lib/slug";
import { noteHeadings, stripCode } from "../lint/vaultDoctor";

export type WikiQueryKind = "note" | "heading" | "block";

export interface WikiQuery {
  kind: WikiQueryKind;
  /** Where the link's `[[` starts, in the text before the caret. */
  open: number;
  /** The note part as typed (`Note` of `[[Note#x`; empty for `[[#x`). */
  note: string;
  /** What is being completed: the note name, or the heading / block id typed so far. */
  text: string;
  /** Where the replaced text starts; it runs to the caret. */
  from: number;
  /** `[[Note^id` (no `#`): the completion writes `#^id`, starting at the `^`. */
  bareCaret?: boolean;
}

/** Longer than this after `[[` is not a link being typed. */
const MAX_QUERY = 200;

/** What is being completed, given the text of the line up to the caret — or null outside an open `[[`. */
export function parseWikiQuery(before: string): WikiQuery | null {
  const open = before.lastIndexOf("[[");
  if (open < 0) return null;
  const start = open + 2;
  const q = before.slice(start);
  // Closed (`]`), a label (`|`) or another link: nothing to complete.
  if (q.length > MAX_QUERY || /[[\]|\n]/.test(q)) return null;
  const hash = q.indexOf("#");
  if (hash >= 0) {
    const note = q.slice(0, hash);
    const rest = q.slice(hash + 1);
    if (rest.startsWith("^")) return { kind: "block", open, note, text: rest.slice(1), from: start + hash + 2 };
    return { kind: "heading", open, note, text: rest, from: start + hash + 1 };
  }
  const caret = q.indexOf("^");
  if (caret >= 0) return { kind: "block", open, note: q.slice(0, caret), text: q.slice(caret + 1), from: start + caret, bareCaret: true };
  return { kind: "note", open, note: q, text: q, from: start };
}

/* ─── The notes ─────────────────────────────────────────────────────── */

/** A file of the workspace index (`IndexedFile` fits). */
export interface CatalogFile {
  path: string;
  content: string;
  modified: number;
}

export interface NoteEntry {
  path: string;
  /** The file name without `.md` — what a short link says. */
  stem: string;
  /** The path without `.md` — what a link says when the name is shared. */
  full: string;
  key: string;
  fullKey: string;
  aliases: string[];
  aliasKeys: string[];
  modified: number;
  content: string;
}

export interface NoteCatalog {
  notes: NoteEntry[];
  /** Notes per `key`: a name two notes share is linked by its path. */
  stemCount: Map<string, number>;
  /** The notes, most recently changed first (made on first use). */
  recent?: NoteEntry[];
}

const MD = /\.(md|markdown)$/i;

/**
 * Entries per index file object. The index replaces a file's object when it
 * re-reads the file, so an unchanged note is never parsed again — rebuilding
 * the catalog for 10,000 notes is a lookup per note.
 */
const entries = new WeakMap<CatalogFile, NoteEntry>();

/** Folder keys: a vault has few folders and many notes, and keying is half the first build. */
const folderKeys = new Map<string, string>();
function folderKey(dir: string): string {
  let k = folderKeys.get(dir);
  if (k === undefined) {
    if (folderKeys.size > 5000) folderKeys.clear();
    folderKeys.set(dir, (k = noteKey(dir)));
  }
  return k;
}

function entryOf(f: CatalogFile): NoteEntry {
  const full = f.path.replace(MD, "");
  const slash = full.lastIndexOf("/");
  const stem = full.slice(slash + 1);
  const key = noteKey(stem);
  const aliases = frontmatterAliases(f.content);
  return {
    path: f.path,
    stem,
    full,
    key,
    fullKey: slash < 0 ? key : `${folderKey(full.slice(0, slash))}/${key}`,
    aliases,
    aliasKeys: aliases.map(noteKey),
    modified: f.modified,
    content: f.content,
  };
}

/** The Markdown notes of the index, ready to match. */
export function noteCatalog(files: readonly CatalogFile[]): NoteCatalog {
  const notes: NoteEntry[] = [];
  const stemCount = new Map<string, number>();
  for (const f of files) {
    if (!MD.test(f.path)) continue;
    let e = entries.get(f);
    if (!e) {
      e = entryOf(f);
      entries.set(f, e);
    }
    notes.push(e);
    stemCount.set(e.key, (stemCount.get(e.key) ?? 0) + 1);
  }
  return { notes, stemCount };
}

/** What a link to this note says: its name, or its path when another note has the same name. */
export function linkTarget(e: NoteEntry, catalog: NoteCatalog): string {
  return (catalog.stemCount.get(e.key) ?? 0) > 1 ? e.full : e.stem;
}

/** The note a link names — by path, else by name (the way short links resolve). */
export function findNote(catalog: NoteCatalog, name: string): NoteEntry | undefined {
  const key = noteKey(name);
  if (!key) return undefined;
  return catalog.notes.find((e) => e.fullKey === key) ?? catalog.notes.find((e) => e.key === key);
}

const unquote = (s: string) => s.trim().replace(/^(["'])([\s\S]*)\1$/, "$2").trim();

/** `[a, "b, c", 'd']` without the brackets → its items. */
function inlineList(v: string): string[] {
  const out: string[] = [];
  for (const m of v.matchAll(/\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^,]+))/g)) {
    const item = (m[1] ?? m[2]?.replace(/''/g, "'") ?? m[3]).trim();
    if (item) out.push(item);
  }
  return out;
}

/**
 * `aliases:` (or the older `alias:`) of a note's YAML front matter — a list
 * (`[a, b]` or `- a` lines) or one value. No YAML library: this runs once
 * per note of the vault.
 */
export function frontmatterAliases(content: string): string[] {
  if (!content.startsWith("---")) return [];
  const fm = /^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(content);
  if (!fm) return [];
  const lines = fm[1].split(/\r?\n/);
  const at = lines.findIndex((l) => /^alias(?:es)?[ \t]*:/i.test(l));
  if (at < 0) return [];
  const value = lines[at].replace(/^alias(?:es)?[ \t]*:/i, "").replace(/[ \t]+#.*$/, "").trim();
  let out: string[];
  if (value.startsWith("[")) out = inlineList(value.replace(/^\[|\]$/g, ""));
  else if (value) out = [unquote(value)];
  else {
    out = [];
    for (const l of lines.slice(at + 1)) {
      const item = /^[ \t]*-[ \t]+(.*)$/.exec(l);
      if (item) out.push(unquote(item[1]));
      else if (l.trim() && !/^[ \t]/.test(l)) break;
    }
  }
  return out.filter((a) => a && a !== "null" && a !== "~");
}

/* ─── Matching ──────────────────────────────────────────────────────── */

/** How well `key` matches the query key `q`: 5 equal … 1 in order, 0 not at all. */
function rank(key: string, q: string): number {
  if (key === q) return 5;
  if (key.startsWith(q)) return 4;
  const at = key.indexOf(q);
  if (at > 0) return /[\s/\-_.(]/.test(key[at - 1]) ? 3 : 2;
  // The query's characters in order (`pa` → `Project Alpha`).
  let i = 0;
  for (const ch of q) {
    i = key.indexOf(ch, i);
    if (i < 0) return 0;
    i += ch.length;
  }
  return 1;
}

export type WikiSuggestionKind = "note" | "alias" | "heading" | "block" | "create";

export interface WikiSuggestion {
  kind: WikiSuggestionKind;
  /** The note, alias, heading or block id; for "create", the new note's name. */
  label: string;
  /** Folder (note), the aliased note (alias), the block's text (block). */
  detail?: string;
  /** What replaces the typed text (see `wikiEdit`). */
  insert: string;
  /** "create": the workspace path of the note to create. */
  createPath?: string;
}

/** Note names a link can't hold (`#`, `^`, `|`, brackets) or a file system refuses. */
const BAD_NAME = /[\\:*?"<>|#^[\]]/;

/** The path of a new note named as typed (`Folder/Name` allowed), or null when the name can't be one. */
export function newNotePath(typed: string): string | null {
  const parts = typed.trim().split("/").map((p) => p.trim().replace(/\s+/g, " "));
  if (parts.some((p) => !p || p === "." || p === ".." || BAD_NAME.test(p))) return null;
  const path = parts.join("/");
  if (path.length > 200) return null;
  return MD.test(path) ? path : `${path}.md`;
}

export interface SuggestOptions {
  limit?: number;
  /** Offer to create the note when none has the typed name (needs a writable vault). */
  create?: boolean;
}

/** Among equally good matches: the shorter name, then the newer note, then by path. */
const closer = (a: NoteEntry, b: NoteEntry) => a.key.length - b.key.length || b.modified - a.modified || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/** The `k` smallest of `xs` by `cmp`, sorted — without sorting all of `xs`. */
function topK<T>(xs: readonly T[], k: number, cmp: (a: T, b: T) => number): T[] {
  if (xs.length <= k * 4) return [...xs].sort(cmp).slice(0, k);
  const out: T[] = [];
  for (const x of xs) {
    if (out.length === k && cmp(x, out[k - 1]) >= 0) continue;
    let lo = 0;
    let hi = out.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmp(out[mid], x) <= 0) lo = mid + 1;
      else hi = mid;
    }
    out.splice(lo, 0, x);
    if (out.length > k) out.pop();
  }
  return out;
}

/** Notes (and aliases) for `[[typed`, best first. */
export function suggestNotes(catalog: NoteCatalog, typed: string, opts: SuggestOptions = {}): WikiSuggestion[] {
  const limit = opts.limit ?? 50;
  const q = noteKey(typed);
  const option = (e: NoteEntry): WikiSuggestion => ({
    kind: "note",
    label: e.stem,
    detail: e.full.includes("/") ? e.full.slice(0, e.full.lastIndexOf("/")) : undefined,
    insert: linkTarget(e, catalog),
  });
  if (!q) {
    // Nothing typed yet: the most recently changed notes.
    catalog.recent ??= [...catalog.notes].sort((a, b) => b.modified - a.modified);
    return catalog.recent.slice(0, limit).map(option);
  }
  // Hits by score; only the best buckets get sorted (a one-letter query
  // matches most of a 10,000-note vault).
  const buckets = new Map<number, NoteEntry[]>();
  const viaAlias = new Map<NoteEntry, string>();
  let exact = false;
  for (const e of catalog.notes) {
    let score = rank(e.key, q);
    // A path match (`folder/na`) ranks just below the same match on the name.
    if (score < 5 && e.fullKey !== e.key) {
      const p = rank(e.fullKey, q);
      if (p === 5) score = 5;
      else score = Math.max(score, p - 0.5);
    }
    let alias: string | undefined;
    for (let i = 0; i < e.aliasKeys.length; i++) {
      const a = rank(e.aliasKeys[i], q) - 0.25;
      if (a > score) {
        score = a;
        alias = e.aliases[i];
      }
    }
    if (score >= 4.75 && (e.key === q || e.fullKey === q || e.aliasKeys.includes(q))) exact = true;
    if (score <= 0) continue;
    const bucket = buckets.get(score);
    if (bucket) bucket.push(e);
    else buckets.set(score, [e]);
    if (alias !== undefined) viaAlias.set(e, alias);
  }
  const best: NoteEntry[] = [];
  for (const score of [...buckets.keys()].sort((a, b) => b - a)) {
    if (best.length >= limit) break;
    best.push(...topK(buckets.get(score)!, limit - best.length, closer));
  }
  const out = best.map((e): WikiSuggestion => {
    const alias = viaAlias.get(e);
    if (alias === undefined) return option(e);
    // An alias with a bracket or bar can't be a link label (`[[T|a [b]]]`
    // closes early): it still finds the note, which is linked without one.
    const target = linkTarget(e, catalog);
    return { kind: "alias", label: alias, detail: e.stem, insert: /[[\]|]/.test(alias) ? target : `${target}|${alias}` };
  });
  const path = opts.create && !exact ? newNotePath(typed) : null;
  if (path) out.push({ kind: "create", label: path.replace(MD, ""), insert: path.replace(MD, ""), createPath: path });
  return out;
}

/** Characters a heading link can't carry; the heading's slug drops them anyway, so it still resolves. */
const LINK_CHARS = /[[\]|#^]/g;

/** Headings of a note for `[[Note#typed`, best first, then in document order. */
export function suggestHeadings(content: string, typed: string, limit = 50): WikiSuggestion[] {
  return suggestHeadingList(noteHeadings(content), typed, limit);
}

/**
 * The same, from the headings' text in document order (the WYSIWYG editor
 * reads them off its live document). A heading is linked by its text — as
 * in Obsidian — unless an earlier heading took its slug: the preview ids
 * the second `## Setup` `setup-1`, and only `[[Note#setup-1]]` reaches it.
 */
export function suggestHeadingList(headings: readonly string[], typed: string, limit = 50): WikiSuggestion[] {
  const q = noteKey(typed);
  const slugger = headingSlugger();
  const hits: Array<{ text: string; slug: string | null; score: number; i: number }> = [];
  headings.forEach((text, i) => {
    // Every heading counts for the numbering, as in rehype-slug.
    const id = slugger.slug(text);
    if (!text.trim()) return;
    const score = q ? rank(noteKey(text), q) : 1;
    if (score > 0) hits.push({ text, slug: id === headingSlug(text) ? null : id, score, i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.slice(0, limit).map(({ text, slug }): WikiSuggestion =>
    slug === null ? { kind: "heading", label: text, insert: text.replace(LINK_CHARS, "") } : { kind: "heading", label: text, detail: `#${slug}`, insert: slug },
  );
}

/** The `^id` block ids of a note, with their block's text, in document order. */
export function noteBlocks(content: string): Array<{ id: string; text: string }> {
  // Code blanked to spaces: offsets stay those of `content`.
  const scan = stripCode(content);
  const out: Array<{ id: string; text: string }> = [];
  for (const m of scan.matchAll(/(?:^|[ \t])\^([A-Za-z0-9-]+)[ \t]*$/gm)) {
    const end = m.index ?? 0;
    const lineStart = content.lastIndexOf("\n", end) + 1;
    let text = content.slice(lineStart, end).trim();
    // An id on a line of its own names the block above it.
    if (!text) {
      const above = content.slice(0, Math.max(0, lineStart - 1)).split("\n").reverse().find((l) => l.trim());
      text = above?.trim() ?? "";
    }
    out.push({ id: m[1], text: text.replace(/^(?:[-*+]|\d+[.)]|>|#{1,6})\s+/, "").slice(0, 80) });
  }
  return out;
}

/** Block ids of a note for `[[Note#^typed` (or `[[Note^typed`). Not offered until 4.8 — see the top of the file. */
export function suggestBlocks(content: string, typed: string, bareCaret = false, limit = 50): WikiSuggestion[] {
  const q = noteKey(typed);
  const hits: Array<{ id: string; text: string; score: number; i: number }> = [];
  noteBlocks(content).forEach(({ id, text }, i) => {
    const score = q ? Math.max(rank(noteKey(id), q), rank(noteKey(text), q) - 0.5) : 1;
    if (score > 0) hits.push({ id, text, score, i });
  });
  hits.sort((a, b) => b.score - a.score || a.i - b.i);
  return hits.slice(0, limit).map(({ id, text }) => ({ kind: "block", label: id, detail: text || undefined, insert: bareCaret ? `#^${id}` : id }));
}

/** The note being edited: `[[#` completes its headings, and its unsaved text wins over the index. */
export interface CurrentNote {
  path?: string | null;
  content: string;
  /** Its headings as the editor shows them now, when the editor knows better than `content`. */
  headings?: () => string[];
}

/** Everything to offer for a parsed query. */
export function wikiSuggestions(q: WikiQuery, catalog: NoteCatalog, current?: CurrentNote, opts: SuggestOptions = {}): WikiSuggestion[] {
  if (q.kind === "note") return suggestNotes(catalog, q.text, opts);
  // Block links wait for 4.8: nothing would take the reader to the block.
  if (q.kind === "block") return [];
  const e = q.note.trim() ? findNote(catalog, q.note) : undefined;
  const isCurrent = !q.note.trim() || (!!e && current?.path === e.path);
  if (isCurrent && current?.headings) return suggestHeadingList(current.headings(), q.text, opts.limit);
  const content = isCurrent ? current?.content : e?.content;
  return content === undefined ? [] : suggestHeadings(content, q.text, opts.limit);
}

/* ─── Applying a suggestion ─────────────────────────────────────────── */

export interface WikiEdit {
  /** Replace [from, to) — offsets in the line, the caret being at `before.length`. */
  from: number;
  to: number;
  insert: string;
  /** Where the caret goes, as a line offset. */
  caret: number;
}

/**
 * The edit a picked suggestion makes. `before` / `after` are the line's
 * text before and after the caret. Inside a closed link (`[[Old]]`,
 * `[[Old|label]]`, `[[Old#h]]`) the rest of the old target is replaced too
 * and the brackets kept; otherwise the link is closed with `]]`. The caret
 * ends after the link — or after the target, when a label or heading
 * follows it.
 */
export function wikiEdit(q: WikiQuery, before: string, after: string, s: WikiSuggestion): WikiEdit {
  const caret = before.length;
  const rest = (q.kind === "note" ? /^[^\]|#^[\n]*/ : /^[^\]|[\n]*/).exec(after)?.[0] ?? "";
  const ext = /^(\]\]|\||#)/.test(after.slice(rest.length)) ? rest.length : 0;
  const tail = after.slice(ext);
  let insert = s.insert;
  // An alias picked inside `[[Old|label]]` keeps the label already there.
  if (s.kind === "alias" && tail.startsWith("|") && insert.includes("|")) insert = insert.slice(0, insert.indexOf("|"));
  let end: number;
  if (tail.startsWith("]]")) end = q.from + insert.length + 2;
  else if (/^[|#^]/.test(tail)) end = q.from + insert.length;
  else if (tail.startsWith("]")) {
    insert += "]";
    end = q.from + insert.length + 1;
  } else {
    insert += "]]";
    end = q.from + insert.length;
  }
  return { from: q.from, to: caret + ext, insert, caret: end };
}

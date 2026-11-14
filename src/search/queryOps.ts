/**
 * Search operators and body tags (plan 11.3).
 *
 * A query is free text plus operators, combined with AND:
 *
 *   tag:project      the note has the tag (front matter `tags:` or a `#tag` in the text);
 *                    `tag:a/b` also matches nested `#a/b/c`
 *   path:daily/      the note's path contains this (case-insensitive)
 *   "exact phrase"   the text contains the phrase as written (case-insensitive, Hebrew-aware)
 *   /regex/i         the text matches the regular expression (flags: i, m, s, u)
 *   -term            the note does NOT match `term` — any of the above, or a word
 *
 * Words outside operators go to the ranked search as before (BM25 in
 * ../storage/vaultIndexCore.ts). A query that is only operators lists the
 * matching notes, newest first.
 *
 * Pure and DOM-free: it runs in the index worker. Front-matter tags are
 * read by a small line parser (inline lists, `tags: a, b` and `- a` block
 * lists) so the YAML library stays out of the worker.
 */

import { hasHebrew, hebrewFind } from "../text/hebrew";

export type Op =
  | { kind: "tag"; value: string; negate: boolean }
  | { kind: "path"; value: string; negate: boolean }
  | { kind: "phrase"; value: string; negate: boolean }
  | { kind: "regex"; re: RegExp; negate: boolean }
  /** A bare word with `-` in front: excluded as a word of the text, name or path. */
  | { kind: "word"; value: string; negate: true };

export interface ParsedQuery {
  /** The free text for ranking (operators removed, positive phrases kept as words). */
  text: string;
  ops: Op[];
  /** Operator tokens that could not be used (an invalid /regex/) — shown, not silently dropped. */
  invalid: string[];
}

/** One token: a quoted phrase, a /regex/flags, or a run of non-space characters. */
const TOKEN = /(-?)(?:"([^"]*)"|\/((?:\\.|[^/\\])+)\/([imsu]*)(?=\s|$)|(\S+))/g;

export function parseQuery(query: string): ParsedQuery {
  const ops: Op[] = [];
  const free: string[] = [];
  const invalid: string[] = [];
  TOKEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOKEN.exec(query)) !== null) {
    const negate = m[1] === "-";
    const [, , phrase, reSource, reFlags, word] = m;
    if (phrase !== undefined) {
      const value = phrase.trim();
      if (!value) continue;
      ops.push({ kind: "phrase", value, negate });
      // A wanted phrase also ranks by its words.
      if (!negate) free.push(value);
      continue;
    }
    if (reSource !== undefined) {
      try {
        ops.push({ kind: "regex", re: new RegExp(reSource, reFlags.replace(/[gy]/g, "")), negate });
      } catch {
        invalid.push(m[0]);
      }
      continue;
    }
    if (word === undefined) continue;
    const colon = word.indexOf(":");
    const key = colon > 0 ? word.slice(0, colon).toLowerCase() : "";
    const rest = colon > 0 ? word.slice(colon + 1) : "";
    if ((key === "tag" || key === "path") && rest) {
      const value = key === "tag" ? normalizeTag(rest) : rest.toLowerCase();
      if (value) ops.push({ kind: key, value, negate });
      continue;
    }
    if (negate) {
      // "-" alone, or a dash inside a word ("well-known"), is text.
      if (word.length > 0) ops.push({ kind: "word", value: word.toLowerCase(), negate: true });
      continue;
    }
    free.push(word);
  }
  return { text: free.join(" "), ops, invalid };
}

/** `#Project/Sub` → `project/sub`. */
export function normalizeTag(tag: string): string {
  return tag.replace(/^#+/, "").replace(/\/+$/, "").toLowerCase();
}

/*
 * A body tag: `#` after a start, a space or an opening bracket, then letters
 * (any script, so `#עברית` is a tag), digits, `_`, `-` and `/` for nesting;
 * at least one non-digit, so `#1` and `#123` (issue numbers) are not tags.
 * Not a heading (`# Title`), not inside code, not a URL fragment.
 */
const BODY_TAG = /(^|[\s([{>"'״׳,;])#([\p{L}\p{M}\p{N}_/-]*[\p{L}\p{M}_][\p{L}\p{M}\p{N}_/-]*)/gu;

/** Code spans and fenced blocks, so `#include` in code is not a tag. */
function withoutCode(text: string): string {
  return text
    // Up to the closing fence, or the end of the note (not of the line: `m` makes `$` a line end).
    .replace(/^([ \t]*)(```|~~~)[^\n]*\n[\s\S]*?(?:\n\1\2[^\n]*|(?![\s\S]))/gm, " ")
    .replace(/`+[^`\n]*`+/g, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
}

/** The front matter block's text, or "" (same delimiters as renderer/pipeline's extractFrontmatter). */
function frontMatterOf(text: string): { body: string; fm: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  return m ? { fm: m[1], body: text.slice(m[0].length) } : { fm: "", body: text };
}

/** `tags:` / `tag:` values of a front matter block: `[a, b]`, `a, b`, `a b`, or a `- a` list. */
function frontMatterTags(fm: string): string[] {
  if (!fm) return [];
  const lines = fm.split(/\r?\n/);
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(?:tags|tag)\s*:\s*(.*)$/i);
    if (!m) continue;
    const inline = m[1].trim();
    if (inline) {
      for (const part of inline.replace(/^\[|\]$/g, "").split(/[,\s]+/)) {
        const t = normalizeTag(part.replace(/^["']|["']$/g, ""));
        if (t) out.push(t);
      }
      continue;
    }
    for (let j = i + 1; j < lines.length; j++) {
      const item = lines[j].match(/^\s*-\s+(.+)$/);
      if (!item) break;
      const t = normalizeTag(item[1].trim().replace(/^["']|["']$/g, ""));
      if (t) out.push(t);
    }
  }
  return out;
}

/** Every tag of a note: its front matter `tags:` and every `#tag` in its text (outside code). Lower-case, unique, in order. */
export function noteTags(text: string): string[] {
  const { fm, body } = frontMatterOf(text);
  const seen = new Set<string>(frontMatterTags(fm));
  const clean = withoutCode(body);
  BODY_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BODY_TAG.exec(clean)) !== null) {
    const t = normalizeTag(m[2]);
    if (t) seen.add(t);
  }
  return [...seen];
}

/** The parts a note is matched on (computed once, when it is indexed). */
export interface Matchable {
  content: string;
  /** content.toLowerCase() */
  lower: string;
  pathLower: string;
  nameLower: string;
  tags: string[];
}

function hasTag(tags: string[], want: string): boolean {
  // `tag:a` matches `a` and the nested `a/b`; `tag:a/b` matches `a/b` and `a/b/c`.
  return tags.some((t) => t === want || t.startsWith(want + "/"));
}

function hasPhrase(n: Matchable, phrase: string): boolean {
  const q = phrase.toLowerCase();
  if (n.lower.includes(q)) return true;
  return hasHebrew(q) ? hebrewFind(n.content, q) !== null : false;
}

/** One operator, before its `-`. */
function test(op: Op, n: Matchable): boolean {
  switch (op.kind) {
    case "tag":
      return hasTag(n.tags, op.value);
    case "path":
      return n.pathLower.includes(op.value);
    case "phrase":
      return hasPhrase(n, op.value);
    case "regex":
      op.re.lastIndex = 0;
      return op.re.test(n.content);
    case "word":
      return n.lower.includes(op.value) || n.nameLower.includes(op.value) || n.pathLower.includes(op.value) || (hasHebrew(op.value) && hebrewFind(n.content, op.value) !== null);
  }
}

/** True when the note passes every operator. */
export function matchesOps(ops: Op[], n: Matchable): boolean {
  for (const op of ops) if (test(op, n) === op.negate) return false;
  return true;
}

/** Where to put the snippet for an operator-only hit: the first positive phrase / regex / tag in the text. */
export function opLocation(ops: Op[], n: Matchable): { start: number; end: number } | null {
  for (const op of ops) {
    if (op.negate) continue;
    if (op.kind === "phrase") {
      const at = n.lower.indexOf(op.value.toLowerCase());
      if (at >= 0) return { start: at, end: at + op.value.length };
      const h = hasHebrew(op.value) ? hebrewFind(n.content, op.value) : null;
      if (h) return h;
    } else if (op.kind === "regex") {
      const re = new RegExp(op.re.source, op.re.flags.replace(/[gy]/g, ""));
      const m = re.exec(n.content);
      if (m && m[0].length) return { start: m.index, end: m.index + m[0].length };
    } else if (op.kind === "tag") {
      const at = n.lower.indexOf("#" + op.value);
      if (at >= 0) return { start: at, end: at + op.value.length + 1 };
    }
  }
  return null;
}

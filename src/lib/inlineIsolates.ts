/**
 * Bidi isolates for Markdown inline syntax (plan W11.H2).
 *
 * In a Hebrew line, "ראה `npm run dev` וגם https://example.com/a" is a
 * right-to-left paragraph with left-to-right islands. Without isolation the
 * browser's bidi algorithm lets their neutrals (spaces, "/", "." "(") join
 * the surrounding runs, so the islands come apart on screen, and CodeMirror
 * moves the cursor through them in an order that no longer matches what is
 * drawn: Home/End stop one character short of the edge and the arrows
 * bounce at RTL/LTR boundaries (the Obsidian 1.14.2 bugs, research R2 §1.9).
 *
 * This module finds the islands in one line of Markdown source; the editor
 * (src/editor/bidiIsolates.ts) marks each as an isolate and tells
 * CodeMirror (`bidiIsolatedRanges`), so cursor motion follows the drawing:
 * - left to right: inline code, bare and angle-bracket URLs, a link's
 *   `(destination)`, footnote references `[^1]`;
 * - their own direction (first strong, "auto"): `[[wiki links]]` and `#tags`,
 *   whose text may be Hebrew or English.
 * Inline math is isolated already by src/editor/mathBidi.ts (W5.14); its
 * spans are left out here so the two never overlap.
 */
import { codeSpanRanges, inlineMathSpans } from "./mathIsolate";

export interface Isolate {
  from: number;
  to: number;
  dir: "ltr" | "auto";
  kind: "code" | "url" | "link-target" | "wikilink" | "tag" | "footnote";
}

const URL_RE = /\b(?:https?|ftp|mailto):[^\s<>]+|\bwww\.[^\s<>]+/gi;
/** A URL does not end in sentence punctuation or an unbalanced ")". */
function trimUrl(s: string): string {
  let t = s.replace(/[.,;:!?'"״׳]+$/, "");
  while (t.endsWith(")") && (t.match(/\(/g)?.length ?? 0) < (t.match(/\)/g)?.length ?? 0)) t = t.slice(0, -1).replace(/[.,;:!?]+$/, "");
  return t;
}

export function inlineIsolates(line: string): Isolate[] {
  const out: Isolate[] = [];
  const taken: [number, number][] = [...inlineMathSpans(line)];
  const free = (a: number, b: number) => !taken.some(([x, y]) => a < y && b > x);
  const add = (from: number, to: number, dir: Isolate["dir"], kind: Isolate["kind"]) => {
    if (to > from && free(from, to)) {
      out.push({ from, to, dir, kind });
      taken.push([from, to]);
    }
  };
  for (const [a, b] of codeSpanRanges(line)) add(a, b, "ltr", "code");
  // [[target]] and [[target|alias]]: one island in its own direction.
  for (const m of line.matchAll(/!?\[\[[^\]\n]+?\]\]/g)) add(m.index!, m.index! + m[0].length, "auto", "wikilink");
  // Footnote references.
  for (const m of line.matchAll(/\[\^[^\]\s]+\]/g)) add(m.index!, m.index! + m[0].length, "ltr", "footnote");
  // Link and image destinations: the "(…)" after "]", balanced, with an optional <…> form.
  for (let i = line.indexOf("]("); i >= 0; i = line.indexOf("](", i + 1)) {
    const open = i + 1;
    let j = open + 1;
    if (line[j] === "<") {
      const close = line.indexOf(">", j);
      if (close < 0) continue;
      j = close + 1;
    }
    let depth = 1;
    for (; j < line.length; j++) {
      const c = line[j];
      if (c === "\\") j++;
      else if (c === "(") depth++;
      else if (c === ")" && --depth === 0) break;
    }
    if (j < line.length) add(open, j + 1, "ltr", "link-target");
  }
  for (const m of line.matchAll(/<((?:https?|mailto):[^\s>]+)>/gi)) add(m.index!, m.index! + m[0].length, "ltr", "url");
  for (const m of line.matchAll(URL_RE)) {
    const u = trimUrl(m[0]);
    add(m.index!, m.index! + u.length, "ltr", "url");
  }
  // #tag (Obsidian rules: not after a word character, at least one non-digit, no space after "#").
  for (const m of line.matchAll(/(^|[\s(])#([\p{L}\p{N}_/-]+)/gu)) {
    if (/^[\p{N}]+$/u.test(m[2])) continue;
    const from = m.index! + m[1].length;
    if (from === 0 && /^#{1,6}\s/.test(line)) continue;
    add(from, from + 1 + m[2].length, "auto", "tag");
  }
  return out.sort((a, b) => a.from - b.from);
}

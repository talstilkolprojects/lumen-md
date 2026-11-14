/**
 * Vault paths inside `[[…]]` (plan 4.14). `#`, `|`, `[`, `]` are wiki-link
 * syntax, so a generated link percent-encodes them (and `%` itself, and line
 * breaks); whoever compares or resolves a link target decodes it first.
 *
 * Whitespace at either end of a path is encoded too (`%20` for a space): a
 * wiki-link target is trimmed when it is read, so ` paper.pdf` written raw
 * would come back as `paper.pdf` and miss the file (review #272, step 2.20).
 * Whitespace inside a path stays as written.
 */

/** The characters JavaScript's `trim()` removes (`\s`), minus the line breaks encoded everywhere. */
const EDGE_WS = "\t\v\f                  　﻿";

/** One escape per edge-whitespace character, as `encodeURIComponent` writes it (`%20`, `%C2%A0`, …). */
const EDGE_ESCAPES = Array.from(EDGE_WS, (c) => encodeURIComponent(c));
const EDGE_ALT = EDGE_ESCAPES.join("|");
const LEADING_ESCAPES = new RegExp(`^(?:${EDGE_ALT})+`, "i");
const TRAILING_ESCAPES = new RegExp(`(?:${EDGE_ALT})+$`, "i");

/** A vault path made safe inside `[[…]]`. */
export function encodeWikiPath(path: string): string {
  const inner = path.replace(/[%#|[\]\r\n]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
  const edge = (run: string) => Array.from(run, (c) => encodeURIComponent(c)).join("");
  return inner.replace(/^\s+/, edge).replace(/\s+$/, edge);
}

/**
 * A wiki target with the escapes `encodeWikiPath` writes decoded. Only those:
 * any other `%xx` in a hand-written link stays as written, and an encoded
 * space counts only at either end of the target.
 */
export function decodeWikiPath(target: string): string {
  // The edges first: `%2520` (a literal `%20`) must not become a space.
  const edges = target
    .replace(LEADING_ESCAPES, (run) => decodeURIComponent(run))
    .replace(TRAILING_ESCAPES, (run) => decodeURIComponent(run));
  return edges.replace(/%(23|25|5B|5D|7C|0A|0D)/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** Does `target` hold one of the escapes `encodeWikiPath` writes (so it may be a generated link)? */
export function hasWikiPathEscape(target: string): boolean {
  return decodeWikiPath(target) !== target;
}

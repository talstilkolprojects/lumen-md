/**
 * Vault paths inside `[[…]]` (plan 4.14). `#`, `|`, `[`, `]` are wiki-link
 * syntax, so a generated link percent-encodes them (and `%` itself, and line
 * breaks); whoever compares or resolves a link target decodes it first.
 */

/** A vault path made safe inside `[[…]]`. */
export function encodeWikiPath(path: string): string {
  return path.replace(/[%#|[\]\r\n]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

/**
 * A wiki target with the escapes `encodeWikiPath` writes decoded. Only those:
 * any other `%xx` in a hand-written link stays as written.
 */
export function decodeWikiPath(target: string): string {
  return target.replace(/%(23|25|5B|5D|7C|0A|0D)/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

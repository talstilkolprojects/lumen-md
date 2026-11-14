/**
 * Citation keys (plan W2.16): pandoc's `@key`. A source's own key wins
 * (BibTeX, CSL `citation-key`, "Citation Key:" from Better BibTeX / Zotero);
 * otherwise `<family><year>` (Hebrew stays Hebrew: pandoc keys may use any
 * letters), with a, b, … when two sources would share one.
 */
import type { CitationRecord } from "../data/citationStyles";

/** What pandoc accepts: starts with a letter, digit or _, then alphanumerics and :.#$%&-+?<>~/ inside. */
export const KEY = /[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&+?<>~/-]*[\p{L}\p{N}_])?/u;
export const isKey = (s: string) => new RegExp(`^${KEY.source}$`, "u").test(s);

export function baseKey(r: CitationRecord): string {
  const who = r.authors[0]?.family ?? r.title.split(/\s+/)[0] ?? "ref";
  const clean = who.normalize("NFC").replace(/[\u0591-\u05C7]/g, "").replace(/[^\p{L}\p{N}]+/gu, "").toLocaleLowerCase("en");
  return `${clean || "ref"}${r.year ?? ""}`;
}

/** A key not in `used` (which it joins). */
export function uniqueKey(base: string, used: Set<string>): string {
  let key = base;
  for (let i = 0; used.has(key); i++) key = `${base}${String.fromCharCode(97 + (i % 26))}${i >= 26 ? Math.floor(i / 26) : ""}`;
  used.add(key);
  return key;
}

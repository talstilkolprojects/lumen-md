/**
 * `[[target]]` / `[[target|label]]` wiki-links in a note's text — shared by
 * the main-thread workspace index and the index core in the worker, so the
 * core stays out of the startup bundle.
 */

export const WIKI_RE = /\[\[([^\]\r\n|]+?)(?:\|[^\]\r\n]+?)?\]\]/g;

/** The raw `[[target]]` texts of a note, in order. */
export function wikiTargetsOf(content: string): string[] {
  const out: string[] = [];
  const re = new RegExp(WIKI_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1].trim());
  return out;
}

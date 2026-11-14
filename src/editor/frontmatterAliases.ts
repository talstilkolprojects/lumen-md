/**
 * Front-matter aliases of a note (plan 4.5), on their own so the vault index
 * worker (../storage/noteSummary.ts, W6.36) reads them without loading the
 * whole of ./wikiComplete.ts. Re-exported from there.
 */

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

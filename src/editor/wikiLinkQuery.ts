/** The pure half of ./wikiLinkComplete.ts (plan W1.25): what the cursor is completing, and the options. */

/** Note names the list offers, given the vault's paths: Markdown files, by name without `.md`, the path as detail. */
export function noteOptions(paths: readonly string[]): Array<{ label: string; detail: string }> {
  const out: Array<{ label: string; detail: string }> = [];
  for (const p of paths) {
    if (!/\.mdx?$/i.test(p)) continue;
    const name = p.split("/").pop()!.replace(/\.mdx?$/i, "");
    out.push({ label: name, detail: p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "" });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/** The `[[query` the cursor is in, or null: from the `[[` to the cursor, before any `|`, `#` or `]`. */
export function wikiQueryAt(lineBefore: string): { query: string; offset: number } | null {
  const open = lineBefore.lastIndexOf("[[");
  if (open < 0) return null;
  const query = lineBefore.slice(open + 2);
  if (/[\]|#]/.test(query)) return null;
  return { query, offset: open + 2 };
}

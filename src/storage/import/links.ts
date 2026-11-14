/**
 * Internal links of an imported vault: how many there are and how many
 * reach a note or an attachment of the import (the report's "links
 * converted"). Wikilinks resolve as Obsidian resolves them — a path from
 * the vault root, a path suffix, or a note name; Markdown links are
 * relative to the note.
 */
import { dirOf, resolveRel } from "./names";
import type { ConvertedVault, LinkStats } from "./types";

const MAX_LISTED = 200;

/** The note's text without fenced code and inline code, where `[[x]]` is not a link. */
function prose(md: string): string {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1\s*$/gm, "").replace(/`[^`\n]*`/g, "");
}

export function linkTargets(md: string): { kind: "wiki" | "md"; target: string }[] {
  const out: { kind: "wiki" | "md"; target: string }[] = [];
  const text = prose(md);
  for (const m of text.matchAll(/!?\[\[([^\]|#^\n]*)(?:[#^][^\]|\n]*)?(?:\|[^\]\n]*)?\]\]/g)) {
    if (m[1].trim()) out.push({ kind: "wiki", target: m[1].trim() });
  }
  for (const m of text.matchAll(/!?\[(?:[^\]\n]|\\\])*\]\((<[^>\n]+>|[^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const dest = m[1].replace(/^<|>$/g, "");
    if (/^[a-z][a-z0-9+.-]*:/i.test(dest) || dest.startsWith("#") || dest.startsWith("//")) continue;
    out.push({ kind: "md", target: dest });
  }
  return out;
}

export function linkStats(vault: Pick<ConvertedVault, "notes" | "attachments">): LinkStats {
  const all = [...vault.notes.keys(), ...vault.attachments.keys()];
  const key = (p: string) => p.normalize("NFC").toLowerCase();
  const exact = new Set(all.map(key));
  const names = new Set<string>();
  for (const p of all) {
    const k = key(p);
    names.add(k.slice(k.lastIndexOf("/") + 1));
    names.add(k.slice(k.lastIndexOf("/") + 1).replace(/\.md$/, ""));
  }
  const suffixes = all.map((p) => `/${key(p)}`);
  const resolvesWiki = (t: string): boolean => {
    const k = key(t.replace(/^\/+/, ""));
    if (exact.has(k) || exact.has(`${k}.md`)) return true;
    if (!k.includes("/")) return names.has(k) || names.has(`${k}.md`);
    return suffixes.some((s) => s.endsWith(`/${k}`) || s.endsWith(`/${k}.md`));
  };
  const stats: LinkStats = { total: 0, resolved: 0, unresolved: [] };
  for (const [path, text] of vault.notes) {
    if (!/\.md$/i.test(path)) continue;
    for (const l of linkTargets(text)) {
      stats.total++;
      let ok: boolean;
      if (l.kind === "wiki") ok = resolvesWiki(l.target);
      else {
        let d = l.target.split(/[?#]/)[0];
        try {
          d = decodeURIComponent(d);
        } catch {
          /* as written */
        }
        ok = !d || exact.has(key(resolveRel(dirOf(path), d)));
      }
      if (ok) stats.resolved++;
      else if (stats.unresolved.length < MAX_LISTED) stats.unresolved.push({ path, target: l.target });
    }
  }
  return stats;
}

/**
 * Bear: a backup (`.bearbk`, File → Backup notes) or a TextBundle export —
 * one `<note>.textbundle/` folder per note with `text.md` (or
 * `text.markdown`), `info.json` (dates, trashed / archived) and `assets/`.
 * Plain Markdown exports go through as they are. Bear's own syntax becomes
 * standard: `::highlight::` → `==highlight==`, `#multi word tag#` →
 * `#multi-word-tag`.
 */
import { claimPath, dirOf, mdDest, relativeTo, safeName, safePath, stemOf } from "./names";
import { isoDate, tagValue, withFrontmatter } from "./frontmatter";
import { emptyVault, type ConvertedVault } from "./types";

interface BearInfo {
  creationDate?: string;
  modificationDate?: string;
  trashed?: number | boolean;
  archived?: number | boolean;
  pinned?: number | boolean;
}

const BUNDLE = /^(.*?[^/]+\.textbundle)\//i;

/** Bear's tags and highlights → standard Markdown (code spans and fences untouched). */
export function bearToMarkdown(md: string): string {
  const out: string[] = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence || /^\s*(```|~~~)/.test(line)) {
      out.push(line);
      continue;
    }
    out.push(
      line
        .split(/(`[^`]*`)/)
        .map((part, i) =>
          i % 2
            ? part
            : part
                .replace(/::([^:\n]+?)::/g, "==$1==")
                // #multi word tag# — Bear's closing hash allows spaces.
                .replace(/(^|\s)#([^\s#][^#\n]*?[^\s#])#(?=\s|$)/g, (_, pre: string, t: string) => `${pre}#${tagValue(t)}`),
        )
        .join(""),
    );
  }
  return out.join("\n");
}

export function convertBear(files: Map<string, Uint8Array>): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const dec = new TextDecoder();
  const bundles = new Map<string, Map<string, Uint8Array>>();
  const loose = new Map<string, Uint8Array>();
  for (const [p, data] of files) {
    const m = BUNDLE.exec(p);
    if (m) {
      if (!bundles.has(m[1])) bundles.set(m[1], new Map());
      bundles.get(m[1])!.set(p.slice(m[1].length + 1), data);
    } else loose.set(p, data);
  }
  for (const [bundle, parts] of bundles) {
    const textKey = [...parts.keys()].find((k) => /^text\.(md|markdown|txt)$/i.test(k));
    const assets = [...parts.keys()].filter((k) => /^assets\//i.test(k));
    if (!textKey) {
      vault.skipped.push({ path: bundle, reason: "unreadable" });
      continue;
    }
    let info: BearInfo = {};
    const infoBytes = parts.get("info.json");
    if (infoBytes) {
      try {
        const j = JSON.parse(dec.decode(infoBytes)) as Record<string, unknown>;
        info = (j["net.shinyfrog.bear"] as BearInfo | undefined) ?? {};
      } catch {
        /* dates only — the note still imports */
      }
    }
    if (info.trashed) {
      vault.skipped.push({ path: bundle, reason: "trashed" });
      continue;
    }
    vault.sourceAttachments += assets.length;
    const text = dec.decode(parts.get(textKey)!);
    const title = /^#\s+(.+)$/m.exec(text)?.[1]?.trim() || stemOf(bundle.replace(/\.textbundle$/i, "") + ".x");
    const folder = info.archived ? "Archive" : "";
    const notePath = claimPath(taken, `${folder ? `${folder}/` : ""}${safeName(title)}.md`);
    const assetDir = `assets/${stemOf(notePath)}`;
    const moved = new Map<string, string>();
    for (const a of assets) {
      const target = claimPath(taken, `${assetDir}/${safePath(a.slice("assets/".length))}`);
      vault.attachments.set(target, parts.get(a)!);
      moved.set(a, target);
    }
    // Links into the bundle's assets/ follow the files to their new folder.
    const fromDir = dirOf(notePath);
    let body = bearToMarkdown(text).replace(/(!?\[[^\]]*\]\()(<[^>]+>|[^)\s]+)(\))/g, (m, open: string, dest: string, close: string) => {
      let raw = dest.replace(/^<|>$/g, "");
      try {
        raw = decodeURIComponent(raw);
      } catch {
        /* keep as written */
      }
      const target = moved.get(raw);
      if (!target) return m;
      return `${open}${mdDest(relativeTo(fromDir, target))}${close}`;
    });
    const linked = new Set([...body.matchAll(/\]\((?:<([^>]+)>|([^)\s]+))\)/g)].map((x) => x[1] ?? x[2]));
    const unused = [...moved.values()].filter((t) => !linked.has(relativeTo(fromDir, t)));
    if (unused.length) body = `${body.trimEnd()}\n\n${unused.map((t) => `[${stemOf(t)}](${mdDest(relativeTo(fromDir, t))})`).join("\n")}\n`;
    const created = info.creationDate ? isoDate(new Date(info.creationDate)) : undefined;
    const updated = info.modificationDate ? isoDate(new Date(info.modificationDate)) : undefined;
    if (!created && !updated) vault.warnings.push({ path: notePath, reason: "noDates" });
    vault.notes.set(notePath, withFrontmatter({ created, updated, pinned: info.pinned ? true : undefined }, body));
  }
  // A Markdown export (no bundles): notes and their attachment folders as they are.
  for (const [p, data] of loose) {
    if (/\.(md|markdown|txt)$/i.test(p)) {
      vault.notes.set(claimPath(taken, p.normalize("NFC").replace(/\.(markdown|txt)$/i, ".md")), bearToMarkdown(dec.decode(data)));
    } else if (/(^|\/)\.DS_Store$/.test(p)) {
      vault.skipped.push({ path: p, reason: "appFolder" });
    } else {
      vault.sourceAttachments++;
      vault.attachments.set(claimPath(taken, p.normalize("NFC")), data);
    }
  }
  return vault;
}

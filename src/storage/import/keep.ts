/**
 * Google Keep, from Google Takeout (takeout.google.com → Keep): one `.json`
 * per note (an `.html` copy next to it), attachments beside them. Text and
 * checklists become Markdown; labels, colour, pin and dates become
 * properties; archived notes go to `Archive/`, trashed ones are left out.
 */
import { claimPath, dirOf, mdEmbed, safeName, stemOf } from "./names";
import { isoDate, tagValue, withFrontmatter } from "./frontmatter";
import { emptyVault, type ConvertedVault } from "./types";

interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: { text?: string; isChecked?: boolean }[];
  labels?: { name?: string }[];
  attachments?: { filePath?: string; mimetype?: string }[];
  annotations?: { url?: string; title?: string }[];
  createdTimestampUsec?: number;
  userEditedTimestampUsec?: number;
  isTrashed?: boolean;
  isArchived?: boolean;
  isPinned?: boolean;
  color?: string;
}

const isKeepNote = (v: unknown): v is KeepNote =>
  !!v && typeof v === "object" && ("textContent" in v || "listContent" in v) && ("userEditedTimestampUsec" in v || "createdTimestampUsec" in v);

/** Takeout names an attachment `x.jpeg` in the JSON and `x.jpg` on disk (and the other way round). */
function findAttachment(files: Map<string, Uint8Array>, dir: string, name: string): string | undefined {
  const exact = dir ? `${dir}/${name}` : name;
  if (files.has(exact)) return exact;
  const stem = name.replace(/\.[^.]+$/, "");
  for (const p of files.keys()) if (dirOf(p) === dir && stemOf(p) === stem && !/\.(json|html)$/i.test(p)) return p;
  return undefined;
}

export function convertKeep(files: Map<string, Uint8Array>): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const used = new Set<string>();
  const trashed = new Set<string>();
  const dec = new TextDecoder();
  const usec = (n: number | undefined) => (typeof n === "number" && n > 0 ? isoDate(Math.round(n / 1000)) : undefined);
  const notes = [...files.keys()].filter((p) => /\.json$/i.test(p));
  for (const path of notes) {
    let json: unknown;
    try {
      json = JSON.parse(dec.decode(files.get(path)!));
    } catch {
      vault.skipped.push({ path, reason: "unreadable" });
      continue;
    }
    if (!isKeepNote(json)) {
      vault.skipped.push({ path, reason: "unsupported" });
      continue;
    }
    if (json.isTrashed) {
      vault.skipped.push({ path, reason: "trashed" });
      for (const a of json.attachments ?? []) {
        const f = a.filePath && findAttachment(files, dirOf(path), a.filePath);
        if (f) trashed.add(f);
      }
      continue;
    }
    const text = (json.textContent ?? "").replace(/\r\n/g, "\n");
    const list = (json.listContent ?? []).map((i) => `- [${i.isChecked ? "x" : " "}] ${(i.text ?? "").trim()}`).join("\n");
    const title = json.title?.trim() || text.split("\n")[0]?.trim().slice(0, 60) || stemOf(path);
    if (!text.trim() && !list && !(json.attachments ?? []).length) {
      vault.skipped.push({ path, reason: "empty" });
      continue;
    }
    const folder = json.isArchived ? "Archive" : "";
    const notePath = claimPath(taken, `${folder ? `${folder}/` : ""}${safeName(title)}.md`);
    const parts: string[] = [];
    if (text.trim()) parts.push(text.trim());
    if (list) parts.push(list);
    for (const a of json.annotations ?? []) if (a.url) parts.push(`[${(a.title || a.url).replace(/[[\]]/g, "")}](${a.url})`);
    const embeds: string[] = [];
    for (const a of json.attachments ?? []) {
      if (!a.filePath) continue;
      const src = findAttachment(files, dirOf(path), a.filePath);
      if (!src) {
        vault.warnings.push({ path: notePath, reason: "missingAttachment", detail: a.filePath });
        continue;
      }
      used.add(src);
      const target = claimPath(taken, `attachments/${safeName(stemOf(src))}${src.match(/\.[^./]+$/)?.[0]?.toLowerCase() ?? ""}`);
      vault.attachments.set(target, files.get(src)!);
      embeds.push(mdEmbed(target, dirOf(notePath)));
    }
    if (embeds.length) parts.push(embeds.join("\n"));
    const props = {
      created: usec(json.createdTimestampUsec),
      updated: usec(json.userEditedTimestampUsec),
      tags: (json.labels ?? []).map((l) => tagValue(l.name ?? "")).filter(Boolean),
      color: json.color && json.color !== "DEFAULT" ? json.color.toLowerCase() : undefined,
      pinned: json.isPinned ? true : undefined,
      archived: json.isArchived ? true : undefined,
    };
    vault.notes.set(notePath, withFrontmatter(props, `# ${title}\n\n${parts.join("\n\n")}\n`));
  }
  for (const p of files.keys()) {
    if (/\.json$/i.test(p)) continue;
    if (/\.html$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "duplicate" });
      continue;
    }
    if (/(^|\/)Labels\.txt$/i.test(p)) {
      vault.skipped.push({ path: p, reason: "appFolder" });
      continue;
    }
    if (trashed.has(p) && !used.has(p)) {
      vault.skipped.push({ path: p, reason: "trashed" });
      continue;
    }
    vault.sourceAttachments++;
    if (used.has(p)) continue;
    // A file no note points at (Takeout keeps drawings and recordings this way): kept, never dropped.
    const target = claimPath(taken, `attachments/${safeName(stemOf(p))}${p.match(/\.[^./]+$/)?.[0]?.toLowerCase() ?? ""}`);
    vault.attachments.set(target, files.get(p)!);
  }
  return vault;
}

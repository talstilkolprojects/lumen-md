/**
 * From the files a person picked to a converted vault: archives opened
 * (nested ones too — Notion zips its parts), paths cleaned, the source
 * detected, its converter run. No writes: the vault is untouched until the
 * wizard commits (./commit.ts).
 */
import { unzip } from "../zip";
import { convertBear } from "./bear";
import { convertEvernote } from "./evernote";
import { convertHtmlNotes } from "./htmlNotes";
import { convertKeep } from "./keep";
import { convertLogseq } from "./logseq";
import { convertNotion, looksLikeNotion } from "./notion";
import { claimPath } from "./names";
import { emptyVault, type ConvertedVault, type ImportSourceId } from "./types";

/** Every source the wizard offers, in the order it shows them. */
export const IMPORT_SOURCES: readonly ImportSourceId[] = ["obsidian", "notion", "evernote", "bear", "appleNotes", "keep", "logseq", "onenote", "lumen"];

/** Brand names stay as they are in every language. */
export const SOURCE_NAMES: Record<ImportSourceId, string> = {
  obsidian: "Obsidian",
  notion: "Notion",
  evernote: "Evernote",
  bear: "Bear",
  appleNotes: "Apple Notes",
  keep: "Google Keep",
  logseq: "Logseq",
  onenote: "OneNote",
  lumen: "Lumen",
};

/** What the file picker of each source accepts (a folder picker is offered next to it). */
export const SOURCE_ACCEPT: Record<ImportSourceId, string> = {
  obsidian: ".zip",
  notion: ".zip",
  evernote: ".enex",
  bear: ".bearbk,.zip,.textbundle",
  appleNotes: ".zip,.html,.htm,.txt,.md",
  keep: ".zip,.json",
  logseq: ".zip",
  onenote: ".mht,.mhtml,.zip",
  lumen: ".zip",
};

const ARCHIVE = /\.(zip|bearbk)$/i;

/** `a\b/../c` → `a/c`; `..` never climbs above the export. Null for a name with nothing left. */
export function cleanArchivePath(p: string): string | null {
  const out: string[] = [];
  for (const seg of p.replace(/\\/g, "/").split("/")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg.normalize("NFC"));
  }
  return out.length ? out.join("/") : null;
}

/** Open archives inside `files` (up to 3 levels: Notion's `Export.zip` holds `Part-1.zip`). */
export async function expandArchives(files: Map<string, Uint8Array>, depth = 0): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const [p, data] of files) {
    const clean = cleanArchivePath(p);
    if (!clean) continue;
    if (ARCHIVE.test(clean) && depth < 3) {
      let inner: Map<string, Uint8Array>;
      try {
        inner = await unzip(data.slice().buffer);
      } catch {
        out.set(clean, data);
        continue;
      }
      // A .bearbk / a single top-level archive opens in place; a nested one in its own folder.
      const prefix = depth === 0 && files.size === 1 ? "" : clean.replace(ARCHIVE, "") + "/";
      const opened = await expandArchives(new Map([...inner].map(([k, v]) => [prefix + k, v])), depth + 1);
      for (const [k, v] of opened) out.set(k, v);
    } else out.set(clean, data);
  }
  return out;
}

/**
 * The archive's own top folder ("MyVault/…", "Export-…/…"): the first
 * segment, when every path shares it — and only that one. A Bear
 * `Note.textbundle/` is a note, never a wrapper.
 */
export function stripWrapper(files: Map<string, Uint8Array>): Map<string, Uint8Array> {
  const paths = [...files.keys()].filter((p) => !/(^|\/)(__MACOSX|\.DS_Store)(\/|$)/.test(p));
  const first = paths[0]?.split("/") ?? [];
  if (first.length < 2) return files;
  const top = `${first[0]}/`;
  if (/\.textbundle\/$/i.test(top) || !paths.every((p) => p.startsWith(top))) return files;
  return new Map([...files].filter(([p]) => p.startsWith(top)).map(([p, v]) => [p.slice(top.length), v]));
}

/** Which tool wrote this export (the wizard preselects it; the person can change it). */
export function detectImportSource(paths: string[]): ImportSourceId {
  if (paths.some((p) => /(^|\/)\.obsidian\//.test(p))) return "obsidian";
  if (paths.some((p) => /(^|\/)logseq\/config\.edn$/.test(p))) return "logseq";
  if (paths.some((p) => /\.enex$/i.test(p))) return "evernote";
  if (paths.some((p) => /\.textbundle\//i.test(p))) return "bear";
  if (paths.some((p) => /\.(mht|mhtml)$/i.test(p))) return "onenote";
  if (paths.some((p) => /(^|\/)Keep\/[^/]+\.json$/.test(p))) return "keep";
  if (looksLikeNotion(paths)) return "notion";
  if (paths.some((p) => /\.html?$/i.test(p)) && !paths.some((p) => /\.md$/i.test(p))) return "appleNotes";
  return "lumen";
}

const APP = /(^|\/)(\.obsidian|\.trash|\.git|\.lumen|__MACOSX)(\/|$)|(^|\/)\.DS_Store$/;

/** Obsidian and Lumen vaults are Markdown already: kept as they are, app folders left out. */
function convertVault(files: Map<string, Uint8Array>): ConvertedVault {
  const vault = emptyVault();
  const taken = new Set<string>();
  const dec = new TextDecoder();
  for (const [p, data] of files) {
    if (APP.test(p)) {
      vault.skipped.push({ path: p, reason: p.includes(".trash") ? "trashed" : "appFolder" });
      continue;
    }
    const target = claimPath(taken, p);
    if (/\.(md|markdown|base|canvas)$/i.test(p)) vault.notes.set(target, dec.decode(data));
    else {
      vault.sourceAttachments++;
      vault.attachments.set(target, data);
    }
  }
  return vault;
}

/** Run `source`'s converter. `folder` is the vault folder the import will go into. */
export function convertExport(source: ImportSourceId, files: Map<string, Uint8Array>, folder: string): ConvertedVault {
  // Keep's Takeout puts the notes under Takeout/Keep/: that folder is the export.
  if (source === "keep") {
    const keep = [...files.keys()].find((p) => /(^|\/)Keep\/[^/]+\.json$/.test(p));
    if (keep) {
      const root = keep.slice(0, keep.lastIndexOf("/") + 1);
      const outside = [...files.keys()].filter((p) => !p.startsWith(root));
      const v = convertKeep(new Map([...files].filter(([p]) => p.startsWith(root)).map(([p, d]) => [p.slice(root.length), d])));
      // The report names files as they are in the export.
      v.skipped = v.skipped.map((i) => ({ ...i, path: root + i.path }));
      for (const p of outside) v.skipped.push({ path: p, reason: "unsupported" });
      return v;
    }
    return convertKeep(files);
  }
  switch (source) {
    case "notion":
      return convertNotion(files, { folder });
    case "evernote":
      return convertEvernote(files);
    case "bear":
      return convertBear(files);
    case "logseq":
      return convertLogseq(files);
    case "appleNotes":
    case "onenote":
      return convertHtmlNotes(files, source);
    default:
      return convertVault(files);
  }
}

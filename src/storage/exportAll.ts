/**
 * Export and import the whole vault (MASTER_PLAN v3, T47).
 *
 * The notes live in the browser's private file system, invisible to the
 * user; until now there was no way to get all of them out. Export writes
 * every note and attachment, with its folder path, to a .zip or to a real
 * folder (File System Access API). Import reads a .zip or a folder —
 * Lumen's own export, an Obsidian vault, or a Notion export — into a new
 * folder of the vault, so nothing existing is overwritten.
 */

import { unzip, zip } from "./zip";
import { createDirectoryHandleBackend } from "./vault";
import {
  createWorkspaceFolder,
  listWorkspace,
  readWorkspaceBlob,
  uniqueWorkspaceName,
  workspaceHasEntry,
  writeWorkspaceBlob,
  writeWorkspaceFile,
} from "./workspace";

export interface ExportedFile {
  path: string;
  data: Uint8Array;
}

/** Every note and attachment of the vault (dot folders — trash, app data — excluded). */
export async function collectVault(): Promise<ExportedFile[]> {
  const list = await listWorkspace({ includeAssets: true });
  const out: ExportedFile[] = [];
  for (const f of list) {
    const blob = await readWorkspaceBlob(f.path);
    out.push({ path: f.path, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/** The vault as one .zip (paths kept). */
export async function exportVaultZip(): Promise<{ bytes: Uint8Array; files: number }> {
  const files = await collectVault();
  return { bytes: await zip(files.map((f) => ({ name: f.path, data: f.data }))), files: files.length };
}

/**
 * Write the vault into a real folder the user picked — inside a new
 * subfolder (`lumen-vault-<date>`, numbered when taken), so files already
 * in the picked folder are never overwritten. The picked folder is written
 * through the same directory-handle vault backend as OPFS.
 */
export async function exportVaultToFolder(dir: FileSystemDirectoryHandle, name = `lumen-vault-${new Date().toISOString().slice(0, 10)}`): Promise<{ files: number; folder: string }> {
  const target = createDirectoryHandleBackend({ id: "export-folder", root: async () => dir });
  let folder = name;
  for (let n = 2; await target.stat(folder); n++) folder = `${name} ${n}`;
  await target.mkdir(folder);
  const files = await collectVault();
  for (const f of files) await target.write(`${folder}/${f.path}`, f.data);
  return { files: files.length, folder };
}

/* ─── Import ─────────────────────────────────────────────────────────── */

export type ImportSource = "lumen" | "obsidian" | "notion" | "folder";

export interface ImportReport {
  source: ImportSource;
  folder: string;
  notes: number;
  attachments: number;
  skipped: string[];
}

const NOTION_ID = /\s[0-9a-f]{32}(?=(\.[a-z0-9]+)?$)/i;
const SKIP = /(^|\/)(\.obsidian|\.trash|\.git|__MACOSX|\.DS_Store)(\/|$)/;

/** Which tool wrote this set of files. */
export function detectSource(paths: string[]): ImportSource {
  if (paths.some((p) => /(^|\/)\.obsidian\//.test(p))) return "obsidian";
  const notionish = paths.filter((p) => NOTION_ID.test(p.split("/").pop() ?? "") || p.split("/").some((seg) => NOTION_ID.test(seg)));
  if (notionish.length && notionish.length >= paths.length / 2) return "notion";
  return "lumen";
}

/** "Page 1a2b…32hex.md" → "Page.md", in every path segment. */
export function stripNotionIds(path: string): string {
  return path
    .split("/")
    .map((seg) => seg.replace(NOTION_ID, ""))
    .join("/");
}

/** Split `href` into its path and its `?query` / `#fragment` suffix. */
function splitSuffix(href: string): [string, string] {
  const cut = href.search(/[?#]/);
  return cut < 0 ? [href, ""] : [href.slice(0, cut), href.slice(cut)];
}

function resolveRel(fromDir: string, rel: string): string {
  const out: string[] = [];
  for (const p of [...(fromDir ? fromDir.split("/") : []), ...rel.split("/")]) {
    if (!p || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function relativeTo(fromDir: string, to: string): string {
  const a = fromDir ? fromDir.split("/") : [];
  const b = to.split("/");
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

const dirOf = (p: string) => p.split("/").slice(0, -1).join("/");

/**
 * Notion links are relative, URL-encoded paths that carry the IDs:
 * `[Page](Sub%201a2b…%20.md)`. Rewrite them to the cleaned names, keeping a
 * `#heading` / `?query` suffix. With `from` (the note's archive path) and
 * `finalOf` (archive path → imported path), a link follows its page even
 * when a same-titled page made the import rename it (`Page 2.md`).
 */
export function rewriteNotionLinks(md: string, ctx?: { from: string; finalOf: (archivePath: string) => string | undefined }): string {
  return md.replace(/\]\(([^)\s]+)\)/g, (m, href: string) => {
    if (/^[a-z]+:/i.test(href) || href.startsWith("#")) return m;
    const [path, suffix] = splitSuffix(href);
    let decoded = path;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      return m;
    }
    const final = ctx?.finalOf(resolveRel(dirOf(ctx.from), decoded));
    const self = ctx?.finalOf(ctx.from);
    const cleaned = final !== undefined && self !== undefined ? relativeTo(dirOf(self), final) : stripNotionIds(decoded);
    return cleaned === decoded ? m : `](${encodeURI(cleaned)}${suffix})`;
  });
}

/**
 * The archive's own top folder ("MyVault/…", "Export-…/…"): the first path
 * segment, when every path shares it. Only that wrapper — a deeper folder
 * all the notes happen to share (`Vault/Projects/`) is real structure.
 */
function wrapperRoot(paths: string[]): string {
  const first = paths[0]?.split("/") ?? [];
  if (first.length < 2) return "";
  const top = first[0] + "/";
  return paths.every((p) => p.startsWith(top)) ? top : "";
}

/**
 * Import files into `Imported/<name>/` (a free name), never over existing
 * notes. `files` maps archive path → bytes.
 */
export async function importFiles(files: Map<string, Uint8Array>, name: string): Promise<ImportReport> {
  const paths = [...files.keys()];
  const source = detectSource(paths);
  const base = name.replace(/\.zip$/i, "");
  // Drop the archive's own top folder ("MyVault/…", "Export-…/…") but never
  // a real folder of a Lumen export that happens to be the only one.
  const common = wrapperRoot(paths.filter((p) => !SKIP.test(p)));
  const root = common && (source !== "lumen" || common === `${base}/`) ? common : "";
  let folder = `Imported/${base.replace(/[/\\]/g, "_") || "import"}`;
  if (await workspaceHasEntry(folder)) {
    let n = 2;
    while (await workspaceHasEntry(`${folder} ${n}`)) n++;
    folder = `${folder} ${n}`;
  }
  await createWorkspaceFolder(folder);
  const report: ImportReport = { source, folder, notes: 0, attachments: 0, skipped: [] };
  // First pass: where every file goes. Two Notion pages with the same title
  // (different IDs) clean to the same name; the later one gets "Page 2.md",
  // and links to it must follow (archive path → final path).
  const finalOf = new Map<string, string>();
  const taken = new Set<string>();
  for (const path of files.keys()) {
    if (SKIP.test(path)) continue;
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    let target = source === "notion" ? stripNotionIds(rel) : rel;
    if (taken.has(target)) {
      const ext = target.match(/\.[^./]+$/)?.[0] ?? "";
      const stem = target.slice(0, target.length - ext.length);
      let n = 2;
      while (taken.has(`${stem} ${n}${ext}`)) n++;
      target = `${stem} ${n}${ext}`;
    }
    taken.add(target);
    finalOf.set(rel, target);
  }
  const dec = new TextDecoder();
  for (const [path, data] of files) {
    if (SKIP.test(path)) {
      report.skipped.push(path);
      continue;
    }
    const rel = path.startsWith(root) ? path.slice(root.length) : path;
    let target = `${folder}/${finalOf.get(rel) ?? rel}`;
    if (await workspaceHasEntry(target)) target = await uniqueWorkspaceName(target);
    if (/\.(md|markdown|txt)$/i.test(rel)) {
      let text = dec.decode(data);
      if (source === "notion") text = rewriteNotionLinks(text, { from: rel, finalOf: (p) => finalOf.get(p) });
      await writeWorkspaceFile(target, text);
      report.notes++;
    } else {
      await writeWorkspaceBlob(target, new Blob([data as unknown as BlobPart]));
      report.attachments++;
    }
  }
  return report;
}

/** Import a .zip archive (Lumen, Obsidian or Notion export). */
export async function importZip(buffer: ArrayBuffer, name: string): Promise<ImportReport> {
  return importFiles(await unzip(buffer), name);
}

/** Import files picked with `<input webkitdirectory>` (paths in webkitRelativePath). */
export async function importFileList(list: ArrayLike<File>): Promise<ImportReport> {
  const files = new Map<string, Uint8Array>();
  let name = "folder";
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    name = rel.split("/")[0] || name;
    files.set(rel, new Uint8Array(await f.arrayBuffer()));
  }
  return importFiles(files, name);
}

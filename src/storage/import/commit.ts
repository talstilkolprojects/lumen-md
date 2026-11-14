/**
 * The import wizard's two steps against the vault (plan W1.26):
 *
 *  1. `prepareImport` reads the picked files, converts them and counts the
 *     links — nothing is written yet, so the wizard can show what will
 *     come in and what will not.
 *  2. `commitImport` writes it all into a new folder (`Imported/<name>`,
 *     numbered when taken) — never over an existing note — and returns the
 *     report and an undo record.
 *
 * `undoImport` removes exactly what the import created: the folder, and
 * `Imported/` when the import made it. If the person changed something in
 * the folder since, the folder goes to the trash instead (nothing of
 * theirs is deleted for good).
 */
import { createWorkspaceFolder, deleteWorkspaceFile, listWorkspace, listWorkspaceTree, readWorkspaceBlob, workspaceHasEntry, writeWorkspaceBlob, writeWorkspaceFile } from "../workspace";
import { moveToTrash } from "../trash";
import { convertExport, detectImportSource, expandArchives, stripWrapper } from "./convert";
import { linkStats } from "./links";
import { safeName } from "./names";
import type { ConvertedVault, ImportReport, ImportSourceId, LinkStats } from "./types";

export const IMPORT_ROOT = "Imported";
const UNDO_KEY = "lumen-last-import";

export interface PreparedImport {
  source: ImportSourceId;
  detected: ImportSourceId;
  name: string;
  folder: string;
  vault: ConvertedVault;
  links: LinkStats;
}

export interface UndoRecord {
  folder: string;
  /** `Imported/` did not exist before this import. */
  createdRoot: boolean;
  /** SHA-256 per file written (path inside the folder → hex), to see if anything changed since. */
  digests: Record<string, string>;
  at: number;
}

async function sha256(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const d = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** The free folder for an import called `name`. */
export async function importFolderFor(name: string): Promise<string> {
  const base = `${IMPORT_ROOT}/${safeName(name.replace(/\.(zip|bearbk|enex|mht|mhtml|json)$/i, ""), "import")}`;
  if (!(await workspaceHasEntry(base))) return base;
  let n = 2;
  while (await workspaceHasEntry(`${base} ${n}`)) n++;
  return `${base} ${n}`;
}

/** Files picked in the browser (one archive, several files, or a folder via webkitdirectory) → archive path → bytes. */
export async function readPicked(list: ArrayLike<File>): Promise<{ files: Map<string, Uint8Array>; name: string }> {
  const files = new Map<string, Uint8Array>();
  let name = "";
  for (const f of Array.from(list)) {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
    if (!name) name = rel.includes("/") ? rel.split("/")[0] : f.name;
    files.set(rel, new Uint8Array(await f.arrayBuffer()));
  }
  return { files, name: name || "import" };
}

/** Convert without writing. `source` null: detect it. */
export async function prepareImport(picked: Map<string, Uint8Array>, name: string, source: ImportSourceId | null): Promise<PreparedImport> {
  const opened = stripWrapper(await expandArchives(picked));
  const junk = [...opened.keys()].filter((p) => /(^|\/)__MACOSX(\/|$)|(^|\/)\.DS_Store$/.test(p));
  for (const p of junk) opened.delete(p);
  const detected = detectImportSource([...opened.keys()]);
  const chosen = source ?? detected;
  const folder = await importFolderFor(name);
  const vault = convertExport(chosen, opened, folder);
  for (const p of junk) vault.skipped.push({ path: p, reason: "appFolder" });
  return { source: chosen, detected, name, folder, vault, links: linkStats(vault) };
}

/** Write a prepared import into its folder. */
export async function commitImport(prep: PreparedImport, now = Date.now()): Promise<{ report: ImportReport; undo: UndoRecord }> {
  // The folder was free when prepared; take the next one if something appeared there since.
  const folder = (await workspaceHasEntry(prep.folder)) ? await importFolderFor(prep.name) : prep.folder;
  const createdRoot = !(await workspaceHasEntry(IMPORT_ROOT));
  await createWorkspaceFolder(folder);
  const digests: Record<string, string> = {};
  const undo: UndoRecord = { folder, createdRoot, digests, at: now };
  try {
    for (const [path, text] of prep.vault.notes) {
      await writeWorkspaceFile(`${folder}/${path}`, text);
      digests[path] = await sha256(text);
    }
    for (const [path, data] of prep.vault.attachments) {
      await writeWorkspaceBlob(`${folder}/${path}`, new Blob([data as unknown as BlobPart]));
      digests[path] = await sha256(data);
    }
  } catch (e) {
    // Half an import is worse than none: take back what was written.
    await undoImport(undo, { force: true }).catch(() => undefined);
    throw e;
  }
  const written = new Set((await listWorkspace({ includeAssets: true })).map((f) => f.path));
  const lost = [...prep.vault.attachments.keys()].filter((p) => !written.has(`${folder}/${p}`)).length;
  const report: ImportReport = {
    source: prep.source,
    folder,
    notes: [...prep.vault.notes.keys()].filter((p) => !p.endsWith(".base")).length,
    attachments: prep.vault.attachments.size,
    bases: [...prep.vault.notes.keys()].filter((p) => p.endsWith(".base")).length,
    skipped: prep.vault.skipped,
    warnings: prep.vault.warnings,
    links: prep.links,
    attachmentsLost: Math.max(lost, prep.vault.sourceAttachments - prep.vault.attachments.size, 0),
    at: now,
  };
  saveUndo(undo);
  return { report, undo };
}

/** Write one more note into the import's folder (the saved report) — undo takes it back too. Returns its vault path. */
export async function addToImport(u: UndoRecord, name: string, text: string): Promise<string> {
  const taken = new Set(Object.keys(u.digests).map((p) => p.toLowerCase()));
  const ext = name.match(/\.[^.]+$/)?.[0] ?? "";
  let rel = name;
  for (let n = 2; taken.has(rel.toLowerCase()) || (await workspaceHasEntry(`${u.folder}/${rel}`)); n++) rel = `${name.slice(0, name.length - ext.length)} ${n}${ext}`;
  await writeWorkspaceFile(`${u.folder}/${rel}`, text);
  u.digests[rel] = await sha256(text);
  const cur = lastImport();
  if (!cur || (cur.folder === u.folder && cur.at === u.at)) saveUndo(u);
  return `${u.folder}/${rel}`;
}

export function saveUndo(u: UndoRecord): void {
  try {
    localStorage.setItem(UNDO_KEY, JSON.stringify(u));
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* private mode: undo still works while the wizard is open */
  }
}

export function lastImport(): UndoRecord | null {
  try {
    const raw = localStorage.getItem(UNDO_KEY);
    const u = raw ? (JSON.parse(raw) as UndoRecord) : null;
    return u && typeof u.folder === "string" && u.folder.startsWith(`${IMPORT_ROOT}/`) && u.digests && typeof u.digests === "object" ? u : null;
  } catch {
    return null;
  }
}

/** Did anything in the import's folder change since it was written (edited, added, removed)? */
export async function importChanged(u: UndoRecord): Promise<boolean> {
  const now = (await listWorkspace({ includeAssets: true })).filter((f) => f.path.startsWith(`${u.folder}/`));
  if (now.length !== Object.keys(u.digests).length) return true;
  for (const f of now) {
    const rel = f.path.slice(u.folder.length + 1);
    const want = u.digests[rel];
    if (!want) return true;
    if ((await sha256(new Uint8Array(await (await readWorkspaceBlob(f.path)).arrayBuffer()))) !== want) return true;
  }
  return false;
}

export type UndoResult = "removed" | "trashed" | "gone";

/**
 * Take an import back. Unchanged: deleted (the vault is as it was before).
 * Changed since: moved to the trash, unless `force`.
 */
export async function undoImport(u: UndoRecord, opts: { force?: boolean } = {}): Promise<UndoResult> {
  if (!u.folder.startsWith(`${IMPORT_ROOT}/`) || !(await workspaceHasEntry(u.folder))) {
    clearUndo(u);
    return "gone";
  }
  let result: UndoResult = "removed";
  if (!opts.force && (await importChanged(u))) {
    await moveToTrash([u.folder], { [u.folder]: "directory" });
    result = "trashed";
  } else await deleteWorkspaceFile(u.folder);
  if (u.createdRoot && (await workspaceHasEntry(IMPORT_ROOT))) {
    const left = (await listWorkspace({ includeAssets: true })).some((f) => f.path.startsWith(`${IMPORT_ROOT}/`));
    if (!left && (await isEmptyFolder(IMPORT_ROOT))) await deleteWorkspaceFile(IMPORT_ROOT);
  }
  clearUndo(u);
  return result;
}

async function isEmptyFolder(path: string): Promise<boolean> {
  const tree = await listWorkspaceTree();
  const node = tree.find((n) => n.path === path);
  return !node || !node.children || node.children.length === 0;
}

function clearUndo(u: UndoRecord): void {
  try {
    const cur = lastImport();
    if (cur && cur.folder === u.folder && cur.at === u.at) localStorage.removeItem(UNDO_KEY);
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* nothing stored */
  }
}

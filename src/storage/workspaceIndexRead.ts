/**
 * The workspace index's reads of the vault — one note, the listing, the
 * vault's id — and its diff of a listing against the index (plan W6.25:
 * moved out of workspaceIndex.ts unchanged).
 */
import { isAssetName, listWorkspace, readWorkspaceFile, type WorkspaceEntry, type WorkspaceNode } from "./workspace";
import { getVaultBackend, unwrapVaultBackend, vaultEncryptionReady, VaultNotFoundError } from "./vault";
import type { IndexInput } from "./vaultIndexCore";
import type { IndexEngine } from "./vaultIndexProtocol";
import { sameNote, utf8Length } from "./indexSnapshot";
import { summarize } from "./noteSummary";
import { cache, type ReadNote } from "./workspaceIndexState";

/** Notes sent to the worker per message while building. */
export const UPSERT_BATCH = 500;

function toInput(r: ReadNote): IndexInput {
  return { path: r.file.path, name: r.file.name, content: r.content, modified: r.file.modified };
}

export async function upsertAll(e: IndexEngine, notes: ReadNote[]): Promise<void> {
  for (let i = 0; i < notes.length; i += UPSERT_BATCH) await e.upsert(notes.slice(i, i + UPSERT_BATCH).map(toInput));
}

// ── Reading notes ───────────────────────────────────────────────────────

/** When the vault says `path` last changed (now, if it cannot tell). */
async function mtimeOf(path: string): Promise<number> {
  try {
    return (await getVaultBackend().stat(path))?.mtime || Date.now();
  } catch {
    return Date.now();
  }
}

/**
 * Read one file into an index entry, or null if unreadable. `modified`
 * null (a save announced by an event): ask the vault, so the next listing
 * check does not take the note for changed again.
 */
export async function indexFile(e: { path: string; name: string; modified: number | null }): Promise<ReadNote | null> {
  try {
    // The mtime before the read: a write landing in between then looks
    // newer than what was read, and the next listing check reads it again.
    const modified = e.modified ?? (await mtimeOf(e.path));
    const content = await readWorkspaceFile(e.path);
    return { file: { path: e.path, name: e.name, modified, size: utf8Length(content), ...summarize(content) }, content };
  } catch {
    return null;
  }
}

/** Run `fn` over `items` with at most `limit` in flight (a 10k vault must not open 10k reads at once). */
export async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  });
  await Promise.all(workers);
}

export const nameOf = (path: string) => path.split("/").pop() ?? path;

/** Hidden from the tree, search and the index: dot entries at any depth (T46) and pasted assets. */
export function indexable(path: string): boolean {
  return !!path && !path.split("/").some((s) => s.startsWith(".")) && !isAssetName(path);
}

function flatten(nodes: WorkspaceNode[], out: WorkspaceEntry[] = []): WorkspaceEntry[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push({ path: n.path, name: n.name, size: n.size ?? 0, modified: n.modified ?? 0 });
    else if (n.children) flatten(n.children, out);
  }
  return out;
}

/**
 * The vault's notes. After a structural event (`reuseTree`), the file
 * tree's listing of that same change, when it has one; it is used once.
 * Otherwise — the first build, the timed check for changes nobody
 * announced (another tab) — a fresh listing: a cached one would hide them.
 */
export async function listNotes(reuseTree: boolean): Promise<WorkspaceEntry[]> {
  const l = cache.listing;
  cache.listing = null;
  const list =
    reuseTree && l && l.generation === cache.generation ? flatten(l.tree) : await listWorkspace({ includeAssets: false });
  return list.filter((e) => !isAssetName(e.path));
}

/** Where a vault keeps its own random id (Y2): in its `.lumen` app data, hidden from the index and the tree. */
export const VAULT_ID_PATH = ".lumen/vault-id";
const recordIds = new WeakMap<object, string>();

/**
 * Review 19 Y2 / R1: the key the vault's snapshot record is filed under,
 * stable across sessions: `<kind>:<random id>`, the id read from
 * VAULT_ID_PATH, or made and written there the first time. Where it can't be
 * read or written (a read-only folder, an I/O error), the kind alone, as
 * before; that case is not remembered, so the next build tries again.
 */
export async function recordVault(): Promise<string> {
  const backend = getVaultBackend();
  const inner = unwrapVaultBackend(backend);
  const known = recordIds.get(inner);
  if (known) return known;
  const ok = (id: string) => {
    const key = `${inner.id}:${id}`;
    recordIds.set(inner, key);
    return key;
  };
  try {
    const id = (await backend.readText(VAULT_ID_PATH)).trim();
    if (/^[0-9a-f-]{36}$/.test(id)) return ok(id);
  } catch (err) {
    if (!(err instanceof VaultNotFoundError)) return inner.id;
  }
  try {
    const id = crypto.randomUUID();
    await backend.write(VAULT_ID_PATH, `${id}\n`);
    return ok(id);
  } catch {
    return inner.id;
  }
}

/** Whether the vault the index is about to be filled from is encrypted (or can't tell): its notes are never saved in the clear. */
export async function fillingEncrypted(): Promise<boolean> {
  try {
    if (!getVaultBackend().available()) return true;
    return (await vaultEncryptionReady()) !== "none";
  } catch {
    return true;
  }
}

/** Every indexed path at or under `path` (a deleted / moved folder takes its notes with it). */
export function under(path: string): string[] {
  if (cache.byPath.has(path)) return [path];
  const prefix = path + "/";
  return [...cache.byPath.keys()].filter((p) => p.startsWith(prefix));
}

export type IndexOp = { kind: "remove"; path: string } | { kind: "move"; from: string; to: string; name: string };
export type ToRead = { path: string; name: string; modified: number | null };

/** A fresh listing against the index: notes gone are dropped (in `cache.byPath` and as `indexOps`), notes new or with another mtime go to `toRead`. */
export function diffListing(list: WorkspaceEntry[], indexOps: IndexOp[], toRead: Map<string, ToRead>): void {
  const seen = new Set(list.map((e) => e.path));
  for (const path of [...cache.byPath.keys()]) {
    if (!seen.has(path)) {
      cache.byPath.delete(path);
      indexOps.push({ kind: "remove", path });
    }
  }
  // S3: a note is unchanged only with the same mtime and, when both are known, the same size.
  for (const e of list) {
    const f = cache.byPath.get(e.path);
    if (!f || !sameNote(f, e)) toRead.set(e.path, e);
  }
}

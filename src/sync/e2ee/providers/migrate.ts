/**
 * Migration of plain-text notes at a provider to the encrypted vault
 * (plan 3.5.6). An earlier Lumen synced notes as readable files into
 * Dropbox (`/Apps/Lumen`) or Google Drive (the "Lumen" folder). Encrypted
 * sync stores only ciphertext, so those files must come home:
 *
 *   1. every plain-text file is read from the provider and written into the
 *      local vault — a note already here with other text is kept, the
 *      provider's copy lands next to it as "name (from Dropbox).md";
 *   2. nothing is deleted at the provider: the files are moved aside into
 *      `lumen-plaintext-backup-<date>/` (the backup), and what was moved is
 *      recorded locally;
 *   3. the next encrypted sync uploads the notes as ciphertext.
 *
 * `revertPlaintextMigration` moves the files back where they were. Readable
 * copies then exist again at the provider — that is the point of reverting.
 */

import type { LegacyCloudStore } from "../../cloud";
import type { LocalFiles } from "../localFiles";
import { isSyncedPath } from "../localFiles";

export interface MigrationRecord {
  provider: string;
  startedAt: number;
  finishedAt: number | null;
  backupFolder: string;
  /** Files moved aside: original path → path inside the backup folder. */
  moved: Array<{ from: string; to: string }>;
  /** Notes written into the vault: provider path → vault path. */
  imported: Array<{ from: string; to: string }>;
}

export interface MigrationPlan {
  /** Plain-text files found at the provider. */
  files: Array<{ path: string; size: number }>;
  /** Of those, notes whose vault copy differs (they will be imported next to it). */
  clashes: string[];
}

const RECORD_KEY = (provider: string) => `lumen-sync-migration-${provider}`;

interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
}
let kv: KV | null = null;
async function store(): Promise<KV> {
  if (kv) return kv;
  const { get, set, del } = await import("idb-keyval");
  return (kv = { get: (k) => get(k), set: (k, v) => set(k, v), del: (k) => del(k) });
}
/** @internal tests */
export function __setMigrationStore(s: KV | null): void {
  kv = s;
}

export async function loadMigrationRecord(provider: string): Promise<MigrationRecord | null> {
  return (await (await store()).get<MigrationRecord>(RECORD_KEY(provider))) ?? null;
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const BACKUP_PREFIX = "lumen-plaintext-backup-";

/** What a migration would do: the plain-text files at the provider, and which notes clash with local ones. */
export async function planPlaintextMigration(provider: LegacyCloudStore, local: LocalFiles): Promise<MigrationPlan> {
  const all = (await provider.listFiles()).filter((f) => !f.path.startsWith(BACKUP_PREFIX) && isSyncedPath(f.path));
  const clashes: string[] = [];
  for (const f of all) {
    const mine = await local.read(f.path);
    if (!mine) continue;
    const theirs = await provider.readFile(f.path);
    if (!same(mine, theirs)) clashes.push(f.path);
  }
  return { files: all.map((f) => ({ path: f.path, size: f.size })), clashes };
}

/** `notes/a.md` → `notes/a (from Dropbox).md` (numbered if taken). */
async function sideName(local: LocalFiles, path: string, label: string): Promise<string> {
  const m = /^(.*?)(\.[^./]+)?$/.exec(path)!;
  for (let n = 1; n < 1000; n++) {
    const candidate = `${m[1]} (${label}${n > 1 ? ` ${n}` : ""})${m[2] ?? ""}`;
    if (!(await local.read(candidate))) return candidate;
  }
  throw new Error(`No free name for ${path}`);
}

/**
 * Run the migration (see the module comment). Resumable: a record with
 * `finishedAt: null` continues where it stopped — files already moved aside
 * are not read again from their old place.
 */
export async function migratePlaintext(
  provider: LegacyCloudStore,
  local: LocalFiles,
  opts: { label?: string; now?: () => number; onProgress?: (done: number, total: number) => void } = {},
): Promise<MigrationRecord> {
  const now = opts.now ?? Date.now;
  const s = await store();
  const existing = await loadMigrationRecord(provider.name);
  const record: MigrationRecord =
    existing && !existing.finishedAt
      ? existing
      : {
          provider: provider.name,
          startedAt: now(),
          finishedAt: null,
          backupFolder: `${BACKUP_PREFIX}${new Date(now()).toISOString().slice(0, 19).replace(/[:T]/g, "-")}`,
          moved: [],
          imported: [],
        };
  await s.set(RECORD_KEY(provider.name), record);
  const label = opts.label ?? `from ${provider.name === "gdrive" ? "Google Drive" : provider.name === "dropbox" ? "Dropbox" : provider.name}`;
  const files = (await provider.listFiles()).filter((f) => !f.path.startsWith(BACKUP_PREFIX) && isSyncedPath(f.path));
  let done = 0;
  for (const f of files) {
    const data = await provider.readFile(f.path);
    const mine = await local.read(f.path);
    let target = f.path;
    // Imported before an interrupted run stopped (it never got moved aside): not again.
    const already = record.imported.some((i) => i.from === f.path);
    if (!already && mine && !same(mine, data)) target = await sideName(local, f.path, label);
    if (!already && (!mine || target !== f.path)) {
      // Create-only: a note that appeared meanwhile is never overwritten.
      if (!(await local.write(target, data, null))) throw new Error(`"${target}" changed during the migration; run it again`);
      record.imported.push({ from: f.path, to: target });
    }
    // Aside into the backup folder: the note is never deleted at the provider.
    const to = `${record.backupFolder}/${f.path}`;
    await provider.moveFile(f.path, to);
    record.moved.push({ from: f.path, to });
    await s.set(RECORD_KEY(provider.name), record);
    opts.onProgress?.(++done, files.length);
  }
  record.finishedAt = now();
  await s.set(RECORD_KEY(provider.name), record);
  return record;
}

/** Undo the backup step: every file moved aside goes back to where it was (vault copies stay). */
export async function revertPlaintextMigration(provider: LegacyCloudStore): Promise<number> {
  const s = await store();
  const record = await loadMigrationRecord(provider.name);
  if (!record) return 0;
  let n = 0;
  for (const m of [...record.moved]) {
    await provider.moveFile(m.to, m.from);
    record.moved = record.moved.filter((x) => x !== m);
    await s.set(RECORD_KEY(provider.name), record);
    n++;
  }
  await s.del(RECORD_KEY(provider.name));
  return n;
}

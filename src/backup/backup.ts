/**
 * Backups to a second place, with a restore you can rely on (plan W1.6).
 *
 * The history (plan 3.2) lives in the same browser storage as the vault, so
 * it doesn't survive losing that disk. A backup is an archive on another
 * drive, folder or server (`BackupTarget`):
 *
 *   lumen-backup-<UTC time>.tar         a plain tar (mirror mode)
 *   lumen-backup-<UTC time>.tar.age     the same tar, encrypted with age to
 *                                       the backup key (plan W1.7)
 *
 * The first entry, `.lumen-backup.json`, lists every file with its size and
 * SHA-256; a restore checks each file against it and refuses a damaged
 * archive. Both formats open without Lumen:
 * `age -d -i backup-key.txt file.tar.age | tar x`.
 *
 * Kept: the newest backup of each of the last 7 days, 4 weeks and 6 months
 * (./rotation.ts). A backup is never written into the vault (the archives
 * would sync and fill the history), and a target inside the vault folder is
 * refused (`targetInsideVault`).
 */

import { ageDecrypt, ageEncrypt } from "../sync/e2ee/age";
import type { SyncProvider } from "../sync/e2ee/provider";
import type { VaultBackend } from "../storage/vault/types";
import { selectKept, type Snapshot } from "./rotation";
import { readTar, writeTar, type TarEntry } from "./tar";

export const BACKUP_DIR = "Lumen backups";
export const MANIFEST_ENTRY = ".lumen-backup.json";
export const BACKUP_FORMAT = "lumen-backup/1";
const NAME = /^lumen-backup-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})Z\.tar(\.age)?$/;

/** Where backups go: a folder of archives. */
export interface BackupTarget {
  readonly id: string;
  readonly label: string;
  /** Names of the archives there (other files are ignored). */
  list(): Promise<string[]>;
  read(name: string): Promise<Uint8Array>;
  write(name: string, data: Uint8Array): Promise<void>;
  remove(name: string): Promise<void>;
}

export type BackupMode = { kind: "plain" } | { kind: "age"; recipient: string };

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  at: number;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export class BackupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BackupError";
  }
}

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function sha256(data: Uint8Array): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new Uint8Array(data)));
}

/* ─── Targets ──────────────────────────────────────────────────────────── */

/** A folder (one the user picked, an external drive, a desktop path) through the vault layer's backends. */
export function backendTarget(backend: VaultBackend, label: string, dir = BACKUP_DIR): BackupTarget {
  const at = (name: string) => `${dir}/${name}`;
  return {
    id: `${backend.id}:${dir}`,
    label,
    async list() {
      if (!(await backend.stat(dir))) return [];
      return (await backend.list(dir)).filter((e) => e.kind === "file" && NAME.test(e.name)).map((e) => e.name);
    },
    async read(name) {
      return new Uint8Array(await (await backend.read(at(name))).arrayBuffer());
    },
    async write(name, data) {
      await backend.write(at(name), data);
    },
    async remove(name) {
      await backend.remove(at(name));
    },
  };
}

/** A storage provider (WebDAV, S3…) as a backup target, under `prefix`. */
export function providerTarget(provider: SyncProvider, label: string, prefix = "lumen-backups/"): BackupTarget {
  return {
    id: `${provider.id}:${prefix}`,
    label,
    async list() {
      return (await provider.list()).filter((n) => n.startsWith(prefix)).map((n) => n.slice(prefix.length)).filter((n) => NAME.test(n));
    },
    async read(name) {
      const o = await provider.get(prefix + name);
      if (!o) throw new BackupError(`${name} is not at the backup target`);
      return o.data;
    },
    async write(name, data) {
      await provider.put(prefix + name, data);
    },
    async remove(name) {
      await provider.delete(prefix + name);
    },
  };
}

/**
 * Is the picked folder the vault itself, or inside it? Backups must never
 * go there: they would sync, and every later backup would contain the
 * earlier ones.
 */
export async function targetInsideVault(vaultRoot: FileSystemDirectoryHandle | null, target: FileSystemDirectoryHandle): Promise<boolean> {
  if (!vaultRoot) return false;
  if (await vaultRoot.isSameEntry(target)) return true;
  return (await vaultRoot.resolve(target)) !== null;
}

/** The same check for desktop paths. */
export function pathInsideVault(vaultPath: string, targetPath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const v = norm(vaultPath);
  const t = norm(targetPath);
  return t === v || t.startsWith(`${v}/`);
}

/* ─── Names ────────────────────────────────────────────────────────────── */

export function archiveName(at: number, encrypted: boolean): string {
  const iso = new Date(at).toISOString().replace(/\.\d{3}Z$/, "Z").replace(/:/g, "-");
  return `lumen-backup-${iso}.tar${encrypted ? ".age" : ""}`;
}

export function archiveTime(name: string): number | null {
  const m = NAME.exec(name);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
}

export async function listBackups(target: BackupTarget): Promise<Array<Snapshot & { encrypted: boolean }>> {
  return (await target.list())
    .map((name) => ({ name, at: archiveTime(name) ?? 0, encrypted: name.endsWith(".age") }))
    .sort((a, b) => b.at - a.at);
}

/* ─── Backing up ───────────────────────────────────────────────────────── */

/** Paths a backup leaves out: git internals and the trash (they are not notes). */
export const skipPath = (p: string) => p === ".git" || p.startsWith(".git/") || p === ".trash" || p.startsWith(".trash/");

async function walk(vault: VaultBackend, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await vault.list(dir)) {
    if (skipPath(e.path)) continue;
    if (e.kind === "directory") out.push(...(await walk(vault, e.path)));
    else out.push(e.path);
  }
  return out;
}

export interface BackupResult {
  name: string;
  files: number;
  bytes: number;
  pruned: string[];
}

export async function runBackup(o: { vault: VaultBackend; target: BackupTarget; mode: BackupMode; now?: () => number }): Promise<BackupResult> {
  const at = (o.now ?? Date.now)();
  const entries: TarEntry[] = [];
  const files: BackupManifest["files"] = [];
  for (const path of await walk(o.vault)) {
    const data = new Uint8Array(await (await o.vault.read(path)).arrayBuffer());
    const st = await o.vault.stat(path);
    entries.push({ path, data, mtime: Math.floor((st?.mtime || at) / 1000) });
    files.push({ path, size: data.length, sha256: await sha256(data) });
  }
  const manifest: BackupManifest = { format: BACKUP_FORMAT, at, files };
  const tar = writeTar([{ path: MANIFEST_ENTRY, data: new TextEncoder().encode(JSON.stringify(manifest, null, 1)), mtime: Math.floor(at / 1000) }, ...entries]);
  const data = o.mode.kind === "age" ? await ageEncrypt(tar, [{ x25519: o.mode.recipient }]) : tar;
  const name = archiveName(at, o.mode.kind === "age");
  await o.target.write(name, data);
  // Read it back: a full or failing drive must fail the backup, not a later restore.
  const back = await o.target.read(name);
  if ((await sha256(back)) !== (await sha256(data))) throw new BackupError("The backup read back differently from what was written");
  const { prune } = selectKept(await listBackups(o.target));
  for (const s of prune) await o.target.remove(s.name);
  return { name, files: files.length, bytes: data.length, pruned: prune.map((s) => s.name) };
}

/* ─── Restoring ────────────────────────────────────────────────────────── */

export interface OpenedBackup {
  manifest: BackupManifest;
  files: Map<string, Uint8Array>;
}

/** Read, decrypt (age identity for `.tar.age`) and check every file of an archive against its manifest. */
export async function openBackup(target: BackupTarget, name: string, identity?: string): Promise<OpenedBackup> {
  let bytes = await target.read(name);
  if (name.endsWith(".age")) {
    if (!identity) throw new BackupError("This backup is encrypted: the backup key is needed");
    bytes = await ageDecrypt(bytes, [{ identity }]);
  }
  const entries = readTar(bytes);
  if (entries[0]?.path !== MANIFEST_ENTRY) throw new BackupError("Not a Lumen backup (no manifest)");
  const manifest = JSON.parse(new TextDecoder().decode(entries[0].data)) as BackupManifest;
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError("Unknown backup format");
  const files = new Map(entries.slice(1).map((e) => [e.path, e.data]));
  for (const f of manifest.files) {
    const d = files.get(f.path);
    if (!d || d.length !== f.size || (await sha256(d)) !== f.sha256) throw new BackupError(`The backup is damaged: ${f.path} does not match its checksum`);
  }
  return { manifest, files };
}

export type RestoreSelection = { all: true } | { file: string } | { folder: string };

function selected(path: string, s: RestoreSelection): boolean {
  if ("all" in s) return true;
  if ("file" in s) return path === s.file;
  const f = s.folder.replace(/\/+$/, "");
  return path === f || path.startsWith(`${f}/`);
}

/** `notes/a.md` → `notes/a (restored 2026-11-10).md`, then ` 2`, ` 3`… while taken. */
async function freeName(into: VaultBackend, path: string, day: string): Promise<string> {
  const slash = path.lastIndexOf("/");
  const dir = path.slice(0, slash + 1);
  const base = path.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let n = 1; ; n++) {
    const p = `${dir}${stem} (restored ${day}${n > 1 ? ` ${n}` : ""})${ext}`;
    if (!(await into.stat(p))) return p;
  }
}

/**
 * Restore files from an archive into `into` (the vault, or a new folder),
 * under `prefix` if given. Nothing is overwritten: a file that is already
 * there is restored next to it, as "<name> (restored <date>)".
 */
export async function restore(o: { target: BackupTarget; name: string; identity?: string; into: VaultBackend; select: RestoreSelection; prefix?: string; now?: () => number }): Promise<{ restored: string[]; renamed: Array<[string, string]> }> {
  const { manifest, files } = await openBackup(o.target, o.name, o.identity);
  const day = new Date((o.now ?? Date.now)()).toISOString().slice(0, 10);
  const prefix = o.prefix ? `${o.prefix.replace(/\/+$/, "")}/` : "";
  const restored: string[] = [];
  const renamed: Array<[string, string]> = [];
  for (const f of manifest.files) {
    if (!selected(f.path, o.select)) continue;
    let dest = prefix + f.path;
    if (await o.into.stat(dest)) {
      const free = await freeName(o.into, dest, day);
      renamed.push([dest, free]);
      dest = free;
    }
    await o.into.write(dest, files.get(f.path)!);
    restored.push(dest);
  }
  if (restored.length === 0 && !("all" in o.select)) throw new BackupError("Nothing in this backup matches");
  return { restored, renamed };
}

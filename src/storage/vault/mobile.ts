/**
 * The vault in a folder on the phone (plan 4.20), for the Capacitor app.
 *
 *   • iOS — the app's Documents folder through the Capacitor Filesystem
 *     plugin. With `UIFileSharingEnabled` and
 *     `LSSupportsOpeningDocumentsInPlace` (ios/App/App/Info.plist) it shows
 *     in the Files app under "On My iPhone › Lumen", so other apps can open
 *     and edit the notes in place.
 *   • Android — a folder the user picks with the Storage Access Framework
 *     (`ACTION_OPEN_DOCUMENT_TREE`, permission kept across restarts), through
 *     Lumen's small native plugin `LumenVaultFolder`
 *     (android/app/src/main/java/com/lumen/editor/, registered in
 *     MainActivity; see mobile/README.md). Without the plugin (or if the user picks nothing), the
 *     app's own folder on the device (Capacitor `Directory.External`).
 *
 * Both are a `MobileFs`: a handful of calls over paths relative to the
 * vault folder. `createMobileBackend` turns one into a `VaultBackend` with
 * the same behaviour as every other backend (the contract suite runs on
 * both, over fakes of the two native APIs). Changes made in the Files app or
 * another app are found by polling sizes and times (plan 4.4,
 * watchExternalChanges), and at once when the app comes back to the front.
 */

// Through the vault barrel (already in the startup bundle), like tauri.ts.
import {
  checkRename,
  compareVaultEntries,
  toBytes,
  VaultEmitter,
  vaultSegments,
  VaultError,
  VaultNotFoundError,
  WorkspaceConflictError,
  type VaultBackend,
  type VaultEntry,
  type VaultEvent,
} from "./index";
import { atomicWrite, hasLeftovers, parseLeftover, recoverDir, saveId, type AtomicFs } from "./atomic";

export interface MobileEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  /** ms since the epoch; 0 when unknown. */
  mtime: number;
}

/** What a phone's file API has to offer the vault. Paths are relative to the vault folder; "" is the folder. */
export interface MobileFs {
  readdir(path: string): Promise<MobileEntry[]>;
  /** null when nothing is there. */
  stat(path: string): Promise<Omit<MobileEntry, "name"> | null>;
  readFile(path: string): Promise<Uint8Array>;
  /** Creates missing parent folders. */
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Creates missing parents; a no-op when it exists. */
  mkdir(path: string): Promise<void>;
  /** Move a file or a folder; the target does not exist (the backend checks). */
  rename(from: string, to: string): Promise<void>;
  /** Delete a file, or a folder with everything in it. */
  remove(path: string): Promise<void>;
}

const join = (parts: string[]) => parts.join("/");

/** The atomic-save steps (./atomic.ts) over a phone folder. */
export function atomicFsOf(fs: MobileFs): AtomicFs {
  return {
    readdir: (dir) => fs.readdir(dir),
    exists: async (path) => !!(await fs.stat(path)),
    writeFile: (path, data) => fs.writeFile(path, data),
    size: async (path) => {
      const s = await fs.stat(path);
      return s && s.type === "file" ? s.size : null;
    },
    rename: (from, to) => fs.rename(from, to),
    remove: (path) => fs.remove(path),
    readFile: (path) => fs.readFile(path),
  };
}

/** A `VaultBackend` over a phone folder. */
export function createMobileBackend(fs: MobileFs, opts: { id?: string; available?: () => boolean } = {}): VaultBackend {
  const events = new VaultEmitter();
  const emit = (e: Omit<VaultEvent, "origin">) => events.emit({ ...e, origin: "self" });
  const afs = atomicFsOf(fs);
  // Saves running now (path → done), and their ids: their temporary files
  // are not leftovers, and a read of the note waits for the save.
  const saving = new Map<string, Promise<void>>();
  const busy = new Set<string>();
  const settled = async (paths: Iterable<string>) => {
    for (const p of [...paths]) await saving.get(p)?.catch(() => undefined);
  };
  const inFolder = (dir: string) => [...saving.keys()].filter((p) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "") === dir);

  /**
   * A save the app did not live to finish leaves hidden files next to the
   * note (./atomic.ts); finish or undo it the first time the folder is
   * looked at, so the note is never missing. Returns the folder's listing.
   */
  // Folders found without leftovers in this session: leftovers come from a
  // run that was stopped (a failed save removes its own), so a missing note
  // costs one listing of its folder at most.
  const clean = new Set<string>();

  async function listRecovered(dir: string, wait = true): Promise<MobileEntry[]> {
    if (wait) await settled(inFolder(dir));
    let entries = await fs.readdir(dir);
    if (hasLeftovers(entries.map((e) => e.name).filter((n) => !busy.has(parseLeftover(n)?.id ?? "")))) {
      await recoverDir(afs, dir, { names: entries.map((e) => e.name), busy });
      entries = await fs.readdir(dir);
    }
    clean.add(dir);
    // A save that started meanwhile: its temporary file is not a note.
    return entries.filter((e) => {
      const l = parseLeftover(e.name);
      return !l || !busy.has(l.id);
    });
  }

  /**
   * stat(), finishing an interrupted save of `p` first when the note is
   * missing. `wait`: let a running save of `p` finish first (not from inside
   * that save).
   */
  async function statRecovered(p: string, wait = true): Promise<Omit<MobileEntry, "name"> | null> {
    if (wait) await settled([p]);
    const s = await fs.stat(p);
    if (s || !p) return s;
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    if (clean.has(dir) || (dir && (await fs.stat(dir))?.type !== "directory")) return null;
    await listRecovered(dir, wait);
    return fs.stat(p);
  }

  /** Every folder from the root down to `parts` must be a folder (or missing). */
  async function checkParents(parts: string[], path: string): Promise<void> {
    for (let i = 1; i < parts.length; i++) {
      const s = await fs.stat(join(parts.slice(0, i)));
      if (!s) return;
      if (s.type !== "directory") throw new VaultError("EKIND", path, `Cannot write "${path}": a file is in the way`);
    }
  }

  return {
    id: opts.id ?? "mobile",
    available: () => (opts.available ? opts.available() : true),

    async list(dir) {
      const parts = vaultSegments(dir);
      const s = await fs.stat(join(parts));
      if (parts.length && (!s || s.type !== "directory")) throw new VaultNotFoundError(dir);
      const out = (await listRecovered(join(parts))).map(
        (e): VaultEntry =>
          e.type === "directory"
            ? { name: e.name, path: join([...parts, e.name]), kind: "directory" }
            : { name: e.name, path: join([...parts, e.name]), kind: "file", size: e.size, mtime: e.mtime },
      );
      return out.sort(compareVaultEntries);
    },

    async stat(path) {
      const parts = vaultSegments(path);
      if (!parts.length) return { kind: "directory", size: 0, mtime: 0 };
      const s = await statRecovered(join(parts));
      if (!s) return null;
      return s.type === "directory" ? { kind: "directory", size: 0, mtime: 0 } : { kind: "file", size: s.size, mtime: s.mtime };
    },

    async read(path) {
      const p = join(vaultSegments(path));
      const s = p ? await statRecovered(p) : null;
      if (!s || s.type !== "file") throw new VaultNotFoundError(path);
      return new Blob([(await fs.readFile(p)) as BlobPart]);
    },

    async readText(path) {
      return new TextDecoder().decode(new Uint8Array(await (await this.read(path)).arrayBuffer()));
    },

    async write(path, data) {
      const parts = vaultSegments(path);
      if (!parts.length) throw new VaultError("EKIND", path, "Cannot write to the vault root");
      const p = join(parts);
      const bytes = await toBytes(data);
      await checkParents(parts, path);
      // One save of a note at a time; each lands whole (./atomic.ts).
      const previous = saving.get(p);
      const id = saveId();
      const run = (async () => {
        await previous?.catch(() => undefined);
        if ((await statRecovered(p, false))?.type === "directory") throw new VaultError("EKIND", path, `Cannot write "${path}": a folder of that name is in the way`);
        busy.add(id);
        try {
          await atomicWrite(afs, p, bytes, id);
        } finally {
          busy.delete(id);
        }
      })();
      saving.set(p, run);
      try {
        await run;
      } finally {
        if (saving.get(p) === run) saving.delete(p);
      }
      emit({ type: "write", path: p });
    },

    async mkdir(path) {
      const parts = vaultSegments(path);
      if (!parts.length) return;
      const p = join(parts);
      await checkParents(parts, path);
      const s = await fs.stat(p);
      if (s?.type === "file") throw new VaultError("EKIND", path, `Cannot create folder "${path}": a file is in the way`);
      if (!s) await fs.mkdir(p);
      emit({ type: "mkdir", path: p });
    },

    async rename(from, to, o = {}) {
      const r = checkRename(from, to);
      if (!r) return;
      const [a, b] = [join(r.src), join(r.dst)];
      await settled([...saving.keys()].filter((k) => k === a || k.startsWith(a + "/") || k === b || k.startsWith(b + "/")));
      if (!(await statRecovered(a))) throw new VaultNotFoundError(from);
      const target = await fs.stat(b);
      if (target && !o.overwrite) throw new WorkspaceConflictError(to);
      await checkParents(r.dst, to);
      const parent = join(r.dst.slice(0, -1));
      if (parent && !(await fs.stat(parent))) await fs.mkdir(parent);
      if (target) await fs.remove(b);
      await fs.rename(a, b);
      emit({ type: "rename", path: b, from: a });
    },

    async remove(path) {
      const parts = vaultSegments(path);
      if (!parts.length) throw new VaultError("EINVAL", path, "Cannot delete the workspace root");
      const p = join(parts);
      await settled([...saving.keys()].filter((k) => k === p || k.startsWith(p + "/")));
      if (!(await statRecovered(p))) throw new VaultNotFoundError(path);
      await fs.remove(p);
      emit({ type: "delete", path: p });
    },

    watch: (listener) => events.on(listener),
    notifyExternal: (event) => events.emit({ ...event, origin: "external" }),
  };
}

// ── The native side ──────────────────────────────────────────────────────

/** The subset of @capacitor/filesystem this needs (the plugin's own API). */
export interface CapacitorFilesystemPlugin {
  readdir(o: { path: string; directory: string }): Promise<{ files: Array<{ name: string; type: "file" | "directory"; size: number; mtime: number }> }>;
  stat(o: { path: string; directory: string }): Promise<{ type: "file" | "directory"; size: number; mtime: number }>;
  readFile(o: { path: string; directory: string }): Promise<{ data: string | Blob }>;
  writeFile(o: { path: string; directory: string; data: string; recursive: boolean }): Promise<unknown>;
  mkdir(o: { path: string; directory: string; recursive: boolean }): Promise<void>;
  rename(o: { from: string; to: string; directory: string; toDirectory: string }): Promise<void>;
  deleteFile(o: { path: string; directory: string }): Promise<void>;
  rmdir(o: { path: string; directory: string; recursive: boolean }): Promise<void>;
}

/** Lumen's Android plugin over a Storage Access Framework tree (android/app/src/main/java/com/lumen/editor/LumenVaultFolderPlugin.java). */
export interface LumenVaultFolderPlugin {
  /** The folder picker; null `uri` when the user cancelled. Keeps the read/write permission. */
  pickFolder(): Promise<{ uri: string | null; name: string }>;
  /** Is the permission for `uri` still held (it can be revoked in the system settings)? */
  hasAccess(o: { uri: string }): Promise<{ granted: boolean }>;
  readdir(o: { uri: string; path: string }): Promise<{ files: MobileEntry[] }>;
  stat(o: { uri: string; path: string }): Promise<{ exists: boolean; type?: "file" | "directory"; size?: number; mtime?: number }>;
  /** base64 */
  readFile(o: { uri: string; path: string }): Promise<{ data: string }>;
  writeFile(o: { uri: string; path: string; data: string }): Promise<void>;
  mkdir(o: { uri: string; path: string }): Promise<void>;
  rename(o: { uri: string; from: string; to: string }): Promise<void>;
  remove(o: { uri: string; path: string }): Promise<void>;
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** "Does not exist" from either platform's Filesystem plugin. */
const isMissing = (e: unknown) => /not exist|no such file|not found|ENOENT/i.test(e instanceof Error ? e.message : String(e));

/** Capacitor Filesystem in `directory` ("DOCUMENTS" on iOS, "EXTERNAL" for the Android app folder). */
export function capacitorFs(plugin: CapacitorFilesystemPlugin, directory: string): MobileFs {
  const at = (path: string) => ({ path: path || "", directory });
  return {
    async readdir(path) {
      const r = await plugin.readdir(at(path));
      return r.files.map((f) => ({ name: f.name, type: f.type, size: f.type === "file" ? f.size : 0, mtime: Number(f.mtime) || 0 }));
    },
    async stat(path) {
      try {
        const s = await plugin.stat(at(path));
        return { type: s.type, size: s.type === "file" ? s.size : 0, mtime: Number(s.mtime) || 0 };
      } catch (e) {
        if (isMissing(e)) return null;
        throw e;
      }
    },
    async readFile(path) {
      const { data } = await plugin.readFile(at(path));
      return typeof data === "string" ? fromBase64(data) : new Uint8Array(await data.arrayBuffer());
    },
    async writeFile(path, data) {
      await plugin.writeFile({ ...at(path), data: toBase64(data), recursive: true });
    },
    mkdir: (path) => plugin.mkdir({ ...at(path), recursive: true }),
    rename: (from, to) => plugin.rename({ from, to, directory, toDirectory: directory }),
    async remove(path) {
      const s = await plugin.stat(at(path));
      if (s.type === "directory") await plugin.rmdir({ ...at(path), recursive: true });
      else await plugin.deleteFile(at(path));
    },
  };
}

/** The Android plugin over the tree `uri`. */
export function safFs(plugin: LumenVaultFolderPlugin, uri: string): MobileFs {
  return {
    readdir: async (path) => (await plugin.readdir({ uri, path })).files,
    async stat(path) {
      const s = await plugin.stat({ uri, path });
      return s.exists && s.type ? { type: s.type, size: s.size ?? 0, mtime: s.mtime ?? 0 } : null;
    },
    readFile: async (path) => fromBase64((await plugin.readFile({ uri, path })).data),
    writeFile: (path, data) => plugin.writeFile({ uri, path, data: toBase64(data) }),
    mkdir: (path) => plugin.mkdir({ uri, path }),
    rename: (from, to) => plugin.rename({ uri, from, to }),
    remove: (path) => plugin.remove({ uri, path }),
  };
}

interface CapacitorGlobal {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  isPluginAvailable?: (name: string) => boolean;
}

const capacitor = (): CapacitorGlobal | null => (typeof window !== "undefined" ? ((window as { Capacitor?: CapacitorGlobal }).Capacitor ?? null) : null);

/** Running inside the Capacitor app on a phone? */
export function isMobileApp(): boolean {
  return !!capacitor()?.isNativePlatform?.();
}

export function mobilePlatform(): "ios" | "android" | null {
  const p = capacitor()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : null;
}

export interface MobileBridge {
  platform: "ios" | "android";
  filesystem: CapacitorFilesystemPlugin | null;
  folder: LumenVaultFolderPlugin | null;
}

/** The native plugins, through @capacitor/core (loaded only in the app). */
export async function loadMobileBridge(): Promise<MobileBridge> {
  const platform = mobilePlatform();
  if (!platform) throw new Error("Not running in the mobile app.");
  const { registerPlugin, Capacitor } = await import("@capacitor/core");
  return {
    platform,
    filesystem: Capacitor.isPluginAvailable("Filesystem") ? registerPlugin<CapacitorFilesystemPlugin>("Filesystem") : null,
    folder: Capacitor.isPluginAvailable("LumenVaultFolder") ? registerPlugin<LumenVaultFolderPlugin>("LumenVaultFolder") : null,
  };
}

/** Where a phone vault is: the iOS Documents folder, the Android app folder, or an Android folder the user picked. */
export type MobileStore = { store: "documents" } | { store: "app" } | { store: "saf"; uri: string };

export class MobileVaultUnavailableError extends Error {
  constructor(what: string) {
    super(`${what} is not installed in this build of the app (see mobile/README.md).`);
    this.name = "MobileVaultUnavailableError";
  }
}

/** The `MobileFs` for `where`. */
export function mobileFsFor(bridge: MobileBridge, where: MobileStore): MobileFs {
  if (where.store === "saf") {
    if (!bridge.folder) throw new MobileVaultUnavailableError("The folder plugin");
    return safFs(bridge.folder, where.uri);
  }
  if (!bridge.filesystem) throw new MobileVaultUnavailableError("@capacitor/filesystem");
  return capacitorFs(bridge.filesystem, where.store === "documents" ? "DOCUMENTS" : "EXTERNAL");
}

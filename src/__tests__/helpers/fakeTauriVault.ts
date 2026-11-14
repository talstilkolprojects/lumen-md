/**
 * A stand-in for the app's Rust vault commands (src-tauri/src/lib.rs over
 * src-tauri/vault): the same command names and arguments, folders named by
 * root and granted only by the "dialog", raw byte transport with
 * percent-encoded headers, and "CODE: message" errors — over in-memory
 * vaults. The Rust file-system semantics are tested by `cargo test`.
 */
import { createMemoryBackend, VaultError, type VaultBackend } from "../../storage/vault";
import type { TauriInvoke } from "../../storage/vault/tauri";

export interface FakeTauriVault {
  invoke: TauriInvoke;
  /** The disk: one in-memory vault per folder path. */
  disk: Map<string, VaultBackend>;
  /** The folder at "/home/tal/Notes" (the usual pick). */
  fs: VaultBackend;
  /** The folder the "native dialog" returns next (null = cancelled). */
  nextPick: string | null;
  /** Folders granted by the dialog this session (or the saved one). */
  granted: Set<string>;
  /** The saved vault folder (vault.json). */
  active: string | null;
  backups: Map<string, Uint8Array>;
  calls: string[];
}

function asRustError(e: unknown): string {
  if (e instanceof VaultError) return `${e.code}: ${e.message}`;
  return `EIO: ${(e as Error).message}`;
}

export function fakeTauriVault(active: string | null = null): FakeTauriVault {
  const disk = new Map<string, VaultBackend>();
  const folder = (root: string) => {
    let f = disk.get(root);
    if (!f) disk.set(root, (f = createMemoryBackend({ id: `disk:${root}` })));
    return f;
  };
  const self: FakeTauriVault = {
    disk,
    fs: folder("/home/tal/Notes"),
    nextPick: "/home/tal/Notes",
    granted: new Set(active ? [active] : []),
    active,
    backups: new Map(),
    calls: [],
    invoke: (async (cmd: string, args?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => {
      self.calls.push(cmd);
      const a = (args ?? {}) as Record<string, string & boolean>;
      const h = (name: string) => decodeURIComponent(options?.headers?.[name] ?? "");
      const vault = (root: string) => {
        if (!self.granted.has(root)) throw "ENOVAULT: this folder was not chosen in the dialog";
        return folder(root);
      };
      try {
        switch (cmd) {
          case "vault_root":
            return self.active;
          case "vault_pick_folder":
            if (self.nextPick) self.granted.add(self.nextPick);
            return self.nextPick;
          case "vault_use":
            vault(a.root);
            self.active = a.root;
            return null;
          case "vault_forget":
            self.active = null;
            self.granted.clear();
            return null;
          case "vault_backup":
            if (!ArrayBuffer.isView(args)) throw "EINVAL: vault_backup expects raw bytes";
            self.backups.set(h("x-backup-name"), args as Uint8Array);
            return `/appdata/backups/${h("x-backup-name")}`;
          case "vault_list":
            return await vault(a.root).list(a.dir);
          case "vault_stat":
            return await vault(a.root).stat(a.path);
          case "vault_read":
            return await (await vault(a.root).read(a.path)).arrayBuffer();
          case "vault_write":
            if (!ArrayBuffer.isView(args)) throw "EINVAL: vault_write expects raw bytes";
            return await vault(h("x-vault-root")).write(h("x-vault-path"), args as Uint8Array);
          case "vault_snapshot": {
            const out: { path: string; size: number; mtime: number }[] = [];
            const walk = async (dir: string) => {
              for (const e of await vault(a.root).list(dir)) {
                if (e.kind === "directory") await walk(e.path);
                else out.push({ path: e.path, size: e.size ?? 0, mtime: e.mtime ?? 0 });
              }
            };
            await walk("");
            return out;
          }
          case "vault_mkdir":
            return await vault(a.root).mkdir(a.path);
          case "vault_rename":
            return await vault(a.root).rename(a.from, a.to, { overwrite: a.overwrite });
          case "vault_remove":
            return await vault(a.root).remove(a.path);
        }
        throw `EINVAL: unknown command ${cmd}`;
      } catch (e) {
        if (typeof e === "string") throw e;
        throw asRustError(e);
      }
    }) as TauriInvoke,
  };
  return self;
}

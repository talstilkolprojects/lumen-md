/**
 * The desktop vault backend (plan 4.3): the vault is a folder on disk, read
 * and written by the app's own Rust commands (src-tauri/vault, `vault_*`).
 * Rust holds the folder the user picked in the native dialog and checks
 * every path to stay inside it; the WebView has no `fs:` permission at all.
 *
 * Errors come back as "CODE: message" strings and become the vault's error
 * classes, so callers see the same behaviour as on OPFS. File bytes travel
 * raw (an ArrayBuffer back, a raw request body out), not as JSON arrays.
 */

// Through the vault barrel (already in the startup bundle), so this lazy
// module does not split its helpers out into a startup chunk of their own.
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
  type VaultStat,
} from "./index";

export type TauriInvoke = <T>(
  cmd: string,
  args?: Record<string, unknown> | Uint8Array,
  options?: { headers?: Record<string, string> },
) => Promise<T>;

/** Running inside the desktop app? */
export function isDesktopApp(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export async function loadTauriInvoke(): Promise<TauriInvoke> {
  const core = await import("@tauri-apps/api/core");
  return core.invoke as TauriInvoke;
}

/** "CODE: message" from Rust → the vault's error classes. */
function asVaultError(e: unknown, path: string): Error {
  const text = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
  const m = /^([A-Z]+): ([\s\S]*)$/.exec(text);
  if (!m) return e instanceof Error ? e : new Error(text);
  const [, code, message] = m;
  if (code === "ENOENT") return new VaultNotFoundError(path);
  if (code === "EEXIST") return new WorkspaceConflictError(path);
  if (code === "EKIND" || code === "EINVAL") return new VaultError(code, path, message);
  if (code === "ENOVAULT") return new Error("No vault folder is chosen. Choose the vault folder first.");
  return new Error(message);
}

/**
 * The vault in folder `root` (an absolute path the native dialog granted).
 * Every command names its folder, so a move can read one granted folder
 * while writing another.
 */
export function createTauriBackend(invoke: TauriInvoke, root: string, opts: { available?: () => boolean } = {}): VaultBackend {
  const events = new VaultEmitter();
  const emit = (e: Omit<VaultEvent, "origin">) => events.emit({ ...e, origin: "self" });
  const call = async <T,>(path: string, cmd: string, args?: Record<string, unknown> | Uint8Array, o?: { headers?: Record<string, string> }) => {
    try {
      return await invoke<T>(cmd, args, o);
    } catch (e) {
      throw asVaultError(e, path);
    }
  };
  const norm = (path: string) => vaultSegments(path).join("/");

  return {
    id: "desktop",
    available: () => (opts.available ? opts.available() : true),

    async list(dir) {
      const entries = await call<VaultEntry[]>(dir, "vault_list", { root, dir: norm(dir) });
      // Same order as every other backend (Rust sorts by bytes).
      return entries.sort(compareVaultEntries);
    },

    async stat(path) {
      return (await call<VaultStat | null>(path, "vault_stat", { root, path: norm(path) })) ?? null;
    },

    async read(path) {
      const raw = await call<ArrayBuffer | number[]>(path, "vault_read", { root, path: norm(path) });
      return new Blob([raw instanceof ArrayBuffer ? raw : new Uint8Array(raw)]);
    },

    async readText(path) {
      return (await this.read(path)).text();
    },

    async write(path, data) {
      const p = norm(path);
      await call(path, "vault_write", await toBytes(data), { headers: { "x-vault-root": encodeURIComponent(root), "x-vault-path": encodeURIComponent(p) } });
      emit({ type: "write", path: p });
    },

    async mkdir(path) {
      const p = norm(path);
      if (!p) return;
      await call(path, "vault_mkdir", { root, path: p });
      emit({ type: "mkdir", path: p });
    },

    async rename(from, to, o = {}) {
      const r = checkRename(from, to);
      if (!r) return;
      const [a, b] = [r.src.join("/"), r.dst.join("/")];
      try {
        await invoke("vault_rename", { root, from: a, to: b, overwrite: !!o.overwrite });
      } catch (e) {
        const err = asVaultError(e, from);
        // Rust says which side: EEXIST is the target, ENOENT the source.
        throw err instanceof WorkspaceConflictError ? new WorkspaceConflictError(to) : err;
      }
      emit({ type: "rename", path: b, from: a });
    },

    async remove(path) {
      const p = norm(path);
      await call(path, "vault_remove", { root, path: p });
      emit({ type: "delete", path: p });
    },

    watch: (listener) => events.on(listener),
    notifyExternal: (event) => events.emit({ ...event, origin: "external" }),
  };
}

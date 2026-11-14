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
  PathLock,
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
  /** write / remove / writeIf / removeIf on one path, one at a time (2.28). */
  const lock = new PathLock();
  const pathHeaders = (p: string, extra: Record<string, string> = {}) => ({ headers: { "x-vault-root": encodeURIComponent(root), "x-vault-path": encodeURIComponent(p), ...extra } });
  /**
   * The file's bytes when they hash to `expect` (null: nothing there, and
   * nothing expected); false otherwise. Rust then compares these exact bytes
   * again and replaces the file in the same command, so the swap does not
   * span a round trip.
   */
  const current = async (path: string, p: string, expect: string | null): Promise<Uint8Array | null | false> => {
    const st = await call<VaultStat | null>(path, "vault_stat", { root, path: p });
    if (st?.kind === "directory") return false;
    if (!st) return expect === null ? null : false;
    if (expect === null) return false;
    const raw = await call<ArrayBuffer | number[]>(path, "vault_read", { root, path: p });
    const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : new Uint8Array(raw);
    const { sha256Hex } = await import("./cas");
    return (await sha256Hex(bytes)) === expect ? bytes : false;
  };

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
      const bytes = await toBytes(data);
      await lock.run(p, () => call(path, "vault_write", bytes, pathHeaders(p)));
      emit({ type: "write", path: p });
    },

    async writeIf(path, data, expect) {
      const p = norm(path);
      if (!p) throw new VaultError("EKIND", path, "Cannot write to the vault root");
      const next = await toBytes(data);
      const ok = await lock.run(p, async () => {
        const before = await current(path, p, expect);
        if (before === false) return false;
        // Body: the expected bytes, then the new ones; `x-vault-expect` is the length of the first part ("none": nothing may be there).
        const body = new Uint8Array((before?.byteLength ?? 0) + next.byteLength);
        if (before) body.set(before, 0);
        body.set(next, before?.byteLength ?? 0);
        return !!(await call<boolean>(path, "vault_write_if", body, pathHeaders(p, { "x-vault-expect": before ? String(before.byteLength) : "none" })));
      });
      if (ok) emit({ type: "write", path: p });
      return ok;
    },

    async removeIf(path, expect) {
      const p = norm(path);
      const ok = await lock.run(p, async () => {
        const before = await current(path, p, expect);
        if (!before) return false;
        return !!(await call<boolean>(path, "vault_remove_if", before, pathHeaders(p)));
      });
      if (ok) emit({ type: "delete", path: p });
      return ok;
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
      await lock.run(p, () => call(path, "vault_remove", { root, path: p }));
      emit({ type: "delete", path: p });
    },

    watch: (listener) => events.on(listener),
    notifyExternal: (event) => events.emit({ ...event, origin: "external" }),
  };
}

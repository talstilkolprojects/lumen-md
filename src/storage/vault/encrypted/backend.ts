/**
 * The encrypted vault backend (plan 11.4): wraps any `VaultBackend` — OPFS,
 * a real folder in the browser (4.2), the desktop folder (Tauri, 4.3), the
 * mobile folder (4.20) — so that what reaches the storage is ciphertext and
 * what Lumen reads is the note. Everything above the vault layer (the index,
 * git, embeddings, export, trash, sync) works unchanged.
 *
 * Reads accept both formats: an encrypted file is decrypted, a plaintext
 * file (one written before encryption was turned on, by a conversion that
 * was cut off, or by another program into the folder) is returned as it is
 * and encrypted the next time it is written or by "check and repair". So a
 * conversion that stops half way never makes a note unreadable.
 *
 * Writes follow the header's target: encrypted while the vault is (or is
 * becoming) encrypted, plain while encryption is being turned off.
 *
 * The header files and the conversion's temporary files are the layer's own:
 * hidden from `list()` and `watch()`, refused as targets.
 */

import { VaultError, type VaultBackend, type VaultEntry, type VaultEvent } from "../types";
import { toBytes } from "../shared";
import { decryptFile, encryptFile, FILE_OVERHEAD, isEncryptedFile, type RestKeys, type RestTarget } from "./format";
import { isLayerPath } from "./paths";

export { HEADER_BACKUP_PATH, HEADER_PATH, isLayerPath, TEMP_SUFFIX } from "./paths";

function refuse(path: string): never {
  throw new VaultError("EINVAL", path, `"${path}" is reserved for vault encryption`);
}

const plainSize = (size: number) => Math.max(0, size - FILE_OVERHEAD);

export interface EncryptedBackendOptions {
  /** Where the vault is going (from the header); read on every write. */
  target: () => RestTarget;
}

export function createEncryptedBackend(inner: VaultBackend, keys: RestKeys, opts: EncryptedBackendOptions): VaultBackend & { readonly inner: VaultBackend } {
  async function plainBytes(path: string): Promise<Uint8Array> {
    const raw = new Uint8Array(await (await inner.read(path)).arrayBuffer());
    return isEncryptedFile(raw) ? decryptFile(keys, raw, path) : raw;
  }

  return {
    id: inner.id,
    inner,
    available: () => inner.available(),

    async list(dir) {
      const entries = await inner.list(dir);
      return entries
        .filter((e) => !isLayerPath(e.path))
        .map((e): VaultEntry => (e.kind === "file" && e.size !== undefined ? { ...e, size: plainSize(e.size) } : e));
    },

    async stat(path) {
      if (isLayerPath(path)) return null;
      const s = await inner.stat(path);
      return s && s.kind === "file" ? { ...s, size: plainSize(s.size) } : s;
    },

    async read(path) {
      if (isLayerPath(path)) refuse(path);
      return new Blob([(await plainBytes(path)) as BlobPart]);
    },

    async readText(path) {
      if (isLayerPath(path)) refuse(path);
      return new TextDecoder().decode(await plainBytes(path));
    },

    async write(path, data) {
      if (isLayerPath(path)) refuse(path);
      if (opts.target() === "plain") return inner.write(path, data);
      const plain = await toBytes(data);
      return inner.write(path, await encryptFile(keys, plain));
    },

    mkdir: (path) => (isLayerPath(path) ? Promise.reject(new VaultError("EINVAL", path)) : inner.mkdir(path)),

    rename(from, to, o) {
      if (isLayerPath(from) || isLayerPath(to)) return Promise.reject(new VaultError("EINVAL", isLayerPath(from) ? from : to, "reserved for vault encryption"));
      return inner.rename(from, to, o);
    },

    remove(path) {
      if (isLayerPath(path)) return Promise.reject(new VaultError("EINVAL", path, "reserved for vault encryption"));
      return inner.remove(path);
    },

    watch(listener) {
      return inner.watch((e: VaultEvent) => {
        if (isLayerPath(e.path) || (e.from && isLayerPath(e.from))) return;
        listener(e);
      });
    },

    notifyExternal: (event) => inner.notifyExternal(event),
  };
}

export class VaultLockedError extends Error {
  constructor() {
    super("The vault is locked");
    this.name = "VaultLockedError";
  }
}

/**
 * The vault while it is locked: every file call waits until it is unlocked
 * (the unlock screen covers the app meanwhile), then runs on the unlocked
 * backend. Nothing is read or written without the key — in particular no
 * plaintext is written into an encrypted vault.
 */
export function createLockedBackend(inner: VaultBackend, unlocked: () => Promise<VaultBackend>): VaultBackend {
  const later =
    <A extends unknown[], R>(op: (b: VaultBackend, ...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> =>
      op(await unlocked(), ...a);
  return {
    id: inner.id,
    available: () => inner.available(),
    list: later((b, dir: string) => b.list(dir)),
    stat: later((b, path: string) => b.stat(path)),
    read: later((b, path: string) => b.read(path)),
    readText: later((b, path: string) => b.readText(path)),
    write: later((b, path: string, data: Parameters<VaultBackend["write"]>[1]) => b.write(path, data)),
    mkdir: later((b, path: string) => b.mkdir(path)),
    rename: later((b, from: string, to: string, o?: { overwrite?: boolean }) => b.rename(from, to, o)),
    remove: later((b, path: string) => b.remove(path)),
    watch: (listener) =>
      inner.watch((e) => {
        if (!isLayerPath(e.path) && !(e.from && isLayerPath(e.from))) listener(e);
      }),
    notifyExternal: (event) => inner.notifyExternal(event),
  };
}

/**
 * Compare-and-swap for the vault backends (2.28): `writeIf` / `removeIf`
 * (see `VaultBackend` in ./types.ts). A lazy chunk: the backends load it on
 * the first conditional write, so none of it is on the startup path.
 *
 * The directory-handle backend (OPFS, a picked folder) has no conditional
 * write underneath, so the swap is staged: the new bytes go into the
 * writable's swap file first, then the file is read again and compared with
 * the bytes that were hashed, and only then does `close()` let the swap file
 * replace it. What is left is the step between that last compare and
 * `close()`, for writers outside this backend (another program on a picked
 * folder); writers through this backend wait on its per-path lock.
 */

import { VaultError, type VaultData } from "./types";

/** SHA-256 of `bytes`, lower-case hex (the hash `writeIf` / `removeIf` compare). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

const bytesOf = async (f: Blob) => new Uint8Array(await f.arrayBuffer());

/** What the directory-handle backend (./handleBackend.ts) lends its compare-and-swap: its own helpers. */
export interface HandleCasHost {
  lookup(parts: string[]): Promise<{ kind: "file"; handle: FileSystemFileHandle } | { kind: "directory"; handle: FileSystemDirectoryHandle } | null>;
  removeAt(parts: string[], path: string): Promise<void>;
  /** The file handle at `parts`, created with its parent folders when missing (errors as the platform raises them). */
  createFile(parts: string[]): Promise<FileSystemFileHandle>;
  openWritable(handle: FileSystemFileHandle): Promise<FileSystemWritableFileStream>;
  /** Writes for engines without `createWritable` (see DirectoryHandleBackendOptions). */
  writeFallback?: (parts: string[], data: VaultData) => Promise<void>;
}

async function lookupFile(host: HandleCasHost, parts: string[]): Promise<FileSystemFileHandle | "directory" | null> {
  const found = parts.length ? await host.lookup(parts) : null;
  return !found ? null : found.kind === "directory" ? "directory" : found.handle;
}

/** The file handle at `parts`, created (with its parent folders) when missing; as `write` does. */
async function createFile(host: HandleCasHost, parts: string[], path: string): Promise<FileSystemFileHandle> {
  try {
    return await host.createFile(parts);
  } catch (e) {
    const name = (e as { name?: unknown } | null)?.name;
    if (name === "NotFoundError" || name === "TypeMismatchError") {
      throw new VaultError("EKIND", path, `Cannot write "${path}": a file or folder of that name is in the way`);
    }
    throw e;
  }
}

/** The current bytes when the file is the `expect` one (null: absent and expected absent); false otherwise. */
async function matches(found: FileSystemFileHandle | "directory" | null, expect: string | null): Promise<Uint8Array | null | false> {
  if (found === "directory") return false;
  if (!found) return expect === null ? null : false;
  if (expect === null) return false;
  const before = await bytesOf(await found.getFile());
  return (await sha256Hex(before)) === expect ? before : false;
}

export async function handleWriteIf(host: HandleCasHost, parts: string[], path: string, data: VaultData, expect: string | null): Promise<boolean> {
  if (!parts.length) throw new VaultError("EKIND", path, "Cannot write to the vault root");
  const found = await lookupFile(host, parts);
  const before = await matches(found, expect);
  if (before === false) return false;
  const handle = found && found !== "directory" ? found : await createFile(host, parts, path);
  /** Still the file that was checked? (A file this call created is still empty.) */
  const unchanged = async () => {
    const now = await bytesOf(await handle.getFile());
    return before ? sameBytes(now, before) : now.byteLength === 0;
  };
  /** A file this call created and did not fill: take it away again. */
  const dropCreated = async () => {
    if (before || !(await unchanged().catch(() => false))) return;
    await host.removeAt(parts, path).catch(() => undefined);
  };
  if (typeof (handle as { createWritable?: unknown }).createWritable !== "function") {
    if (!host.writeFallback) throw new Error("This browser cannot write files here.");
    if (!(await unchanged())) {
      await dropCreated();
      return false;
    }
    await host.writeFallback(parts, data);
    return true;
  }
  const writable = await host.openWritable(handle);
  let committed = false;
  try {
    await writable.write(data as FileSystemWriteChunkType);
    if (!(await unchanged())) return false;
    await writable.close();
    committed = true;
    return true;
  } finally {
    if (!committed) {
      // Drop the swap file: the file keeps what the other writer put there.
      await (writable as { abort?: () => Promise<void> }).abort?.().catch(() => undefined);
      await dropCreated();
    }
  }
}

export async function handleRemoveIf(host: HandleCasHost, parts: string[], path: string, expect: string): Promise<boolean> {
  const found = await lookupFile(host, parts);
  const before = await matches(found, expect);
  if (!before || !found || found === "directory") return false;
  // Compared again right before the delete.
  if (!sameBytes(await bytesOf(await found.getFile()), before)) return false;
  await host.removeAt(parts, path);
  return true;
}

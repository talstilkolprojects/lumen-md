/**
 * Turning vault encryption on and off, check and repair (plan 11.4).
 *
 * Data safety rules, each covered by src/__tests__/vaultEncryption.test.ts:
 *
 *   1. The header is written (twice) before the first file is encrypted, and
 *      removed only after the last file is decrypted — so as long as one
 *      encrypted file exists, the vault knows it is encrypted and opens with
 *      the passphrase or the recovery key.
 *   2. A file is converted copy-first: the new bytes go to
 *      `<path>.lumen-convert`, are read back and checked (decrypted and
 *      compared), and only then replace the file. Cut off at any point, the
 *      file is either its old or its new complete self; `recoverInterrupted`
 *      finishes or drops the copy.
 *   3. A file that changed while it was being converted (another program, a
 *      sync) is left alone and picked up by the next run.
 *   4. A file that cannot be decrypted is never overwritten or deleted; it is
 *      reported.
 *
 * Every run is idempotent: running it again after a crash continues where it
 * stopped.
 */

import type { VaultBackend } from "../types";
import { HEADER_BACKUP_PATH, HEADER_PATH, isLayerPath, TEMP_SUFFIX } from "./paths";
import { decodeRestHeader, decryptFile, encodeRestHeader, encryptFile, isEncryptedFile, NotDecryptableError, type RestHeader, type RestKeys, type RestTarget } from "./format";
import type { KdfPolicy } from "../../../sync/e2ee/kdf";

export class BrokenHeaderError extends Error {
  constructor(readonly reason: string) {
    super(`The vault is encrypted but its encryption header cannot be read: ${reason}`);
    this.name = "BrokenHeaderError";
  }
}

const bytesOf = async (b: Blob) => new Uint8Array(await b.arrayBuffer());

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The vault's encryption header, or null when the vault is not encrypted.
 * The main copy first, the backup copy when the main one is missing or
 * unreadable. A header file that exists but neither copy can be read throws
 * `BrokenHeaderError`: the vault must not then be treated as plaintext.
 */
export async function readHeader(inner: VaultBackend, policy: KdfPolicy = {}): Promise<RestHeader | null> {
  let seen = false;
  let reason = "";
  for (const path of [HEADER_PATH, HEADER_BACKUP_PATH]) {
    const s = await inner.stat(path);
    if (!s) continue;
    seen = true;
    try {
      return decodeRestHeader(await bytesOf(await inner.read(path)), policy);
    } catch (err) {
      reason = err instanceof Error ? err.message : String(err);
      // The KDF is known but unavailable here (argon2id) or too weak: the
      // other copy says the same, and guessing would be wrong.
      if (err instanceof Error && (err.name === "KdfUnavailableError" || err.name === "WeakKdfError")) throw err;
    }
  }
  if (seen) throw new BrokenHeaderError(reason);
  return null;
}

/** Write both header copies, each read back and checked. */
export async function writeHeader(inner: VaultBackend, header: RestHeader, policy: KdfPolicy = {}): Promise<void> {
  const bytes = encodeRestHeader(header);
  for (const path of [HEADER_PATH, HEADER_BACKUP_PATH]) {
    await inner.write(path, bytes);
    const back = await bytesOf(await inner.read(path));
    if (!sameBytes(back, bytes)) throw new Error(`The encryption header could not be written (${path})`);
    decodeRestHeader(back, policy);
  }
}

/** Remove both header copies (the backup first: the main copy is what a reader looks for). */
export async function removeHeader(inner: VaultBackend): Promise<void> {
  for (const path of [HEADER_BACKUP_PATH, HEADER_PATH]) if (await inner.stat(path)) await inner.remove(path);
}

/** Every file in the vault (the layer's own files and copies listed separately). */
export async function walk(inner: VaultBackend): Promise<{ files: string[]; temps: string[] }> {
  const files: string[] = [];
  const temps: string[] = [];
  const visit = async (dir: string) => {
    for (const e of await inner.list(dir)) {
      if (e.kind === "directory") await visit(e.path);
      else if (e.path.endsWith(TEMP_SUFFIX)) temps.push(e.path);
      else if (!isLayerPath(e.path)) files.push(e.path);
    }
  };
  await visit("");
  return { files: files.sort(), temps: temps.sort() };
}

/**
 * Finish what an interrupted conversion left: a copy whose file still exists
 * is dropped (the file is complete, old or new); a copy whose file is gone
 * (cut off inside the replace) becomes the file. Returns how many it fixed.
 */
export async function recoverInterrupted(inner: VaultBackend): Promise<number> {
  const { temps } = await walk(inner);
  for (const temp of temps) {
    const original = temp.slice(0, -TEMP_SUFFIX.length);
    if (await inner.stat(original)) await inner.remove(temp);
    else await inner.rename(temp, original);
  }
  return temps.length;
}

export interface ConvertProgress {
  done: number;
  total: number;
}

export interface ConvertReport {
  /** Files rewritten in this run. */
  converted: number;
  /** Files already in the target format. */
  unchanged: number;
  /** Files that changed while being converted: left alone, done by the next run. */
  retry: string[];
  /** Files that cannot be decrypted (changed outside Lumen, or from another vault): never overwritten. */
  broken: string[];
}

/** Bring every file to `target` (see the rules at the top). */
export async function convertFiles(
  inner: VaultBackend,
  keys: RestKeys,
  target: RestTarget,
  onProgress?: (p: ConvertProgress) => void,
): Promise<ConvertReport> {
  await recoverInterrupted(inner);
  const { files } = await walk(inner);
  const report: ConvertReport = { converted: 0, unchanged: 0, retry: [], broken: [] };
  let done = 0;
  for (const path of files) {
    onProgress?.({ done, total: files.length });
    done++;
    const before = await inner.stat(path);
    if (!before || before.kind !== "file") continue;
    const raw = await bytesOf(await inner.read(path));
    const encrypted = isEncryptedFile(raw);
    let next: Uint8Array;
    if (target === "encrypted") {
      if (encrypted) {
        report.unchanged++;
        continue;
      }
      next = await encryptFile(keys, raw);
      if (!sameBytes(await decryptFile(keys, next, path), raw)) throw new Error(`Encryption check failed for "${path}"`);
    } else {
      if (!encrypted) {
        report.unchanged++;
        continue;
      }
      try {
        next = await decryptFile(keys, raw, path);
      } catch (err) {
        if (err instanceof NotDecryptableError) {
          report.broken.push(path);
          continue;
        }
        throw err;
      }
    }
    const temp = path + TEMP_SUFFIX;
    await inner.write(temp, next);
    if (!sameBytes(await bytesOf(await inner.read(temp)), next)) {
      await inner.remove(temp);
      throw new Error(`The converted copy of "${path}" did not read back the same`);
    }
    const now = await inner.stat(path);
    if (!now || now.size !== before.size || now.mtime !== before.mtime) {
      await inner.remove(temp);
      report.retry.push(path);
      continue;
    }
    await inner.rename(temp, path, { overwrite: true });
    report.converted++;
  }
  onProgress?.({ done: files.length, total: files.length });
  return report;
}

export interface ScanReport {
  encrypted: number;
  plain: string[];
  /** Encrypted files that do not decrypt with this vault's key. */
  broken: string[];
  /** Copies an interrupted conversion left. */
  temps: string[];
}

/** Check every file: does it decrypt? Which ones are still plaintext? Changes nothing. */
export async function scanVault(inner: VaultBackend, keys: RestKeys): Promise<ScanReport> {
  const { files, temps } = await walk(inner);
  const report: ScanReport = { encrypted: 0, plain: [], broken: [], temps };
  for (const path of files) {
    const raw = await bytesOf(await inner.read(path));
    if (!isEncryptedFile(raw)) {
      report.plain.push(path);
      continue;
    }
    try {
      await decryptFile(keys, raw, path);
      report.encrypted++;
    } catch {
      report.broken.push(path);
    }
  }
  return report;
}

/** The header of a vault that is being turned off has `target: "plain"`; true when it may now be removed. */
export function canRemoveHeader(scan: ScanReport): boolean {
  return scan.encrypted === 0 && scan.broken.length === 0 && scan.temps.length === 0;
}

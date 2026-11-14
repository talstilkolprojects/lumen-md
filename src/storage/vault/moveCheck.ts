/**
 * The vault move's errors and its byte-for-byte check (split out of
 * location.ts, plan W4.11; it re-exports the error classes and MoveReport).
 */
import { vaultEncryptionReady } from "./index";
import type { VaultBackend } from "./types";

/** Files at the target that already exist with different content: nothing was written. */
export class VaultMoveConflictError extends Error {
  constructor(readonly paths: string[]) {
    super(`${paths.length} file(s) already exist at the target with different content: ${paths.slice(0, 3).join(", ")}`);
    this.name = "VaultMoveConflictError";
  }
}

/**
 * An encrypted vault (plan 11.4) is not moved: the move copies what the
 * vault layer reads, which is the decrypted notes. Turn encryption off,
 * move, and turn it on again in the new place.
 */
export class VaultEncryptedMoveError extends Error {
  constructor() {
    super("An encrypted vault can't be moved. Turn encryption off first, move it, then turn it on again.");
    this.name = "VaultEncryptedMoveError";
  }
}

export async function refuseEncryptedMove(): Promise<void> {
  const state = await vaultEncryptionReady();
  if (state === "locked" || state === "unlocked") throw new VaultEncryptedMoveError();
}

/** The browser did not grant read-write access to the folder. */
export class VaultPermissionError extends Error {
  constructor(readonly folder: string) {
    super(`No permission to edit “${folder}”`);
    this.name = "VaultPermissionError";
  }
}

export interface MoveReport {
  files: number;
  bytes: number;
  /** Files already identical at the target (a resume, or a merge into an existing folder). */
  unchanged: number;
  /**
   * Moving back: copies an earlier move left at the target whose notes were
   * deleted since, put in the trash (restorable) instead of reappearing.
   */
  trashed: number;
}

/** Every file path of `b`, dot entries (the trash) included. */
export async function allFiles(b: VaultBackend, dir = "", out: string[] = []): Promise<string[]> {
  for (const e of await b.list(dir)) {
    if (e.kind === "directory") await allFiles(b, e.path, out);
    else out.push(e.path);
  }
  return out;
}

export async function bytes(b: VaultBackend, path: string): Promise<Uint8Array> {
  return new Uint8Array(await (await b.read(path)).arrayBuffer());
}

export async function sha256(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data as BufferSource));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

export async function targetBytes(b: VaultBackend, path: string): Promise<Uint8Array | null> {
  const st = await b.stat(path);
  if (!st) return null;
  if (st.kind !== "file") throw new VaultMoveConflictError([path]);
  return bytes(b, path);
}

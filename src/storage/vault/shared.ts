/**
 * Pieces every vault backend shares, so they all behave the same: path
 * handling, the order `list()` returns, the checks a rename makes before
 * it touches anything, and the event emitter behind `watch()`.
 */

import { log } from "../../lib/logger";
import { VaultError, type VaultData, type VaultEntry, type VaultEvent, type VaultListener } from "./types";

// ── Paths ────────────────────────────────────────────────────────────────

export function splitPath(path: string): string[] {
  return path.split("/").filter(Boolean);
}

export function joinPath(...parts: string[]): string {
  return parts.flatMap(splitPath).join("/");
}

export function basename(path: string): string {
  const parts = splitPath(path);
  return parts[parts.length - 1] ?? "";
}

export function dirname(path: string): string {
  const parts = splitPath(path);
  parts.pop();
  return parts.join("/");
}

/**
 * The segments of a vault path. Refuses `.` / `..` segments and NUL, so a
 * path from a note, a git tree or an imported zip cannot leave the vault
 * once a backend maps it onto a real folder.
 */
export function vaultSegments(path: string): string[] {
  const parts = splitPath(path);
  for (const p of parts) {
    if (p === "." || p === ".." || p.includes("\0")) throw new VaultError("EINVAL", path, `Invalid vault path "${path}"`);
  }
  return parts;
}

/** `list()` order: directories first, then files, each group by name. */
export function compareVaultEntries(a: Pick<VaultEntry, "kind" | "name">, b: Pick<VaultEntry, "kind" | "name">): number {
  if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
  return a.name.localeCompare(b.name);
}

/**
 * The checks a rename makes before touching anything. Returns the
 * normalised paths, or null for a no-op (same path).
 */
export function checkRename(from: string, to: string): { src: string[]; dst: string[] } | null {
  const src = vaultSegments(from);
  const dst = vaultSegments(to);
  if (!src.length || !dst.length) throw new VaultError("EINVAL", src.length ? to : from, "Cannot move the vault root");
  const a = src.join("/");
  const b = dst.join("/");
  if (a === b) return null;
  if (b.startsWith(a + "/")) throw new VaultError("EINVAL", to, `Cannot move "${from}" into itself`);
  // Replacing a folder that contains the source would delete the source first.
  if (a.startsWith(b + "/")) throw new VaultError("EINVAL", to, `Cannot replace "${to}" with "${from}", which is inside it`);
  return { src, dst };
}

/** `data` as bytes (strings as UTF-8); always a copy the caller cannot change afterwards. */
export async function toBytes(data: VaultData): Promise<Uint8Array> {
  if (typeof data === "string") return new TextEncoder().encode(data);
  // Not `instanceof`: bytes from another realm (a worker, an iframe, jsdom's
  // TextEncoder) are still bytes.
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  if (Object.prototype.toString.call(data) === "[object ArrayBuffer]") return new Uint8Array((data as ArrayBuffer).slice(0));
  return new Uint8Array(await (data as Blob).arrayBuffer());
}

// ── Events ───────────────────────────────────────────────────────────────

/** The emitter behind `watch()` / `notifyExternal()`. A failing listener never fails the write. */
export class VaultEmitter {
  private readonly listeners = new Set<VaultListener>();

  on(listener: VaultListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: VaultEvent): void {
    for (const fn of [...this.listeners]) {
      try {
        fn(event);
      } catch (err) {
        log.warn("vault listener failed", err);
      }
    }
  }
}

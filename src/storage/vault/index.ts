/**
 * The active vault (plan 4.1). Lumen has one vault backend at a time —
 * OPFS by default; a real folder (4.2 / 4.3) or the in-memory backend
 * (tests) can take its place with `setVaultBackend`. The workspace module
 * (../workspace.ts) routes every file call through `getVaultBackend()`.
 *
 * `watchVault` subscribes to whichever backend is active, across switches.
 * External changes (origin "external") are also announced as a structural
 * `lumen-workspace-changed`, so the file tree and the index pick them up
 * the way they pick up Lumen's own saves.
 *
 * Encryption at rest (plan 11.4): every backend is wrapped in a small gate
 * that, before its first call, looks for the encryption header. In an
 * encrypted vault the calls go through the encrypted layer (loaded only
 * then, from ./encrypted/session), which waits for the passphrase while the
 * vault is locked. A file that turns out to be ciphertext while the gate
 * thought the vault was plain (another tab turned encryption on) makes it
 * look again; ciphertext is never handed to the app as a note.
 */

import { log } from "../../lib/logger";
import { notifyWorkspaceChanged } from "../workspaceEvents";
import { createOpfsBackend } from "./opfs";
import type { VaultBackend, VaultEvent, VaultListener } from "./types";
import { ENCRYPTED_PREFIX, ENCRYPTED_TEXT_PREFIX, HEADER_BACKUP_PATH, HEADER_PATH, isLayerPath } from "./encrypted/paths";

export * from "./types";
export { checkRename, compareVaultEntries, toBytes, VaultEmitter, vaultSegments } from "./shared";
export { createDirectoryHandleBackend, type DirectoryHandleBackendOptions } from "./handleBackend";
export { createMemoryBackend } from "./memory";
export { createOpfsBackend, isOpfsSupported } from "./opfs";

let active: VaultBackend | null = null;
let unsubscribe: (() => void) | null = null;
const listeners = new Set<VaultListener>();

function forward(event: VaultEvent): void {
  for (const fn of [...listeners]) {
    try {
      fn(event);
    } catch (err) {
      log.warn("vault listener failed", err);
    }
  }
  if (event.origin === "external") {
    notifyWorkspaceChanged({ kind: "structure", paths: event.from ? [event.from, event.path] : [event.path] });
  }
}

// ── Encryption gate (plan 11.4) ─────────────────────────────────────────

/** The vault's encryption, as far as the active gate knows: "unknown" until its first call. */
export type VaultEncryptionState = "unknown" | "none" | "locked" | "unlocked";

interface Gate extends VaultBackend {
  readonly inner: VaultBackend;
  /** Look for the encryption header again on the next call (after it was written or removed). */
  refresh(): void;
  /** Resolves once the gate knows whether the vault is encrypted. */
  ready(): Promise<VaultEncryptionState>;
}

let encryptionState: VaultEncryptionState = "unknown";
/** Set by ./encrypted/session when the encrypted layer locks or unlocks. */
export function setVaultEncryptionState(state: VaultEncryptionState): void {
  encryptionState = state;
}
export function vaultEncryptionState(): VaultEncryptionState {
  return encryptionState;
}

class EncryptedButNoHeaderError extends Error {
  constructor(path: string) {
    super(`"${path}" is encrypted, but the vault's encryption header is missing`);
    this.name = "EncryptedButNoHeaderError";
  }
}

const startsEncrypted = (b: Uint8Array) => ENCRYPTED_PREFIX.every((x, i) => b[i] === x);

function gate(inner: VaultBackend): Gate {
  let target: Promise<VaultBackend> | null = null;
  const detect = async (): Promise<VaultBackend> => {
    const header = (await inner.stat(HEADER_PATH)) ?? (await inner.stat(HEADER_BACKUP_PATH));
    if (!header) {
      encryptionState = "none";
      return inner;
    }
    const { encryptedLayer } = await import("./encrypted/session");
    return encryptedLayer(inner);
  };
  const resolve = (): Promise<VaultBackend> => {
    if (!inner.available()) return Promise.resolve(inner);
    if (!target) {
      const p = detect();
      target = p;
      // A failed look (I/O error) is not an answer: try again on the next call.
      p.catch(() => {
        if (target === p) target = null;
      });
    }
    return target;
  };
  const via =
    <A extends unknown[], R>(op: (b: VaultBackend, ...a: A) => Promise<R>) =>
    async (...a: A): Promise<R> =>
      op(await resolve(), ...a);
  /** Plain bytes that are ciphertext: look again, once; never return them as a note. */
  async function checked<T>(b: VaultBackend, path: string, value: T, encrypted: boolean, again: (b: VaultBackend) => Promise<T>): Promise<T> {
    if (b !== inner || !encrypted) return value;
    target = null;
    const next = await resolve();
    if (next === inner) throw new EncryptedButNoHeaderError(path);
    return again(next);
  }
  return {
    get id() {
      return inner.id;
    },
    inner,
    refresh: () => {
      target = null;
    },
    ready: async () => {
      await resolve();
      return encryptionState;
    },
    available: () => inner.available(),
    list: via((b, dir: string) => b.list(dir)),
    stat: via((b, path: string) => b.stat(path)),
    read: via(async (b, path: string) => {
      const blob = await b.read(path);
      const encrypted = b === inner && startsEncrypted(new Uint8Array(await blob.slice(0, ENCRYPTED_PREFIX.length).arrayBuffer()));
      return checked(b, path, blob, encrypted, (n) => n.read(path));
    }),
    readText: via(async (b, path: string) => {
      const text = await b.readText(path);
      return checked(b, path, text, text.startsWith(ENCRYPTED_TEXT_PREFIX), (n) => n.readText(path));
    }),
    write: via((b, path: string, data: Parameters<VaultBackend["write"]>[1]) => b.write(path, data)),
    mkdir: via((b, path: string) => b.mkdir(path)),
    rename: via((b, from: string, to: string, o?: { overwrite?: boolean }) => b.rename(from, to, o)),
    remove: via((b, path: string) => b.remove(path)),
    // The layer's own files (header, conversion copies) are never news to anyone.
    watch: (listener) =>
      inner.watch((e) => {
        if (!isLayerPath(e.path) && !(e.from && isLayerPath(e.from))) listener(e);
      }),
    notifyExternal: (event) => inner.notifyExternal(event),
  };
}

const isGate = (b: VaultBackend): b is Gate => typeof (b as Partial<Gate>).refresh === "function" && "inner" in b;

/** The backend under the encryption gate (what is really stored). */
export function unwrapVaultBackend(backend: VaultBackend = getVaultBackend()): VaultBackend {
  return isGate(backend) ? backend.inner : backend;
}

/** Make the active gate look for the encryption header again (after it was written or removed). */
export function refreshVaultEncryption(): void {
  const b = getVaultBackend();
  if (isGate(b)) b.refresh();
}

/** Whether the active vault is encrypted, once the gate has looked. */
export async function vaultEncryptionReady(): Promise<VaultEncryptionState> {
  const b = getVaultBackend();
  return isGate(b) ? b.ready() : "none";
}

function activate(backend: VaultBackend): VaultBackend {
  encryptionState = "unknown";
  const gated = isGate(backend) ? backend : gate(backend);
  active = gated;
  unsubscribe = gated.watch(forward);
  return gated;
}

/** The backend every vault read and write goes through. */
export function getVaultBackend(): VaultBackend {
  return active ?? activate(createOpfsBackend());
}

/**
 * Make `backend` the active vault (null: back to the default OPFS backend
 * on next use). Returns the previous one, so tests can restore it.
 */
export function setVaultBackend(backend: VaultBackend | null): VaultBackend | null {
  const previous = active ? unwrapVaultBackend(active) : null;
  unsubscribe?.();
  unsubscribe = null;
  active = null;
  if (backend) activate(backend);
  return previous;
}

/** Changes in the active vault, whichever backend that is. Returns the unsubscribe function. */
export function watchVault(listener: VaultListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

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
 */

import { log } from "../../lib/logger";
import { notifyWorkspaceChanged } from "../workspaceEvents";
import { createOpfsBackend } from "./opfs";
import type { VaultBackend, VaultEvent, VaultListener } from "./types";

export * from "./types";
export { compareVaultEntries, vaultSegments } from "./shared";
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

function activate(backend: VaultBackend): VaultBackend {
  active = backend;
  unsubscribe = backend.watch(forward);
  return backend;
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
  const previous = active;
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

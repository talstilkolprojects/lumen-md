/**
 * The OPFS vault backend: the browser's Origin Private File System, where
 * Lumen keeps the notes today. A directory-handle backend rooted at
 * `navigator.storage.getDirectory()`, writing through a worker on engines
 * without `createWritable` (./opfsSyncWrite.ts).
 */

import { createDirectoryHandleBackend } from "./handleBackend";
import { syncWriteOpfs } from "./opfsSyncWrite";
import type { VaultBackend } from "./types";

export function isOpfsSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

export function createOpfsBackend(): VaultBackend {
  return createDirectoryHandleBackend({
    id: "opfs",
    available: isOpfsSupported,
    root: async () => {
      if (!isOpfsSupported()) throw new Error("OPFS is not available in this browser.");
      return await navigator.storage.getDirectory();
    },
    writeFallback: (segments, data) => syncWriteOpfs(segments, data),
  });
}

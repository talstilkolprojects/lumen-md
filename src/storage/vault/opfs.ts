/**
 * The OPFS vault backend: the browser's Origin Private File System, where
 * Lumen keeps the notes today. A directory-handle backend rooted at
 * `navigator.storage.getDirectory()`, writing through a worker on engines
 * without `createWritable` (./opfsSyncWrite.ts, loaded on first use).
 */

import { createDirectoryHandleBackend } from "./handleBackend";
import type { VaultBackend } from "./types";

export function isOpfsSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.storage?.getDirectory;
}

/** Writes handed to the worker and not answered yet (their temporary files are not leftovers). */
let pendingWrites = 0;

export function createOpfsBackend(): VaultBackend {
  return createDirectoryHandleBackend({
    id: "opfs",
    available: isOpfsSupported,
    root: async () => {
      if (!isOpfsSupported()) throw new Error("OPFS is not available in this browser.");
      return await navigator.storage.getDirectory();
    },
    // Only engines without createWritable (Safari before 26) need the
    // worker, so it loads on the first such write.
    writeFallback: async (segments, data) => {
      pendingWrites++;
      try {
        await (await import("./opfsSyncWrite")).syncWriteOpfs(segments, data);
      } finally {
        pendingWrites--;
      }
    },
    writesPending: () => pendingWrites > 0,
  });
}

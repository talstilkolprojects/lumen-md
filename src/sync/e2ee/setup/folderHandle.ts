/**
 * The desktop sync folder the encrypted sync writes into (plan W4.19): picked
 * once with the browser's folder access (the same as the vault folder), and
 * kept in IndexedDB so the next visit finds it. Browsers ask again for
 * permission after a restart; a click on "Sync now" or the wizard grants it.
 */
import type { VaultBackend } from "../../../storage/vault/types";
import { createFolderBackend, ensureFolderPermission, isFolderVaultSupported, pickVaultFolder } from "../../../storage/vault/location";
import { ProviderAuthError } from "../providers/http";

const KEY = "lumen-sync-folder-handle";

async function kv() {
  return import("idb-keyval");
}

export const syncFolderSupported = isFolderVaultSupported;

/** Ask the user for the folder (a click); null when they cancel. */
export async function pickSyncFolder(): Promise<{ name: string } | null> {
  const handle = await pickVaultFolder();
  if (!handle) return null;
  if (!(await ensureFolderPermission(handle, true))) return null;
  await (await kv()).set(KEY, handle);
  return { name: handle.name };
}

/** Grant access again after a restart (call from a click). */
export async function reconnectSyncFolder(): Promise<boolean> {
  const handle = (await (await kv()).get(KEY)) as FileSystemDirectoryHandle | undefined;
  return !!handle && ensureFolderPermission(handle, true);
}

/** The folder as a vault backend, for the folder provider. */
export async function syncFolderBackend(): Promise<VaultBackend> {
  const handle = (await (await kv()).get(KEY)) as FileSystemDirectoryHandle | undefined;
  if (!handle || !(await ensureFolderPermission(handle, false))) throw new ProviderAuthError("folder", 403);
  return createFolderBackend(handle);
}

export async function forgetSyncFolder(): Promise<void> {
  await (await kv()).del(KEY);
}

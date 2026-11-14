/**
 * The backup settings (plan W1.6), in IndexedDB: the target folder's handle
 * (the browser keeps the permission with it), its name, and the mode. For
 * the encrypted mode only the backup key's public half (an age recipient)
 * is stored; the secret half is the user's to keep, and is asked for at
 * restore time.
 */

import type { BackupMode } from "./backup";

export interface BackupConfig {
  kind: "folder";
  handle: FileSystemDirectoryHandle;
  label: string;
  mode: BackupMode;
}

const KEY = "lumen-backup-config";
/** Read at startup without loading anything: are backups set up at all? */
export const ENABLED_KEY = "lumen.backup.enabled";

export async function loadBackupConfig(): Promise<BackupConfig | null> {
  const { get } = await import("idb-keyval");
  return ((await get<BackupConfig>(KEY)) ?? null) as BackupConfig | null;
}

export async function saveBackupConfig(c: BackupConfig | null): Promise<void> {
  const { set, del } = await import("idb-keyval");
  if (c) await set(KEY, c);
  else await del(KEY);
  try {
    if (c) localStorage.setItem(ENABLED_KEY, "1");
    else localStorage.removeItem(ENABLED_KEY);
  } catch {
    // why: storage is blocked or full (private mode, quota): the setting holds for this session only
    /* the scheduler then starts when the panel is opened */
  }
}

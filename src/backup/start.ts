/**
 * Backups in the running app (plan W1.6): the scheduler, fed with the saved
 * folder and the active vault, telling the user through toasts. Loaded only
 * when backups are set up (main.tsx checks a localStorage flag first).
 */

import { getVaultBackend } from "../storage/vault";
import { createFolderBackend, ensureFolderPermission } from "../storage/vault/location";
import { toast } from "../store/useToastStore";
import { t } from "../i18n";
import { backendTarget, BackupError, type BackupTarget } from "./backup";
import { loadBackupConfig, type BackupConfig } from "./config";
import { startBackupScheduler } from "./scheduler";
import "./strings";

export async function targetFor(c: BackupConfig): Promise<BackupTarget> {
  // Without a click the browser may not grant the folder again: that is a failure the user sees and fixes in the panel.
  if (!(await ensureFolderPermission(c.handle, false))) throw new BackupError(t("backup.reconnect"));
  return backendTarget(createFolderBackend(c.handle), c.label);
}

let scheduler: ReturnType<typeof startBackupScheduler> | null = null;

export function startBackups(): ReturnType<typeof startBackupScheduler> {
  scheduler ??= startBackupScheduler({
    config: async () => {
      const c = await loadBackupConfig();
      return c ? { target: await targetFor(c), mode: c.mode } : null;
    },
    vault: () => getVaultBackend(),
    notify: (kind, detail) => {
      if (kind === "failed") toast.error(t("backup.toast.failed"), detail);
      else if (kind === "stale") toast.warn(t("backup.toast.stale", { days: detail }));
    },
  });
  return scheduler;
}

/**
 * The vault folder's state, when it needs the user (plan 4.2): a folder the
 * browser wants a click to reopen ("Reconnect folder"), a move in progress,
 * or a move that was interrupted ("Resume"). Nothing shows otherwise.
 */
import { useEffect, useState } from "react";
import { t } from "../i18n";
import { showAiToast } from "./AiToast";
import { chooseDesktopFolder } from "./vaultFolderActions";
import {
  cancelPendingMove,
  dismissDesktopFirstRun,
  isDesktopFirstRun,
  getMoveProgress,
  getPendingMove,
  getVaultStatus,
  moveVault,
  onVaultStatusChange,
  reconnectVaultFolder,
  switchToBrowserStorage,
  VaultMoveConflictError,
} from "../storage/vault/location";

export function VaultFolderBanner() {
  const [, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => onVaultStatusChange(() => setTick((n) => n + 1)), []);

  const status = getVaultStatus();
  const progress = getMoveProgress();
  const pending = getPendingMove();

  if (progress) {
    return (
      <div className="vault-folder-banner" role="status" aria-live="polite">
        <span>{t("vault.folder.moving", { done: String(progress.done), total: String(progress.total) })}</span>
      </div>
    );
  }

  if (isDesktopFirstRun()) {
    return (
      <div className="vault-folder-banner" role="dialog" aria-label={t("vault.desktop.choose")}>
        <span>{t("vault.desktop.firstRunBody")}</span>
        <button
          type="button"
          className="vault-folder-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await chooseDesktopFolder();
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("vault.desktop.choose")}
        </button>
        <button type="button" className="vault-folder-btn secondary" disabled={busy} onClick={() => dismissDesktopFirstRun()}>
          {t("vault.desktop.notNow")}
        </button>
      </div>
    );
  }

  if (status.location === "restoring") {
    return (
      <div className="vault-folder-banner" role="status" aria-live="polite">
        <span>{t("vault.folder.restoring")}</span>
      </div>
    );
  }

  if (status.location === "folder-disconnected") {
    return (
      <div className="vault-folder-banner" role="alert">
        <span>{t("vault.folder.reconnectBody", { folder: status.name })}</span>
        <button
          type="button"
          className="vault-folder-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (!(await reconnectVaultFolder())) showAiToast(t("vault.folder.permissionDenied", { folder: status.name }), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("vault.folder.reconnect")}
        </button>
        <button type="button" className="vault-folder-btn secondary" disabled={busy} onClick={() => void switchToBrowserStorage()}>
          {t("vault.folder.useBrowser")}
        </button>
      </div>
    );
  }

  if (pending) {
    const to = pending.to.kind !== "opfs" ? pending.to.name : t("vault.folder.browserStorage");
    return (
      <div className="vault-folder-banner" role="status">
        <span>{t("vault.folder.interrupted", { folder: to })}</span>
        <button
          type="button"
          className="vault-folder-btn"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await moveVault(pending.to);
              showAiToast(t(pending.to.kind !== "opfs" ? "vault.folder.moved" : "vault.folder.movedBack", { folder: pending.to.kind !== "opfs" ? to : pending.from.kind !== "opfs" ? pending.from.name : "", n: String(r.files) }), "info");
            } catch (e) {
              if (e instanceof VaultMoveConflictError) showAiToast(t("vault.folder.conflict", { n: String(e.paths.length), folder: to, path: e.paths[0] }), "error");
              else showAiToast(t("vault.folder.failed", { error: (e as Error).message }), "error");
            } finally {
              setBusy(false);
            }
          }}
        >
          {t("vault.folder.resume")}
        </button>
        <button type="button" className="vault-folder-btn secondary" disabled={busy} onClick={() => void cancelPendingMove()}>
          {t("vault.folder.cancelMove")}
        </button>
      </div>
    );
  }
  return null;
}

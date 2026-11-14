/**
 * Opens the sync panel in its own root (plan 3.5), so the startup bundle
 * carries only the command that imports this module.
 */

import { createRoot, type Root } from "react-dom/client";
import { SyncPanel, takePendingOAuth, connectError } from "./SyncPanel";
import { syncSession } from "./session";

let root: Root | null = null;
let host: HTMLElement | null = null;

export function closeSyncPanel(): void {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
}

export function openSyncPanel(): void {
  if (root) return;
  host = document.createElement("div");
  host.dataset.lumenSyncPanel = "";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<SyncPanel onClose={closeSyncPanel} />);
}

/**
 * The OAuth redirect (`/oauth/dropbox`, `/oauth/gdrive`): finish the sign-in,
 * restore the address, reopen the panel and connect the provider chosen
 * before leaving. Untested against the real services until Lumen has
 * Dropbox / Google client ids (plan 15.5).
 */
export async function finishOAuthReturn(kind: "dropbox" | "gdrive", code: string): Promise<void> {
  const cloud = await import("../../cloud");
  history.replaceState(null, "", "/");
  try {
    await (kind === "dropbox" ? cloud.finishDropboxOAuth(code) : cloud.finishGDriveOAuth(code));
  } finally {
    openSyncPanel();
  }
  const pending = takePendingOAuth();
  if (pending?.kind === kind) {
    await syncSession()
      .connect(pending, null)
      .catch((e) => syncSession().reportError(connectError(e, pending)));
  }
}

/**
 * Which place the guided sync setup suggests first (plan W4.19). Pure, so the
 * choice is tested on every platform's capabilities.
 *
 *   1. A desktop sync app's folder (iCloud Drive, Dropbox, Google Drive for
 *      desktop, OneDrive): no account with anyone new, no server of ours,
 *      and the app already runs on most computers. Needs folder access
 *      (Chromium on a computer, the desktop app).
 *   2. The encrypted relay: works everywhere, phones included; needs the
 *      relay to be configured in this build.
 *   3. WebDAV (Nextcloud, a NAS…): always possible, needs an address and a
 *      password, so it is last for a non-technical user.
 *
 * Google Drive and Dropbox through their APIs need OAuth apps that are not
 * registered yet (an owner step); the setup offers them only when they are.
 */

export type SetupBackend = "folder" | "relay" | "webdav" | "dropbox" | "gdrive";

export interface SetupCapabilities {
  /** The browser can open a folder for writing (or this is the desktop app with that ability). */
  folderAccess: boolean;
  /** A phone or tablet: no desktop sync app, even if a folder could be opened. */
  mobile: boolean;
  /** The relay's https origin in this build, or null. */
  relayUrl: string | null;
  /** OAuth client ids configured (plan 15.5). */
  dropboxOAuth: boolean;
  gdriveOAuth: boolean;
}

export interface SetupChoices {
  recommended: SetupBackend;
  /** Every place this device can use, the recommended one first. */
  available: SetupBackend[];
}

export function setupChoices(c: SetupCapabilities): SetupChoices {
  const available: SetupBackend[] = [];
  if (c.folderAccess && !c.mobile) available.push("folder");
  if (c.relayUrl) available.push("relay");
  if (c.gdriveOAuth) available.push("gdrive");
  if (c.dropboxOAuth) available.push("dropbox");
  available.push("webdav");
  return { recommended: available[0], available };
}

/** Is this a phone or a tablet? (Coarse pointer and no hover, or a mobile user agent.) */
export function isMobileDevice(nav: { userAgent?: string; maxTouchPoints?: number } = typeof navigator !== "undefined" ? navigator : {}, coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse) and (hover: none)").matches): boolean {
  const ua = nav.userAgent ?? "";
  if (/Android|iPhone|iPod|Mobile/i.test(ua)) return true;
  // iPadOS reports a Mac user agent; touch points give it away.
  if (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1) return true;
  return coarse;
}

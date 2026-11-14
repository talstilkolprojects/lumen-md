/**
 * The only module the startup code imports for the encrypted sync (plan 3.5),
 * and only on use. It keeps the startup chunk small: a dynamic import of the
 * panel itself would put the panel's whole chunk-dependency list (Vite's
 * preload map) into the eager bundle; this hop puts one entry there instead.
 */
export function openSync(): Promise<void> {
  return import("./open").then((m) => m.openSyncPanel());
}

/** `/oauth/dropbox` or `/oauth/gdrive` with `?code=`: finish the sign-in once secrets and vault are ready. */
export async function oauthReturn(ready: Promise<unknown>): Promise<void> {
  const kind = /^\/oauth\/(dropbox|gdrive)$/.exec(location.pathname)?.[1] as "dropbox" | "gdrive" | undefined;
  const code = new URLSearchParams(location.search).get("code");
  if (!kind || !code) return;
  try {
    await ready;
    await (await import("./open")).finishOAuthReturn(kind, code);
  } catch (err) {
    const { log } = await import("../../../lib/logger");
    log.warn("sync sign-in failed", err);
  }
}

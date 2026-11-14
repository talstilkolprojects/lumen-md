/**
 * Sync while the app is in the background, within what iOS and Android
 * allow (plan W1.8), and a notice when it did not run.
 *
 * What the platforms allow: a web page, and Lumen's iOS / Android app (a
 * Capacitor WebView), runs no JavaScript once the system suspends it,
 * usually seconds after it leaves the screen. Native background tasks
 * (BGTaskScheduler, WorkManager) could wake a separate script, but the
 * vault's keys exist only in this tab's memory: they are never stored, so a
 * script started by the system could not decrypt anything without the
 * passphrase being kept on the device, which the sync's threat model rules out.
 *
 * So the sync does what it can, and says what it could not:
 *   • when the app goes to the background, one round starts at once (it
 *     usually finishes before the system suspends the app; if it doesn't,
 *     nothing is lost and the next round finishes it);
 *   • the periodic round keeps running while the app is alive;
 *   • when the app comes back after a while and no round finished in
 *     between, a notice says sync did not run in the background, for how
 *     long, and a round starts.
 */

/** Background periods shorter than this need no notice (a quick app switch). */
export const NOTICE_AFTER_MS = 2 * 60_000;

export interface ResumeInput {
  /** When the app left the screen. */
  hiddenAt: number;
  now: number;
  /** When the last round finished, or null. */
  lastAt: number | null;
  /** Keys in memory (vault unlocked). */
  unlocked: boolean;
  /** Running as the iOS / Android app. */
  native: boolean;
}

export type ResumeNotice = { key: "e2ee.bg.didNotRun" | "e2ee.bg.didNotRunNative" | "e2ee.bg.locked"; minutes: number } | null;

/** What to tell the user when the app comes back to the screen. */
export function resumeNotice(i: ResumeInput): ResumeNotice {
  const away = i.now - i.hiddenAt;
  if (away < NOTICE_AFTER_MS) return null;
  const minutes = Math.round(away / 60_000);
  if (!i.unlocked) return { key: "e2ee.bg.locked", minutes };
  if (i.lastAt !== null && i.lastAt > i.hiddenAt) return null; // a round finished while away
  return { key: i.native ? "e2ee.bg.didNotRunNative" : "e2ee.bg.didNotRun", minutes };
}

export interface BackgroundHooks {
  unlocked: () => boolean;
  lastAt: () => number | null;
  syncNow: () => Promise<unknown>;
  notify: (notice: NonNullable<ResumeNotice>) => void;
  native?: () => boolean;
  now?: () => number;
}

/** Follow the page's visibility; returns the uninstall function. */
export function installBackgroundSync(h: BackgroundHooks, doc: Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState"> = document): () => void {
  const now = h.now ?? (() => Date.now());
  let hiddenAt: number | null = null;
  const onChange = () => {
    if (doc.visibilityState === "hidden") {
      hiddenAt = now();
      if (h.unlocked()) void h.syncNow().catch(() => undefined);
      return;
    }
    if (hiddenAt === null) return;
    const notice = resumeNotice({ hiddenAt, now: now(), lastAt: h.lastAt(), unlocked: h.unlocked(), native: h.native?.() ?? false });
    hiddenAt = null;
    if (notice) h.notify(notice);
    if (h.unlocked()) void h.syncNow().catch(() => undefined);
  };
  doc.addEventListener("visibilitychange", onChange);
  return () => doc.removeEventListener("visibilitychange", onChange);
}

/** Running inside the Capacitor app (iOS / Android)? Read without importing Capacitor. */
export function isNativeApp(): boolean {
  const cap = (globalThis as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  try {
    return !!cap?.isNativePlatform?.();
  } catch {
    return false;
  }
}

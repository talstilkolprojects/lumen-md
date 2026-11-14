/**
 * Safari deletes a site's storage after seven days without a visit (ITP),
 * and `navigator.storage.persist()` is granted there only to installed apps
 * (plan 13.3.3). When the vault is not persisted in a WebKit browser that is
 * not installed and not the native app, remind the user once a week to
 * export the vault or add Lumen to the Home Screen. Loaded lazily from
 * main.tsx after the persistence request, so the startup bundle grows by
 * the import only.
 */
import type { PersistenceStatus } from "./persistentStorage";
// Its English ships with this lazy chunk, not the startup bundle.
import "./evictionStrings";

export const REMINDER_KEY = "lumen.evictionReminder.shownAt";
export const REMINDER_EVERY_MS = 7 * 24 * 60 * 60 * 1000;

export interface ReminderEnv {
  status: PersistenceStatus | null;
  userAgent: string;
  /** Installed as a PWA (display-mode: standalone / navigator.standalone). */
  standalone: boolean;
  /** Running inside the Capacitor shell: the OS keeps the app's storage. */
  native: boolean;
  now: number;
  /** The last time the reminder was shown (ms since epoch), or null. */
  shownAt: number | null;
}

/** Safari on macOS, or any browser on iOS / iPadOS (all are WebKit and share the eviction rule). */
export function isWebKitBrowser(ua: string): boolean {
  if (!/AppleWebKit/i.test(ua)) return false;
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return true;
  // iPadOS 13+ reports itself as a Mac; "Mobile/" without Chrome/Firefox still means Safari-family.
  return /Safari\//.test(ua) && !/\b(Chrome|Chromium|CriOS|Edg|EdgiOS|OPR|FxiOS|Firefox)\b/.test(ua);
}

/** Decide, from the environment alone, whether the reminder is due. */
export function shouldRemind(env: ReminderEnv): boolean {
  if (env.status === "persisted") return false;
  if (env.native || env.standalone) return false;
  if (!isWebKitBrowser(env.userAgent)) return false;
  return env.shownAt === null || env.now - env.shownAt >= REMINDER_EVERY_MS;
}

function readEnv(status: PersistenceStatus | null): ReminderEnv {
  let shownAt: number | null = null;
  try {
    const raw = localStorage.getItem(REMINDER_KEY);
    shownAt = raw ? Number(raw) || null : null;
  } catch {
    shownAt = null;
  }
  const nav = navigator as Navigator & { standalone?: boolean };
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return {
    status,
    userAgent: nav.userAgent ?? "",
    standalone: nav.standalone === true || (typeof matchMedia === "function" && matchMedia("(display-mode: standalone)").matches),
    native: typeof cap?.isNativePlatform === "function" && cap.isNativePlatform(),
    now: Date.now(),
    shownAt,
  };
}

/**
 * Show the reminder when it is due. Returns true when it was shown. Imports
 * the toast store and i18n here, not at module top, to stay off the startup
 * path of pages that never need it.
 */
export async function remindIfEvictable(status: PersistenceStatus | null): Promise<boolean> {
  if (typeof window === "undefined") return false;
  const env = readEnv(status);
  if (!shouldRemind(env)) return false;
  const [{ useToastStore }, { t }] = await Promise.all([import("../store/useToastStore"), import("../i18n")]);
  useToastStore.getState().push({
    kind: "warning",
    title: t("storage.eviction.title"),
    body: t("storage.eviction.body"),
    ttlMs: 15_000,
    action: {
      label: t("storage.eviction.export"),
      run: () => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "vault.export" } })),
    },
  });
  try {
    localStorage.setItem(REMINDER_KEY, String(env.now));
  } catch {
    /* why: private mode: the reminder simply shows again next time */
  }
  return true;
}

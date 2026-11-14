/**
 * First run (plan 14.1): what the setup's choices do. The dialog
 * (./FirstRun) collects them; this applies them — the vault's place, the
 * language, the look, the first note — so it can be tested without a DOM.
 * Loaded lazily with the dialog.
 */
import type { Locale } from "../i18n";
import { detectLocale, systemHasHebrew } from "../i18n/detect";
import { t } from "../i18n";
import type { Theme } from "../store/useStore";
import type { PresetId } from "../lib/themeSettings";

/** localStorage flag: setup (and its tour) done or skipped. Kept from the old tour so returning users never see setup. */
export const DONE_KEY = "lumen-tour-done";

export type StartChoice = "sample" | "empty";

export interface Look {
  theme: Theme;
  preset: PresetId;
}

export function markSetupDone(): void {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* why: storage denied: setup shows again next time, nothing else breaks */
  }
}

/** Setup is due on a first visit; never when storage can't be read (it couldn't remember finishing). */
export function setupDue(): boolean {
  try {
    return !localStorage.getItem(DONE_KEY);
  } catch {
    return false;
  }
}

/** The vault in a folder the user picked; false when permission was refused. */
export async function openFolderVault(handle: FileSystemDirectoryHandle): Promise<boolean> {
  const { openFolderAsVault } = await import("../storage/vault/location");
  return openFolderAsVault(handle);
}

/** Where the vault is now (reopening setup from ⌘K): its folder, if any, and whether that folder needs permission again. */
export async function currentVault(): Promise<{ folder: string | null; disconnected: boolean }> {
  const { getVaultStatus } = await import("../storage/vault/location");
  const status = getVaultStatus();
  if (status.location === "folder") return { folder: status.name, disconnected: false };
  if (status.location === "folder-disconnected") return { folder: status.name, disconnected: true };
  return { folder: null, disconnected: false };
}

/** Ask again for the folder vault the browser closed (after a restart); false when refused. */
export async function reconnectFolderVault(): Promise<boolean> {
  const { reconnectVaultFolder } = await import("../storage/vault/location");
  return reconnectVaultFolder();
}

/** The vault in browser storage (the default; a no-op unless a folder was chosen earlier in this setup). */
export async function openBrowserVault(): Promise<void> {
  const { getVaultStatus, switchToBrowserStorage } = await import("../storage/vault/location");
  if (getVaultStatus().location !== "opfs") await switchToBrowserStorage();
}

/**
 * The first note to open: the sample's start page in the chosen language,
 * or a new empty note. Returns its workspace path and text.
 */
export async function createFirstNote(start: StartChoice, locale: Locale): Promise<{ path: string; content: string }> {
  const ws = await import("../storage/workspace");
  if (start === "sample") {
    const { createLocalizedSample } = await import("../storage/sampleWorkspace");
    const r = await createLocalizedSample(locale);
    return { path: r.entry, content: await ws.readWorkspaceFile(r.entry) };
  }
  const path = await ws.uniqueWorkspaceName(`${t("onboard.firstNote.name")}.md`);
  const content = t("onboard.firstNote.body");
  await ws.writeWorkspaceFile(path, content);
  return { path, content };
}

/**
 * Plan W4.35: the language question. A system that lists Hebrew starts in
 * Hebrew with no question (the language step is skipped; it can be opened
 * from the dialog). Otherwise one question, "Which language will you write
 * in?", with the system's language suggested and Hebrew first in the list.
 */
export function languagePlan(languages: readonly string[], saved: unknown = null): { ask: boolean; locale: Locale } {
  if (typeof saved === "string" && saved) return { ask: false, locale: detectLocale(saved, languages) };
  if (systemHasHebrew(languages)) return { ask: false, locale: "he" };
  return { ask: true, locale: detectLocale(null, languages) };
}

/** The order of the language choices: Hebrew, English, then the rest as listed. */
export function languageOrder<T extends { code: string }>(locales: readonly T[]): T[] {
  const rank = (c: string) => (c === "he" ? 0 : c === "en" ? 1 : 2);
  return [...locales].sort((a, b) => rank(a.code) - rank(b.code));
}

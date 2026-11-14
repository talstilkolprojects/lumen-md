/**
 * First run (plan 14.1): what the setup's choices do. The dialog
 * (./FirstRun) collects them; this applies them — the vault's place, the
 * language, the look, the first note — so it can be tested without a DOM.
 * Loaded lazily with the dialog.
 */
import type { Locale } from "../i18n";
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
    /* storage denied: setup shows again next time, nothing else breaks */
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

/**
 * Where the vault is now (reopening setup from ⌘K): its folder, if any, and
 * whether that folder needs permission again. `restoring`: start-up has not
 * found out yet (a slow restore) — neither browser storage nor a folder, so
 * the setup waits instead of guessing (2.85, Codex P2 on #261).
 */
export async function currentVault(): Promise<{ folder: string | null; disconnected: boolean; restoring: boolean }> {
  const { getVaultStatus } = await import("../storage/vault/location");
  const status = getVaultStatus();
  if (status.location === "folder") return { folder: status.name, disconnected: false, restoring: false };
  if (status.location === "folder-disconnected") return { folder: status.name, disconnected: true, restoring: false };
  return { folder: null, disconnected: false, restoring: status.location === "restoring" };
}

/** Call `fn` whenever the vault's place changes (a slow restore finishing, a switch). Returns the stop function. */
export async function onVaultChange(fn: () => void): Promise<() => void> {
  const { onVaultStatusChange } = await import("../storage/vault/location");
  return onVaultStatusChange(fn);
}

/** Ask again for the folder vault the browser closed (after a restart); false when refused. */
export async function reconnectFolderVault(): Promise<boolean> {
  const { reconnectVaultFolder } = await import("../storage/vault/location");
  return reconnectVaultFolder();
}

/**
 * The vault in browser storage (the default; a no-op unless a folder was
 * chosen earlier in this setup). False, and nothing switched, while start-up
 * is still restoring: the saved place may be a folder, and it is never
 * replaced before it is known (2.85).
 */
export async function openBrowserVault(): Promise<boolean> {
  const { getVaultStatus, switchToBrowserStorage } = await import("../storage/vault/location");
  const location = getVaultStatus().location;
  if (location === "restoring") return false;
  if (location !== "opfs") await switchToBrowserStorage();
  return true;
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

/** Import an Obsidian vault (a folder's files) or a Notion export (.zip) with the existing importers. */
export async function importInto(kind: "obsidian" | "notion", files: ArrayLike<File>): Promise<{ notes: number; folder: string }> {
  const { importZip, importFileList } = await import("../storage/exportAll");
  const r = kind === "notion" ? await importZip(await files[0].arrayBuffer(), files[0].name) : await importFileList(files);
  return { notes: r.notes, folder: r.folder };
}

/**
 * The desktop app's system-wide capture shortcut (plan 4.16): ⌥⌘N on macOS
 * brings Lumen to the front with the capture box open, even when another
 * app has the focus.
 *
 * macOS only. On Windows and Linux the same keys are Ctrl+Alt+N, which many
 * layouts produce with AltGr+N: a system-wide hook can't tell the two apart
 * (unlike the in-window handler, which checks AltGraph), so typing that
 * character in any app would open Lumen (review: #268). There the in-window
 * shortcut, the command palette and File ▸ Quick capture stay the way in.
 *
 * The desktop shell bundles Tauri's global-shortcut plugin (src-tauri:
 * Cargo.toml, lib.rs, capabilities/default.json; audit W10.C13). This asks
 * it to register the shortcut through Tauri's IPC. When the OS refuses —
 * another app already holds ⌥⌘N — `onFail("taken")` tells the user, who
 * would otherwise press it and get nothing; an older build without the
 * plugin gives `onFail("no-plugin")`. The in-window ⌥⌘N and File ▸ Quick
 * capture stay the way in either way.
 *
 * Loaded only inside the desktop app.
 */

/** The accelerator, in the plugin's syntax (macOS: ⌥⌘N). */
export const GLOBAL_CAPTURE_SHORTCUT = "Alt+Command+N";

// Inline, not lib/platformKeys: importing it here moved shared code into the startup chunk.
const onMac = (): boolean => typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** What the plugin sends on each press (`ShortcutEvent`). */
interface ShortcutEvent {
  shortcut: string;
  state: "Pressed" | "Released";
}

/** Why registering failed: the keys are taken (or refused by the OS), or this build has no plugin. */
export type GlobalCaptureFailure = "taken" | "no-plugin";

/** An IPC error that means the plugin is not in this build, not that the keys were refused. */
export function failureOf(e: unknown): GlobalCaptureFailure {
  const m = String((e as { message?: unknown })?.message ?? e);
  if (/already registered|hotkey|in use/i.test(m)) return "taken";
  return /plugin\b.*\bnot found|unknown command|not allowed/i.test(m) ? "no-plugin" : "taken";
}

/**
 * Register the global shortcut; `onCapture` runs on every press. Resolves
 * to true when the plugin took it; false outside the desktop app, off
 * macOS, or when it failed — then `onFail` says why.
 */
export async function registerGlobalCapture(onCapture: () => void, onFail?: (why: GlobalCaptureFailure) => void): Promise<boolean> {
  if (!isTauri() || !onMac()) return false;
  try {
    const core = await import("@tauri-apps/api/core");
    // The plugin's own JS API does exactly this (plugin:global-shortcut|register
    // with a Channel for the events); calling it directly needs no npm package.
    const handler = new core.Channel<ShortcutEvent>();
    handler.onmessage = (e) => {
      if (e.state !== "Pressed") return;
      void bringToFront();
      onCapture();
    };
    // Registered by an earlier load of the page (a reload keeps the process).
    await core.invoke("plugin:global-shortcut|unregister", { shortcuts: [GLOBAL_CAPTURE_SHORTCUT] }).catch(() => undefined);
    await core.invoke("plugin:global-shortcut|register", { shortcuts: [GLOBAL_CAPTURE_SHORTCUT], handler });
    return true;
  } catch (e) {
    // The OS refused the keys (another app holds ⌥⌘N), or no plugin in this build.
    onFail?.(failureOf(e));
    return false;
  }
}

/** Show and focus the main window (it may be hidden or behind other apps). */
async function bringToFront(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
  } catch {
    /* why: not permitted by the capability: the box still opens when the user switches back */
  }
}

/** Tell the user the system-wide shortcut is off, and why (the in-window ways still work). */
export async function reportGlobalCaptureFailure(why: GlobalCaptureFailure): Promise<void> {
  const [{ t }, { toast }] = await Promise.all([import("../i18n"), import("../store/useToastStore"), import("./strings")]);
  if (why === "taken") toast.warn(t("capture.globalShortcut.taken"));
  else (await import("../lib/logger")).log.warn("capture", "global-shortcut plugin missing from this build: the system-wide ⌥⌘N is off");
}

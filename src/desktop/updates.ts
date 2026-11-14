/**
 * Desktop updates, the WebView side (plans 11.5.1, 14.4). The Rust shell checks and
 * installs (`lumen_check_update`, `lumen_install_update`: no parameters since
 * W11.S2; the shell verifies latest.json's own signature before reading it,
 * and the plugin each bundle's); this file only asks it, after the privacy
 * policy: in "local only" nothing is checked, and every check is in the
 * privacy log.
 *
 * Two update channels (plan 14.4): stable follows the latest release; beta
 * also gets beta releases, so new features reach testers first. The
 * channel is the user's choice (default: the build's own channel), handed
 * to the shell with `lumen_set_update_channel` before a check; the shell
 * maps it to one of its two build-time endpoints and never accepts a URL
 * from here.
 */
import { getAiPolicy } from "../ai/policy";
import { recordAppUpdateCheck } from "../ai/privacyLedger";
import { buildChannel, isEnabled, type Channel } from "../flags/flags";

export type UpdateStatus =
  | { state: "not-configured" }
  | { state: "up-to-date"; current: string }
  | { state: "available"; current: string; version: string; notes: string | null };

export type CheckResult = UpdateStatus | { state: "not-desktop" } | { state: "blocked-local-only" };

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const defaultInvoke: Invoke = async (cmd, args) => (await import("@tauri-apps/api/core")).invoke(cmd, args);

const RELEASE_HOST = "github.com";
const CHANNEL_KEY = "lumen-update-channel";
const LAST_CHECK_KEY = "lumen-update-last-check";

/** The update channel: the user's choice, else the build's. */
export function updateChannel(storage: Pick<Storage, "getItem"> | null = safeStorage()): Channel {
  try {
    const v = storage?.getItem(CHANNEL_KEY);
    if (v === "beta" || v === "stable") return v;
  } catch {
    /* storage blocked */
  }
  return buildChannel();
}

export function setUpdateChannel(channel: Channel, storage: Pick<Storage, "setItem"> | null = safeStorage()): void {
  try {
    storage?.setItem(CHANNEL_KEY, channel);
  } catch {
    /* storage blocked: this session only */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

export async function checkForUpdate(deps: { invoke?: Invoke; desktop?: boolean; channel?: Channel } = {}): Promise<CheckResult> {
  if (!(deps.desktop ?? isDesktop())) return { state: "not-desktop" };
  if (getAiPolicy() === "local-only") {
    recordAppUpdateCheck(RELEASE_HOST, "blocked");
    return { state: "blocked-local-only" };
  }
  const invoke = deps.invoke ?? defaultInvoke;
  await invoke("lumen_set_update_channel", { channel: deps.channel ?? updateChannel() });
  const status = await invoke<UpdateStatus>("lumen_check_update");
  if (status.state !== "not-configured") recordAppUpdateCheck(RELEASE_HOST, "allowed");
  return status;
}

export async function installUpdate(deps: { invoke?: Invoke } = {}): Promise<void> {
  if (getAiPolicy() === "local-only") throw new Error("local-only");
  recordAppUpdateCheck(RELEASE_HOST, "allowed");
  // W11.S2: installs the update the last check verified; nothing is passed.
  await (deps.invoke ?? defaultInvoke)("lumen_install_update");
}

/** One automatic check a day at most. */
export const LAUNCH_CHECK_EVERY_MS = 24 * 60 * 60 * 1000;

export function shouldCheckOnLaunch(lastIso: string | null, now: number): boolean {
  const last = lastIso ? Date.parse(lastIso) : NaN;
  return !Number.isFinite(last) || now - last >= LAUNCH_CHECK_EVERY_MS || last > now;
}

/**
 * The beta flag `update.checkOnLaunch`: in beta builds, check once a day at
 * launch so testers get fixes quickly. Off in stable until promoted; never
 * in local-only (checkForUpdate refuses, and that is logged); quiet unless
 * there is an update.
 */
export async function launchUpdateCheck(deps: { invoke?: Invoke; desktop?: boolean; now?: number; storage?: Pick<Storage, "getItem" | "setItem"> | null; enabled?: boolean } = {}): Promise<CheckResult | null> {
  if (!(deps.desktop ?? isDesktop())) return null;
  if (!(deps.enabled ?? isEnabled("update.checkOnLaunch"))) return null;
  if (getAiPolicy() === "local-only") return null;
  const storage = deps.storage === undefined ? safeStorage() : deps.storage;
  const now = deps.now ?? Date.now();
  let last: string | null = null;
  try {
    last = storage?.getItem(LAST_CHECK_KEY) ?? null;
  } catch {
    /* storage blocked */
  }
  if (!shouldCheckOnLaunch(last, now)) return null;
  try {
    storage?.setItem(LAST_CHECK_KEY, new Date(now).toISOString());
  } catch {
    /* storage blocked */
  }
  return checkForUpdate({ invoke: deps.invoke, desktop: true });
}

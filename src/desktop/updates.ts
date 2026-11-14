/**
 * Desktop updates, the WebView side (plan 11.5.1). The Rust shell checks and
 * installs (`update_check`, `update_install`, signature verified by
 * tauri-plugin-updater); this file only asks it, after the privacy policy:
 * in "local only" nothing is checked, and every check is in the privacy log.
 */
import { getAiPolicy } from "../ai/policy";
import { recordAppUpdateCheck } from "../ai/privacyLedger";

export type UpdateStatus =
  | { state: "not-configured" }
  | { state: "up-to-date"; current: string }
  | { state: "available"; current: string; version: string; notes: string | null };

export type CheckResult = UpdateStatus | { state: "not-desktop" } | { state: "blocked-local-only" };

type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

const isDesktop = () => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
const defaultInvoke: Invoke = async (cmd, args) => (await import("@tauri-apps/api/core")).invoke(cmd, args);

const RELEASE_HOST = "github.com";

export async function checkForUpdate(deps: { invoke?: Invoke; desktop?: boolean } = {}): Promise<CheckResult> {
  if (!(deps.desktop ?? isDesktop())) return { state: "not-desktop" };
  if (getAiPolicy() === "local-only") {
    recordAppUpdateCheck(RELEASE_HOST, "blocked");
    return { state: "blocked-local-only" };
  }
  const status = await (deps.invoke ?? defaultInvoke)<UpdateStatus>("update_check");
  if (status.state !== "not-configured") recordAppUpdateCheck(RELEASE_HOST, "allowed");
  return status;
}

export async function installUpdate(deps: { invoke?: Invoke } = {}): Promise<void> {
  if (getAiPolicy() === "local-only") throw new Error("local-only");
  recordAppUpdateCheck(RELEASE_HOST, "allowed");
  await (deps.invoke ?? defaultInvoke)("update_install");
}

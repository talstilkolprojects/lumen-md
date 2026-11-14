/** Plan 11.5.1 — the WebView side of desktop updates: policy first, every check in the privacy log. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, installUpdate } from "../desktop/updates";
import { __resetLedger, ledgerEntries } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

describe("desktop updates", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLedger();
  });

  it("does nothing outside the desktop app", async () => {
    const invoke = vi.fn();
    expect(await checkForUpdate({ invoke, desktop: false })).toEqual({ state: "not-desktop" });
    expect(invoke).not.toHaveBeenCalled();
  });

  it("in local-only: no request, and the refusal is in the privacy log", async () => {
    setAiPolicy("local-only");
    const invoke = vi.fn();
    expect(await checkForUpdate({ invoke, desktop: true })).toEqual({ state: "blocked-local-only" });
    expect(invoke).not.toHaveBeenCalled();
    expect(ledgerEntries().at(-1)).toMatchObject({ host: "github.com", decision: "blocked" });
    await expect(installUpdate({ invoke })).rejects.toThrow("local-only");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("otherwise asks the Rust shell and logs the check", async () => {
    setAiPolicy("local-first");
    const invoke = vi.fn().mockResolvedValue({ state: "available", current: "0.1.0", version: "0.2.0", notes: null });
    expect(await checkForUpdate({ invoke, desktop: true })).toMatchObject({ state: "available", version: "0.2.0" });
    expect(invoke).toHaveBeenCalledWith("update_check");
    expect(ledgerEntries().at(-1)).toMatchObject({ host: "github.com", decision: "allowed", reason: expect.stringMatching(/update check/) });
  });

  it("a build without update keys sends nothing and logs nothing", async () => {
    setAiPolicy("cloud");
    const invoke = vi.fn().mockResolvedValue({ state: "not-configured" });
    expect(await checkForUpdate({ invoke, desktop: true })).toEqual({ state: "not-configured" });
    expect(ledgerEntries()).toHaveLength(0);
  });
});

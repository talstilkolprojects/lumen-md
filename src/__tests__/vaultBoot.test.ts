/**
 * Start-up when the vault-location chunk can't load (plan 4.2, review): the
 * vault would stay closed. It is retried when the browser is back online, and
 * a bar offers "Try again" (a second failure reloads the page).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { openVaultAtBoot } from "../storage/vault/boot";

const bar = () => document.getElementById("lumen-vault-boot-failed");
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => bar()?.remove());

describe("openVaultAtBoot", () => {
  it("opens quietly when the location code loads", async () => {
    const load = vi.fn().mockResolvedValue(undefined);
    await openVaultAtBoot({ load });
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    expect(bar()).toBeNull();
  });

  it("a failed load shows an alert with Try again; trying again opens the vault and takes the bar away", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("Failed to fetch dynamically imported module")).mockResolvedValue(undefined);
    const reload = vi.fn();
    await openVaultAtBoot({ load, reload });
    await tick();
    expect(bar()?.getAttribute("role")).toBe("alert");
    expect(bar()?.textContent).toContain("Try again");
    bar()!.querySelector("button")!.click();
    await tick();
    expect(load).toHaveBeenCalledTimes(2);
    expect(bar()).toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });

  it("back online, it retries by itself", async () => {
    const load = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue(undefined);
    await openVaultAtBoot({ load, reload: vi.fn() });
    await tick();
    expect(bar()).not.toBeNull();
    window.dispatchEvent(new Event("online"));
    await tick();
    expect(load).toHaveBeenCalledTimes(2);
    expect(bar()).toBeNull();
  });

  it("if Try again fails too, the page reloads", async () => {
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    const reload = vi.fn();
    await openVaultAtBoot({ load, reload });
    await tick();
    bar()!.querySelector("button")!.click();
    await tick();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

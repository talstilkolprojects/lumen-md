import { describe, it, expect, vi } from "vitest";
import { persistenceStatus, requestPersistentStorage } from "../storage/persistentStorage";

vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

describe("requestPersistentStorage", () => {
  it("asks the browser to persist the origin and reports success", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(false);
    await expect(requestPersistentStorage({ persist, persisted })).resolves.toBe("persisted");
    expect(persisted).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persistenceStatus()).toBe("persisted");
  });

  it("does not prompt again when the origin is already persisted", async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const persisted = vi.fn().mockResolvedValue(true);
    await expect(requestPersistentStorage({ persist, persisted })).resolves.toBe("persisted");
    expect(persist).not.toHaveBeenCalled();
  });

  it("reports a refusal without throwing", async () => {
    const persist = vi.fn().mockResolvedValue(false);
    const persisted = vi.fn().mockResolvedValue(false);
    await expect(requestPersistentStorage({ persist, persisted })).resolves.toBe("denied");
    expect(persistenceStatus()).toBe("denied");
  });

  it("treats a throwing persist() as a refusal", async () => {
    const persist = vi.fn().mockRejectedValue(new Error("SecurityError"));
    const persisted = vi.fn().mockResolvedValue(false);
    await expect(requestPersistentStorage({ persist, persisted })).resolves.toBe("denied");
  });

  it("is unsupported when there is no StorageManager", async () => {
    await expect(requestPersistentStorage(undefined)).resolves.toBe("unsupported");
    await expect(requestPersistentStorage({} as never)).resolves.toBe("unsupported");
  });

  it("is wired into app startup", async () => {
    // main.tsx boots the whole app; assert on its source so the call
    // cannot quietly disappear in a refactor.
    const src = await import("../main.tsx?raw");
    expect(src.default).toMatch(/requestPersistentStorage\(\)/);
  });
});

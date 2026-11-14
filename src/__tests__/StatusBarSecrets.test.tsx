/** Plan 2.5 — no silent plain mode: unencrypted secrets show in the status bar. */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { StatusBar } from "../ui/StatusBar";
import { __resetSecretStore, initSecretStore, secretStoreMode } from "../lib/secretStore";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetSecretStore();
});

describe("StatusBar — secrets stored unencrypted", () => {
  it("shows a notice as soon as the store falls back to localStorage", async () => {
    __resetSecretStore();
    render(<StatusBar text="x" dirty={false} filename="x.md" />);
    expect(screen.queryByTestId("status-secrets-plain")).toBeNull();
    vi.stubGlobal("indexedDB", undefined); // no IndexedDB: plain mode
    await act(async () => {
      await initSecretStore();
    });
    expect(secretStoreMode()).toBe("plain");
    const badge = screen.getByTestId("status-secrets-plain");
    expect(badge.textContent).toMatch(/KEYS UNENCRYPTED/);
    expect(badge.getAttribute("title")).toMatch(/stored unencrypted in localStorage/);
    expect(badge.getAttribute("role")).toBe("status");
  });

  it("shows nothing when the secrets are encrypted", async () => {
    __resetSecretStore();
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
    render(<StatusBar text="x" dirty={false} filename="x.md" />);
    expect(screen.queryByTestId("status-secrets-plain")).toBeNull();
  });
});

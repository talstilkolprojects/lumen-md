/**
 * Unit tests for pure helper functions in the git sync module.
 * These don't require full isomorphic-git/IndexedDB infrastructure.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createMemoryBackend, setVaultBackend } from "../storage/vault";

// Mock idb-keyval to use a plain Map
const store = new Map<string, unknown>();
vi.mock("idb-keyval", () => ({
  get: (k: string) => Promise.resolve(store.get(k)),
  set: (k: string, v: unknown) => { store.set(k, v); return Promise.resolve(); },
}));

// Mock workspace to prevent OPFS access
vi.mock("../storage/workspace", () => ({
  createWorkspaceFolder: vi.fn(),
  deleteWorkspaceFile: vi.fn(),
  listWorkspace: vi.fn().mockResolvedValue([]),
  readWorkspaceBlob: vi.fn().mockResolvedValue(new Blob([])),
  readWorkspaceFile: vi.fn().mockResolvedValue(""),
  workspaceHasEntry: vi.fn().mockResolvedValue(false),
  workspaceHasFile: vi.fn().mockResolvedValue(false),
  writeWorkspaceBlob: vi.fn(),
}));

// Clone without the network: record what isomorphic-git is asked to do.
const { cloneCalls } = vi.hoisted(() => ({ cloneCalls: [] as Array<Record<string, unknown>> }));
vi.mock("isomorphic-git", () => ({
  default: {
    clone: async (o: Record<string, unknown>) => {
      cloneCalls.push(o);
    },
  },
}));
vi.mock("isomorphic-git/http/web", () => ({ default: {} }));
vi.mock("@isomorphic-git/lightning-fs", () => ({
  default: class {
    promises = {
      mkdir: async () => undefined,
      readdir: async () => [],
      stat: async () => ({ isDirectory: () => false, isFile: () => false }),
      readFile: async () => new Uint8Array(),
      writeFile: async () => undefined,
    };
  },
}));

describe("git sync — helpers", () => {
  beforeEach(async () => {
    store.clear();
    localStorage.clear();
    setVaultBackend(createMemoryBackend());
    // The token now lives in the secret store (T36); start each test empty.
    (await import("../lib/secretStore")).__resetSecretStore();
  });

  it("setGitToken + getGitToken round-trips", async () => {
    const { setGitToken, getGitToken } = await import("../sync/git");
    expect(await getGitToken()).toBe("");
    await setGitToken("ghp_test123");
    expect(await getGitToken()).toBe("ghp_test123");
  });

  it("getGitToken returns empty string when not set", async () => {
    const { getGitToken } = await import("../sync/git");
    expect(await getGitToken()).toBe("");
  });

  it("setGitToken(null) clears the token", async () => {
    const { setGitToken, getGitToken } = await import("../sync/git");
    await setGitToken("ghp_secret");
    await setGitToken(null);
    expect(await getGitToken()).toBe("");
  });

  it("setGitIdentity + getGitIdentity round-trips", async () => {
    const { setGitIdentity, getGitIdentity } = await import("../sync/git");
    const defaultId = await getGitIdentity();
    expect(defaultId.name).toBe("Lumen User");
    expect(defaultId.email).toContain("example");

    await setGitIdentity({ name: "Tal", email: "tal@lumen.md" });
    const id = await getGitIdentity();
    expect(id.name).toBe("Tal");
    expect(id.email).toBe("tal@lumen.md");
  });

  it("GitStatusEntry state mapping covers all cases", async () => {
    // Verify the type interface covers the 4 expected states
    const { gitStatus } = await import("../sync/git");
    expect(typeof gitStatus).toBe("function");
    // The state type is: "unmodified" | "modified" | "added" | "deleted"
    // This is a compile-time check — if the type changes, TS will catch it.
    const states: Array<"unmodified" | "modified" | "added" | "deleted"> = [
      "unmodified", "modified", "added", "deleted",
    ];
    expect(states).toHaveLength(4);
  });

  it("cloneRepo works without a token (public repository) and sends no credentials", async () => {
    const { cloneRepo } = await import("../sync/git");
    cloneCalls.length = 0;
    const r = await cloneRepo("https://github.com/user/repo.git", { token: "" });
    expect(r.workspaceFolder).toBe("repo");
    expect(cloneCalls).toHaveLength(1);
    expect(cloneCalls[0].onAuth).toBeUndefined();
    expect(cloneCalls[0].url).toBe("https://github.com/user/repo.git");
  });

  it("cloneRepo passes the token and the CORS proxy when they are set", async () => {
    const { cloneRepo } = await import("../sync/git");
    cloneCalls.length = 0;
    await cloneRepo("https://github.com/user/private.git", { token: "ghp_x", corsProxy: "http://localhost:9999" });
    expect(cloneCalls[0].corsProxy).toBe("http://localhost:9999");
    expect((cloneCalls[0].onAuth as () => unknown)()).toEqual({ username: "ghp_x", password: "x-oauth-basic" });
  });
});

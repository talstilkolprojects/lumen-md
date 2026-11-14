/** T36 — secrets are encrypted at rest, migrated from plaintext, keychain on desktop. */
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createStore, get, set, keys } from "idb-keyval";
import {
  __resetSecretStore,
  flushSecrets,
  getSecret,
  initSecretStore,
  isSecretName,
  secretStoreMode,
  setSecret,
} from "../lib/secretStore";

const tauriStore = new Map<string, string>();
const faults = { gets: 0, sets: 0 };
vi.mock("@tauri-apps/api/core", () => ({
  invoke: async (cmd: string, args?: { name?: string; value?: string | null }) => {
    if (cmd === "secret_available") return true;
    if (cmd === "secret_get") {
      if (faults.gets > 0 && faults.gets--) throw new Error("keychain locked");
      return tauriStore.get(args!.name!) ?? null;
    }
    if (cmd === "secret_set") {
      if (faults.sets > 0 && faults.sets--) throw new Error("access denied");
      if (args!.value == null) tauriStore.delete(args!.name!);
      else tauriStore.set(args!.name!, args!.value);
      return null;
    }
    throw new Error(cmd);
  },
}));

async function freshDb() {
  __resetSecretStore();
  localStorage.clear();
  const db = createStore("lumen-secrets", "kv");
  for (const k of await keys(db)) await (await import("idb-keyval")).del(k, db);
}

describe("secretStore", () => {
  beforeEach(async () => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
    tauriStore.clear();
    faults.gets = 0;
    faults.sets = 0;
    vi.unstubAllGlobals();
    await freshDb();
  });

  it("knows which names are secrets", () => {
    expect(isSecretName("lumen.ai.key.anthropic")).toBe(true);
    expect(isSecretName("lumen.cloud.dropbox.refresh")).toBe(true);
    expect(isSecretName("lumen.ai.policy")).toBe(false);
    // The Supabase session (plan 2.5).
    expect(isSecretName("sb-abcdefgh-auth-token")).toBe(true);
    expect(isSecretName("sb-abcdefgh-auth-token-code-verifier")).toBe(true);
    expect(isSecretName("sb-abcdefgh-other")).toBe(false);
  });

  it("migrates a Supabase session left in localStorage into the encrypted store", async () => {
    const session = JSON.stringify({ access_token: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1In0.c2ln", refresh_token: "r-123" });
    localStorage.setItem("sb-proj-auth-token", session);
    await initSecretStore();
    expect(localStorage.getItem("sb-proj-auth-token")).toBeNull();
    expect(getSecret("sb-proj-auth-token")).toBe(session);
  });

  it("moves plaintext keys out of localStorage and the legacy git token out of IndexedDB", async () => {
    localStorage.setItem("lumen.ai.key.anthropic", "sk-ant-123");
    localStorage.setItem("lumen.cloud.github.token", "ghp_abc");
    localStorage.setItem("lumen.ai.policy", "local-first");
    await set("lumen.git.token.v1", "ghp_git");
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
    expect(getSecret("lumen.ai.key.anthropic")).toBe("sk-ant-123");
    expect(getSecret("lumen.git.token.v1")).toBe("ghp_git");
    expect(localStorage.getItem("lumen.ai.key.anthropic")).toBeNull();
    expect(localStorage.getItem("lumen.cloud.github.token")).toBeNull();
    expect(localStorage.getItem("lumen.ai.policy")).toBe("local-first");
    expect(await get("lumen.git.token.v1")).toBeUndefined();
  });

  it("stores ciphertext only, and a reload decrypts it again", async () => {
    await initSecretStore();
    setSecret("lumen.ai.key.gemini", "AIza-secret-value");
    await flushSecrets();
    const db = createStore("lumen-secrets", "kv");
    const raw = await get("lumen.ai.key.gemini", db);
    expect(JSON.stringify(raw)).not.toContain("AIza");
    expect(new TextDecoder().decode((raw as { data: ArrayBuffer }).data)).not.toContain("AIza");
    const key = (await get("__key__", db)) as CryptoKey;
    expect(key.extractable).toBe(false);

    __resetSecretStore();
    await initSecretStore();
    expect(getSecret("lumen.ai.key.gemini")).toBe("AIza-secret-value");
    setSecret("lumen.ai.key.gemini", null);
    await flushSecrets();
    expect(await get("lumen.ai.key.gemini", db)).toBeUndefined();
  });

  it("uses the OS keychain in the desktop app; only names stay in localStorage", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    localStorage.setItem("lumen.collab.password", "room-pass");
    await initSecretStore();
    expect(secretStoreMode()).toBe("keychain");
    expect(tauriStore.get("lumen.collab.password")).toBe("room-pass");
    expect(localStorage.getItem("lumen.collab.password")).toBeNull();
    setSecret("lumen.ai.key.mistral", "mk-1");
    await flushSecrets();
    expect(tauriStore.get("lumen.ai.key.mistral")).toBe("mk-1");
    expect(JSON.parse(localStorage.getItem("lumen.secrets.index")!)).toEqual(expect.arrayContaining(["lumen.ai.key.mistral"]));
    expect(localStorage.getItem("lumen.secrets.index")).not.toContain("mk-1");

    __resetSecretStore();
    await initSecretStore();
    expect(getSecret("lumen.ai.key.mistral")).toBe("mk-1");
  });

  it("stays on the keychain after a transient read error", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    tauriStore.set("lumen.ai.key.a", "ka");
    tauriStore.set("lumen.ai.key.b", "kb");
    localStorage.setItem("lumen.secrets.index", JSON.stringify(["lumen.ai.key.a", "lumen.ai.key.b"]));
    faults.gets = 1; // first read fails once, the retry succeeds
    await initSecretStore();
    expect(secretStoreMode()).toBe("keychain");
    expect(getSecret("lumen.ai.key.a")).toBe("ka");
    expect(getSecret("lumen.ai.key.b")).toBe("kb");

    __resetSecretStore();
    faults.gets = 100; // keychain locked for the whole start-up
    await initSecretStore();
    faults.gets = 0;
    expect(secretStoreMode()).toBe("keychain");
    setSecret("lumen.ai.key.c", "kc");
    await flushSecrets();
    expect(tauriStore.get("lumen.ai.key.c")).toBe("kc"); // not IndexedDB
  });

  it("moves the legacy git token to localStorage when WebCrypto is missing", async () => {
    vi.stubGlobal("crypto", { getRandomValues: (a: Uint8Array) => a });
    await set("lumen.git.token.v1", "ghp_old");
    await initSecretStore();
    expect(secretStoreMode()).toBe("plain");
    expect(getSecret("lumen.git.token.v1")).toBe("ghp_old");
    expect(await get("lumen.git.token.v1")).toBeUndefined();
  });

  it("reports a failed write and rolls the in-memory value back", async () => {
    (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
    await initSecretStore();
    await setSecret("lumen.ai.key.x", "old");
    faults.sets = 1;
    const write = setSecret("lumen.ai.key.x", "new");
    await expect(write).rejects.toThrow("access denied");
    await expect(flushSecrets()).rejects.toThrow("access denied");
    expect(getSecret("lumen.ai.key.x")).toBe("old");
    expect(tauriStore.get("lumen.ai.key.x")).toBe("old");
    // The queue still works afterwards, and the failure is reported once.
    await setSecret("lumen.ai.key.x", "newer");
    await expect(flushSecrets()).resolves.toBeUndefined();
    expect(tauriStore.get("lumen.ai.key.x")).toBe("newer");
  });
});

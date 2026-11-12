/**
 * Plan 0.15 — lib/secretStore without module mocks: secret names, the
 * encrypted store (AES-GCM key in IndexedDB), moving plaintext secrets out of
 * localStorage, dropping entries that no longer decrypt, and the plain
 * fallback without IndexedDB. The OS-keychain mode needs the Tauri runtime
 * and is covered by secretStore.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, del, get, keys, set } from "idb-keyval";
import { __resetSecretStore, __setKeychainForTests, flushSecrets, getSecret, initSecretStore, isSecretName, removeSecret, secretStoreMode, setSecret } from "../lib/secretStore";

const g = globalThis as { indexedDB?: unknown };
/** The secret store's own IndexedDB store. */
const kv = () => createStore("lumen-secrets", "kv");
const hadIdb = typeof g.indexedDB !== "undefined";

async function wipe() {
  __resetSecretStore();
  localStorage.clear();
  for (const k of (await keys()) as string[]) await del(k);
  for (const k of (await keys(kv())) as string[]) await del(k, kv());
}

describe("secret store", () => {
  beforeEach(async () => {
    if (!hadIdb) g.indexedDB = {};
    await wipe();
  });
  afterEach(async () => {
    await wipe();
    if (!hadIdb) delete g.indexedDB;
  });

  it("knows which names are secrets", () => {
    expect(isSecretName("lumen.ai.key.openai")).toBe(true);
    expect(isSecretName("lumen.cloud.github.token")).toBe(true);
    expect(isSecretName("lumen.git.token.v1")).toBe(true);
    expect(isSecretName("lumen.ai.keyring")).toBe(false);
    expect(isSecretName("lumen.theme")).toBe(false);
    expect(isSecretName("x.lumen.ai.key.a")).toBe(false);
  });

  it("encrypts secrets, and reads them back after a restart", async () => {
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
    await setSecret("lumen.ai.key.openai", "sk-1");
    await flushSecrets();
    expect(getSecret("lumen.ai.key.openai")).toBe("sk-1");
    const sealed = (await get("lumen.ai.key.openai", kv())) as { iv: Uint8Array; data: ArrayBuffer };
    expect(sealed.iv.length).toBe(12);
    expect(new TextDecoder().decode(sealed.data)).not.toContain("sk-1");
    expect(localStorage.getItem("lumen.ai.key.openai")).toBe(null);
    __resetSecretStore();
    await initSecretStore();
    expect(getSecret("lumen.ai.key.openai")).toBe("sk-1");
  });

  it("removes a secret with null, an empty string or removeSecret", async () => {
    await initSecretStore();
    await setSecret("lumen.ai.key.a", "1");
    await setSecret("lumen.ai.key.b", "2");
    await setSecret("lumen.ai.key.c", "3");
    await setSecret("lumen.ai.key.a", "");
    await setSecret("lumen.ai.key.b", null);
    await removeSecret("lumen.ai.key.c");
    await flushSecrets();
    expect([getSecret("lumen.ai.key.a"), getSecret("lumen.ai.key.b"), getSecret("lumen.ai.key.c")]).toEqual([null, null, null]);
    expect(await get("lumen.ai.key.a", kv())).toBe(undefined);
  });

  it("moves plaintext secrets out of localStorage and leaves other settings", async () => {
    localStorage.setItem("lumen.ai.key.openai", "sk-old");
    localStorage.setItem("lumen.theme", "dark");
    await initSecretStore();
    expect(getSecret("lumen.ai.key.openai")).toBe("sk-old");
    expect(localStorage.getItem("lumen.ai.key.openai")).toBe(null);
    expect(localStorage.getItem("lumen.theme")).toBe("dark");
  });

  it("moves the legacy git token out of the default store", async () => {
    await set("lumen.git.token.v1", "ghp-legacy");
    await initSecretStore();
    expect(getSecret("lumen.git.token.v1")).toBe("ghp-legacy");
  });

  it("drops an entry that no longer decrypts", async () => {
    await initSecretStore();
    await setSecret("lumen.ai.key.ok", "fine");
    await flushSecrets();
    await set("lumen.cloud.github.token", { iv: new Uint8Array(12), data: new ArrayBuffer(32) }, kv());
    __resetSecretStore();
    await initSecretStore();
    expect(getSecret("lumen.cloud.github.token")).toBe(null);
    expect(await get("lumen.cloud.github.token", kv())).toBe(undefined);
    expect(getSecret("lumen.ai.key.ok")).toBe("fine");
  });

  it("falls back to plain storage without IndexedDB", async () => {
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      await initSecretStore();
      expect(secretStoreMode()).toBe("plain");
      await setSecret("lumen.ai.key.x", "v");
      expect(localStorage.getItem("lumen.ai.key.x")).toBe("v");
      expect(getSecret("lumen.ai.key.x")).toBe("v");
      await setSecret("lumen.ai.key.x", "");
      expect(localStorage.getItem("lumen.ai.key.x")).toBe(null);
    } finally {
      g.indexedDB = saved;
    }
  });

  it("keeps the newer secret when the legacy git token is also in the store, and drops an empty one", async () => {
    await initSecretStore();
    await setSecret("lumen.git.token.v1", "ghp-new");
    await flushSecrets();
    __resetSecretStore();
    await set("lumen.git.token.v1", "ghp-old");
    await initSecretStore();
    expect(getSecret("lumen.git.token.v1")).toBe("ghp-new");
    expect(await get("lumen.git.token.v1")).toBe(undefined);
    await removeSecret("lumen.git.token.v1");
    await flushSecrets();
    __resetSecretStore();
    await set("lumen.git.token.v1", "");
    await initSecretStore();
    expect(getSecret("lumen.git.token.v1")).toBe(null);
    expect(await get("lumen.git.token.v1")).toBe(undefined);
  });

  it("without Web Crypto, keeps secrets in plain storage and moves the legacy git token there", async () => {
    const c = globalThis.crypto as unknown as Record<string, unknown>;
    Object.defineProperty(c, "subtle", { value: undefined, configurable: true });
    try {
      await set("lumen.git.token.v1", "ghp-legacy");
      await initSecretStore();
      expect(secretStoreMode()).toBe("plain");
      expect(localStorage.getItem("lumen.git.token.v1")).toBe("ghp-legacy");
      expect(await get("lumen.git.token.v1")).toBe(undefined);
      // An existing plain value wins; the legacy copy is still dropped.
      __resetSecretStore();
      localStorage.setItem("lumen.git.token.v1", "ghp-plain");
      await set("lumen.git.token.v1", "ghp-other");
      await initSecretStore();
      expect(localStorage.getItem("lumen.git.token.v1")).toBe("ghp-plain");
      expect(await get("lumen.git.token.v1")).toBe(undefined);
      // A non-string legacy value is left alone; an empty one is dropped without copying.
      __resetSecretStore();
      localStorage.clear();
      await set("lumen.git.token.v1", 42);
      await initSecretStore();
      expect(localStorage.getItem("lumen.git.token.v1")).toBe(null);
      expect(await get("lumen.git.token.v1")).toBe(42);
      __resetSecretStore();
      await set("lumen.git.token.v1", "");
      await initSecretStore();
      expect(localStorage.getItem("lumen.git.token.v1")).toBe(null);
      expect(await get("lumen.git.token.v1")).toBe(undefined);
    } finally {
      delete c.subtle;
    }
  });

  it("starts uninitialized and initializes once", async () => {
    expect(secretStoreMode()).toBe("uninitialized");
    const a = initSecretStore();
    expect(initSecretStore()).toBe(a);
    await a;
  });

  it("returns null, not undefined, for a missing secret, and keeps the key unextractable", async () => {
    await initSecretStore();
    expect(getSecret("lumen.ai.key.none")).toBe(null);
    const key = (await get("__key__", kv())) as CryptoKey;
    expect(key.extractable).toBe(false);
  });

  it("rolls a failed write back and reports it once from flushSecrets", async () => {
    await initSecretStore();
    await setSecret("lumen.ai.key.r", "v1");
    await flushSecrets();
    const realSubtle = crypto.subtle.encrypt.bind(crypto.subtle);
    (crypto.subtle as { encrypt: unknown }).encrypt = () => Promise.reject(new Error("disk full"));
    try {
      await expect(setSecret("lumen.ai.key.r", "v2")).rejects.toThrow("disk full");
      expect(getSecret("lumen.ai.key.r")).toBe("v1");
      (crypto.subtle as { encrypt: unknown }).encrypt = () => Promise.reject(new Error("quota"));
      await expect(setSecret("lumen.ai.key.new", "x")).rejects.toThrow("quota");
      expect(getSecret("lumen.ai.key.new")).toBe(null);
      // The first failure since the last flush, then nothing.
      await expect(flushSecrets()).rejects.toThrow("disk full");
      await flushSecrets();
    } finally {
      (crypto.subtle as { encrypt: unknown }).encrypt = realSubtle;
    }
    await setSecret("lumen.ai.key.r", "v3");
    await flushSecrets();
    expect(getSecret("lumen.ai.key.r")).toBe("v3");
  });
});

describe("secret store in the OS keychain (desktop)", () => {
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  let store: Map<string, string>;
  let calls: string[];
  let failGet: number;
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(cmd);
    const name = args?.name as string;
    if (cmd === "secret_available") return available as T;
    if (cmd === "secret_get") {
      if (failGet > 0) {
        failGet--;
        throw new Error("locked");
      }
      return (store.get(name) ?? null) as T;
    }
    if (cmd === "secret_set") {
      const v = args?.value as string | null;
      if (v === null) store.delete(name);
      else store.set(name, v);
      return undefined as T;
    }
    throw new Error(cmd);
  };
  let available = true;
  const hadWindow = typeof w.window !== "undefined";

  beforeEach(async () => {
    if (!hadIdb) g.indexedDB = {};
    await wipe();
    store = new Map();
    calls = [];
    failGet = 0;
    available = true;
    w.window ??= {};
    w.window.__TAURI_INTERNALS__ = {};
    __setKeychainForTests(invoke);
  });
  afterEach(async () => {
    __setKeychainForTests(null);
    if (w.window) delete w.window.__TAURI_INTERNALS__;
    if (!hadWindow) delete w.window;
    await wipe();
    if (!hadIdb) delete g.indexedDB;
  });

  it("uses the keychain when it is available, and keeps an index of the names", async () => {
    await initSecretStore();
    expect(secretStoreMode()).toBe("keychain");
    await setSecret("lumen.ai.key.k", "v");
    await flushSecrets();
    expect(store.get("lumen.ai.key.k")).toBe("v");
    expect(getSecret("lumen.ai.key.k")).toBe("v");
    expect(JSON.parse(localStorage.getItem("lumen.secrets.index")!)).toEqual(["lumen.ai.key.k"]);
    await removeSecret("lumen.ai.key.k");
    await flushSecrets();
    expect(store.has("lumen.ai.key.k")).toBe(false);
    expect(JSON.parse(localStorage.getItem("lumen.secrets.index")!)).toEqual([]);
    expect(getSecret("lumen.ai.key.k")).toBe(null);
  });

  it("reads the indexed names at start, retrying a failed read once", async () => {
    store.set("lumen.ai.key.a", "A");
    store.set("lumen.ai.key.b", "B");
    localStorage.setItem("lumen.secrets.index", JSON.stringify(["lumen.ai.key.a", "lumen.ai.key.b", 5, "lumen.ai.key.gone"]));
    failGet = 1;
    await initSecretStore();
    expect(getSecret("lumen.ai.key.a")).toBe("A");
    expect(getSecret("lumen.ai.key.b")).toBe("B");
    expect(getSecret("lumen.ai.key.gone")).toBe(null);
    expect(calls.filter((c) => c === "secret_get").length).toBe(4);
  });

  it("ignores a broken index", async () => {
    localStorage.setItem("lumen.secrets.index", "{not json");
    await initSecretStore();
    expect(secretStoreMode()).toBe("keychain");
    localStorage.setItem("lumen.secrets.index", JSON.stringify({ a: 1 }));
  });

  it("moves plaintext secrets into the keychain", async () => {
    localStorage.setItem("lumen.ai.key.p", "plain");
    await initSecretStore();
    expect(store.get("lumen.ai.key.p")).toBe("plain");
    expect(localStorage.getItem("lumen.ai.key.p")).toBe(null);
  });

  it("falls back to the encrypted store when asking the keychain fails", async () => {
    __setKeychainForTests(async () => {
      throw new Error("no keychain");
    });
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
  });

  it("falls back to the encrypted store when the keychain is unavailable or missing", async () => {
    available = false;
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
    __resetSecretStore();
    if (w.window) delete w.window.__TAURI_INTERNALS__;
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
  });
});

/**
 * Plan 0.15 — lib/secretStore without module mocks: secret names, the
 * encrypted store (AES-GCM key in IndexedDB), moving plaintext secrets out of
 * localStorage, dropping entries that no longer decrypt, and the plain
 * fallback without IndexedDB. The OS-keychain mode needs the Tauri runtime
 * and is covered by secretStore.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, del, get, keys, set } from "idb-keyval";
import { __resetSecretStore, __setKeychainForTests, flushSecrets, getSecret, initSecretStore, isSecretName, removeSecret, secretStoreMode, setSecret } from "../lib/secretStore";

const g = globalThis as { indexedDB?: unknown };
/** The secret store's own IndexedDB store. */
const kv = () => createStore("lumen-secrets", "kv");
const hadIdb = typeof g.indexedDB !== "undefined";

async function wipe() {
  __resetSecretStore();
  localStorage.clear();
  for (const k of (await keys()) as string[]) await del(k);
  for (const k of (await keys(kv())) as string[]) await del(k, kv());
}

describe("secret store", () => {
  beforeEach(async () => {
    if (!hadIdb) g.indexedDB = {};
    await wipe();
  });
  afterEach(async () => {
    await wipe();
    if (!hadIdb) delete g.indexedDB;
  });

  it("knows which names are secrets", () => {
    expect(isSecretName("lumen.ai.key.openai")).toBe(true);
    expect(isSecretName("lumen.cloud.github.token")).toBe(true);
    expect(isSecretName("lumen.git.token.v1")).toBe(true);
    expect(isSecretName("lumen.ai.keyring")).toBe(false);
    expect(isSecretName("lumen.theme")).toBe(false);
    expect(isSecretName("x.lumen.ai.key.a")).toBe(false);
  });

  it("encrypts secrets, and reads them back after a restart", async () => {
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
    await setSecret("lumen.ai.key.openai", "sk-1");
    await flushSecrets();
    expect(getSecret("lumen.ai.key.openai")).toBe("sk-1");
    const sealed = (await get("lumen.ai.key.openai", kv())) as { iv: Uint8Array; data: ArrayBuffer };
    expect(sealed.iv.length).toBe(12);
    expect(new TextDecoder().decode(sealed.data)).not.toContain("sk-1");
    expect(localStorage.getItem("lumen.ai.key.openai")).toBe(null);
    __resetSecretStore();
    await initSecretStore();
    expect(getSecret("lumen.ai.key.openai")).toBe("sk-1");
  });

  it("removes a secret with null, an empty string or removeSecret", async () => {
    await initSecretStore();
    await setSecret("lumen.ai.key.a", "1");
    await setSecret("lumen.ai.key.b", "2");
    await setSecret("lumen.ai.key.c", "3");
    await setSecret("lumen.ai.key.a", "");
    await setSecret("lumen.ai.key.b", null);
    await removeSecret("lumen.ai.key.c");
    await flushSecrets();
    expect([getSecret("lumen.ai.key.a"), getSecret("lumen.ai.key.b"), getSecret("lumen.ai.key.c")]).toEqual([null, null, null]);
    expect(await get("lumen.ai.key.a", kv())).toBe(undefined);
  });

  it("moves plaintext secrets out of localStorage and leaves other settings", async () => {
    localStorage.setItem("lumen.ai.key.openai", "sk-old");
    localStorage.setItem("lumen.theme", "dark");
    await initSecretStore();
    expect(getSecret("lumen.ai.key.openai")).toBe("sk-old");
    expect(localStorage.getItem("lumen.ai.key.openai")).toBe(null);
    expect(localStorage.getItem("lumen.theme")).toBe("dark");
  });

  it("moves the legacy git token out of the default store", async () => {
    await set("lumen.git.token.v1", "ghp-legacy");
    await initSecretStore();
    expect(getSecret("lumen.git.token.v1")).toBe("ghp-legacy");
  });

  it("drops an entry that no longer decrypts", async () => {
    await initSecretStore();
    await setSecret("lumen.ai.key.ok", "fine");
    await flushSecrets();
    await set("lumen.cloud.github.token", { iv: new Uint8Array(12), data: new ArrayBuffer(32) }, kv());
    __resetSecretStore();
    await initSecretStore();
    expect(getSecret("lumen.cloud.github.token")).toBe(null);
    expect(await get("lumen.cloud.github.token", kv())).toBe(undefined);
    expect(getSecret("lumen.ai.key.ok")).toBe("fine");
  });

  it("falls back to plain storage without IndexedDB", async () => {
    const saved = g.indexedDB;
    delete g.indexedDB;
    try {
      await initSecretStore();
      expect(secretStoreMode()).toBe("plain");
      await setSecret("lumen.ai.key.x", "v");
      expect(localStorage.getItem("lumen.ai.key.x")).toBe("v");
      expect(getSecret("lumen.ai.key.x")).toBe("v");
      await setSecret("lumen.ai.key.x", "");
      expect(localStorage.getItem("lumen.ai.key.x")).toBe(null);
    } finally {
      g.indexedDB = saved;
    }
  });

  it("keeps the newer secret when the legacy git token is also in the store, and drops an empty one", async () => {
    await initSecretStore();
    await setSecret("lumen.git.token.v1", "ghp-new");
    await flushSecrets();
    __resetSecretStore();
    await set("lumen.git.token.v1", "ghp-old");
    await initSecretStore();
    expect(getSecret("lumen.git.token.v1")).toBe("ghp-new");
    expect(await get("lumen.git.token.v1")).toBe(undefined);
    await removeSecret("lumen.git.token.v1");
    await flushSecrets();
    __resetSecretStore();
    await set("lumen.git.token.v1", "");
    await initSecretStore();
    expect(getSecret("lumen.git.token.v1")).toBe(null);
    expect(await get("lumen.git.token.v1")).toBe(undefined);
  });

  it("without Web Crypto, keeps secrets in plain storage and moves the legacy git token there", async () => {
    const c = globalThis.crypto as unknown as Record<string, unknown>;
    Object.defineProperty(c, "subtle", { value: undefined, configurable: true });
    try {
      await set("lumen.git.token.v1", "ghp-legacy");
      await initSecretStore();
      expect(secretStoreMode()).toBe("plain");
      expect(localStorage.getItem("lumen.git.token.v1")).toBe("ghp-legacy");
      expect(await get("lumen.git.token.v1")).toBe(undefined);
      // An existing plain value wins; the legacy copy is still dropped.
      __resetSecretStore();
      localStorage.setItem("lumen.git.token.v1", "ghp-plain");
      await set("lumen.git.token.v1", "ghp-other");
      await initSecretStore();
      expect(localStorage.getItem("lumen.git.token.v1")).toBe("ghp-plain");
      expect(await get("lumen.git.token.v1")).toBe(undefined);
      // A non-string legacy value is left alone; an empty one is dropped without copying.
      __resetSecretStore();
      localStorage.clear();
      await set("lumen.git.token.v1", 42);
      await initSecretStore();
      expect(localStorage.getItem("lumen.git.token.v1")).toBe(null);
      expect(await get("lumen.git.token.v1")).toBe(42);
      __resetSecretStore();
      await set("lumen.git.token.v1", "");
      await initSecretStore();
      expect(localStorage.getItem("lumen.git.token.v1")).toBe(null);
      expect(await get("lumen.git.token.v1")).toBe(undefined);
    } finally {
      delete c.subtle;
    }
  });

  it("starts uninitialized and initializes once", async () => {
    expect(secretStoreMode()).toBe("uninitialized");
    const a = initSecretStore();
    expect(initSecretStore()).toBe(a);
    await a;
  });

  it("returns null, not undefined, for a missing secret, and keeps the key unextractable", async () => {
    await initSecretStore();
    expect(getSecret("lumen.ai.key.none")).toBe(null);
    const key = (await get("__key__", kv())) as CryptoKey;
    expect(key.extractable).toBe(false);
  });

  it("rolls a failed write back and reports it once from flushSecrets", async () => {
    await initSecretStore();
    await setSecret("lumen.ai.key.r", "v1");
    await flushSecrets();
    const realSubtle = crypto.subtle.encrypt.bind(crypto.subtle);
    (crypto.subtle as { encrypt: unknown }).encrypt = () => Promise.reject(new Error("disk full"));
    try {
      await expect(setSecret("lumen.ai.key.r", "v2")).rejects.toThrow("disk full");
      expect(getSecret("lumen.ai.key.r")).toBe("v1");
      (crypto.subtle as { encrypt: unknown }).encrypt = () => Promise.reject(new Error("quota"));
      await expect(setSecret("lumen.ai.key.new", "x")).rejects.toThrow("quota");
      expect(getSecret("lumen.ai.key.new")).toBe(null);
      // The first failure since the last flush, then nothing.
      await expect(flushSecrets()).rejects.toThrow("disk full");
      await flushSecrets();
    } finally {
      (crypto.subtle as { encrypt: unknown }).encrypt = realSubtle;
    }
    await setSecret("lumen.ai.key.r", "v3");
    await flushSecrets();
    expect(getSecret("lumen.ai.key.r")).toBe("v3");
  });
});

describe("secret store in the OS keychain (desktop)", () => {
  const w = globalThis as { window?: Record<string, unknown> };
  let store: Map<string, string>;
  let calls: string[];
  let failGet: number;
  const invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push(cmd);
    const name = args?.name as string;
    if (cmd === "secret_available") return available as T;
    if (cmd === "secret_get") {
      if (failGet > 0) {
        failGet--;
        throw new Error("locked");
      }
      return (store.get(name) ?? null) as T;
    }
    if (cmd === "secret_set") {
      const v = args?.value as string | null;
      if (v === null) store.delete(name);
      else store.set(name, v);
      return undefined as T;
    }
    throw new Error(cmd);
  };
  let available = true;
  const hadWindow = typeof w.window !== "undefined";

  beforeEach(async () => {
    if (!hadIdb) g.indexedDB = {};
    await wipe();
    store = new Map();
    calls = [];
    failGet = 0;
    available = true;
    w.window ??= {};
    w.window.__TAURI_INTERNALS__ = {};
    __setKeychainForTests(invoke);
  });
  afterEach(async () => {
    __setKeychainForTests(null);
    if (w.window) delete w.window.__TAURI_INTERNALS__;
    if (!hadWindow) delete w.window;
    await wipe();
    if (!hadIdb) delete g.indexedDB;
  });

  it("uses the keychain when it is available, and keeps an index of the names", async () => {
    await initSecretStore();
    expect(secretStoreMode()).toBe("keychain");
    await setSecret("lumen.ai.key.k", "v");
    await flushSecrets();
    expect(store.get("lumen.ai.key.k")).toBe("v");
    expect(getSecret("lumen.ai.key.k")).toBe("v");
    expect(JSON.parse(localStorage.getItem("lumen.secrets.index")!)).toEqual(["lumen.ai.key.k"]);
    await removeSecret("lumen.ai.key.k");
    await flushSecrets();
    expect(store.has("lumen.ai.key.k")).toBe(false);
    expect(JSON.parse(localStorage.getItem("lumen.secrets.index")!)).toEqual([]);
    expect(getSecret("lumen.ai.key.k")).toBe(null);
  });

  it("reads the indexed names at start, retrying a failed read once", async () => {
    store.set("lumen.ai.key.a", "A");
    store.set("lumen.ai.key.b", "B");
    localStorage.setItem("lumen.secrets.index", JSON.stringify(["lumen.ai.key.a", "lumen.ai.key.b", 5, "lumen.ai.key.gone"]));
    failGet = 1;
    await initSecretStore();
    expect(getSecret("lumen.ai.key.a")).toBe("A");
    expect(getSecret("lumen.ai.key.b")).toBe("B");
    expect(getSecret("lumen.ai.key.gone")).toBe(null);
    expect(calls.filter((c) => c === "secret_get").length).toBe(4);
  });

  it("ignores a broken index", async () => {
    localStorage.setItem("lumen.secrets.index", "{not json");
    await initSecretStore();
    expect(secretStoreMode()).toBe("keychain");
    localStorage.setItem("lumen.secrets.index", JSON.stringify({ a: 1 }));
  });

  it("moves plaintext secrets into the keychain", async () => {
    localStorage.setItem("lumen.ai.key.p", "plain");
    await initSecretStore();
    expect(store.get("lumen.ai.key.p")).toBe("plain");
    expect(localStorage.getItem("lumen.ai.key.p")).toBe(null);
  });

  it("falls back to the encrypted store when asking the keychain fails", async () => {
    __setKeychainForTests(async () => {
      throw new Error("no keychain");
    });
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
  });

  it("falls back to the encrypted store when the keychain is unavailable or missing", async () => {
    available = false;
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
    __resetSecretStore();
    if (w.window) delete w.window.__TAURI_INTERNALS__;
    await initSecretStore();
    expect(secretStoreMode()).toBe("encrypted");
  });
});


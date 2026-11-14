/**
 * Plan 2.5 acceptance: after signing in (Supabase, mocked), a scan of
 * localStorage, sessionStorage and every IndexedDB database finds no
 * plaintext secret — neither a token-shaped value nor a known secret key
 * holding one.
 *
 * The fake @supabase/supabase-js (passed as `loadSdk`; the optional package is
 * not installed here) persists its session the way the real
 * client does: JSON under `sb-<project ref>-auth-token` in `auth.storage`,
 * falling back to localStorage when no storage is given. So the test fails
 * if the provider stops passing the secret store as `auth.storage`.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetSecretStore, flushSecrets, initSecretStore, isSecretName } from "../lib/secretStore";

const ACCESS = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEiLCJyb2xlIjoiYXV0aGVudGljYXRlZCJ9.c2lnbmF0dXJlLXNlY3JldA";
const REFRESH = "v1.refresh-Zq8mX4nR2pT7wK9s";
const PASSWORD = "correct horse battery staple";
const ENV = { url: "https://proj.supabase.co", anonKey: "anon-public-key" };

type Storage = { getItem(k: string): unknown; setItem(k: string, v: string): unknown; removeItem(k: string): unknown };
const fakeSdk = () => Promise.resolve({
  createClient: (url: string, _key: string, opts?: { auth?: { storage?: Storage; storageKey?: string } }) => {
    const storage: Storage = opts?.auth?.storage ?? localStorage;
    const key = opts?.auth?.storageKey ?? `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
    const user = { id: "user-1", email: "tal@example.com", user_metadata: { name: "Tal" } };
    return {
      auth: {
        async signInWithPassword({ password }: { email: string; password: string }) {
          if (password !== PASSWORD) return { data: { user: null }, error: { message: "bad" } };
          await storage.setItem(key, JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, token_type: "bearer", user }));
          return { data: { user }, error: null };
        },
        async getSession() {
          const raw = (await storage.getItem(key)) as string | null;
          return { data: { session: raw ? JSON.parse(raw) : null } };
        },
        async signUp() {
          return { data: { user: null }, error: { message: "n/a" } };
        },
        async signInWithOAuth() {
          return { error: null };
        },
        async signOut() {
          await storage.removeItem(key);
          return { error: null };
        },
      },
    };
  },
});

const JWT = /eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/;
const KNOWN = [ACCESS, REFRESH, PASSWORD];

function leaks(where: string, key: string, value: unknown, out: string[]) {
  const text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value) ?? ""; } catch { return ""; } })();
  if (JWT.test(text) || KNOWN.some((k) => text.includes(k))) out.push(`${where}: ${key}`);
  else if (isSecretName(key) && text && text !== "null" && !/^\{"iv":/.test(text)) out.push(`${where}: ${key} (known secret key, plaintext value)`);
}

/** Every key/value in localStorage, sessionStorage and all IndexedDB databases. */
async function scanStorage(): Promise<string[]> {
  const out: string[] = [];
  for (const [where, st] of [["localStorage", localStorage], ["sessionStorage", sessionStorage]] as const) {
    for (let i = 0; i < st.length; i++) {
      const k = st.key(i)!;
      leaks(where, k, st.getItem(k), out);
    }
  }
  for (const info of await indexedDB.databases()) {
    const db = await new Promise<IDBDatabase>((res, rej) => {
      const r = indexedDB.open(info.name!);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    for (const store of Array.from(db.objectStoreNames)) {
      const tx = db.transaction(store, "readonly");
      const os = tx.objectStore(store);
      const [ks, vs] = await Promise.all(
        [os.getAllKeys(), os.getAll()].map((r) => new Promise<unknown[]>((res, rej) => ((r.onsuccess = () => res(r.result as unknown[])), (r.onerror = () => rej(r.error))))),
      );
      // Sealed values are { iv: Uint8Array, data: ArrayBuffer }: JSON shows no plaintext.
      ks.forEach((k, i) => leaks(`indexedDB ${info.name}/${store}`, String(k), vs[i], out));
    }
    db.close();
  }
  return out;
}

beforeEach(() => {
  __resetSecretStore();
  localStorage.clear();
  sessionStorage.clear();
});

describe("plan 2.5 — no plaintext secrets after sign-in", () => {
  it("the scan itself catches a plaintext session (the default supabase-js behaviour)", async () => {
    localStorage.setItem("sb-proj-auth-token", JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH }));
    expect(await scanStorage()).toEqual(["localStorage: sb-proj-auth-token"]);
  });

  it("signing in leaves 0 plaintext tokens in localStorage, sessionStorage and IndexedDB", async () => {
    vi.resetModules();
    const { createSupabaseProvider } = await import("../auth/supabaseProvider");
    const { initSecretStore: init } = await import("../lib/secretStore");
    await init();
    const provider = (await createSupabaseProvider({ loadSdk: fakeSdk, env: ENV }))!;
    expect(provider).not.toBeNull();
    const user = await provider.signInWithPassword!("tal@example.com", PASSWORD);
    expect(user.id).toBe("user-1");
    const { flushSecrets: flush } = await import("../lib/secretStore");
    await flush();
    expect(await scanStorage()).toEqual([]);
    // The session is still there for the next load and the API calls.
    expect(await provider.getAccessToken!()).toBe(ACCESS);
    expect((await provider.loadSession())?.email).toBe("tal@example.com");
  });

  it("a session an older build left in localStorage is migrated on start, then the scan is clean", async () => {
    localStorage.setItem("sb-proj-auth-token", JSON.stringify({ access_token: ACCESS, refresh_token: REFRESH, user: { id: "user-1", email: "tal@example.com" } }));
    await initSecretStore();
    await flushSecrets();
    expect(await scanStorage()).toEqual([]);
    vi.resetModules();
    const { createSupabaseProvider } = await import("../auth/supabaseProvider");
    // A fresh module graph has its own (empty) store state; it re-reads the encrypted copy.
    expect((await (await createSupabaseProvider({ loadSdk: fakeSdk, env: ENV }))!.loadSession())?.id).toBe("user-1");
  });
});

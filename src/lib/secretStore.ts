/**
 * Encrypted store for API keys and tokens (T36).
 *
 * Before: AI keys, cloud OAuth tokens, the GitHub token, the collab room
 * password and the research search key sat in localStorage (and the git
 * token in IndexedDB) as plain text — readable by anything that copies the
 * browser profile or by a glance in DevTools.
 *
 * Now: each secret is encrypted with AES-GCM-256 under a key that WebCrypto
 * generated as **non-extractable** and that lives only in IndexedDB. The raw
 * key bytes never exist in JavaScript, so a copied profile or a storage
 * export doesn't reveal the secrets. (Honest limit: code running in this
 * origin can still ask WebCrypto to decrypt — this protects data at rest,
 * not against an XSS in the app; the CSP and sanitizer handle that.)
 *
 * The app reads secrets synchronously (many call sites, some in render), so
 * `initSecretStore()` decrypts everything into memory once at startup and
 * migrates any plaintext leftovers. Writes update memory at once and are
 * persisted encrypted in the background.
 *
 * In the desktop app on macOS / Windows the secrets go to the OS keychain
 * instead (Rust commands `secret_get` / `secret_set`); only their names are
 * kept, in localStorage, so the app knows what to load.
 *
 * Where IndexedDB or WebCrypto is missing (old engines, some tests), the
 * store falls back to the old localStorage behaviour and says so via
 * `secretStoreMode()`.
 */
import { createStore, get, set, del, keys, type UseStore } from "idb-keyval";

const KEY_ENTRY = "__key__";
const PREFIX_SECRETS = ["lumen.ai.key."];
const EXACT_SECRETS = new Set([
  "lumen.cloud.dropbox.token",
  "lumen.cloud.dropbox.refresh",
  "lumen.cloud.gdrive.token",
  "lumen.cloud.gdrive.refresh",
  "lumen.cloud.github.token",
  "lumen.collab.password",
  "lumen.collab.wsToken",
  "lumen.research.searchKey",
  "lumen.research.token",
  "lumen.git.token.v1",
]);
/** The git token used to live in idb-keyval's default store. */
const LEGACY_IDB_SECRETS = ["lumen.git.token.v1"];

export function isSecretName(name: string): boolean {
  return EXACT_SECRETS.has(name) || PREFIX_SECRETS.some((p) => name.startsWith(p));
}

interface Sealed {
  iv: Uint8Array<ArrayBuffer>;
  data: ArrayBuffer;
}

let db: UseStore | null = null;
let cryptoKey: CryptoKey | null = null;
type Mode = "keychain" | "encrypted" | "plain" | "uninitialized";
let mode: Mode = "uninitialized";
const INDEX_KEY = "lumen.secrets.index";
type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
let invoke: Invoke | null = null;
const cache = new Map<string, string>();
let initPromise: Promise<void> | null = null;
let pending: Promise<unknown> = Promise.resolve();

export function secretStoreMode(): Mode {
  return mode;
}

function lsGet(name: string): string | null {
  try {
    return localStorage.getItem(name);
  } catch {
    return null;
  }
}
function lsSet(name: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(name);
    else localStorage.setItem(name, value);
  } catch {
    /* storage denied */
  }
}

async function seal(value: string): Promise<Sealed> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey!, new TextEncoder().encode(value));
  return { iv, data };
}

async function open(sealed: Sealed): Promise<string> {
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.iv }, cryptoKey!, sealed.data);
  return new TextDecoder().decode(plain);
}

function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readIndex(): string[] {
  try {
    const v: unknown = JSON.parse(lsGet(INDEX_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

async function initKeychain(): Promise<boolean> {
  if (!isTauri()) return false;
  let inv: Invoke;
  try {
    const core = await import("@tauri-apps/api/core");
    inv = core.invoke as Invoke;
    if (!(await inv<boolean>("secret_available"))) return false;
  } catch {
    return false;
  }
  // The keychain is the store from here on. A failing read (keychain locked,
  // access denied) must not switch this session to IndexedDB: the next launch
  // would pick the keychain again and never see what was saved meanwhile.
  invoke = inv;
  mode = "keychain";
  for (const name of readIndex()) {
    let v: string | null = null;
    try {
      v = await inv<string | null>("secret_get", { name });
    } catch {
      try {
        v = await inv<string | null>("secret_get", { name }); // one retry
      } catch (e) {
        console.warn(`[secrets] keychain read failed for ${name}`, e);
      }
    }
    if (v) cache.set(name, v);
  }
  try {
    await migratePlaintext();
  } catch (e) {
    console.warn("[secrets] keychain migration failed", e);
  }
  return true;
}

async function doInit(): Promise<void> {
  if (await initKeychain()) return;
  if (typeof indexedDB === "undefined" || typeof crypto === "undefined" || !crypto.subtle) {
    mode = "plain";
    await migrateLegacyToPlain();
    return;
  }
  try {
    db = createStore("lumen-secrets", "kv");
    let key = (await get(KEY_ENTRY, db)) as CryptoKey | undefined;
    if (!key) {
      key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      await set(KEY_ENTRY, key, db);
    }
    cryptoKey = key;
    for (const name of (await keys(db)) as string[]) {
      if (name === KEY_ENTRY) continue;
      const sealed = (await get(name, db)) as Sealed | undefined;
      if (!sealed) continue;
      try {
        cache.set(name, await open(sealed));
      } catch {
        // Undecryptable (key lost): drop it rather than keep garbage.
        await del(name, db);
      }
    }
    mode = "encrypted";
    await migratePlaintext();
  } catch {
    db = null;
    cryptoKey = null;
    mode = "plain";
    await migrateLegacyToPlain();
  }
}

/**
 * Plain mode reads secrets from localStorage, so a git token still in the
 * legacy idb-keyval store (IndexedDB present, WebCrypto not — e.g. a
 * non-secure context) is moved there instead of looking lost.
 */
async function migrateLegacyToPlain(): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  for (const name of LEGACY_IDB_SECRETS) {
    try {
      const v = (await get(name)) as string | undefined;
      if (typeof v !== "string") continue;
      if (v && lsGet(name) === null) lsSet(name, v);
      if (!v || lsGet(name) !== null) await del(name);
    } catch {
      /* default idb-keyval store unavailable */
    }
  }
}

/** Move plaintext secrets from localStorage / legacy IndexedDB into the store. */
async function migratePlaintext(): Promise<void> {
  const names: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && isSecretName(k)) names.push(k);
    }
  } catch {
    /* no localStorage */
  }
  for (const name of names) {
    const value = lsGet(name);
    if (value === null) continue;
    if (!cache.has(name)) await persist(name, value);
    lsSet(name, null);
  }
  for (const name of LEGACY_IDB_SECRETS) {
    try {
      const v = (await get(name)) as string | undefined;
      if (typeof v === "string") {
        if (v && !cache.has(name)) await persist(name, v);
        await del(name);
      }
    } catch {
      /* default idb-keyval store unavailable */
    }
  }
}

async function persist(name: string, value: string | null): Promise<void> {
  if (mode === "keychain" && invoke) {
    await invoke("secret_set", { name, value });
    if (value === null) cache.delete(name);
    else cache.set(name, value);
    const index = new Set(readIndex());
    if (value === null) index.delete(name);
    else index.add(name);
    lsSet(INDEX_KEY, JSON.stringify([...index]));
    return;
  }
  if (value === null) {
    cache.delete(name);
    if (db) await del(name, db);
    return;
  }
  cache.set(name, value);
  if (db && cryptoKey) await set(name, await seal(value), db);
}

/** Decrypt the store into memory. Safe to call many times. */
export function initSecretStore(): Promise<void> {
  return (initPromise ??= doInit());
}

/** The secret, or null. Synchronous: call after initSecretStore() resolved. */
export function getSecret(name: string): string | null {
  if (mode === "encrypted" || mode === "keychain") return cache.get(name) ?? null;
  return lsGet(name);
}

/**
 * Store (or, with null / "", remove) a secret. Memory updates at once; the
 * write persists in the background. The returned promise settles when that
 * write has landed and rejects if it failed (the in-memory value is then
 * rolled back, so the app never shows a credential that won't survive a
 * reload). Fire-and-forget callers may ignore it.
 */
export function setSecret(name: string, value: string | null): Promise<void> {
  const v = value ? value : null;
  if (mode !== "encrypted" && mode !== "keychain") {
    lsSet(name, v);
    return Promise.resolve();
  }
  const prev = cache.get(name) ?? null;
  if (v === null) cache.delete(name);
  else cache.set(name, v);
  const op = pending.then(() => persist(name, v));
  op.catch((e: unknown) => {
    // Roll back unless a later write already replaced the value.
    if ((cache.get(name) ?? null) === v) {
      if (prev === null) cache.delete(name);
      else cache.set(name, prev);
    }
    failures.push(e);
  });
  // Keep the queue usable after a failure.
  pending = op.catch(() => {});
  return op;
}

export function removeSecret(name: string): Promise<void> {
  return setSecret(name, null);
}

const failures: unknown[] = [];

/**
 * Resolves once every background write has landed (tests, export); rejects
 * with the first failure since the previous flush.
 */
export async function flushSecrets(): Promise<void> {
  await pending;
  if (failures.length) {
    const first = failures[0];
    failures.length = 0;
    throw first instanceof Error ? first : new Error(String(first));
  }
}

/** Test hook: forget everything in memory and start over. */
export function __resetSecretStore(): void {
  cache.clear();
  db = null;
  cryptoKey = null;
  mode = "uninitialized";
  initPromise = null;
  invoke = null;
  pending = Promise.resolve();
  failures.length = 0;
}

/**
 * The encrypted sync of this tab (plan 3.5): which provider is connected,
 * whether the vault is unlocked, the last round's result. Lives in the
 * lazy sync chunk; the panel and the periodic sync read it.
 *
 * Keys are never stored: after a reload the passphrase is asked again.
 * Provider settings live in IndexedDB, provider secrets in the secret store.
 */

import { createVault, E2eeSync, unlockVault, type SyncResult } from "../engine";
import { HEADER_NAME } from "../header";
import { dialogResolver, type ConflictResolver } from "../conflict";
import { idbStateStore, type SyncStateStore } from "../state";
import { vaultLocalFiles, type LocalFiles } from "../localFiles";
import { createSyncProvider, loadProviderSettings, saveProviderSecret, saveProviderSettings, type ConnectedProvider, type ProviderSettings } from "../providers";
import type { FetchLike } from "../providers/http";

export type Phase = "disconnected" | "connected" | "unlocked";

export interface SessionState {
  phase: Phase;
  settings: ProviderSettings | null;
  /** Connected: does the provider already hold a vault (unlock) or not (create)? */
  vaultExists: boolean;
  syncing: boolean;
  last: SyncResult | null;
  lastAt: number | null;
  error: string | null;
}

export interface SessionDeps {
  fetch?: FetchLike;
  local?: () => LocalFiles | Promise<LocalFiles>;
  store?: (vaultId: string) => Promise<SyncStateStore>;
  resolver?: ConflictResolver;
  pbkdf2Iterations?: number;
  kdfPolicy?: { minPbkdf2Iterations: number };
  /** Minutes between automatic rounds while unlocked; 0 turns them off. */
  intervalMinutes?: number;
}

const initial = (): SessionState => ({ phase: "disconnected", settings: null, vaultExists: false, syncing: false, last: null, lastAt: null, error: null });

export function createSession(deps: SessionDeps = {}) {
  let state = initial();
  let provider: ConnectedProvider | null = null;
  let engine: E2eeSync | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  const listeners = new Set<(s: SessionState) => void>();

  const set = (patch: Partial<SessionState>) => {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  };

  const local = async (): Promise<LocalFiles> => {
    if (deps.local) return deps.local();
    const { getVaultBackend } = await import("../../../storage/vault");
    return vaultLocalFiles(getVaultBackend());
  };

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
  }
  const onOnline = () => void syncNow().catch(() => undefined);

  async function syncNow(): Promise<SyncResult> {
    if (!engine) throw new Error("The vault is locked");
    set({ syncing: true, error: null });
    try {
      const last = await engine.sync();
      set({ syncing: false, last, lastAt: Date.now() });
      return last;
    } catch (e) {
      set({ syncing: false, error: (e as Error).message ?? String(e) });
      throw e;
    }
  }

  return {
    get: () => state,
    subscribe(l: (s: SessionState) => void): () => void {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    /** The sync engine while unlocked (for the freshness banner and pairing). */
    engine: () => engine,

    /** Show an error in the panel (a failed OAuth return, for one). */
    reportError(message: string): void {
      set({ error: message });
    },

    /** The local side: the open vault. */
    localFiles: local,

    /** Settings saved earlier, to prefill the form. */
    saved: () => loadProviderSettings(),

    /**
     * Check the provider (credentials, conditional writes) and remember it.
     * `secret` is the WebDAV password / S3 secret key; null keeps the stored one.
     */
    async connect(settings: ProviderSettings, secret: string | null): Promise<void> {
      set({ error: null });
      const p = createSyncProvider(settings, { ...(secret !== null ? { secret } : {}), ...(deps.fetch ? { fetch: deps.fetch } : {}) });
      await p.probe?.();
      const vaultExists = !!(await p.get(HEADER_NAME));
      await saveProviderSettings(settings);
      if (secret !== null) await saveProviderSecret(settings.kind, secret);
      provider = p;
      engine = null;
      stopTimer();
      set({ phase: "connected", settings, vaultExists, last: null, lastAt: null });
    },

    /** Create the vault (first device) or unlock it, then run a first round. */
    async open(passphrase: string): Promise<SyncResult> {
      if (!provider) throw new Error("No provider connected");
      const files = await local();
      const makeStore = deps.store ?? idbStateStore;
      let created: Awaited<ReturnType<typeof createVault>> | null = null;
      let keys;
      if (state.vaultExists) keys = (await unlockVault(provider, passphrase, deps.kdfPolicy)).keys;
      else {
        created = await createVault(provider, passphrase, deps.pbkdf2Iterations ? { pbkdf2Iterations: deps.pbkdf2Iterations } : {});
        keys = created.keys;
      }
      engine = new E2eeSync({ provider, keys, local: files, store: await makeStore(keys.vaultId), resolver: deps.resolver ?? dialogResolver });
      if (created) await engine.markCreated(created.anchor);
      set({ phase: "unlocked", vaultExists: true });
      const minutes = deps.intervalMinutes ?? 5;
      if (minutes > 0) {
        timer = setInterval(() => void syncNow().catch(() => undefined), minutes * 60_000);
        if (typeof window !== "undefined") window.addEventListener("online", onOnline);
      }
      return syncNow();
    },

    syncNow,

    /** Lock: forget the keys in memory. The provider stays connected. */
    lock(): void {
      engine = null;
      stopTimer();
      if (provider) set({ phase: "connected" });
    },

    /** Forget the provider: settings and its stored secret. Nothing at the provider is deleted. */
    async disconnect(): Promise<void> {
      const kind = state.settings?.kind;
      stopTimer();
      engine = null;
      provider = null;
      await saveProviderSettings(null);
      if (kind) await saveProviderSecret(kind, null);
      set(initial());
    },
  };
}

export type SyncSession = ReturnType<typeof createSession>;

let current: SyncSession | null = null;
/** The tab's one session. */
export function syncSession(): SyncSession {
  return (current ??= createSession());
}

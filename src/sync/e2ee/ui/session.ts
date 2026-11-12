/**
 * The encrypted sync of this tab (plan 3.5): which provider is connected,
 * whether the vault is unlocked, the last round's result. Lives in the
 * lazy sync chunk; the panel and the periodic sync read it.
 *
 * Keys are never stored: after a reload the passphrase is asked again.
 * Provider settings live in IndexedDB, provider secrets in the secret store.
 *
 * Plan W1.8: the session also keeps what explains the sync — the activity
 * log, the current round's progress and time left, every file's state (and
 * the file tree's badges), this device's selective-sync rules (read again
 * for every round; unreadable rules stop the round), and the background /
 * resume behaviour with its notice.
 *
 * A live provider (the local network, plan W2.19) also syncs right after a
 * local edit and after the other device reports a change.
 */

import { createVault, E2eeSync, unlockVault, type SyncResult } from "../engine";
import { HEADER_NAME } from "../header";
import { dialogResolver, type ConflictResolver } from "../conflict";
import { idbStateStore, type SyncStateStore } from "../state";
import { vaultLocalFiles, type LocalFiles } from "../localFiles";
import { createSyncProvider, loadProviderSettings, saveProviderSecret, saveProviderSettings, type ConnectedProvider, type ProviderSettings } from "../providers";
import type { FetchLike } from "../providers/http";
import { ActivityLog, type SyncEvent } from "../activity";
import { RoundEstimator, type Progress } from "../estimate";
import { compileRules, loadRules, saveRules, type SyncRules } from "../rules";
import { folderStates, type ExcludeRule, type FileStatus, type FileSyncState } from "../status";
import { installBackgroundSync, isNativeApp, type ResumeNotice } from "../background";
import { applyTreeBadges, clearTreeBadges } from "./treeBadges";
import { liveSync } from "../lan/rpc";
import { e2eeErrorText } from "./errorText";
import { explainError } from "../../../lib/userError";

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
  /** The running round's progress and time left (plan W1.8), or null between rounds. */
  progress: Progress | null;
  /** Every file's sync state as of the last round (plus local edits since), or null while locked. */
  files: ReadonlyMap<string, FileStatus> | null;
  folders: ReadonlyMap<string, FileSyncState> | null;
  /** This device's selective-sync rules. */
  rules: SyncRules;
  /** Shown once after the app comes back: sync did not run in the background. */
  notice: NonNullable<ResumeNotice> | null;
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
  /** Draw the file tree's badges (default true; tests turn it off). */
  treeBadges?: boolean;
  /** Follow the page's visibility for background / resume sync (default true). */
  background?: boolean;
  /** The vault's change feed, to mark edits pending between rounds (default: the active vault's). */
  watch?: (listener: (e: { type: string; path: string; from?: string }) => void) => () => void;
  /** Local edits, for live providers (default: the vault's own change feed). */
  watchLocal?: (fn: () => void) => () => void;
  /** Delay before a live round, after the last change (ms). */
  liveDebounceMs?: number;
}

function safeRules(): SyncRules {
  try {
    return loadRules();
  } catch {
    return { folders: [], extensions: [], maxAttachmentBytes: null };
  }
}

const initial = (): SessionState => ({ phase: "disconnected", settings: null, vaultExists: false, syncing: false, last: null, lastAt: null, error: null, progress: null, files: null, folders: null, rules: safeRules(), notice: null });

/** Progress updates at most this often (a first sync of 10,000 notes is 10,000 events). */
const PROGRESS_EVERY_MS = 250;

export function createSession(deps: SessionDeps = {}) {
  let state = initial();
  let provider: ConnectedProvider | null = null;
  let engine: E2eeSync | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopLive: (() => void) | null = null;
  const listeners = new Set<(s: SessionState) => void>();
  const activity = new ActivityLog();
  const estimator = new RoundEstimator();
  let progressAt = 0;
  /** The rules for the running round; replaced at the start of each round. */
  let exclude: ExcludeRule = compileRules(safeRules());
  let unwatch: (() => void) | null = null;
  let unbackground: (() => void) | null = null;

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
    stopLive?.();
    stopLive = null;
    if (typeof window !== "undefined") window.removeEventListener("online", onOnline);
    unwatch?.();
    unwatch = null;
    unbackground?.();
    unbackground = null;
    if (deps.treeBadges !== false) clearTreeBadges();
    set({ files: null, folders: null, progress: null });
  }

  function onEngineEvent(e: SyncEvent) {
    activity.push(e);
    const progress = estimator.push(e);
    const at = Date.now();
    if (e.kind === "start" || e.kind === "done" || e.kind === "error" || at - progressAt >= PROGRESS_EVERY_MS) {
      progressAt = at;
      set({ progress: e.kind === "done" || e.kind === "error" ? null : progress });
    }
  }

  function publishStates(files: ReadonlyMap<string, FileStatus>) {
    const folders = folderStates(files);
    set({ files, folders });
    if (deps.treeBadges !== false) applyTreeBadges(files, folders);
  }

  async function refreshStates(rescan = false): Promise<void> {
    if (!engine) return;
    publishStates(await engine.fileStates({ rescan }));
  }

  /** A note changed between rounds: show it pending (or excluded) at once, without listing the vault. */
  function markChanged(path: string) {
    if (!state.files || state.syncing) return;
    const files = new Map(state.files);
    const why = exclude(path, null);
    files.set(path, why ? { state: "excluded", reason: why } : { state: "pending", direction: "up" });
    publishStates(files);
  }

  async function startWatching() {
    // The active vault's feed, unless the caller brought its own files (tests).
    const watch: SessionDeps["watch"] | null = deps.watch ?? (deps.local ? null : (await import("../../../storage/vault")).watchVault);
    if (!watch) return;
    unwatch?.();
    unwatch = watch((e) => {
      if (e.from) markChanged(e.from);
      markChanged(e.path);
    });
  }
  const onOnline = () => void syncNow().catch(() => undefined);

  async function syncNow(): Promise<SyncResult> {
    if (!engine) throw new Error("The vault is locked");
    set({ syncing: true, error: null });
    try {
      // This device's rules, read for every round. Unreadable rules stop the
      // round (SyncRulesUnreadableError): an excluded file must not leave by accident.
      const rules = loadRules();
      exclude = compileRules(rules);
      if (JSON.stringify(rules) !== JSON.stringify(state.rules)) set({ rules });
      const last = await engine.sync();
      set({ syncing: false, last, lastAt: Date.now() });
      await refreshStates().catch(() => undefined);
      return last;
    } catch (e) {
      set({ syncing: false, error: e2eeErrorText(e, "other", explainError) });
      throw e;
    }
  }

  /** Live providers: a round shortly after a local edit or a change on the other side. */
  async function startLive(p: ConnectedProvider): Promise<void> {
    const live = liveSync(() => (engine ? syncNow() : Promise.resolve()), { debounceMs: deps.liveDebounceMs ?? 300 });
    const offRemote = p.onRemoteChange?.(live.kick);
    let offLocal: () => void;
    if (deps.watchLocal) offLocal = deps.watchLocal(live.kick);
    else {
      const { watchVault } = await import("../../../storage/vault");
      offLocal = watchVault(live.kick);
    }
    stopLive = () => {
      live.stop();
      offRemote?.();
      offLocal();
    };
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
      await provider.unlocked?.(keys);
      engine = new E2eeSync({
        provider,
        keys,
        local: files,
        store: await makeStore(keys.vaultId),
        resolver: deps.resolver ?? dialogResolver,
        exclude: (path, size) => exclude(path, size),
        onEvent: onEngineEvent,
      });
      if (created) await engine.markCreated(created.anchor);
      set({ phase: "unlocked", vaultExists: true });
      const minutes = deps.intervalMinutes ?? 5;
      if (minutes > 0) {
        timer = setInterval(() => void syncNow().catch(() => undefined), minutes * 60_000);
        if (typeof window !== "undefined") window.addEventListener("online", onOnline);
      }
      await startWatching().catch(() => undefined);
      if (deps.background !== false && typeof document !== "undefined") {
        unbackground = installBackgroundSync({
          unlocked: () => engine !== null,
          lastAt: () => state.lastAt,
          syncNow: () => (state.syncing ? Promise.resolve() : syncNow()),
          notify: (notice) => set({ notice }),
          native: isNativeApp,
        });
      }
      if (provider.live) await startLive(provider);
      return syncNow();
    },

    syncNow,

    /** What the sync did, newest last (the activity panel). */
    activity,

    /** Every file's state again, listing the vault (the panel calls it when it opens). */
    refreshStates: () => refreshStates(true),

    /** Save this device's selective-sync rules; they apply from the next round. */
    setRules(rules: SyncRules): SyncRules {
      const saved = saveRules(rules);
      exclude = compileRules(saved);
      set({ rules: saved });
      void refreshStates().catch(() => undefined);
      return saved;
    },

    dismissNotice(): void {
      set({ notice: null });
    },

    /** Lock: forget the keys in memory. The provider stays connected. */
    lock(): void {
      engine = null;
      stopTimer();
      provider?.locked?.();
      if (provider) set({ phase: "connected" });
    },

    /** Forget the provider: settings and its stored secret. Nothing at the provider is deleted. */
    async disconnect(): Promise<void> {
      const kind = state.settings?.kind;
      stopTimer();
      engine = null;
      provider?.locked?.();
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

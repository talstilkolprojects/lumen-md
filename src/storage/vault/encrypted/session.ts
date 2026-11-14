/**
 * The encrypted vault while Lumen runs (plan 11.4): locked or unlocked, the
 * passphrase prompt, auto-lock, and turning encryption on and off.
 *
 * Loaded only for a vault that has an encryption header (the gate in
 * ../index.ts imports it), or when the user opens the encryption dialog.
 *
 * Locked means: no key in memory, every vault call waits (the unlock screen
 * covers the app), nothing in IndexedDB is written in the clear. Unlocking
 * derives the keys from the passphrase or the recovery key. After
 * `autoLockMinutes()` without a key press or a pointer event, the vault
 * locks again.
 */

import { getVaultBackend, refreshVaultEncryption, setVaultEncryptionState, unwrapVaultBackend, vaultEncryptionReady } from "../index";
import type { VaultBackend } from "../types";
import { log } from "../../../lib/logger";
import type { KdfPolicy } from "../../../sync/e2ee/kdf";
import { calibrateArgon2, type Argon2Cost } from "../../../sync/e2ee/kdfCalibrate";
import { setRestSealer } from "../restStore";
import { createEncryptedBackend, createLockedBackend } from "./backend";
import { canRemoveHeader, convertFiles, readHeader, recoverInterrupted, removeHeader, scanVault, writeHeader, type ConvertProgress, type ConvertReport, type ScanReport } from "./convert";
import {
  createRestHeader,
  headerFromRecoveryKey,
  openValue,
  retarget,
  rewrapPassphrase,
  sealValue,
  unlockRestHeader,
  WrongPassphraseError,
  type CreateOptions,
  type RestHeader,
  type RestKeys,
} from "./format";

interface Session {
  inner: VaultBackend;
  /** Null while the header could not be read (then only the recovery key helps). */
  header: RestHeader | null;
  headerError: Error | null;
  keys: RestKeys | null;
  layer: VaultBackend | null;
  waiting: Array<(layer: VaultBackend) => void>;
}

const sessions = new WeakMap<VaultBackend, Session>();
/**
 * Every session that holds keys now, of any vault opened in this run, not
 * only the current one (#529 re-review 14.11, T5): `lock()` forgets them all.
 */
const unlockedSessions = new Set<Session>();
let current: Session | null = null;
/** Tests only: accept cheap KDF parameters (production keeps the 600,000-iteration floor). */
let policy: KdfPolicy = {};
/** Tests only: the Argon2id cost new headers get, instead of this device's calibration. */
let argon2ForTests: Argon2Cost | null = null;
export function setKdfPolicyForTests(p: KdfPolicy & { argon2?: Argon2Cost }): void {
  const { argon2, ...rest } = p;
  policy = rest;
  argon2ForTests = argon2 ?? null;
}

/** The Argon2id cost for a header written now (plan W4.20): ≤ 1 s on this device. */
async function argon2Cost(): Promise<Argon2Cost> {
  if (argon2ForTests) return argon2ForTests;
  const { memoryKiB, iterations, parallelism } = await calibrateArgon2();
  return { memoryKiB, iterations, parallelism };
}

export const LOCKED_EVENT = "lumen-vault-locked";
export const UNLOCKED_EVENT = "lumen-vault-unlocked";

function announce(name: string): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(name));
}

function sessionFor(inner: VaultBackend): Session {
  let s = sessions.get(inner);
  if (!s) sessions.set(inner, (s = { inner, header: null, headerError: null, keys: null, layer: null, waiting: [] }));
  return s;
}

/** What the gate routes an encrypted vault's calls through. */
export async function encryptedLayer(inner: VaultBackend): Promise<VaultBackend> {
  const s = sessionFor(inner);
  current = s;
  try {
    s.header = await readHeader(inner, policy);
    s.headerError = null;
  } catch (err) {
    s.header = null;
    s.headerError = err instanceof Error ? err : new Error(String(err));
  }
  if (!s.keys) {
    setVaultEncryptionState("locked");
    showUnlock();
  } else setVaultEncryptionState("unlocked");
  return createLockedBackend(inner, () => unlocked(s));
}

function unlocked(s: Session): Promise<VaultBackend> {
  if (s.layer) {
    touch();
    return Promise.resolve(s.layer);
  }
  return new Promise((resolve) => s.waiting.push(resolve));
}

function open(s: Session, keys: RestKeys, header: RestHeader): void {
  s.keys = keys;
  unlockedSessions.add(s);
  s.header = header;
  s.headerError = null;
  s.layer = createEncryptedBackend(s.inner, keys, { target: () => s.header?.target ?? "encrypted" });
  setRestSealer({ seal: (label, value) => sealValue(keys, label, value), open: (label, sealed) => openValue(keys, label, sealed), snapshotKeys: keys.snapshot });
  setVaultEncryptionState("unlocked");
  const waiting = s.waiting.splice(0);
  for (const w of waiting) w(s.layer);
  startAutoLock();
  announce(UNLOCKED_EVENT);
}

/** The active vault's session, once the gate has looked for the header. */
async function active(): Promise<Session> {
  await vaultEncryptionReady();
  const inner = unwrapVaultBackend(getVaultBackend());
  const s = sessions.get(inner) ?? current;
  if (!s || s.inner !== inner) throw new Error("The vault is not encrypted");
  return s;
}

/** State of the active vault, for the dialog. */
export function encryptionStatus(): { locked: boolean; headerError: string | null; target: RestHeader["target"] | null } {
  const inner = unwrapVaultBackend(getVaultBackend());
  const s = sessions.get(inner);
  return { locked: !s?.keys, headerError: s?.headerError?.message ?? null, target: s?.header?.target ?? null };
}

/** Unlock with the passphrase. Throws `WrongPassphraseError`. Nothing is written either way. */
export async function unlock(passphrase: string): Promise<void> {
  const s = await active();
  if (!s.header) throw s.headerError ?? new Error("The encryption header is missing");
  open(s, await unlockRestHeader(s.header, passphrase), s.header);
}

/**
 * The unlocked vault's passphrase is derived with PBKDF2 (a vault made
 * before plan W4.20) and can move to Argon2id: the dialog offers it.
 */
export function kdfUpgradeAvailable(): boolean {
  const s = sessions.get(unwrapVaultBackend(getVaultBackend()));
  return !!s?.keys && s.header?.passphrase.kdf.alg === "pbkdf2-sha256";
}

/**
 * Move a PBKDF2 vault to Argon2id, at the user's request only (review
 * 12.11). An unlock never does it: a Lumen from before plan W4.20 that opens
 * the same folder (a desktop app not yet updated, say) can't read an
 * Argon2id header, and nothing records which builds read a vault folder,
 * so only the user can tell when every device is ready. The data key is
 * re-wrapped in a new header (both copies, each checked); no file changes.
 */
export async function upgradeKdf(passphrase: string): Promise<void> {
  const s = await active();
  if (!s.header) throw new Error("The encryption header is missing");
  if (s.header.passphrase.kdf.alg !== "pbkdf2-sha256") return;
  const next = await rewrapPassphrase(s.header, passphrase, { newPassphrase: passphrase, kdf: "argon2id", argon2: await argon2Cost() });
  await writeHeader(s.inner, next.header, policy);
  open(s, next.keys, next.header);
}

/**
 * Forgotten passphrase, or a damaged header: the recovery key opens the
 * vault and a new passphrase is set. The header is rewritten (both copies)
 * only after the recovery key proved right — for a damaged header, by
 * decrypting a file of the vault with it.
 */
export async function recover(recoveryKey: string, newPassphrase: string, opts: CreateOptions = {}): Promise<void> {
  // Also for a vault whose header files are gone: then there is no session yet.
  await vaultEncryptionReady();
  const s = sessionFor(unwrapVaultBackend(getVaultBackend()));
  current = s;
  // What is stored now, not what was read at start-up.
  try {
    s.header = await readHeader(s.inner, policy);
    s.headerError = null;
  } catch (err) {
    s.header = null;
    s.headerError = err instanceof Error ? err : new Error(String(err));
  }
  let next: { header: RestHeader; keys: RestKeys };
  if (s.header) {
    next = await rewrapPassphrase(s.header, recoveryKey, { recovery: true, newPassphrase, argon2: await argon2Cost(), ...opts });
  } else {
    next = await headerFromRecoveryKey(recoveryKey, newPassphrase, "encrypted", { argon2: await argon2Cost(), ...opts });
    const scan = await scanVault(s.inner, next.keys);
    if (scan.encrypted === 0 && scan.broken.length > 0) throw new WrongPassphraseError();
  }
  await writeHeader(s.inner, next.header, policy);
  open(s, next.keys, next.header);
  refreshVaultEncryption();
}

/** A new passphrase (the vault is unlocked; the current passphrase is asked again). */
export async function changePassphrase(currentPassphrase: string, newPassphrase: string, opts: CreateOptions = {}): Promise<void> {
  const s = await active();
  if (!s.header) throw new Error("The encryption header is missing");
  const next = await rewrapPassphrase(s.header, currentPassphrase, { newPassphrase, argon2: await argon2Cost(), ...opts });
  await writeHeader(s.inner, next.header, policy);
  open(s, next.keys, next.header);
}

/**
 * Forget the keys of every encrypted vault opened in this run, not only the
 * current one (T5): switching back to another vault afterwards asks for its
 * passphrase. The unlock screen comes up.
 */
export function lock(): void {
  if (!unlockedSessions.size && !current?.keys) return;
  for (const s of [...unlockedSessions, ...(current ? [current] : [])]) {
    s.keys = null;
    s.layer = null;
  }
  unlockedSessions.clear();
  setRestSealer(null);
  setVaultEncryptionState("locked");
  stopAutoLock();
  announce(LOCKED_EVENT);
  showUnlock();
}

// ── Auto-lock ────────────────────────────────────────────────────────────

const LOCK_KEY = "lumen.vaultLock.minutes";
export const DEFAULT_AUTO_LOCK_MINUTES = 15;
let lastActivity = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

/** Minutes without activity before the vault locks; 0 = never. */
export function autoLockMinutes(): number {
  try {
    const v = localStorage.getItem(LOCK_KEY);
    const n = v === null ? DEFAULT_AUTO_LOCK_MINUTES : Number(v);
    return Number.isFinite(n) && n >= 0 ? n : DEFAULT_AUTO_LOCK_MINUTES;
  } catch {
    return DEFAULT_AUTO_LOCK_MINUTES;
  }
}

export function setAutoLockMinutes(n: number): void {
  try {
    localStorage.setItem(LOCK_KEY, String(Math.max(0, Math.round(n))));
  } catch {
    /* why: storage blocked: the default stays */
  }
}

function touch(): void {
  lastActivity = Date.now();
}

/** One auto-lock check (exported for tests): locks when idle for too long. */
export function checkAutoLock(now = Date.now()): boolean {
  const m = autoLockMinutes();
  if (!m || !unlockedSessions.size || now - lastActivity < m * 60_000) return false;
  lock();
  return true;
}

function startAutoLock(): void {
  touch();
  if (timer || typeof window === "undefined") return;
  window.addEventListener("pointerdown", touch, { passive: true, capture: true });
  window.addEventListener("keydown", touch, { passive: true, capture: true });
  timer = setInterval(() => checkAutoLock(), 30_000);
}

function stopAutoLock(): void {
  if (timer) clearInterval(timer);
  timer = null;
  if (typeof window === "undefined") return;
  window.removeEventListener("pointerdown", touch, { capture: true });
  window.removeEventListener("keydown", touch, { capture: true });
}

function showUnlock(): void {
  if (typeof document === "undefined") return;
  void import("../../../ui/VaultUnlock").then((m) => m.showVaultUnlock()).catch(() => undefined);
}

// ── Turning it on and off ────────────────────────────────────────────────

/** Convert, and again for files that changed meanwhile (at most three passes). */
async function convertAll(inner: VaultBackend, keys: RestKeys, target: RestHeader["target"], onProgress?: (p: ConvertProgress) => void): Promise<ConvertReport> {
  let report = await convertFiles(inner, keys, target, onProgress);
  for (let pass = 1; pass < 3 && report.retry.length; pass++) {
    const again = await convertFiles(inner, keys, target, onProgress);
    report = { ...again, converted: report.converted + again.converted };
  }
  return report;
}

export interface EnableResult {
  recoveryKey: string;
}

/**
 * Turn encryption on for the active vault. The recovery key is made first
 * and handed to `confirmRecoveryKey` (the dialog shows it and waits until
 * the user says it is saved; false cancels, and nothing has been written).
 * Then the header is written, every file is encrypted (copy, check,
 * replace) and so is what Lumen keeps in IndexedDB. If this is cut off, the
 * vault opens with the passphrase and `repair()` finishes it.
 */
export async function enableEncryption(
  passphrase: string,
  opts: CreateOptions & { onProgress?: (p: ConvertProgress) => void; confirmRecoveryKey?: (key: string) => Promise<boolean> } = {},
): Promise<(EnableResult & { report: ConvertReport }) | null> {
  const inner = unwrapVaultBackend(getVaultBackend());
  if (await readHeader(inner, policy).catch(() => "broken")) throw new Error("The vault is already encrypted");
  const { header, keys, recoveryKey } = await createRestHeader(passphrase, { argon2: await argon2Cost(), ...opts });
  if (opts.confirmRecoveryKey && !(await opts.confirmRecoveryKey(recoveryKey))) return null;
  await writeHeader(inner, header, policy);
  const s = sessionFor(inner);
  current = s;
  open(s, keys, header);
  refreshVaultEncryption();
  const report = await convertAll(inner, keys, "encrypted", opts.onProgress);
  await migrateStores("seal");
  // The persisted app state (localStorage) drops the open note's text now.
  try {
    const { useAppStore } = await import("../../../store/useStore");
    useAppStore.setState({});
  } catch {
    /* why: it is dropped at the next change anyway */
  }
  return { recoveryKey, report };
}

/** Check and repair: finish an interrupted conversion, then report what is where. Changes no file that does not decrypt. */
export async function repair(onProgress?: (p: ConvertProgress) => void): Promise<{ report: ConvertReport; scan: ScanReport; recovered: number }> {
  const s = await active();
  if (!s.keys || !s.header) throw new Error("The vault is locked");
  const recovered = await recoverInterrupted(s.inner);
  const report = await convertAll(s.inner, s.keys, s.header.target, onProgress);
  const scan = await scanVault(s.inner, s.keys);
  if (s.header.target === "plain") await finishDisable(s, scan);
  return { report, scan, recovered };
}

/**
 * Turn encryption off: the header first says "plain" (so new writes are
 * plaintext), every file is decrypted (copy, check, replace), history comes
 * back in the clear, traces and the semantic index are deleted; the header
 * is removed last, only when no encrypted file is left.
 */
export async function disableEncryption(passphrase: string, onProgress?: (p: ConvertProgress) => void): Promise<{ report: ConvertReport; scan: ScanReport; done: boolean }> {
  const s = await active();
  if (!s.header) throw new Error("The encryption header is missing");
  // The passphrase again: turning it off is not something an open laptop should allow.
  const keys = await unlockRestHeader(s.header, passphrase);
  const header = await retarget(s.header, keys, "plain");
  await writeHeader(s.inner, header, policy);
  s.header = header;
  const report = await convertAll(s.inner, keys, "plain", onProgress);
  const scan = await scanVault(s.inner, keys);
  const done = await finishDisable(s, scan);
  return { report, scan, done };
}

async function finishDisable(s: Session, scan: ScanReport): Promise<boolean> {
  if (!canRemoveHeader(scan)) return false;
  await migrateStores("open");
  await removeHeader(s.inner);
  sessions.delete(s.inner);
  unlockedSessions.delete(s);
  if (current === s) current = null;
  setRestSealer(null);
  // Review 16, T5-1: another vault opened in this run may still hold keys;
  // its auto-lock keeps running.
  if (!unlockedSessions.size) stopAutoLock();
  refreshVaultEncryption();
  setVaultEncryptionState("none");
  return true;
}

/**
 * What Lumen keeps in IndexedDB, into (or out of) the encryption boundary:
 * agent traces (T10), the semantic index (embeddings and chunk text), the
 * history snapshots and the AI response cache.
 */
async function migrateStores(direction: "seal" | "open"): Promise<void> {
  // Each store on its own: one that can't be reached (no IndexedDB in a
  // private window) must not fail the conversion of the files, which is done.
  const step = async (name: string, job: () => Promise<unknown>) => {
    try {
      await job();
    } catch (err) {
      log.warn(`vault encryption: ${name} not migrated`, err);
    }
  };
  if (direction === "seal") {
    await step("agent traces", async () => (await import("../../../agents/trace")).resealTrace());
    await step("semantic index", async () => (await import("../../../ai/semanticSearch")).resealSemanticIndex());
    await step("history", async () => (await import("../../history")).resealHistory());
    // The vault index snapshot (W2.22) holds note text in the clear and cannot be sealed in its worker: drop it.
    await step("index snapshot", async () => (await import("../../indexSnapshot")).dropSnapshot());
  } else {
    await step("history", async () => (await import("../../history")).unsealHistory());
    await step("agent traces", async () => (await import("../../../agents/trace")).clearTrace());
    await step("semantic index", async () => (await import("../../../ai/semanticSearch")).clearSemanticIndex());
  }
  await step("AI cache", async () => (await import("../../../ai/responseCache")).clearAiCache());
}

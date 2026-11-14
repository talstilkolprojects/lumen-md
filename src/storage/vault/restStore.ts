/**
 * What Lumen keeps in IndexedDB about the notes — agent traces, the semantic
 * index, history snapshots, the AI response cache — inside the vault's
 * encryption boundary (plan 11.4).
 *
 * Small on purpose: it is imported by stores that load early, and the
 * cryptography stays in ./encrypted (loaded only for an encrypted vault).
 *
 *   • Plain vault: values are stored as they are.
 *   • Encrypted and unlocked: values are sealed (AES-GCM, the vault's
 *     "store" key, the store's label as additional data).
 *   • Encrypted and locked: nothing is written (`forStore` → undefined), and
 *     sealed values read as absent.
 */

import { getVaultBackend, vaultEncryptionReady } from "./index";

export interface SealedValue {
  lumenSealed: 1;
  vault: string;
  data: string;
}

export interface RestSealer {
  seal(label: string, value: unknown): Promise<SealedValue>;
  open(label: string, sealed: SealedValue): Promise<unknown>;
}

let sealer: RestSealer | null = null;

/** Set by the encrypted session while the vault is unlocked; null when locked or plain. */
export function setRestSealer(next: RestSealer | null): void {
  sealer = next;
}

export function isSealedValue(v: unknown): v is SealedValue {
  return !!v && typeof v === "object" && (v as { lumenSealed?: unknown }).lumenSealed === 1 && typeof (v as { data?: unknown }).data === "string";
}

/** True when values must not be stored in the clear right now (the vault is encrypted). */
export async function storesMustSeal(): Promise<boolean> {
  // An unavailable vault (still opening) holds no note anyone could have read yet.
  if (!getVaultBackend().available()) return false;
  const state = await vaultEncryptionReady();
  return state === "locked" || state === "unlocked";
}

/** What to store for `value` under `label`; undefined means "store nothing now" (locked vault). */
export async function forStore<T>(label: string, value: T): Promise<T | SealedValue | undefined> {
  if (!(await storesMustSeal())) return value;
  return sealer ? sealer.seal(label, value) : undefined;
}

/** A stored value back; undefined when it is sealed and the vault is locked (or it does not decrypt). */
export async function fromStore<T>(label: string, stored: T | SealedValue | undefined): Promise<T | undefined> {
  if (!isSealedValue(stored)) return stored;
  if (!sealer) await vaultEncryptionReady().catch(() => undefined);
  if (!sealer) return undefined;
  try {
    return (await sealer.open(label, stored)) as T;
  } catch {
    return undefined;
  }
}

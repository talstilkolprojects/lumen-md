/**
 * Passphrase → vault master key (plan 3.4, step 2).
 *
 * The algorithm and its parameters live in the vault header (stored at the
 * provider in the clear, but authenticated: see header.ts), so the KDF can be
 * changed without a format break. Two ids exist from day one:
 *
 *   • "pbkdf2-sha256" — implemented with WebCrypto, ≥ 600,000 iterations
 *     (OWASP Password Storage Cheat Sheet, 2023). Used today.
 *   • "argon2id"      — the plan's choice (memory-hard). Reserved: WebCrypto
 *     has no Argon2id, and the `hash-wasm` package that brings it is not in
 *     the lockfile yet. A header that asks for it is refused with
 *     `KdfUnavailableError` instead of being misread.
 *
 * Passphrases are NFC-normalised first, so the same Hebrew passphrase typed on
 * macOS (which may produce decomposed characters) and on Windows derives the
 * same key.
 */

import { bs, randomBytes, toB64u, fromB64u, utf8 } from "./bytes";

/** OWASP 2023 minimum for PBKDF2-HMAC-SHA256. */
export const PBKDF2_MIN_ITERATIONS = 600_000;
/** What a new vault gets. */
export const PBKDF2_DEFAULT_ITERATIONS = 600_000;

export interface Pbkdf2Params {
  alg: "pbkdf2-sha256";
  iterations: number;
  /** base64url, 16 random bytes. */
  salt: string;
}

/** Reserved for hash-wasm's Argon2id; the fields follow RFC 9106. */
export interface Argon2idParams {
  alg: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: string;
}

export type KdfParams = Pbkdf2Params | Argon2idParams;
export type KdfId = KdfParams["alg"];
export const KDF_IDS: readonly KdfId[] = ["pbkdf2-sha256", "argon2id"];

export class KdfUnavailableError extends Error {
  constructor(public readonly alg: string) {
    super(`The key-derivation function "${alg}" is not available in this build`);
    this.name = "KdfUnavailableError";
  }
}

export class WeakKdfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeakKdfError";
  }
}

export interface KdfPolicy {
  /**
   * The fewest PBKDF2 iterations accepted when opening a vault. Production
   * code never sets it; tests pass a small value together with cheap params
   * so 10,000 sync rounds stay fast.
   */
  minPbkdf2Iterations?: number;
}

/** Fresh parameters for a new vault (production defaults unless a test overrides the iterations). */
export function newKdfParams(iterations = PBKDF2_DEFAULT_ITERATIONS): Pbkdf2Params {
  return { alg: "pbkdf2-sha256", iterations, salt: toB64u(randomBytes(16)) };
}

/** Throws unless `p` is well-formed, known and strong enough under `policy`. */
export function validateKdfParams(p: unknown, policy: KdfPolicy = {}): KdfParams {
  if (!p || typeof p !== "object") throw new WeakKdfError("missing KDF parameters");
  const o = p as Record<string, unknown>;
  if (typeof o.salt !== "string" || fromB64u(o.salt).length < 16) throw new WeakKdfError("KDF salt too short");
  if (o.alg === "pbkdf2-sha256") {
    const min = policy.minPbkdf2Iterations ?? PBKDF2_MIN_ITERATIONS;
    if (typeof o.iterations !== "number" || !Number.isSafeInteger(o.iterations) || o.iterations < min) {
      throw new WeakKdfError(`PBKDF2 iterations below ${min}`);
    }
    return { alg: "pbkdf2-sha256", iterations: o.iterations, salt: o.salt };
  }
  if (o.alg === "argon2id") throw new KdfUnavailableError("argon2id");
  throw new KdfUnavailableError(String(o.alg));
}

/** 32 bytes of key material from `passphrase` under `params`. */
export async function deriveMasterKey(passphrase: string, params: KdfParams): Promise<Uint8Array<ArrayBuffer>> {
  if (params.alg !== "pbkdf2-sha256") throw new KdfUnavailableError(params.alg);
  const material = await crypto.subtle.importKey("raw", bs(utf8(passphrase.normalize("NFC"))), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: bs(fromB64u(params.salt)), iterations: params.iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Passphrase → vault master key (plan 3.4, step 2).
 *
 * The algorithm and its parameters live in the vault header (stored at the
 * provider in the clear, but authenticated: see header.ts), so the KDF can be
 * changed without a format break. Two ids exist from day one:
 *
 *   • "pbkdf2-sha256" — implemented with WebCrypto, ≥ 600,000 iterations
 *     (OWASP Password Storage Cheat Sheet, 2023). Used today.
 *   • "argon2id"      — memory-hard (RFC 9106), what a new vault gets since
 *     plan W1.7: 46 MiB, one pass, one lane (OWASP's first option). It runs
 *     in plain TypeScript (./primitives/argon2.ts, about a second); a faster
 *     WebAssembly build (hash-wasm) can be plugged in with
 *     `setArgon2idImplementation` and must give the same bytes.
 *
 * Passphrases are NFC-normalised first, so the same Hebrew passphrase typed on
 * macOS (which may produce decomposed characters) and on Windows derives the
 * same key.
 */

import { bs, randomBytes, toB64u, fromB64u, utf8 } from "./bytes";
import { argon2id, type Argon2Input } from "./primitives/argon2";

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

/** Argon2id (RFC 9106, version 0x13); 32-byte tag, no secret, no associated data. */
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

/** What a new vault gets: OWASP 2023's first Argon2id option. */
export const ARGON2_DEFAULT = { memoryKiB: 47_104, iterations: 1, parallelism: 1 } as const;
/**
 * The floor when opening a vault: OWASP's options trade memory for passes
 * (46 MiB × 1, 19 MiB × 2, 12 MiB × 3, 9 MiB × 4, 7 MiB × 5), so at least
 * 7 MiB, and memory × passes at least 37 MiB.
 */
export const ARGON2_MIN_MEMORY_KIB = 7_168;
export const ARGON2_MIN_COST_KIB = 37_888;

export type Argon2idImplementation = (input: Argon2Input) => Uint8Array | Promise<Uint8Array>;
let argon2Impl: Argon2idImplementation = argon2id;

/**
 * Use a faster Argon2id (hash-wasm's, once it is in the lockfile). It must
 * give the same bytes as ./primitives/argon2.ts: the test vectors check it.
 * null restores the built-in one.
 */
export function setArgon2idImplementation(fn: Argon2idImplementation | null): void {
  argon2Impl = fn ?? argon2id;
}

export interface KdfPolicy {
  /**
   * The fewest PBKDF2 iterations accepted when opening a vault. Production
   * code never sets it; tests pass a small value together with cheap params
   * so 10,000 sync rounds stay fast.
   */
  minPbkdf2Iterations?: number;
  /** The smallest Argon2id memory × passes accepted (KiB); tests lower it. */
  minArgon2CostKiB?: number;
}

/**
 * Fresh parameters for a new vault: Argon2id with the production defaults.
 * Passing PBKDF2 `iterations` (the tests, and vaults that must open in
 * builds before plan W1.7) gives PBKDF2-SHA256 instead; `argon2` overrides
 * the Argon2id cost.
 */
export function newKdfParams(iterations?: number, argon2?: Partial<Omit<Argon2idParams, "alg" | "salt">>): KdfParams {
  const salt = toB64u(randomBytes(16));
  if (iterations !== undefined) return { alg: "pbkdf2-sha256", iterations, salt };
  return { alg: "argon2id", ...ARGON2_DEFAULT, ...argon2, salt };
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
  if (o.alg === "argon2id") {
    const int = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x) && x >= 1;
    if (!int(o.memoryKiB) || !int(o.iterations) || !int(o.parallelism)) throw new WeakKdfError("bad Argon2id parameters");
    const m = o.memoryKiB as number;
    const t = o.iterations as number;
    const p = o.parallelism as number;
    const minCost = policy.minArgon2CostKiB ?? ARGON2_MIN_COST_KIB;
    if (p > 16 || m < 8 * p) throw new WeakKdfError("bad Argon2id parallelism");
    if (m > 4 * 1024 * 1024 || t > 64) throw new WeakKdfError("Argon2id cost too high to open here");
    if ((minCost >= ARGON2_MIN_COST_KIB && m < ARGON2_MIN_MEMORY_KIB) || m * t < minCost) throw new WeakKdfError(`Argon2id memory × passes below ${minCost} KiB`);
    return { alg: "argon2id", memoryKiB: m, iterations: t, parallelism: p, salt: o.salt };
  }
  throw new KdfUnavailableError(String(o.alg));
}

/** 32 bytes of key material from `passphrase` under `params`. */
export async function deriveMasterKey(passphrase: string, params: KdfParams): Promise<Uint8Array<ArrayBuffer>> {
  if (params.alg === "argon2id") {
    const tag = await argon2Impl({ password: utf8(passphrase.normalize("NFC")), salt: fromB64u(params.salt), memoryKiB: params.memoryKiB, iterations: params.iterations, parallelism: params.parallelism, tagLength: 32 });
    return new Uint8Array(tag);
  }
  if (params.alg !== "pbkdf2-sha256") throw new KdfUnavailableError((params as { alg: string }).alg);
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

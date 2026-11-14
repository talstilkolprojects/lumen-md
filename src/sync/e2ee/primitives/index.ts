/**
 * The one door to the sync's cryptographic primitives (W10.D12, plan 3.4,
 * W1.7): ChaCha20-Poly1305 (age's payload and stanzas), scrypt (age's
 * passphrase stanza), BLAKE2b and Argon2id (the vault KDF). Every caller
 * imports from here, never from ./chacha20poly1305.ts and the others; a test
 * (cryptoPrimitivesDoor.test.ts) keeps it so.
 *
 * Which implementation runs is chosen in one place, `usePrimitives`:
 *   IN_HOUSE  the plain-TypeScript files next to this one (today's default)
 *   AUDITED   ./lib/audited.ts over @noble/ciphers, @noble/hashes and
 *             hash-wasm (research R3.5); excluded from tsconfig and not
 *             imported by the app until the Mac run (10.M) installs the
 *             packages, compares 10,000 random vectors and the RFC vectors
 *             (cryptoDifferential.test.ts) and makes it the default.
 * After the switch the in-house files stay only as the differential oracle.
 */
import { argon2id as inHouseArgon2id, type Argon2Input } from "./argon2";
import { blake2b as inHouseBlake2b } from "./blake2b";
import { chachaOpen as inHouseOpen, chachaSeal as inHouseSeal } from "./chacha20poly1305";
import { scrypt as inHouseScrypt } from "./scrypt";

export type { Argon2Input };

export interface ScryptOptions {
  logN: number;
  r?: number;
  p?: number;
  dkLen?: number;
}

/** What every implementation gives, byte for byte the same. */
export interface Primitives {
  readonly name: string;
  /** ChaCha20-Poly1305 (RFC 8439, 96-bit nonce): ciphertext ‖ 16-byte tag. */
  chachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Uint8Array;
  /** The plaintext, or null when the tag does not verify. */
  chachaOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad?: Uint8Array): Uint8Array | null;
  /** scrypt (RFC 7914) with N = 2^logN. */
  scrypt(password: Uint8Array, salt: Uint8Array, opts: ScryptOptions): Promise<Uint8Array>;
  /** BLAKE2b (RFC 7693), unkeyed, `outLen` bytes (1..64), over the concatenated parts. */
  blake2b(parts: Uint8Array | Uint8Array[], outLen?: number): Uint8Array;
  /** Argon2id v1.3 (RFC 9106). */
  argon2id(input: Argon2Input): Uint8Array | Promise<Uint8Array>;
}

/** The plain-TypeScript implementation (the differential oracle once AUDITED is the default). */
export const IN_HOUSE: Primitives = Object.freeze({
  name: "in-house",
  chachaSeal: inHouseSeal,
  chachaOpen: inHouseOpen,
  scrypt: inHouseScrypt,
  blake2b: inHouseBlake2b,
  argon2id: inHouseArgon2id,
});

let active: Primitives = IN_HOUSE;

/** The implementation in use. */
export function primitives(): Primitives {
  return active;
}

/** Choose the implementation (null: back to IN_HOUSE). The one place the choice is made. */
export function usePrimitives(p: Primitives | null): void {
  active = p ?? IN_HOUSE;
}

export const chachaSeal: Primitives["chachaSeal"] = (key, nonce, plaintext, aad) => active.chachaSeal(key, nonce, plaintext, aad);
export const chachaOpen: Primitives["chachaOpen"] = (key, nonce, sealed, aad) => active.chachaOpen(key, nonce, sealed, aad);
export const scrypt: Primitives["scrypt"] = (password, salt, opts) => active.scrypt(password, salt, opts);
export const blake2b: Primitives["blake2b"] = (parts, outLen) => active.blake2b(parts, outLen);
export const argon2id: Primitives["argon2id"] = (input) => active.argon2id(input);

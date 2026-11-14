/**
 * The primitives over audited libraries (W10.D13, research R3.5):
 *   ChaCha20-Poly1305  @noble/ciphers   (Cure53, Sep 2024)
 *   scrypt, BLAKE2b    @noble/hashes    (Cure53, Jan 2022; blake2 and scrypt in scope)
 *   Argon2id           hash-wasm        (the PHC reference C code in WebAssembly),
 *                      run in a Worker (./argon2Worker.ts) where there is one;
 *                      libsodium-wrappers-sumo crypto_pwhash when hash-wasm can't load.
 *                      Not noble's argon2: outside its audit, and slow by design.
 *
 * NOT IN THE BUILD YET: the packages are not in the lockfile (the registry is
 * offline here), so tsconfig.json excludes src/sync/e2ee/primitives/lib and
 * nothing imports this file. At the Mac run (10.M, docs/security/crypto-libs.md):
 * install the pinned versions, remove the exclude, run
 * cryptoDifferential.test.ts (10,000 random vectors per primitive and the RFC
 * vectors, 0 differences), then call `usePrimitives(AUDITED)` at startup.
 */
import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake2b as nobleBlake2b } from "@noble/hashes/blake2.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import type { Argon2Input, Primitives, ScryptOptions } from "../index";
import { argon2idHashWasm, argon2idLibsodium } from "./argon2";

const concat = (parts: Uint8Array | Uint8Array[]): Uint8Array => {
  if (parts instanceof Uint8Array) return parts;
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

export const AUDITED: Primitives = Object.freeze({
  name: "audited (@noble/ciphers, @noble/hashes, hash-wasm)",
  chachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = new Uint8Array()) {
    return chacha20poly1305(key, nonce, aad).encrypt(plaintext);
  },
  chachaOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array = new Uint8Array()) {
    try {
      return chacha20poly1305(key, nonce, aad).decrypt(sealed);
    } catch {
      return null; // a tag that does not verify (or a short input), as the in-house open
    }
  },
  scrypt(password: Uint8Array, salt: Uint8Array, { logN, r = 8, p = 1, dkLen = 32 }: ScryptOptions) {
    return scryptAsync(password, salt, { N: 2 ** logN, r, p, dkLen, maxmem: 2 ** 31 });
  },
  blake2b(parts: Uint8Array | Uint8Array[], outLen = 64) {
    return nobleBlake2b(concat(parts), { dkLen: outLen });
  },
  async argon2id(input: Argon2Input) {
    try {
      return await argon2idHashWasm(input);
    } catch (e) {
      // hash-wasm could not load (no WebAssembly, a blocked worker): the audited libsodium.
      if ((e as Error)?.name === "Argon2ParamsError") throw e;
      return argon2idLibsodium(input);
    }
  },
});

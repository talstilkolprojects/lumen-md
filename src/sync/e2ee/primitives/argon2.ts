/**
 * Argon2id (RFC 9106, version 0x13) in plain TypeScript, so a vault can use
 * a memory-hard KDF in every browser without a package (plan W1.7). A faster
 * implementation (hash-wasm's WebAssembly) can replace it through
 * `setArgon2idImplementation` in ../kdf.ts; both must give the same bytes,
 * which the test vectors (docs/sync-protocol-vectors.json) and the
 * independent Python check (scripts/sync-protocol/check_vectors.py) hold
 * them to.
 *
 * Memory: one Uint32Array of memoryKiB × 256 words. 64-bit words are
 * (low, high) pairs of 32-bit halves.
 */

import { blake2b } from "./blake2b";

export interface Argon2Input {
  password: Uint8Array;
  salt: Uint8Array;
  /** Memory in KiB (blocks of 1 KiB); at least 8 × parallelism. */
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  tagLength: number;
  secret?: Uint8Array;
  associatedData?: Uint8Array;
}

const VERSION = 0x13;
const ARGON2ID = 2;
const BLOCK_WORDS = 256; // 1024 bytes as 32-bit words

const le32 = (n: number) => new Uint8Array([n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255]);

/** H' (RFC 9106 §3.3): variable-length BLAKE2b. */
function hPrime(input: Uint8Array[], outLen: number): Uint8Array {
  const len = le32(outLen);
  if (outLen <= 64) return blake2b([len, ...input], outLen);
  const out = new Uint8Array(outLen);
  const r = Math.ceil(outLen / 32) - 2;
  let vi = blake2b([len, ...input], 64);
  out.set(vi.subarray(0, 32), 0);
  for (let i = 1; i < r; i++) {
    vi = blake2b(vi, 64);
    out.set(vi.subarray(0, 32), i * 32);
  }
  out.set(blake2b(vi, outLen - 32 * r), r * 32);
  return out;
}

/* ─── The compression function G ───────────────────────────────────────── */

const R = new Uint32Array(BLOCK_WORDS);
const Z = new Uint32Array(BLOCK_WORDS);

/** a = a + b + 2·lo(a)·lo(b), on the 64-bit words at word offsets a and b of `w`. */
function blamka(w: Uint32Array, a: number, b: number) {
  const al = w[a];
  const bl = w[b];
  // 32×32 → 64 bit product of the low halves, in 16-bit pieces.
  const a0 = al & 0xffff;
  const a1 = al >>> 16;
  const b0 = bl & 0xffff;
  const b1 = bl >>> 16;
  const p00 = a0 * b0;
  const p01 = a0 * b1;
  const p10 = a1 * b0;
  const p11 = a1 * b1;
  const mid = (p00 >>> 16) + (p01 & 0xffff) + (p10 & 0xffff);
  let plo = ((mid << 16) | (p00 & 0xffff)) >>> 0;
  let phi = (p11 + (p01 >>> 16) + (p10 >>> 16) + (mid >>> 16)) >>> 0;
  // × 2
  phi = ((phi << 1) | (plo >>> 31)) >>> 0;
  plo = (plo << 1) >>> 0;
  // a + b + p
  let lo = al + bl;
  let hi = w[a + 1] + w[b + 1] + (lo > 0xffffffff ? 1 : 0);
  lo >>>= 0;
  const lo2 = lo + plo;
  hi = (hi + phi + (lo2 > 0xffffffff ? 1 : 0)) >>> 0;
  w[a] = lo2 >>> 0;
  w[a + 1] = hi;
}

/** The BLAKE2b-like G of Argon2 on 64-bit words a, b, c, d (word offsets ×2 already applied). */
function gb(w: Uint32Array, a: number, b: number, c: number, d: number) {
  let lo: number;
  let hi: number;
  blamka(w, a, b);
  lo = w[d] ^ w[a];
  hi = w[d + 1] ^ w[a + 1];
  w[d] = hi;
  w[d + 1] = lo; // rotr 32
  blamka(w, c, d);
  lo = w[b] ^ w[c];
  hi = w[b + 1] ^ w[c + 1];
  w[b] = ((lo >>> 24) | (hi << 8)) >>> 0;
  w[b + 1] = ((hi >>> 24) | (lo << 8)) >>> 0; // rotr 24
  blamka(w, a, b);
  lo = w[d] ^ w[a];
  hi = w[d + 1] ^ w[a + 1];
  w[d] = ((lo >>> 16) | (hi << 16)) >>> 0;
  w[d + 1] = ((hi >>> 16) | (lo << 16)) >>> 0; // rotr 16
  blamka(w, c, d);
  lo = w[b] ^ w[c];
  hi = w[b + 1] ^ w[c + 1];
  w[b] = ((hi >>> 31) | (lo << 1)) >>> 0;
  w[b + 1] = ((lo >>> 31) | (hi << 1)) >>> 0; // rotr 63
}

/** The permutation P on 16 64-bit words, given as word indexes (not ×2). */
function perm(w: Uint32Array, i: number[]) {
  const x = (k: number) => i[k] * 2;
  gb(w, x(0), x(4), x(8), x(12));
  gb(w, x(1), x(5), x(9), x(13));
  gb(w, x(2), x(6), x(10), x(14));
  gb(w, x(3), x(7), x(11), x(15));
  gb(w, x(0), x(5), x(10), x(15));
  gb(w, x(1), x(6), x(11), x(12));
  gb(w, x(2), x(7), x(8), x(13));
  gb(w, x(3), x(4), x(9), x(14));
}

// Rows and columns of the 8×8 matrix of 16-byte registers, as 64-bit word indexes.
const ROWS: number[][] = [];
const COLS: number[][] = [];
for (let r = 0; r < 8; r++) ROWS.push(Array.from({ length: 16 }, (_, k) => 16 * r + k));
for (let c = 0; c < 8; c++) {
  const col: number[] = [];
  for (let r = 0; r < 8; r++) col.push(16 * r + 2 * c, 16 * r + 2 * c + 1);
  COLS.push(col);
}

/**
 * out = G(x, y), or out ^= G(x, y) with `xor` (the passes after the first).
 * x, y and out are word offsets into `mem` (out may be its own buffer `o`).
 */
function compressInto(mem: Uint32Array, xo: number, yMem: Uint32Array, yo: number, o: Uint32Array, oo: number, xor: boolean) {
  for (let k = 0; k < BLOCK_WORDS; k++) R[k] = mem[xo + k] ^ yMem[yo + k];
  Z.set(R);
  for (const row of ROWS) perm(Z, row);
  for (const col of COLS) perm(Z, col);
  if (xor) for (let k = 0; k < BLOCK_WORDS; k++) o[oo + k] ^= R[k] ^ Z[k];
  else for (let k = 0; k < BLOCK_WORDS; k++) o[oo + k] = R[k] ^ Z[k];
}

const ZERO = new Uint32Array(BLOCK_WORDS);

/** Argon2id. Synchronous and CPU-bound: call it off the main thread for large parameters. */
export function argon2id(input: Argon2Input): Uint8Array {
  const { password, salt, iterations: t, parallelism: p, tagLength } = input;
  const secret = input.secret ?? new Uint8Array();
  const ad = input.associatedData ?? new Uint8Array();
  if (p < 1 || p > 0xffffff) throw new RangeError("Argon2: bad parallelism");
  if (t < 1) throw new RangeError("Argon2: at least one iteration");
  if (input.memoryKiB < 8 * p) throw new RangeError("Argon2: memory below 8 × parallelism KiB");
  if (tagLength < 4) throw new RangeError("Argon2: tag below 4 bytes");

  const h0 = blake2b(
    [le32(p), le32(tagLength), le32(input.memoryKiB), le32(t), le32(VERSION), le32(ARGON2ID), le32(password.length), password, le32(salt.length), salt, le32(secret.length), secret, le32(ad.length), ad],
    64,
  );
  const segment = Math.floor(input.memoryKiB / (4 * p));
  const q = segment * 4; // columns per lane
  const blocks = q * p;
  const mem = new Uint32Array(blocks * BLOCK_WORDS);
  const at = (lane: number, col: number) => (lane * q + col) * BLOCK_WORDS;
  const toWords = (bytes: Uint8Array, dst: Uint32Array, off: number) => {
    for (let k = 0; k < BLOCK_WORDS; k++) dst[off + k] = bytes[4 * k] | (bytes[4 * k + 1] << 8) | (bytes[4 * k + 2] << 16) | (bytes[4 * k + 3] << 24);
  };
  for (let l = 0; l < p; l++) {
    toWords(hPrime([h0, le32(0), le32(l)], 1024), mem, at(l, 0));
    toWords(hPrime([h0, le32(1), le32(l)], 1024), mem, at(l, 1));
  }

  const addr = new Uint32Array(BLOCK_WORDS);
  const inputBlock = new Uint32Array(BLOCK_WORDS);
  const tmp = new Uint32Array(BLOCK_WORDS);
  for (let pass = 0; pass < t; pass++) {
    for (let slice = 0; slice < 4; slice++) {
      for (let lane = 0; lane < p; lane++) {
        const independent = pass === 0 && slice < 2;
        if (independent) {
          inputBlock.fill(0);
          // (r, l, s, m', t, y, counter) as 64-bit words (low halves; all fit in 32 bits)
          inputBlock[0] = pass;
          inputBlock[2] = lane;
          inputBlock[4] = slice;
          inputBlock[6] = blocks;
          inputBlock[8] = t;
          inputBlock[10] = ARGON2ID;
          inputBlock[12] = 0;
        }
        const start = pass === 0 && slice === 0 ? 2 : 0;
        const nextAddresses = () => {
          inputBlock[12]++;
          compressInto(ZERO, 0, inputBlock, 0, tmp, 0, false);
          compressInto(ZERO, 0, tmp, 0, addr, 0, false);
        };
        if (independent && start !== 0) nextAddresses();
        for (let idx = start; idx < segment; idx++) {
          const col = slice * segment + idx;
          const prev = col === 0 ? q - 1 : col - 1;
          let j1: number;
          let j2: number;
          if (independent) {
            if (idx % 128 === 0) nextAddresses();
            const k = (idx % 128) * 2;
            j1 = addr[k];
            j2 = addr[k + 1];
          } else {
            const o = at(lane, prev);
            j1 = mem[o];
            j2 = mem[o + 1];
          }
          const refLane = pass === 0 && slice === 0 ? lane : j2 % p;
          const same = refLane === lane;
          let area: number;
          if (pass === 0) area = same ? col - 1 : slice * segment + (idx === 0 ? -1 : 0);
          else area = same ? q - segment + idx - 1 : q - segment + (idx === 0 ? -1 : 0);
          // relative position = area - 1 - (area · (J1² / 2^32)) / 2^32
          const x = mulHi(j1, j1);
          const y = mulHi(area, x);
          const rel = area - 1 - y;
          const startPos = pass === 0 ? 0 : ((slice + 1) * segment) % q;
          const refCol = (startPos + rel) % q;
          compressInto(mem, at(lane, prev), mem, at(refLane, refCol), mem, at(lane, col), pass > 0);
        }
      }
    }
  }
  const c = new Uint32Array(BLOCK_WORDS);
  for (let l = 0; l < p; l++) {
    const o = at(l, q - 1);
    for (let k = 0; k < BLOCK_WORDS; k++) c[k] ^= mem[o + k];
  }
  const cb = new Uint8Array(1024);
  for (let k = 0; k < BLOCK_WORDS; k++) {
    cb[4 * k] = c[k] & 255;
    cb[4 * k + 1] = (c[k] >>> 8) & 255;
    cb[4 * k + 2] = (c[k] >>> 16) & 255;
    cb[4 * k + 3] = c[k] >>> 24;
  }
  return hPrime([cb], tagLength);
}

/** floor(a · b / 2^32) for 32-bit unsigned a, b. */
function mulHi(a: number, b: number): number {
  const a0 = a & 0xffff;
  const a1 = a >>> 16;
  const b0 = b & 0xffff;
  const b1 = b >>> 16;
  const mid = ((a0 * b0) >>> 16) + ((a0 * b1) & 0xffff) + ((a1 * b0) & 0xffff);
  return (a1 * b1 + ((a0 * b1) >>> 16) + ((a1 * b0) >>> 16) + (mid >>> 16)) >>> 0;
}

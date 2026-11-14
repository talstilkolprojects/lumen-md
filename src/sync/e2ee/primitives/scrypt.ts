/**
 * scrypt (RFC 7914) in plain TypeScript, for age's passphrase recipient
 * (../age.ts). PBKDF2-HMAC-SHA256 comes from WebCrypto; ROMix runs here.
 */

const rotl = (x: number, n: number) => (x << n) | (x >>> (32 - n));

function salsa8(b: Uint32Array, o: number, x: Uint32Array) {
  for (let i = 0; i < 16; i++) x[i] = b[o + i];
  for (let i = 0; i < 8; i += 2) {
    x[4] ^= rotl((x[0] + x[12]) | 0, 7);
    x[8] ^= rotl((x[4] + x[0]) | 0, 9);
    x[12] ^= rotl((x[8] + x[4]) | 0, 13);
    x[0] ^= rotl((x[12] + x[8]) | 0, 18);
    x[9] ^= rotl((x[5] + x[1]) | 0, 7);
    x[13] ^= rotl((x[9] + x[5]) | 0, 9);
    x[1] ^= rotl((x[13] + x[9]) | 0, 13);
    x[5] ^= rotl((x[1] + x[13]) | 0, 18);
    x[14] ^= rotl((x[10] + x[6]) | 0, 7);
    x[2] ^= rotl((x[14] + x[10]) | 0, 9);
    x[6] ^= rotl((x[2] + x[14]) | 0, 13);
    x[10] ^= rotl((x[6] + x[2]) | 0, 18);
    x[3] ^= rotl((x[15] + x[11]) | 0, 7);
    x[7] ^= rotl((x[3] + x[15]) | 0, 9);
    x[11] ^= rotl((x[7] + x[3]) | 0, 13);
    x[15] ^= rotl((x[11] + x[7]) | 0, 18);
    x[1] ^= rotl((x[0] + x[3]) | 0, 7);
    x[2] ^= rotl((x[1] + x[0]) | 0, 9);
    x[3] ^= rotl((x[2] + x[1]) | 0, 13);
    x[0] ^= rotl((x[3] + x[2]) | 0, 18);
    x[6] ^= rotl((x[5] + x[4]) | 0, 7);
    x[7] ^= rotl((x[6] + x[5]) | 0, 9);
    x[4] ^= rotl((x[7] + x[6]) | 0, 13);
    x[5] ^= rotl((x[4] + x[7]) | 0, 18);
    x[11] ^= rotl((x[10] + x[9]) | 0, 7);
    x[8] ^= rotl((x[11] + x[10]) | 0, 9);
    x[9] ^= rotl((x[8] + x[11]) | 0, 13);
    x[10] ^= rotl((x[9] + x[8]) | 0, 18);
    x[12] ^= rotl((x[15] + x[14]) | 0, 7);
    x[13] ^= rotl((x[12] + x[15]) | 0, 9);
    x[14] ^= rotl((x[13] + x[12]) | 0, 13);
    x[15] ^= rotl((x[14] + x[13]) | 0, 18);
  }
  for (let i = 0; i < 16; i++) b[o + i] = (b[o + i] + x[i]) | 0;
}

/** BlockMix on 2r 64-byte blocks at word offset `o` of `b`, through `y`. */
function blockMix(b: Uint32Array, o: number, y: Uint32Array, r: number, x: Uint32Array, t: Uint32Array) {
  const n = 32 * r;
  for (let i = 0; i < 16; i++) t[i] = b[o + n - 16 + i];
  for (let i = 0; i < 2 * r; i++) {
    for (let k = 0; k < 16; k++) t[k] ^= b[o + 16 * i + k];
    salsa8(t, 0, x);
    // even blocks first, odd blocks after
    const dst = (i & 1) === 0 ? (i >> 1) * 16 : (r + (i >> 1)) * 16;
    for (let k = 0; k < 16; k++) y[dst + k] = t[k];
  }
  for (let i = 0; i < n; i++) b[o + i] = y[i];
}

async function pbkdf2(password: Uint8Array, salt: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(password), "PBKDF2", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new Uint8Array(salt), iterations: 1 }, key, length * 8));
}

/** scrypt(password, salt, N = 2^logN, r, p) → dkLen bytes. */
export async function scrypt(password: Uint8Array, salt: Uint8Array, opts: { logN: number; r?: number; p?: number; dkLen?: number }): Promise<Uint8Array> {
  const r = opts.r ?? 8;
  const p = opts.p ?? 1;
  const dkLen = opts.dkLen ?? 32;
  if (opts.logN < 1 || opts.logN > 22) throw new RangeError("scrypt: logN must be 1–22");
  const N = 2 ** opts.logN;
  const words = 32 * r;
  const B = await pbkdf2(password, salt, p * 128 * r);
  const b32 = new Uint32Array(p * words);
  for (let i = 0; i < b32.length; i++) b32[i] = B[4 * i] | (B[4 * i + 1] << 8) | (B[4 * i + 2] << 16) | (B[4 * i + 3] << 24);
  const V = new Uint32Array(N * words);
  const y = new Uint32Array(words);
  const x = new Uint32Array(16);
  const t = new Uint32Array(16);
  for (let k = 0; k < p; k++) {
    const o = k * words;
    for (let i = 0; i < N; i++) {
      V.set(b32.subarray(o, o + words), i * words);
      blockMix(b32, o, y, r, x, t);
    }
    for (let i = 0; i < N; i++) {
      const j = (b32[o + words - 16] >>> 0) & (N - 1);
      for (let w = 0; w < words; w++) b32[o + w] ^= V[j * words + w];
      blockMix(b32, o, y, r, x, t);
    }
  }
  const out = new Uint8Array(b32.length * 4);
  for (let i = 0; i < b32.length; i++) {
    out[4 * i] = b32[i] & 255;
    out[4 * i + 1] = (b32[i] >>> 8) & 255;
    out[4 * i + 2] = (b32[i] >>> 16) & 255;
    out[4 * i + 3] = b32[i] >>> 24;
  }
  return pbkdf2(password, out, dkLen);
}

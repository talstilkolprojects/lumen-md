/**
 * ChaCha20-Poly1305 (RFC 8439) in plain TypeScript: the AEAD of the age
 * format (../age.ts), which WebCrypto doesn't offer. 12-byte nonce, 16-byte
 * tag appended to the ciphertext.
 */

const rotl = (x: number, n: number) => ((x << n) | (x >>> (32 - n))) >>> 0;

function quarter(s: Uint32Array, a: number, b: number, c: number, d: number) {
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 16);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 12);
  s[a] = (s[a] + s[b]) >>> 0;
  s[d] = rotl(s[d] ^ s[a], 8);
  s[c] = (s[c] + s[d]) >>> 0;
  s[b] = rotl(s[b] ^ s[c], 7);
}

const u32le = (b: Uint8Array, i: number): number => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) >>> 0;

function block(key: Uint8Array, counter: number, nonce: Uint8Array, out: Uint8Array) {
  const init = new Uint32Array(16);
  init[0] = 0x61707865;
  init[1] = 0x3320646e;
  init[2] = 0x79622d32;
  init[3] = 0x6b206574;
  for (let i = 0; i < 8; i++) init[4 + i] = u32le(key, 4 * i);
  init[12] = counter >>> 0;
  for (let i = 0; i < 3; i++) init[13 + i] = u32le(nonce, 4 * i);
  const s = new Uint32Array(init);
  for (let r = 0; r < 10; r++) {
    quarter(s, 0, 4, 8, 12);
    quarter(s, 1, 5, 9, 13);
    quarter(s, 2, 6, 10, 14);
    quarter(s, 3, 7, 11, 15);
    quarter(s, 0, 5, 10, 15);
    quarter(s, 1, 6, 11, 12);
    quarter(s, 2, 7, 8, 13);
    quarter(s, 3, 4, 9, 14);
  }
  for (let i = 0; i < 16; i++) {
    const w = (s[i] + init[i]) >>> 0;
    out[4 * i] = w & 255;
    out[4 * i + 1] = (w >>> 8) & 255;
    out[4 * i + 2] = (w >>> 16) & 255;
    out[4 * i + 3] = w >>> 24;
  }
}

/** ChaCha20 keystream XOR, starting at block `counter`. */
export function chacha20(key: Uint8Array, nonce: Uint8Array, data: Uint8Array, counter = 1): Uint8Array {
  if (key.length !== 32 || nonce.length !== 12) throw new RangeError("ChaCha20: 32-byte key, 12-byte nonce");
  const out = new Uint8Array(data.length);
  const ks = new Uint8Array(64);
  for (let off = 0, c = counter; off < data.length; off += 64, c++) {
    block(key, c, nonce, ks);
    const n = Math.min(64, data.length - off);
    for (let i = 0; i < n; i++) out[off + i] = data[off + i] ^ ks[i];
  }
  return out;
}

/* ─── Poly1305 ─────────────────────────────────────────────────────────── */

const P1305 = (1n << 130n) - 5n;

function leBig(b: Uint8Array, from: number, to: number): bigint {
  let x = 0n;
  for (let i = to - 1; i >= from; i--) x = (x << 8n) | BigInt(b[i]);
  return x;
}

/** Poly1305 (RFC 8439 §2.5), with BigInt arithmetic: exact, and fast enough for 64 KiB chunks. */
export function poly1305(key: Uint8Array, msg: Uint8Array): Uint8Array {
  const r = leBig(key, 0, 16) & 0x0ffffffc0ffffffc0ffffffc0fffffffn;
  const s = leBig(key, 16, 32);
  let h = 0n;
  for (let off = 0; off < msg.length; off += 16) {
    const end = Math.min(off + 16, msg.length);
    const n = leBig(msg, off, end) | (1n << BigInt(8 * (end - off)));
    h = ((h + n) * r) % P1305;
  }
  let t = (h + s) & ((1n << 128n) - 1n);
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    out[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  return out;
}

function macData(aad: Uint8Array, ct: Uint8Array): Uint8Array {
  const pad = (n: number) => (16 - (n % 16)) % 16;
  const out = new Uint8Array(aad.length + pad(aad.length) + ct.length + pad(ct.length) + 16);
  out.set(aad, 0);
  out.set(ct, aad.length + pad(aad.length));
  const v = new DataView(out.buffer);
  const end = out.length - 16;
  v.setUint32(end, aad.length, true);
  v.setUint32(end + 4, Math.floor(aad.length / 0x100000000), true);
  v.setUint32(end + 8, ct.length, true);
  v.setUint32(end + 12, Math.floor(ct.length / 0x100000000), true);
  return out;
}

function polyKey(key: Uint8Array, nonce: Uint8Array): Uint8Array {
  const b = new Uint8Array(64);
  block(key, 0, nonce, b);
  return b.subarray(0, 32);
}

export function chachaSeal(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, aad: Uint8Array = new Uint8Array()): Uint8Array {
  const ct = chacha20(key, nonce, plaintext, 1);
  const tag = poly1305(polyKey(key, nonce), macData(aad, ct));
  const out = new Uint8Array(ct.length + 16);
  out.set(ct);
  out.set(tag, ct.length);
  return out;
}

/** The plaintext, or null when the tag doesn't verify. */
export function chachaOpen(key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array, aad: Uint8Array = new Uint8Array()): Uint8Array | null {
  if (sealed.length < 16) return null;
  const ct = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  const want = poly1305(polyKey(key, nonce), macData(aad, ct));
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= want[i] ^ tag[i];
  return diff === 0 ? chacha20(key, nonce, ct, 1) : null;
}

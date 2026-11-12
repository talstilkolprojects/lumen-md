/**
 * Sealed boxes for the private classroom (plan W5.21): a message that only
 * the holder of one ECDH P-256 private key can open, made with WebCrypto
 * alone (no dependency).
 *
 *   box = 0x01 ‖ mode ‖ ephemeral public key (65) ‖ iv (12) ‖ AES-GCM-256 ciphertext
 *
 *   mode 0, "anonymous" (a student's submission to the teacher):
 *     ikm = ECDH(ephemeral, recipient)
 *   mode 1, "from a known sender" (the teacher's comment to one student):
 *     ikm = ECDH(ephemeral, recipient) ‖ ECDH(sender, recipient)
 *     Only the holder of the sender's private key can make a box that opens
 *     with the sender's public key, so a student knows a comment is the
 *     teacher's and not another student's (the HPKE "auth" mode idea).
 *
 *   key  = HKDF-SHA-256(ikm, salt = ephemeral ‖ recipient public keys,
 *                       info = "lumen-class v1|<mode>|<context>")
 *   AAD  = the same info, so a box made for one assignment and purpose
 *          does not open as another.
 *
 * A fresh ephemeral key per box: two boxes of the same text differ, and the
 * ephemeral private key is dropped right after use. The plaintext is padded
 * to a size bucket (pad / unpad) so the box size tells little about the
 * length of the work.
 */

const VERSION = 1;
const PUB_BYTES = 65;
const IV_BYTES = 12;
const HEADER = 2 + PUB_BYTES + IV_BYTES;
const ECDH: EcKeyGenParams = { name: "ECDH", namedCurve: "P-256" };
const enc = new TextEncoder();

export class SealError extends Error {
  constructor(readonly code: "malformed" | "open") {
    super(`sealed box: ${code}`);
    this.name = "SealError";
  }
}

const buf = (b: Uint8Array) => b as Uint8Array<ArrayBuffer>;

/** A new key pair; the private key cannot be exported (it is kept as a CryptoKey in IndexedDB). */
export async function newKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await crypto.subtle.generateKey(ECDH, extractable, ["deriveBits"])) as CryptoKeyPair;
}

/** The raw (uncompressed, 65-byte) form of a public key. */
export async function rawPublic(key: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.exportKey("raw", key));
}

/** A public key from its raw form; throws SealError("malformed") for anything not on the curve. */
export async function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== PUB_BYTES || raw[0] !== 0x04) throw new SealError("malformed");
  try {
    return await crypto.subtle.importKey("raw", buf(raw), ECDH, true, []);
  } catch {
    throw new SealError("malformed");
  }
}

async function dh(priv: CryptoKey, pub: CryptoKey): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: pub }, priv, 256));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) (out.set(p, at), (at += p.length));
  return out;
}

async function boxKey(ikm: Uint8Array, ephPub: Uint8Array, recipientPub: Uint8Array, info: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", buf(ikm), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: buf(concat(ephPub, recipientPub)), info: buf(info) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    [usage],
  );
}

const infoOf = (mode: number, context: string) => enc.encode(`lumen-class v1|${mode}|${context}`);

export interface SealOptions {
  /** What the box is for, bound into the key and the AAD (e.g. "sub|<assignment>"). */
  context: string;
  /** Mode 1: the sender's private key; the recipient opens with the sender's public key. */
  sender?: CryptoKey;
}

/** Seal `plain` to the holder of `recipient`'s private key. */
export async function seal(plain: Uint8Array, recipient: Uint8Array, opts: SealOptions): Promise<Uint8Array> {
  const to = await importPublic(recipient);
  const eph = await newKeyPair(false);
  const ephPub = await rawPublic(eph.publicKey);
  const mode = opts.sender ? 1 : 0;
  const ikm = opts.sender ? concat(await dh(eph.privateKey, to), await dh(opts.sender, to)) : await dh(eph.privateKey, to);
  const info = infoOf(mode, opts.context);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const key = await boxKey(ikm, ephPub, recipient, info, "encrypt");
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: buf(info) }, key, buf(plain)));
  return concat(Uint8Array.of(VERSION, mode), ephPub, iv, ct);
}

export interface OpenOptions {
  context: string;
  /** Required for, and only for, a mode-1 box: the public key of who must have sealed it. */
  sender?: Uint8Array;
}

/**
 * Open a box with the recipient's key pair. Throws SealError: "malformed"
 * (not a box, or the wrong mode for the options), "open" (not for this key,
 * another context, another sender, or changed bytes).
 */
export async function open(box: Uint8Array, recipient: { privateKey: CryptoKey; publicRaw: Uint8Array }, opts: OpenOptions): Promise<Uint8Array> {
  if (box.length < HEADER + 16 || box[0] !== VERSION || (box[1] !== 0 && box[1] !== 1)) throw new SealError("malformed");
  const mode = box[1] as number;
  if ((mode === 1) !== !!opts.sender) throw new SealError("malformed");
  const ephPub = box.subarray(2, 2 + PUB_BYTES);
  const iv = box.subarray(2 + PUB_BYTES, HEADER);
  const eph = await importPublic(ephPub);
  let ikm = await dh(recipient.privateKey, eph);
  if (opts.sender) ikm = concat(ikm, await dh(recipient.privateKey, await importPublic(opts.sender)));
  const info = infoOf(mode, opts.context);
  const key = await boxKey(ikm, ephPub, recipient.publicRaw, info, "decrypt");
  try {
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf(iv), additionalData: buf(info) }, key, buf(box.subarray(HEADER))));
  } catch {
    throw new SealError("open");
  }
}

/** The padded size for `n` bytes: 1 KiB, then powers of two up to 256 KiB, then multiples of 256 KiB. */
export function bucket(n: number): number {
  const need = n + 4;
  if (need <= 1024) return 1024;
  const step = 256 * 1024;
  if (need > step) return Math.ceil(need / step) * step;
  let b = 1024;
  while (b < need) b *= 2;
  return b;
}

/** Length-prefix and zero-pad to `bucket(bytes.length)`. */
export function pad(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bucket(bytes.length));
  new DataView(out.buffer).setUint32(0, bytes.length);
  out.set(bytes, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  if (padded.length < 4) throw new SealError("malformed");
  const n = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (n > padded.length - 4) throw new SealError("malformed");
  return padded.slice(4, 4 + n);
}

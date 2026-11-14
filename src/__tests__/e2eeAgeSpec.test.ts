/**
 * Plan W4.17 — the age v1 format (https://age-encryption.org/v1) checked
 * against a second, independent implementation written here on Node's own
 * crypto (scrypt, X25519, HKDF, HMAC, ChaCha20-Poly1305): what Lumen writes
 * must open there chunk by chunk, and what is written there, including the
 * corner cases the spec names, must open (or be refused) in Lumen.
 * Written for mutants of src/sync/e2ee/age.ts that the round trips missed.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { createCipheriv, createDecipheriv, createHmac, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scryptSync } from "node:crypto";
import { ageDecrypt, ageEncrypt, bech32Decode, bech32Encode, generateIdentity, parseIdentity, parseRecipient } from "../sync/e2ee/age";

const CHUNK = 64 * 1024;
const VERSION = "age-encryption.org/v1";
const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64").replace(/=+$/, "");
const unb64 = (s: string) => Buffer.from(s, "base64");
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string) => Buffer.from(hkdfSync("sha256", ikm, salt, info, 32));
const seal = (key: Uint8Array, nonce: Uint8Array, pt: Uint8Array) => {
  const c = createCipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  return Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
};
const open = (key: Uint8Array, nonce: Uint8Array, sealed: Uint8Array) => {
  const d = createDecipheriv("chacha20-poly1305", key, nonce, { authTagLength: 16 });
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
};
/** STREAM nonce: an 11-byte big-endian counter, then the last-chunk flag. */
const streamNonce = (i: number, last: boolean) => {
  const n = Buffer.alloc(12);
  n.writeUIntBE(i, 5, 6);
  n[11] = last ? 1 : 0;
  return n;
};
const scryptKey = (pass: string, salt: Uint8Array, logN: number) =>
  scryptSync(Buffer.from(pass), Buffer.concat([Buffer.from("age-encryption.org/v1/scrypt"), salt]), 32, { N: 2 ** logN, r: 8, p: 1, maxmem: 2 ** 30 });

/** An age file from header stanzas (text) and plaintext chunks, every byte made here. */
function build(stanzas: string, fileKey: Uint8Array, chunks: Uint8Array[]): Uint8Array {
  const head = `${VERSION}\n${stanzas}---`;
  const mac = createHmac("sha256", hkdf(fileKey, new Uint8Array(), "header")).update(head).digest();
  const nonce = randomBytes(16);
  const key = hkdf(fileKey, nonce, "payload");
  const sealed = chunks.map((c, i) => seal(key, streamNonce(i, i === chunks.length - 1), c));
  return new Uint8Array(Buffer.concat([Buffer.from(`${head} ${b64(mac)}\n`), nonce, ...sealed]));
}
const scryptStanza = (pass: string, fileKey: Uint8Array, logN = 4, salt: Uint8Array = randomBytes(16)) =>
  `-> scrypt ${b64(salt)} ${logN}\n${b64(seal(scryptKey(pass, salt, logN), new Uint8Array(12), fileKey))}\n`;
function x25519Stanza(recipient: string, fileKey: Uint8Array): string {
  const pub = Buffer.from(parseRecipient(recipient));
  const eph = generateKeyPairSync("x25519");
  const ephPub = Buffer.from(eph.publicKey.export({ format: "jwk" }).x!, "base64url");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: { kty: "OKP", crv: "X25519", x: pub.toString("base64url") }, format: "jwk" }) });
  return `-> X25519 ${b64(ephPub)}\n${b64(seal(hkdf(shared, Buffer.concat([ephPub, pub]), "age-encryption.org/v1/X25519"), new Uint8Array(12), fileKey))}\n`;
}

/** Opens a passphrase file the way the spec reads, and returns what it found on the way. */
function readScryptFile(file: Uint8Array, pass: string) {
  const buf = Buffer.from(file);
  const end = buf.indexOf("\n---");
  const macEnd = buf.indexOf("\n", end + 1);
  const lines = buf.subarray(0, end).toString("utf8").split("\n");
  // The version line, one stanza line, its body (one line: shorter than 64 columns ends it), then "---".
  expect(lines).toHaveLength(3);
  expect(lines[0]).toBe(VERSION);
  const [, type, salt, logN] = lines[1].split(" ");
  expect(type).toBe("scrypt");
  const fileKey = open(scryptKey(pass, unb64(salt), Number(logN)), new Uint8Array(12), unb64(lines[2]));
  const mac = createHmac("sha256", hkdf(fileKey, new Uint8Array(), "header")).update(buf.subarray(0, end + 4)).digest();
  expect(buf.subarray(end + 5, macEnd).toString()).toBe(b64(mac));
  const nonce = buf.subarray(macEnd + 1, macEnd + 17);
  const key = hkdf(fileKey, nonce, "payload");
  const sizes: number[] = [];
  const parts: Buffer[] = [];
  let at = macEnd + 17;
  for (let i = 0; at < buf.length; i++) {
    const piece = buf.subarray(at, Math.min(buf.length, at + CHUNK + 16));
    at += piece.length;
    sizes.push(piece.length);
    parts.push(open(key, streamNonce(i, at === buf.length), piece));
  }
  return { fileKey, logN: Number(logN), sizes, plaintext: Buffer.concat(parts) };
}

const fail = (p: Promise<unknown>, message: RegExp) => expect(p).rejects.toThrow(message);

describe("what Lumen writes, read by an independent age reader", () => {
  it("uses a 16-byte file key, 64 KiB chunks and the STREAM nonces", async () => {
    const pt = randomBytes(2 * CHUNK + 5);
    const r = readScryptFile(await ageEncrypt(pt, [{ passphrase: "pass", logN: 4 }]), "pass");
    expect(r.fileKey.length).toBe(16);
    expect(r.logN).toBe(4);
    expect(r.sizes).toEqual([CHUNK + 16, CHUNK + 16, 5 + 16]);
    expect(r.plaintext.equals(pt)).toBe(true);
  });

  it("counts chunks past 255 in the nonce's next byte", async () => {
    const pt = new Uint8Array(256 * CHUNK + 1);
    pt[256 * CHUNK] = 7;
    const r = readScryptFile(await ageEncrypt(pt, [{ passphrase: "p", logN: 4 }]), "p");
    expect(r.sizes).toHaveLength(257);
    expect(r.plaintext.equals(Buffer.from(pt))).toBe(true);
  });

  it("writes an empty file as one empty last chunk, and a full chunk without an empty one after it", async () => {
    const empty = readScryptFile(await ageEncrypt(new Uint8Array(), [{ passphrase: "p", logN: 4 }]), "p");
    expect(empty.sizes).toEqual([16]);
    expect(empty.plaintext.length).toBe(0);
    expect(readScryptFile(await ageEncrypt(randomBytes(CHUNK), [{ passphrase: "p", logN: 4 }]), "p").sizes).toEqual([CHUNK + 16]);
  });

  it("refuses to mix a passphrase with another recipient", async () => {
    const id = await generateIdentity();
    await fail(ageEncrypt(new Uint8Array(1), [{ x25519: id.recipient }, { passphrase: "x", logN: 4 }]), /only recipient/);
    await fail(ageEncrypt(new Uint8Array(1), []), /no recipients/);
  });
});

describe("files written by the independent writer", () => {
  it("open in Lumen: passphrase, X25519, many chunks", async () => {
    const fileKey = randomBytes(16);
    const chunks = [randomBytes(CHUNK), randomBytes(CHUNK), randomBytes(7)];
    const all = Buffer.concat(chunks);
    expect(Buffer.from(await ageDecrypt(build(scryptStanza("סיסמה", fileKey), fileKey, chunks), [{ passphrase: "סיסמה" }])).equals(all)).toBe(true);
    const id = await generateIdentity();
    expect(Buffer.from(await ageDecrypt(build(x25519Stanza(id.recipient, fileKey), fileKey, chunks), [{ identity: id.identity }])).equals(all)).toBe(true);
  });

  it("try every identity in order until one opens the file", async () => {
    const id = await generateIdentity();
    const other = await generateIdentity();
    const fileKey = randomBytes(16);
    const f = build(x25519Stanza(id.recipient, fileKey), fileKey, [Buffer.from("hi")]);
    expect(Buffer.from(await ageDecrypt(f, [{ identity: other.identity }, { passphrase: "nope" }, { identity: id.identity }])).toString()).toBe("hi");
    // A passphrase is never tried on an X25519 stanza (nor a key on an scrypt one).
    await fail(ageDecrypt(f, [{ passphrase: "nope" }]), /no identity matched/);
    const p = build(scryptStanza("pw", fileKey), fileKey, [Buffer.from("hi")]);
    await fail(ageDecrypt(p, [{ identity: id.identity }]), /no identity matched/);
  });

  it("skip a stanza of an unknown type, whose body may fill whole 64-column lines", async () => {
    const id = await generateIdentity();
    const fileKey = randomBytes(16);
    const grease = `-> grease-x a\n${b64(randomBytes(48))}\n${b64(randomBytes(10))}\n-> grease-y\n${b64(randomBytes(48))}\n\n`;
    expect(b64(randomBytes(48)).length).toBe(64);
    const f = build(grease + x25519Stanza(id.recipient, fileKey), fileKey, [Buffer.from("ok")]);
    expect(Buffer.from(await ageDecrypt(f, [{ identity: id.identity }])).toString()).toBe("ok");
    const tooLong = build(`-> grease-z\n${b64(randomBytes(49))}\n` + x25519Stanza(id.recipient, fileKey), fileKey, [Buffer.from("ok")]);
    await fail(ageDecrypt(tooLong, [{ identity: id.identity }]), /line too long/);
  });

  it("refuse an empty last chunk after a full one", async () => {
    const fileKey = randomBytes(16);
    const f = build(scryptStanza("pw", fileKey), fileKey, [randomBytes(CHUNK), new Uint8Array()]);
    await fail(ageDecrypt(f, [{ passphrase: "pw" }]), /empty last chunk/);
  });

  it("refuse a header with an scrypt stanza next to another one", async () => {
    const id = await generateIdentity();
    const fileKey = randomBytes(16);
    const f = build(scryptStanza("pw", fileKey) + x25519Stanza(id.recipient, fileKey), fileKey, [Buffer.from("x")]);
    await fail(ageDecrypt(f, [{ passphrase: "pw" }]), /must be the only one/);
  });

  it("refuse an scrypt work factor above the limit before deriving anything", async () => {
    const fileKey = randomBytes(16);
    const head = `-> scrypt ${b64(randomBytes(16))} 21\n${b64(randomBytes(32))}\n`;
    await fail(ageDecrypt(build(head, fileKey, [Buffer.from("x")]), [{ passphrase: "pw" }]), /work factor 21 is above the limit 20/);
  });

  it("refuse an X25519 stanza whose share or body is not 32 bytes", async () => {
    const id = await generateIdentity();
    const fileKey = randomBytes(16);
    for (const [share, body] of [[31, 32], [32, 31], [33, 32]] as const) {
      const head = `-> X25519 ${b64(randomBytes(share))}\n${b64(randomBytes(body))}\n`;
      await fail(ageDecrypt(build(head, fileKey, [Buffer.from("x")]), [{ identity: id.identity }]), /bad X25519 stanza/);
    }
  });
});

describe("keys and bech32", () => {
  it("never takes an identity for a recipient or the other way round", async () => {
    const id = await generateIdentity();
    expect(parseRecipient(id.recipient).length).toBe(32);
    expect(parseIdentity(id.identity).length).toBe(32);
    expect(() => parseRecipient(id.identity)).toThrow(/not an age X25519 recipient/);
    expect(() => parseIdentity(id.recipient)).toThrow(/not an age X25519 identity/);
    // The right prefix with the wrong length is refused too.
    expect(() => parseRecipient(bech32Encode("age", new Uint8Array(31)))).toThrow(/not an age X25519 recipient/);
    expect(() => parseIdentity(bech32Encode("age-secret-key-", new Uint8Array(33)))).toThrow(/not an age X25519 identity/);
  });

  it("refuses data whose last group carries bits that are not zero padding", () => {
    // BIP-173's checksum over raw 5-bit groups, written here, so the groups can be anything.
    const G = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    const polymod = (v: number[]) => v.reduce((chk, x) => {
      const top = chk >>> 25;
      let c = ((chk & 0x1ffffff) << 5) ^ x;
      for (let i = 0; i < 5; i++) if ((top >>> i) & 1) c ^= G[i];
      return c;
    }, 1);
    const encodeWords = (hrp: string, words: number[]) => {
      const ex = [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));
      const chk = polymod(ex.concat(words, [0, 0, 0, 0, 0, 0])) ^ 1;
      return `${hrp}1${words.concat(Array.from({ length: 6 }, (_, i) => (chk >> (5 * (5 - i))) & 31)).map((w) => "qpzry9x8gf2tvdw0s3jn54khce6mua7l"[w]).join("")}`;
    };
    // 32 bytes are 52 groups: 256 bits and 4 bits of zero padding.
    const words = Array.from({ length: 52 }, (_, i) => (i * 7) & 31);
    words[51] &= 0b10000;
    expect(bech32Decode(encodeWords("age", words)).data).toHaveLength(32);
    expect(encodeWords("age", words)).toBe(bech32Encode("age", bech32Decode(encodeWords("age", words)).data));
    expect(() => bech32Decode(encodeWords("age", [...words.slice(0, 51), words[51] | 1]))).toThrow(/padding/);
    // Five or more bits left over are a whole extra group, never padding, even when zero.
    expect(() => bech32Decode(encodeWords("age", [...words, 0, 0]))).toThrow(/padding/);
  });

  it("matches the BIP-173 vectors and refuses a string without room for a checksum", () => {
    expect(bech32Decode("A12UEL5L")).toEqual({ hrp: "a", data: new Uint8Array() });
    expect(bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw").hrp).toBe("abcdef");
    expect(bech32Encode("abcdef", bech32Decode("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw").data)).toBe("abcdef1qpzry9x8gf2tvdw0s3jn54khce6mua7lmqqqxw");
    for (const s of ["1qqqqqqqqqqqqqq", "age1qqqqq", "age1"]) expect(() => bech32Decode(s), s).toThrow(/^bad bech32$/);
    expect(() => bech32Decode("Age1qqqqqqqqq")).toThrow(/mixed-case/);
    expect(() => bech32Decode("age1qqqqqqqbqq")).toThrow(/bad bech32 character/);
  });
});

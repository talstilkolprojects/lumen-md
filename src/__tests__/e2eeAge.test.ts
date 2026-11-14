/**
 * Plan W1.7: the age format and the primitives under it, against Node's own
 * crypto (ChaCha20-Poly1305, scrypt, BLAKE2b) and against age's rules.
 * Interop with an independent implementation: scripts/sync-protocol/agepy.py
 * via docs/sync-protocol-vectors.json (e2eeVectors.test.ts, check_vectors.py).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { AgeError, ageDecrypt, ageEncrypt, bech32Decode, bech32Encode, generateIdentity } from "../sync/e2ee/age";
// poly1305 alone is tested inside the in-house file (it is no primitive of the interface).
import { poly1305 } from "../sync/e2ee/primitives/chacha20poly1305";
import { chachaOpen, chachaSeal, scrypt, blake2b } from "../sync/e2ee/primitives";

describe("primitives", () => {
  it("ChaCha20-Poly1305 matches Node's, and refuses a changed byte (RFC 8439 Poly1305 vector too)", () => {
    expect(Buffer.from(poly1305(Buffer.from("85d6be7857556d337f4452fe42d506a80103808afb0db2fd4abff6af4149f51b", "hex"), Buffer.from("Cryptographic Forum Research Group"))).toString("hex")).toBe("a8061dc1305136c6c22b8baf0c0127a9");
    for (const len of [0, 1, 16, 63, 64, 65, 1000, 70_000]) {
      const k = randomBytes(32);
      const n = randomBytes(12);
      const pt = randomBytes(len);
      const aad = randomBytes(len % 40);
      const c = createCipheriv("chacha20-poly1305", k, n, { authTagLength: 16 });
      c.setAAD(aad);
      const ref = Buffer.concat([c.update(pt), c.final(), c.getAuthTag()]);
      const mine = chachaSeal(k, n, pt, aad);
      expect(Buffer.from(mine).equals(ref), `len ${len}`).toBe(true);
      expect(Buffer.from(chachaOpen(k, n, mine, aad)!).equals(pt)).toBe(true);
      mine[0] ^= 1;
      expect(chachaOpen(k, n, mine, aad)).toBeNull();
    }
  });

  it("scrypt and BLAKE2b match Node's", async () => {
    for (const [logN, r, p] of [[4, 8, 1], [10, 8, 1], [5, 2, 3]]) {
      const pw = randomBytes(12);
      const salt = randomBytes(16);
      expect(Buffer.from(await scrypt(pw, salt, { logN, r, p })).equals(scryptSync(pw, salt, 32, { N: 2 ** logN, r, p }))).toBe(true);
    }
    for (const n of [0, 1, 127, 128, 129, 1000]) {
      const d = randomBytes(n);
      expect(Buffer.from(blake2b(d, 64)).toString("hex")).toBe(createHash("blake2b512").update(d).digest("hex"));
    }
  });
});

describe("age", () => {
  it("round-trips to an X25519 recipient and a passphrase, across chunk boundaries", async () => {
    const id = await generateIdentity();
    expect(id.recipient).toMatch(/^age1[0-9a-z]{58}$/);
    expect(id.identity).toMatch(/^AGE-SECRET-KEY-1[0-9A-Z]{58}$/);
    for (const len of [0, 1, 65_535, 65_536, 65_537, 140_000]) {
      const pt = new Uint8Array(len).map((_, i) => i & 255);
      const f = await ageEncrypt(pt, [{ x25519: id.recipient }]);
      expect(new TextDecoder().decode(f.subarray(0, 22))).toBe("age-encryption.org/v1\n");
      expect(Buffer.from(await ageDecrypt(f, [{ identity: id.identity }])).equals(Buffer.from(pt))).toBe(true);
    }
    const f = await ageEncrypt(new TextEncoder().encode("שלום"), [{ passphrase: "סיסמה", logN: 10 }]);
    expect(new TextDecoder().decode(await ageDecrypt(f, [{ passphrase: "סיסמה" }]))).toBe("שלום");
  });

  it("refuses a wrong key, a changed header or payload, a truncated file, and scrypt mixed with others", async () => {
    const id = await generateIdentity();
    const other = await generateIdentity();
    const f = await ageEncrypt(new Uint8Array(70_000), [{ x25519: id.recipient }]);
    await expect(ageDecrypt(f, [{ identity: other.identity }])).rejects.toBeInstanceOf(AgeError);
    const head = f.slice();
    head[30] ^= 1;
    await expect(ageDecrypt(head, [{ identity: id.identity }])).rejects.toBeInstanceOf(AgeError);
    const body = f.slice();
    body[body.length - 3] ^= 1;
    await expect(ageDecrypt(body, [{ identity: id.identity }])).rejects.toThrow(/payload/);
    await expect(ageDecrypt(f.slice(0, f.length - 4500), [{ identity: id.identity }])).rejects.toBeInstanceOf(AgeError);
    await expect(ageEncrypt(new Uint8Array(1), [{ passphrase: "x" }, { x25519: id.recipient }])).rejects.toBeInstanceOf(AgeError);
  });

  it("bech32 round-trips and catches a typo", () => {
    const data = randomBytes(32);
    const s = bech32Encode("age", data);
    expect(Buffer.from(bech32Decode(s).data).equals(data)).toBe(true);
    const typo = s.slice(0, 10) + (s[10] === "q" ? "p" : "q") + s.slice(11);
    expect(() => bech32Decode(typo)).toThrow(AgeError);
  });
});

/**
 * W10.D12/D13 (plan 3.4, W1.7; research R3.5): the in-house primitives against
 * the RFC vectors, and against the audited libraries on 10,000 random vectors
 * per primitive (fewer for the memory-hard KDFs, see N below).
 *
 * The audited side (src/sync/e2ee/primitives/lib/audited.ts) needs
 * @noble/ciphers, @noble/hashes and hash-wasm, which are not in the lockfile
 * until the Mac run (10.M). Until then its block is skipped, and says why;
 * the RFC block runs on the in-house code everywhere.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { IN_HOUSE, type Primitives } from "../sync/e2ee/primitives";
import * as ourAge from "../sync/e2ee/age";

/**
 * The audited implementation, or the reason it can't run here. Loaded and then
 * probed once: an offline runner may resolve a missing package to a stand-in
 * that only throws when used, so a successful import alone proves nothing.
 */
const audited: { impl: Primitives | null; age: AgeLib | null; why: string } = await (async () => {
  try {
    const { AUDITED } = (await import("../sync/e2ee/primitives/lib/audited")) as { AUDITED: Primitives };
    const age = (await import("../sync/e2ee/primitives/lib/age")) as AgeLib;
    AUDITED.blake2b(new Uint8Array(1), 1);
    AUDITED.chachaSeal(new Uint8Array(32), new Uint8Array(12), new Uint8Array(1));
    await AUDITED.scrypt(new Uint8Array(1), new Uint8Array(1), { logN: 1, r: 1, p: 1, dkLen: 1 });
    await AUDITED.argon2id({ password: new Uint8Array(1), salt: new Uint8Array(16), memoryKiB: 8, iterations: 1, parallelism: 1, tagLength: 4 });
    return { impl: AUDITED, age, why: "" };
  } catch (e) {
    return { impl: null, age: null, why: `skip-reason: the audited libraries are not installed (${String((e as Error)?.message ?? e).split("\n")[0]}); they come with the Mac run, 10.M` };
  }
})();
type AgeLib = typeof import("../sync/e2ee/age");

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const unhex = (s: string) => new Uint8Array(Buffer.from(s.replace(/\s+/g, ""), "hex"));
const range = (from: number, n: number) => Uint8Array.from({ length: n }, (_, i) => from + i);

/** RFC vectors: each primitive's published answer. */
const RFC = {
  // RFC 8439 §2.8.2: the AEAD test vector.
  chacha: {
    key: range(0x80, 32),
    nonce: unhex("070000004041424344454647"),
    aad: unhex("50515253c0c1c2c3c4c5c6c7"),
    plaintext: new TextEncoder().encode("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."),
    ciphertextStart: "d31a8d34648e60db7b86afbc53ef7ec2",
    tag: "1ae10b594f09e26a7e902ecbd0600691",
  },
  // RFC 7693 Appendix A: BLAKE2b-512("abc").
  blake2b: { input: new TextEncoder().encode("abc"), digest: "ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923" },
  // RFC 7914 §12: scrypt("", "", N=16, r=1, p=1, dkLen=64).
  scrypt: { logN: 4, r: 1, p: 1, dkLen: 64, out: "77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906" },
  // RFC 9106 §5.3: Argon2id, m=32 KiB, t=3, p=4, with secret and associated data.
  argon2id: { tag: "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659" },
};

async function rfc(p: Primitives) {
  const c = RFC.chacha;
  const sealed = p.chachaSeal(c.key, c.nonce, c.plaintext, c.aad);
  expect(hex(sealed.subarray(0, 16))).toBe(c.ciphertextStart);
  expect(hex(sealed.subarray(sealed.length - 16))).toBe(c.tag);
  expect(p.chachaOpen(c.key, c.nonce, sealed, c.aad)).toEqual(c.plaintext);
  const bad = sealed.slice();
  bad[0] ^= 1;
  expect(p.chachaOpen(c.key, c.nonce, bad, c.aad)).toBeNull();
  expect(hex(p.blake2b(RFC.blake2b.input, 64))).toBe(RFC.blake2b.digest);
  expect(hex(p.blake2b([RFC.blake2b.input.subarray(0, 1), RFC.blake2b.input.subarray(1)], 64))).toBe(RFC.blake2b.digest);
  const s = RFC.scrypt;
  expect(hex(await p.scrypt(new Uint8Array(), new Uint8Array(), { logN: s.logN, r: s.r, p: s.p, dkLen: s.dkLen }))).toBe(s.out);
  const tag = await p.argon2id({ password: new Uint8Array(32).fill(1), salt: new Uint8Array(16).fill(2), secret: new Uint8Array(8).fill(3), associatedData: new Uint8Array(12).fill(4), memoryKiB: 32, iterations: 3, parallelism: 4, tagLength: 32 });
  expect(hex(tag)).toBe(RFC.argon2id.tag);
}

/** A small deterministic generator (xorshift32), so a difference is reproducible from its index. */
function rng(seed: number) {
  let x = seed >>> 0 || 1;
  const next = () => ((x ^= x << 13), (x ^= x >>> 17), (x ^= x << 5), x >>> 0);
  return {
    int: (n: number) => next() % n,
    bytes: (n: number) => Uint8Array.from({ length: n }, () => next() & 0xff),
  };
}

/** How many random vectors per primitive (LUMEN_DIFF_N overrides the 10,000). */
const N = Number(process.env.LUMEN_DIFF_N ?? 10_000);
const N_SCRYPT = Math.max(1, Math.round(N / 50)); // 200: N up to 2^10
const N_ARGON2 = Math.max(1, Math.round(N / 100)); // 100: up to 64 KiB, 3 passes

describe("the in-house primitives match the RFC vectors", () => {
  it("ChaCha20-Poly1305 (RFC 8439), BLAKE2b (RFC 7693), scrypt (RFC 7914), Argon2id (RFC 9106)", async () => {
    await rfc(IN_HOUSE);
  }, 60_000);
});

describe.skipIf(!audited.impl)(`in-house vs audited libraries${audited.impl ? "" : ` (${audited.why})`}`, () => {
  const lib = audited.impl!;
  it("the audited libraries match the RFC vectors", async () => {
    await rfc(lib);
  }, 60_000);

  it(`ChaCha20-Poly1305: ${N} random keys, nonces, messages and AADs, sealed and opened both ways`, () => {
    const r = rng(0x4c756d65);
    for (let i = 0; i < N; i++) {
      const key = r.bytes(32);
      const nonce = r.bytes(12);
      const pt = r.bytes(r.int(300));
      const aad = r.bytes(r.int(40));
      const a = IN_HOUSE.chachaSeal(key, nonce, pt, aad);
      const b = lib.chachaSeal(key, nonce, pt, aad);
      if (hex(a) !== hex(b)) throw new Error(`chacha seal differs at vector ${i}`);
      expect(lib.chachaOpen(key, nonce, a, aad)).toEqual(pt);
      expect(IN_HOUSE.chachaOpen(key, nonce, b, aad)).toEqual(pt);
    }
  }, 600_000);

  it(`BLAKE2b: ${N} random inputs and output lengths`, () => {
    const r = rng(0x626c616b);
    for (let i = 0; i < N; i++) {
      const input = r.bytes(r.int(400));
      const len = 1 + r.int(64);
      if (hex(IN_HOUSE.blake2b(input, len)) !== hex(lib.blake2b(input, len))) throw new Error(`blake2b differs at vector ${i}`);
    }
  }, 600_000);

  it(`scrypt: ${N_SCRYPT} random passwords, salts and N up to 2^10`, async () => {
    const r = rng(0x73637279);
    for (let i = 0; i < N_SCRYPT; i++) {
      const pw = r.bytes(r.int(40));
      const salt = r.bytes(1 + r.int(32));
      const opts = { logN: 1 + r.int(10), r: 1 + r.int(8), p: 1 + r.int(2), dkLen: 1 + r.int(64) };
      if (hex(await IN_HOUSE.scrypt(pw, salt, opts)) !== hex(await lib.scrypt(pw, salt, opts))) throw new Error(`scrypt differs at vector ${i}: ${JSON.stringify(opts)}`);
    }
  }, 600_000);

  it(`Argon2id: ${N_ARGON2} random inputs up to 64 KiB and 3 passes`, async () => {
    const r = rng(0x61726732);
    for (let i = 0; i < N_ARGON2; i++) {
      const parallelism = 1 + r.int(4);
      const input = { password: r.bytes(r.int(64)), salt: r.bytes(8 + r.int(24)), memoryKiB: 8 * parallelism + r.int(64), iterations: 1 + r.int(3), parallelism, tagLength: 4 + r.int(60) };
      if (hex(await IN_HOUSE.argon2id(input)) !== hex(await lib.argon2id(input))) throw new Error(`argon2id differs at vector ${i}: ${JSON.stringify({ ...input, password: undefined, salt: undefined })}`);
    }
  }, 600_000);
});

describe.skipIf(!audited.age)(`age: ours and typage read each other's files${audited.age ? "" : ` (${audited.why})`}`, () => {
  it("X25519 and passphrase files, both ways", async () => {
    const lib = audited.age!;
    const id = await ourAge.generateIdentity();
    const msg = new TextEncoder().encode("שלום, age");
    expect(await lib.ageDecrypt(await ourAge.ageEncrypt(msg, [{ x25519: id.recipient }]), [{ identity: id.identity }])).toEqual(msg);
    expect(await ourAge.ageDecrypt(await lib.ageEncrypt(msg, [{ x25519: id.recipient }]), [{ identity: id.identity }])).toEqual(msg);
    const pw = { passphrase: "correct horse battery staple", logN: 10 };
    expect(await lib.ageDecrypt(await ourAge.ageEncrypt(msg, [pw]), [{ passphrase: pw.passphrase }])).toEqual(msg);
    expect(await ourAge.ageDecrypt(await lib.ageEncrypt(msg, [pw]), [{ passphrase: pw.passphrase }])).toEqual(msg);
  }, 120_000);
});

describe("the skip is honest", () => {
  it("names why the audited block did not run, or ran", () => {
    if (audited.impl) expect(audited.impl.name).toMatch(/noble/);
    else expect(audited.why).toMatch(/^skip-reason: the audited libraries are not installed/);
  });
});

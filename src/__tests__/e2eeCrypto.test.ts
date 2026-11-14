/**
 * Encrypted sync (plan 3.4): byte helpers, KDF, keys, sealed objects, header.
 * Real WebCrypto (AES-256-GCM, HKDF-SHA256, HMAC-SHA256, PBKDF2-SHA256).
 */

import { describe, it, expect } from "vitest";
import { fromB64u, toB64u, utf8, fromUtf8, equalBytes, concat } from "../sync/e2ee/bytes";
import {
  deriveMasterKey,
  KdfUnavailableError,
  KDF_IDS,
  newKdfParams,
  PBKDF2_DEFAULT_ITERATIONS,
  PBKDF2_MIN_ITERATIONS,
  validateKdfParams,
  WeakKdfError,
} from "../sync/e2ee/kdf";
import { DecryptError, deriveVaultKeys, opaqueName, padLength, seal, unseal } from "../sync/e2ee/keys";
import {
  createHeader,
  decodeHeader,
  encodeHeader,
  PROTOCOL_VERSION,
  unlockHeader,
  UnsupportedProtocolError,
  WrongPassphraseError,
} from "../sync/e2ee/header";
import { TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

describe("e2ee bytes", () => {
  it("base64url round-trips every length and rejects foreign characters", () => {
    for (let n = 0; n < 40; n++) {
      const b = crypto.getRandomValues(new Uint8Array(n));
      const s = toB64u(b);
      expect(s).toMatch(/^[A-Za-z0-9_-]*$/);
      expect(equalBytes(fromB64u(s), b)).toBe(true);
    }
    expect(() => fromB64u("ab+c")).toThrow();
    expect(() => fromB64u("a")).toThrow();
  });

  it("decodes UTF-8 strictly", () => {
    expect(fromUtf8(utf8("שלום"))).toBe("שלום");
    expect(() => fromUtf8(new Uint8Array([0xff, 0xfe]))).toThrow();
    expect(equalBytes(concat(utf8("a"), utf8("b")), utf8("ab"))).toBe(true);
    expect(equalBytes(utf8("a"), utf8("ab"))).toBe(false);
  });
});

describe("e2ee KDF", () => {
  it("production defaults are PBKDF2-SHA256 with at least 600,000 iterations (OWASP 2023)", () => {
    expect(PBKDF2_MIN_ITERATIONS).toBeGreaterThanOrEqual(600_000);
    expect(PBKDF2_DEFAULT_ITERATIONS).toBeGreaterThanOrEqual(PBKDF2_MIN_ITERATIONS);
    const p = newKdfParams();
    expect(p.alg).toBe("pbkdf2-sha256");
    expect(p.iterations).toBeGreaterThanOrEqual(600_000);
    expect(fromB64u(p.salt)).toHaveLength(16);
  });

  it("refuses weak parameters unless a test lowers the floor explicitly", () => {
    const cheap = newKdfParams(TEST_ITERATIONS);
    expect(() => validateKdfParams(cheap)).toThrow(WeakKdfError);
    expect(validateKdfParams(cheap, TEST_POLICY)).toEqual(cheap);
    expect(() => validateKdfParams({ ...cheap, salt: toB64u(new Uint8Array(4)) }, TEST_POLICY)).toThrow(WeakKdfError);
    expect(() => validateKdfParams(null)).toThrow(WeakKdfError);
  });

  it("reserves argon2id without a format break: recognised, refused as unavailable", () => {
    expect(KDF_IDS).toContain("argon2id");
    const salt = toB64u(new Uint8Array(16));
    expect(() => validateKdfParams({ alg: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt })).toThrow(
      KdfUnavailableError,
    );
    expect(() => validateKdfParams({ alg: "scrypt", salt })).toThrow(KdfUnavailableError);
    return expect(
      deriveMasterKey("x", { alg: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt }),
    ).rejects.toBeInstanceOf(KdfUnavailableError);
  });

  it("normalises the passphrase to NFC (Hebrew typed on macOS and Windows derives one key)", async () => {
    const p = newKdfParams(TEST_ITERATIONS);
    const composed = "שָׁלוֹם é";
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    const a = await deriveMasterKey(composed, p);
    const b = await deriveMasterKey(decomposed, p);
    expect(a).toHaveLength(32);
    expect(equalBytes(a, b)).toBe(true);
    expect(equalBytes(a, await deriveMasterKey("other", p))).toBe(false);
  });
});

describe("e2ee sealed objects", () => {
  async function keys(id = "vault-1") {
    return deriveVaultKeys(crypto.getRandomValues(new Uint8Array(32)).slice(), id);
  }

  it("pads into coarse buckets", () => {
    expect(padLength(0)).toBe(256);
    expect(padLength(252)).toBe(256);
    expect(padLength(253)).toBe(512);
    expect(padLength(10_000) % 1024).toBe(0);
    for (const n of [0, 1, 300, 5000, 70_000, 1_000_000]) {
      expect(padLength(n)).toBeGreaterThanOrEqual(n + 4);
      if (n > 4096) expect(padLength(n) / (n + 4)).toBeLessThan(1.07);
    }
  });

  it("round-trips, hides the exact length, and uses a fresh nonce each time", async () => {
    const k = await keys();
    const data = utf8("# סוד\nתוכן");
    const a = await seal(k.blobs, k.vaultId, "blob", "n1", data);
    const b = await seal(k.blobs, k.vaultId, "blob", "n1", data);
    expect(equalBytes(a, b)).toBe(false);
    expect(a.length).toBe(1 + 12 + 256 + 16);
    expect(fromUtf8(await unseal(k.blobs, k.vaultId, "blob", "n1", a))).toBe("# סוד\nתוכן");
  });

  it("fails on a flipped byte, another name, another vault or another key", async () => {
    const k = await keys();
    const sealed = await seal(k.blobs, k.vaultId, "blob", "n1", utf8("x"));
    const flipped = sealed.slice();
    flipped[20] ^= 1;
    await expect(unseal(k.blobs, k.vaultId, "blob", "n1", flipped)).rejects.toBeInstanceOf(DecryptError);
    await expect(unseal(k.blobs, k.vaultId, "blob", "n2", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(unseal(k.blobs, "vault-2", "blob", "n1", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(unseal(k.manifest, k.vaultId, "blob", "n1", sealed)).rejects.toBeInstanceOf(DecryptError);
    await expect(unseal(k.blobs, k.vaultId, "blob", "n1", sealed.slice(0, 10))).rejects.toBeInstanceOf(DecryptError);
  });

  it("opaque names are 43 base64url characters, keyed and deterministic", async () => {
    const k = await keys();
    const n = await opaqueName(k, "notes/שלום.md");
    expect(n).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await opaqueName(k, "notes/שלום.md")).toBe(n);
    expect(await opaqueName(await keys(), "notes/שלום.md")).not.toBe(n);
  });
});

describe("e2ee vault header", () => {
  it("unlocks with the right passphrase and refuses a wrong one", async () => {
    const { header } = await createHeader("correct horse", { pbkdf2Iterations: TEST_ITERATIONS });
    expect(header.protocol).toBe(PROTOCOL_VERSION);
    const parsed = decodeHeader(encodeHeader(header), TEST_POLICY);
    const k = await unlockHeader(parsed, "correct horse");
    expect(k.vaultId).toBe(header.vaultId);
    await expect(unlockHeader(parsed, "wrong horse")).rejects.toBeInstanceOf(WrongPassphraseError);
  });

  it("detects a provider that edits the KDF parameters, and a newer protocol", async () => {
    const { header } = await createHeader("pw", { pbkdf2Iterations: TEST_ITERATIONS });
    const edited = { ...header, kdf: { ...header.kdf, iterations: TEST_ITERATIONS + 1 } };
    await expect(unlockHeader(decodeHeader(encodeHeader(edited), TEST_POLICY), "pw")).rejects.toBeInstanceOf(
      WrongPassphraseError,
    );
    // A production client never accepts the cheap test parameters at all.
    expect(() => decodeHeader(encodeHeader(header))).toThrow(WeakKdfError);
    expect(() => decodeHeader(encodeHeader({ ...header, protocol: 2 }), TEST_POLICY)).toThrow(UnsupportedProtocolError);
    expect(() => decodeHeader(utf8("{"), TEST_POLICY)).toThrow();
    expect(() => decodeHeader(utf8(JSON.stringify({ format: "other" })), TEST_POLICY)).toThrow();
  });
});

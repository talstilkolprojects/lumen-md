/**
 * Plan W4.17 — tests for the mutants that survived src/storage/encryption.ts:
 * the stored layout (16-byte salt, 12-byte IV, then the AES-GCM ciphertext
 * and tag) is pinned by a vector made with the same parameters, and the
 * derived key may never be exported.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { decryptText, encryptText } from "../storage/encryption";

/**
 * "שלום, vault" sealed with the password "correct horse": salt 01..10,
 * IV c8..d3, PBKDF2-SHA-256 100,000 rounds, AES-256-GCM. 16 + 12 + 15 + 16 = 59 bytes.
 */
const VECTOR = "AQIDBAUGBwgJCgsMDQ4PEMjJysvMzc7P0NHS06Ckp6Lgr2lStIL1xP20tKfIyWw/ankm13i2bPq6+pU=";

describe("vault encryption, mutant-killing cases", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("decrypts the pinned vector: the salt is 16 bytes and the IV 12", async () => {
    expect(await decryptText(VECTOR, "correct horse")).toBe("שלום, vault");
  });

  it("writes salt + IV + ciphertext + tag, nothing more", async () => {
    const plain = "שלום, vault";
    const packed = atob(await encryptText(plain, "pw"));
    expect(packed.length).toBe(16 + 12 + new TextEncoder().encode(plain).length + 16);
  });

  it("derives a key that cannot be exported", async () => {
    const derive = vi.spyOn(crypto.subtle, "deriveKey");
    await encryptText("x", "pw");
    expect(derive).toHaveBeenCalledTimes(1);
    const [, , , extractable, usages] = derive.mock.calls[0] as unknown[];
    expect(extractable).toBe(false);
    expect(usages).toEqual(["encrypt", "decrypt"]);
  });

  it("round-trips a document larger than one 32 KiB chunk of the base64 packer", async () => {
    const big = "א".repeat(40_000);
    expect(await decryptText(await encryptText(big, "pw"), "pw")).toBe(big);
  });
});

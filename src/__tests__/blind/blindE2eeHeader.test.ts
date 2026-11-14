/**
 * Blind tests (plan W6.15, lane M2): the encrypted-sync vault header and the
 * manifest (src/sync/e2ee/header.ts, src/sync/e2ee/manifest.ts).
 *
 * Written from the spec only: docs/src/content/docs/sync/e2ee.md ("The
 * protocol (version 1)", "Rollback and replay protection") and the public API
 * of header.ts, manifest.ts, kdf.ts and keys.ts as declarations emitted by
 * offline tsc (doc comments, no function bodies). The test list (H1–H10,
 * M1–M10) was written before any implementation was opened; nothing in it was
 * changed to match the code. Failing cases would be `it.fails` entries naming
 * a finding in the W6.15 findings list (PR body of test/blind-tests).
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createHeader,
  decodeHeader,
  encodeHeader,
  HEADER_NAME,
  PROTOCOL_VERSION,
  rekeyHeader,
  unlockHeader,
  UnsupportedProtocolError,
  WrongPassphraseError,
  type VaultHeader,
} from "../../sync/e2ee/header";
import { PBKDF2_MIN_ITERATIONS } from "../../sync/e2ee/kdf";
import { DecryptError, deriveVaultKeys, type VaultKeys } from "../../sync/e2ee/keys";
import {
  blobName,
  checkFreshness,
  emptyManifest,
  HISTORY_LENGTH,
  manifestName,
  openManifest,
  pathRecord,
  RollbackError,
  sealManifest,
  type Manifest,
} from "../../sync/e2ee/manifest";

const PASS = "סיסמה ארוכה לכספת המוצפנת";
const text = (b: Uint8Array) => new TextDecoder().decode(b);
const json = (h: VaultHeader) => JSON.parse(text(encodeHeader(h))) as Record<string, unknown>;
const bytes = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

describe("vault header (blind, H1–H10)", () => {
  let made: Awaited<ReturnType<typeof createHeader>>;
  beforeAll(async () => {
    made = await createHeader(PASS);
  }, 60_000);

  it("H1: the header is named lumen-e2ee-vault and carries format, protocol 1, a vault id, the KDF and a mac — nothing else", () => {
    expect(HEADER_NAME).toBe("lumen-e2ee-vault");
    expect(PROTOCOL_VERSION).toBe(1);
    const h = json(made.header);
    expect(Object.keys(h).sort()).toEqual(["format", "kdf", "mac", "protocol", "vaultId"]);
    expect(h.protocol).toBe(1);
    expect(typeof h.vaultId).toBe("string");
    expect((h.vaultId as string).length).toBeGreaterThan(10);
  });

  it("H2: a new header never holds the passphrase, and a new vault gets a fresh id and salt", async () => {
    const raw = text(encodeHeader(made.header));
    expect(raw).not.toContain(PASS);
    expect(raw).not.toContain("סיסמה");
    const other = await createHeader(PASS);
    expect(other.header.vaultId).not.toBe(made.header.vaultId);
    expect(other.header.kdf.salt).not.toBe(made.header.kdf.salt);
  }, 60_000);

  it("H3: encode → decode gives the same header back", () => {
    expect(decodeHeader(encodeHeader(made.header))).toEqual(made.header);
  });

  it("H4: the right passphrase unlocks; a wrong one is WrongPassphraseError", async () => {
    await expect(unlockHeader(made.header, PASS)).resolves.toBeTruthy();
    await expect(unlockHeader(made.header, PASS + " ")).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(unlockHeader(made.header, "")).rejects.toBeInstanceOf(WrongPassphraseError);
  }, 60_000);

  it("H5: the passphrase is NFC-normalised — the decomposed form of the same text unlocks", async () => {
    const composed = "café שָׁלוֹם";
    const h = await createHeader(composed);
    const decomposed = composed.normalize("NFD");
    expect(decomposed).not.toBe(composed);
    await expect(unlockHeader(h.header, decomposed)).resolves.toBeTruthy();
  }, 60_000);

  it("H6: a service that edits any field (iterations up, salt, vault id) makes the MAC fail", async () => {
    const iter = { ...made.header, kdf: { ...made.header.kdf, iterations: (made.header.kdf as { iterations: number }).iterations + 1 } } as VaultHeader;
    await expect(unlockHeader(iter, PASS)).rejects.toThrow();
    const salt = { ...made.header, kdf: { ...made.header.kdf, salt: made.header.kdf.salt.slice(0, -2) + (made.header.kdf.salt.endsWith("AA") ? "AB" : "AA") } } as VaultHeader;
    await expect(unlockHeader(salt, PASS)).rejects.toThrow();
    const id = { ...made.header, vaultId: made.header.vaultId.slice(0, -1) + (made.header.vaultId.endsWith("A") ? "B" : "A") };
    await expect(unlockHeader(id, PASS)).rejects.toThrow();
  }, 120_000);

  it("H7: fewer than 600,000 PBKDF2 iterations is refused when read (OWASP 2023)", () => {
    expect(PBKDF2_MIN_ITERATIONS).toBe(600_000);
    const h = json(made.header);
    const weak = { ...h, kdf: { ...(h.kdf as object), iterations: 599_999 } };
    expect(() => decodeHeader(bytes(weak))).toThrow();
  });

  it("H8: an unknown KDF algorithm is refused, not guessed", () => {
    const h = json(made.header);
    expect(() => decodeHeader(bytes({ ...h, kdf: { ...(h.kdf as object), alg: "scrypt" } }))).toThrow();
  });

  it("H9: a newer protocol is UnsupportedProtocolError; malformed bytes throw", () => {
    const h = json(made.header);
    expect(() => decodeHeader(bytes({ ...h, protocol: 2 }))).toThrow(UnsupportedProtocolError);
    for (const bad of [new Uint8Array(0), new TextEncoder().encode("not json"), bytes(null), bytes([]), bytes({ ...h, format: "other" }), bytes({ ...h, mac: 5 }), bytes({ ...h, vaultId: undefined })]) {
      expect(() => decodeHeader(bad)).toThrow();
    }
  });

  it("H10: a passphrase change (rekeyHeader) keeps the vault id, changes the salt, and the old passphrase no longer unlocks", async () => {
    const next = await rekeyHeader(made.header.vaultId, "a new passphrase for this vault");
    expect(next.header.vaultId).toBe(made.header.vaultId);
    expect(next.header.kdf.salt).not.toBe(made.header.kdf.salt);
    expect(next.master.length).toBe(32);
    await expect(unlockHeader(next.header, "a new passphrase for this vault")).resolves.toBeTruthy();
    await expect(unlockHeader(next.header, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
  }, 120_000);
});

describe("manifest (blind, M1–M10)", () => {
  const vaultId = "blind-vault-id-0001";
  let keys: VaultKeys;
  let otherKeys: VaultKeys;
  beforeAll(async () => {
    keys = await deriveVaultKeys(crypto.getRandomValues(new Uint8Array(32)), vaultId);
    otherKeys = await deriveVaultKeys(crypto.getRandomValues(new Uint8Array(32)), vaultId);
  });

  const withFile = (counter: number, path: string): Manifest => {
    const m = emptyManifest(vaultId);
    m.counter = counter;
    m.files = pathRecord({ [path]: { ver: 1, rev: "r1", hash: "0".repeat(64), size: 3, by: "dev-a" } });
    return m;
  };

  it("M1: seal → open gives the manifest back, with the digest it was sealed with", async () => {
    const m = withFile(3, "notes/א.md");
    const s = await sealManifest(keys, m);
    const o = await openManifest(keys, s.bytes);
    expect(o.manifest.files["notes/א.md"]).toEqual(m.files["notes/א.md"]);
    expect(o.manifest.counter).toBe(3);
    expect(o.digest).toBe(s.digest);
    expect(s.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("M2: the sealed bytes hold no path, no counter, no device id in clear", async () => {
    const s = await sealManifest(keys, withFile(77_777, "Private/diary-secret.md"));
    const raw = new TextDecoder("latin1").decode(s.bytes);
    for (const leak of ["diary-secret", "Private", "77777", "dev-a", vaultId]) expect(raw).not.toContain(leak);
  });

  it("M3: every flipped byte, a cut tag or another vault key is DecryptError", async () => {
    const s = await sealManifest(keys, withFile(1, "a.md"));
    for (const i of [0, 1, 12, 13, Math.floor(s.bytes.length / 2), s.bytes.length - 1]) {
      const t = new Uint8Array(s.bytes);
      t[i] ^= 0x01;
      await expect(openManifest(keys, t), `byte ${i}`).rejects.toBeInstanceOf(DecryptError);
    }
    await expect(openManifest(keys, s.bytes.slice(0, -1))).rejects.toBeInstanceOf(DecryptError);
    await expect(openManifest(otherKeys, s.bytes)).rejects.toBeInstanceOf(DecryptError);
  });

  it("M4: a manifest sealed under one object name does not open under another (the name is bound in)", async () => {
    const s = await sealManifest(keys, withFile(1, "a.md"), "manifest-name-one");
    await expect(openManifest(keys, s.bytes, "manifest-name-two")).rejects.toBeInstanceOf(DecryptError);
    await expect(openManifest(keys, s.bytes, "manifest-name-one")).resolves.toBeTruthy();
  });

  it("M5: two seals of the same manifest differ (a fresh nonce) and sizes are padded to 256-byte buckets", async () => {
    const m = withFile(1, "a.md");
    const a = await sealManifest(keys, m);
    const b = await sealManifest(keys, m);
    expect(a.bytes.length === b.bytes.length && a.bytes.every((x, i) => x === b.bytes[i])).toBe(false);
    const small = await sealManifest(keys, withFile(1, "b.md"));
    const longer = await sealManifest(keys, withFile(1, "b".repeat(40) + ".md"));
    expect(longer.bytes.length).toBe(small.bytes.length);
  });

  it("M6: the manifest's name is the same for every version and says nothing; blob names hide the path and change per revision", async () => {
    const n1 = await manifestName(keys);
    expect(await manifestName(keys)).toBe(n1);
    expect(n1).not.toMatch(/manifest/i);
    const b1 = await blobName(keys, "notes/a.md", "rev1");
    const b2 = await blobName(keys, "notes/a.md", "rev2");
    expect(b1).not.toBe(b2);
    expect(b1).not.toContain("notes");
    expect(b1).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await blobName(otherKeys, "notes/a.md", "rev1")).not.toBe(b1);
  });

  it("M7: a note called __proto__ or constructor is an ordinary path, through seal and open", async () => {
    const m = emptyManifest(vaultId);
    m.counter = 1; // a written manifest (every write raises the counter)
    // JSON.parse makes "__proto__" an own key (an object literal would set the prototype).
    const stored = JSON.parse(`{"__proto__":{"ver":1,"rev":"r","hash":"${"1".repeat(64)}","size":1,"by":"d"},"constructor":{"ver":2,"rev":"s","hash":"${"2".repeat(64)}","size":2,"by":"d"}}`) as Record<string, Manifest["files"][string]>;
    m.files = pathRecord(stored);
    expect(Object.keys(m.files).sort()).toEqual(["__proto__", "constructor"]);
    const o = await openManifest(keys, (await sealManifest(keys, m)).bytes);
    expect(Object.prototype.hasOwnProperty.call(o.manifest.files, "__proto__")).toBe(true);
    const ctor: string = "constructor";
    expect(o.manifest.files[ctor].ver).toBe(2);
    expect(({} as Record<string, unknown>).ver).toBeUndefined();
  });

  it("M8: freshness — an older counter is a replay, the same counter with other content a fork", () => {
    const anchor = { counter: 10, digest: "a".repeat(64) };
    expect(checkFreshness(anchor, anchor, [])).toBe("ok");
    const older = (() => {
      try {
        checkFreshness(anchor, { counter: 9, digest: "b".repeat(64) }, []);
      } catch (e) {
        return e;
      }
    })();
    expect(older).toBeInstanceOf(RollbackError);
    expect((older as RollbackError).kind).toBe("older");
    const fork = (() => {
      try {
        checkFreshness(anchor, { counter: 10, digest: "c".repeat(64) }, []);
      } catch (e) {
        return e;
      }
    })();
    expect(fork).toBeInstanceOf(RollbackError);
    expect((fork as RollbackError).kind).toBe("fork");
  });

  it("M9: a newer counter must descend from the anchor: listed with the anchor's digest is ok, another digest is a fork", () => {
    const anchor = { counter: 10, digest: "a".repeat(64) };
    expect(checkFreshness(anchor, { counter: 12, digest: "d".repeat(64) }, [[10, anchor.digest], [11, "e".repeat(64)]])).toBe("ok");
    expect(() => checkFreshness(anchor, { counter: 12, digest: "d".repeat(64) }, [[10, "f".repeat(64)], [11, "e".repeat(64)]])).toThrow(RollbackError);
  });

  it("M10: with no anchor yet, or an anchor older than the history reaches, the answer is unproven, never ok", () => {
    expect(HISTORY_LENGTH).toBe(100);
    const history: Array<[number, string]> = Array.from({ length: HISTORY_LENGTH }, (_, i) => [201 + i, "9".repeat(64)]);
    const got = { counter: 301, digest: "d".repeat(64) };
    expect(checkFreshness({ counter: 5, digest: "a".repeat(64) }, got, history)).toBe("unproven");
    expect(checkFreshness({ counter: 5, digest: "a".repeat(64) }, got)).toBe("unproven");
    // First contact: trust on first use; it must not throw.
    expect(["ok", "unproven"]).toContain(checkFreshness(null, got, history));
  });
});

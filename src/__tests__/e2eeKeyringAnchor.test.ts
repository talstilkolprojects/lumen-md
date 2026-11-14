// The keyring's small checks that the flow tests pass through without pinning (W4.17 survivors of
// src/sync/e2ee/keyring.ts after lane K rounds 4 and 5): the file shape (dropped markers), the
// verified anchor (N1: epoch 0, no check yet, a good and a wrong check), a missing keyring after
// one was seen, and the rollback error's own message.
import { describe, expect, it } from "vitest";
import { utf8 } from "../sync/e2ee/bytes";
import type { VaultKeys } from "../sync/e2ee/keys";
import { memoryProvider } from "../sync/e2ee/provider";
import { decodeKeyring, KEYRING_PROTOCOL, KeyringForkError, KeyringRollbackError, refreshKeys, sealAnchor, verifyAnchor } from "../sync/e2ee/keyring";

const file = (extra: Record<string, unknown> = {}) =>
  utf8(JSON.stringify({ format: "lumen-e2ee-keyring", protocol: KEYRING_PROTOCOL, vaultId: "v1", epoch: 2, passphrase: { n: "a", c: "b" }, sealed: { n: "c", c: "d" }, devices: {}, ...extra }));
const marker = (epoch: number) => ({ epoch, at: 1, devices: ["phone"], mac: "m" });

describe("keyring file shape", () => {
  it("reads a keyring with no dropped markers, and one whose marker is for epoch 1", () => {
    expect(decodeKeyring(file()).epoch).toBe(2);
    expect(decodeKeyring(file({ dropped: [marker(1)] })).dropped).toEqual([marker(1)]);
  });

  it("refuses a dropped marker for epoch 0, or a list that isn't one", () => {
    expect(() => decodeKeyring(file({ dropped: [marker(0)] }))).toThrow(/Not a Lumen keyring/);
    expect(() => decodeKeyring(file({ dropped: marker(1) }))).toThrow(/Not a Lumen keyring/);
  });
});

describe("the verified anchor (N1)", () => {
  const secret = new Uint8Array(32).fill(7);
  const keys = (epoch: number) => ({ epoch, vaultId: "v1", secret, olderSecrets: new Map<number, Uint8Array>() }) as unknown as VaultKeys;

  it("epoch 0 has no keyring and no check, and any keys descend from it", async () => {
    expect(await sealAnchor({ epoch: 0, rev: 3, digest: "x" }, secret, "v1")).toEqual({ epoch: 0, rev: 0, digest: "" });
    expect(await verifyAnchor({} as VaultKeys, { epoch: 0, rev: 0, digest: "" })).toBe(true);
  });

  it("an anchor with no check yet says false; a sealed one verifies; another secret's check is a fork", async () => {
    expect(await verifyAnchor(keys(1), { epoch: 1, rev: 2, digest: "d" })).toBe(false);
    const sealed = await sealAnchor({ epoch: 1, rev: 2, digest: "d" }, secret, "v1");
    expect(sealed.check).toMatch(/^[\w-]+$/);
    expect(await verifyAnchor(keys(1), sealed)).toBe(true);
    const other = await sealAnchor({ epoch: 1, rev: 2, digest: "d" }, new Uint8Array(32).fill(8), "v1");
    await expect(verifyAnchor(keys(1), other)).rejects.toBeInstanceOf(KeyringForkError);
  });
});

describe("a missing keyring after one was seen", () => {
  const keys = (epoch: number) => ({ epoch, vaultId: "v1" }) as unknown as VaultKeys;

  it("is a rollback to epoch 0, whether this device saw the keyring or holds its keys", async () => {
    const empty = memoryProvider();
    await expect(refreshKeys(empty, keys(0), { wrap: {} as CryptoKey }, 1)).rejects.toMatchObject({ name: "KeyringRollbackError", seen: 1, got: 0 });
    await expect(refreshKeys(empty, keys(1), { wrap: {} as CryptoKey })).rejects.toMatchObject({ name: "KeyringRollbackError", seen: 1, got: 0 });
    const fresh = keys(0);
    expect(await refreshKeys(empty, fresh, { wrap: {} as CryptoKey })).toBe(fresh);
  });
});

describe("KeyringRollbackError", () => {
  it("names both epochs by default, and keeps a message it is given, even an empty one", () => {
    expect(new KeyringRollbackError(5, 3).message).toMatch(/epoch 3, older than 5/);
    expect(new KeyringRollbackError(5, 3, "revision 5.1").message).toBe("revision 5.1");
    expect(new KeyringRollbackError(5, 3, "").message).toBe("");
  });
});

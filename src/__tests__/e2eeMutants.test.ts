/**
 * Plan 0.15 — tests written for mutants that survived the e2ee suites:
 * the keyring's shape check (a forged or damaged keyring is refused field by
 * field) and the conflict helpers (binary sides never reach the dialog; copy
 * names count up).
 */
import { describe, expect, it } from "vitest";
import { decodeKeyring } from "../sync/e2ee/keyring";
import { DecryptError } from "../sync/e2ee/keys";
import { asText, conflictCopyPath, dialogResolver } from "../sync/e2ee/conflict";

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));
const sealed = { n: "bm9uY2U", c: "Y2lwaGVy" };
const valid = { format: "lumen-e2ee-keyring", protocol: 1, vaultId: "v1", epoch: 1, passphrase: sealed, sealed, devices: {} };

describe("decodeKeyring refuses anything but a well-formed keyring", () => {
  it("accepts a well-formed one", () => {
    expect(decodeKeyring(enc(valid)).epoch).toBe(1);
    expect(decodeKeyring(enc({ ...valid, epoch: 7 })).epoch).toBe(7);
  });

  const bad: [string, unknown][] = [
    ["not JSON", null],
    ["another format", { ...valid, format: "other" }],
    ["another protocol", { ...valid, protocol: 2 }],
    ["protocol 0", { ...valid, protocol: 0 }],
    ["no vault id", { ...valid, vaultId: 5 }],
    ["fractional epoch", { ...valid, epoch: 1.5 }],
    ["epoch 0", { ...valid, epoch: 0 }],
    ["no passphrase seal", { ...valid, passphrase: null }],
    ["passphrase seal without a nonce", { ...valid, passphrase: { c: "x" } }],
    ["passphrase seal without a ciphertext", { ...valid, passphrase: { n: "x" } }],
    ["no sealed secret", { ...valid, sealed: undefined }],
    ["sealed secret with a number", { ...valid, sealed: { n: "x", c: 3 } }],
    ["no devices", { ...valid, devices: null }],
    ["devices not an object", { ...valid, devices: "x" }],
  ];
  for (const [name, o] of bad) {
    it(`refuses: ${name}`, () => {
      const bytes = o === null ? new TextEncoder().encode("{not json") : enc(o);
      expect(() => decodeKeyring(bytes)).toThrow(DecryptError);
    });
  }
});

describe("conflict helpers", () => {
  it("reads text and refuses binary (NUL or invalid UTF-8)", () => {
    expect(asText(new TextEncoder().encode("שלום"))).toBe("שלום");
    expect(asText(new Uint8Array([104, 0, 105]))).toBe(null);
  });

  it("keeps both sides of a binary conflict without opening the dialog", async () => {
    const bin = new Uint8Array([0, 1, 2]);
    const txt = new TextEncoder().encode("text");
    expect(await dialogResolver({ path: "a.png", local: bin, remote: txt, base: null } as never)).toEqual({ kind: "keepBoth" });
    expect(await dialogResolver({ path: "a.png", local: txt, remote: bin, base: null } as never)).toEqual({ kind: "keepBoth" });
  });

  it("names conflict copies, counting up past taken names", () => {
    expect(conflictCopyPath("notes/a.md", "laptop", () => false)).toBe("notes/a (conflict laptop).md");
    const taken = new Set(["notes/a (conflict laptop).md", "notes/a (conflict laptop 2).md"]);
    expect(conflictCopyPath("notes/a.md", "laptop", (p) => taken.has(p))).toBe("notes/a (conflict laptop 3).md");
    expect(conflictCopyPath("README", "x", () => false)).toBe("README (conflict x)");
    expect(conflictCopyPath(".env", "x", () => false)).toBe(".env (conflict x)");
  });
});

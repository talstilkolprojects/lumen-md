/**
 * Plan W1.7: the published test vectors (docs/sync-protocol-vectors.json)
 * open with this code exactly as the spec says. The same file is checked
 * independently by scripts/sync-protocol/check_vectors.py (Python).
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { memoryProvider } from "../sync/e2ee/provider";
import { E2eeSync, unlockVault, unlockWithDevice } from "../sync/e2ee/engine";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { ageDecrypt } from "../sync/e2ee/age";
import { argon2id } from "../sync/e2ee/primitives/argon2";
import { readPairingCode } from "../sync/e2ee/pairing";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
interface Vault {
  name: string;
  passphrase: string;
  objects: Record<string, string>;
  expect: { epoch: number; files: Record<string, string> };
  device?: { id: string; identity: string };
}
const V = JSON.parse(readFileSync(join(root, "docs/sync-protocol-vectors.json"), "utf8")) as {
  vaults: Vault[];
  argon2id: Array<{ password: string; salt: string; memoryKiB: number; iterations: number; parallelism: number; tag: string }>;
  age: Array<{ identity?: string; passphrase?: string; plaintext: string; file: string }>;
  pairing: { vault: number; code: string; body: { counter: number; digest: string } };
};
const bytes = (b64: string) => new Uint8Array(Buffer.from(b64, "base64"));

async function load(v: Vault) {
  const p = memoryProvider();
  for (const [n, d] of Object.entries(v.objects)) await p.put(n, bytes(d));
  return p;
}

async function readAll(v: Vault, keysOf: (p: ReturnType<typeof memoryProvider>) => Promise<{ keys: import("../sync/e2ee/keys").VaultKeys; access?: { device: string; identity: string } }>) {
  const p = await load(v);
  const { keys, access } = await keysOf(p);
  const files = memoryFiles();
  await new E2eeSync({ provider: p, keys, local: files, store: memoryStateStore(), ...(access ? { access } : {}) }).sync();
  return { epoch: keys.epoch, files: Object.fromEntries([...files.files.keys()].map((k) => [k, files.text(k) ?? ""])) };
}

describe("the sync protocol's test vectors", () => {
  for (const v of V.vaults) {
    it(`opens "${v.name}" with the passphrase${v.device ? " and with the device key" : ""}`, async () => {
      const got = await readAll(v, (p) => unlockVault(p, v.passphrase, { minPbkdf2Iterations: 1000 }));
      expect(got).toEqual(v.expect);
      if (v.device) {
        const d = v.device;
        expect(await readAll(v, async (p) => ({ ...(await unlockWithDevice(p, d.id, d.identity)), access: { device: d.id, identity: d.identity } }))).toEqual(v.expect);
      }
    }, 60_000);
  }

  it("Argon2id, age (X25519 and scrypt) and the pairing code", async () => {
    for (const a of V.argon2id) {
      expect(Buffer.from(argon2id({ password: bytes(a.password), salt: bytes(a.salt), memoryKiB: a.memoryKiB, iterations: a.iterations, parallelism: a.parallelism, tagLength: 32 })).toString("base64")).toBe(a.tag);
    }
    for (const a of V.age) {
      const pt = await ageDecrypt(bytes(a.file), [a.identity ? { identity: a.identity } : { passphrase: a.passphrase! }]);
      expect(Buffer.from(pt).toString("base64")).toBe(a.plaintext);
    }
    const v = V.vaults[V.pairing.vault];
    const { keys } = await unlockVault(await load(v), v.passphrase, { minPbkdf2Iterations: 1000 });
    expect(await readPairingCode(keys, V.pairing.code, 1_800_000_000_000)).toEqual(V.pairing.body);
  }, 60_000);
});

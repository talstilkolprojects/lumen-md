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
import { argon2id } from "../sync/e2ee/primitives";
import { readPairingAnswer, readPairingCode, readPairingRequest } from "../sync/e2ee/pairing";
import { manifestName, openManifest } from "../sync/e2ee/manifest";
import { confirmTag, deriveSas, sasCommit, sasKeyPair, type SasTranscript } from "../sync/e2ee/sas";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
interface Vault {
  name: string;
  passphrase: string;
  objects: Record<string, string>;
  expect: { epoch: number; files: Record<string, string> };
  device?: { id: string; identity: string };
  /** The epoch's manifest is frozen (a re-key cut off before its commit). */
  frozen?: boolean;
  /** A passphrase change cut off before its header: the old passphrase still opens the epoch before. */
  pending?: { oldPassphrase: string; oldEpoch: number; oldFiles: string[] };
}
const V = JSON.parse(readFileSync(join(root, "docs/sync-protocol-vectors.json"), "utf8")) as {
  vaults: Vault[];
  argon2id: Array<{ password: string; salt: string; memoryKiB: number; iterations: number; parallelism: number; tag: string }>;
  age: Array<{ identity?: string; passphrase?: string; plaintext: string; file: string }>;
  pairing: Array<{ vault: number; code: string; body: { counter: number; digest: string; ring: { epoch: number; rev: number; digest: string } } }>;
  pairingTwoWay: Array<{
    vault: number;
    now: number;
    request: string;
    requestBody: { nonce: string; ring: { epoch: number; rev: number; digest: string }; manifest: { counter: number; digest: string } | null; issuedAt: number; hash: string };
    answer: string;
    answerBody: { counter: number; digest: string; ring: { epoch: number; rev: number; digest: string } };
  }>;
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
      if (v.frozen) {
        const p = await load(v);
        const { keys } = await unlockVault(p, v.passphrase, { minPbkdf2Iterations: 1000 });
        const name = await manifestName(keys);
        expect((await openManifest(keys, p.objects.get(name)!.data, name)).manifest.frozen?.epoch).toBe(keys.epoch + 1);
      }
      if (v.pending) {
        const p = await load(v);
        const { keys } = await unlockVault(p, v.pending.oldPassphrase, { minPbkdf2Iterations: 1000 });
        expect(keys.epoch).toBe(v.pending.oldEpoch);
        const name = await manifestName(keys);
        expect(Object.keys((await openManifest(keys, p.objects.get(name)!.data, name)).manifest.files)).toEqual(v.pending.oldFiles);
      }
      if (v.device) {
        const d = v.device;
        expect(await readAll(v, async (p) => ({ ...(await unlockWithDevice(p, d.id, d.identity)), access: { device: d.id, identity: d.identity } }))).toEqual(v.expect);
      }
    }, 60_000);
  }

  it("Argon2id, age (X25519 and scrypt), the one-way pairing code and the two-way request and answer", async () => {
    for (const a of V.argon2id) {
      expect(Buffer.from(await argon2id({ password: bytes(a.password), salt: bytes(a.salt), memoryKiB: a.memoryKiB, iterations: a.iterations, parallelism: a.parallelism, tagLength: 32 })).toString("base64")).toBe(a.tag);
    }
    for (const a of V.age) {
      const pt = await ageDecrypt(bytes(a.file), [a.identity ? { identity: a.identity } : { passphrase: a.passphrase! }]);
      expect(Buffer.from(pt).toString("base64")).toBe(a.plaintext);
    }
    for (const pv of V.pairing) {
      const v = V.vaults[pv.vault];
      const { keys } = await unlockVault(await load(v), v.passphrase, { minPbkdf2Iterations: 1000 });
      expect(await readPairingCode(keys, pv.code, 1_800_000_000_000)).toEqual(pv.body);
    }
    expect(V.pairingTwoWay).toHaveLength(2);
    for (const pv of V.pairingTwoWay) {
      const v = V.vaults[pv.vault];
      const { keys } = await unlockVault(await load(v), v.passphrase, { minPbkdf2Iterations: 1000 });
      expect(await readPairingRequest(keys, pv.request)).toEqual(pv.requestBody);
      expect(await readPairingAnswer(keys, pv.answer, pv.requestBody, pv.now + 1000)).toEqual(pv.answerBody);
      // F1: the kind is inside the MAC — a request under another kind's prefix doesn't verify.
      const body = pv.request.slice(pv.request.indexOf(":", "lumen-pair-request:3:".length));
      await expect(readPairingAnswer(keys, `lumen-pair-answer:3:${pv.requestBody.ring.epoch}${body}`, pv.requestBody, pv.now + 1000)).rejects.toThrow(/not from this vault/);
      await expect(readPairingCode(keys, `lumen-pair:4:${pv.requestBody.ring.epoch}${body}`, pv.now)).rejects.toThrow(/not from this vault/);
    }
  }, 60_000);

  it("the pairing comparison (plan W8.5): both sides derive the stated symbols and confirmations from the transcript", async () => {
    const sas = (V as unknown as { sas: Array<{ flow: string; issuerKey: string; joinerKey: string; transcript: string; commitI?: string; commitJ?: string; symbols: number[]; confirmIssuer: string; confirmJoiner: string; windowIssuer: number; windowJoiner: number }> }).sas;
    expect(sas).toHaveLength(4);
    for (const sv of sas) {
      const i = await sasKeyPair(Buffer.from(sv.issuerKey, "hex"));
      const j = await sasKeyPair(Buffer.from(sv.joinerKey, "hex"));
      const a = JSON.parse(sv.transcript) as [string, "one-way" | "two-way", string, number, number, string, number, string, string, string, string, string, string];
      const t: SasTranscript = { flow: a[1], vaultId: a[2], epoch: a[3], ringRev: a[4], ringDigest: a[5], counter: a[6], digest: a[7], session: a[8], answer: a[9], nonce: a[10], pubI: i.pub, pubJ: j.pub };
      const si = await deriveSas(i.priv, j.pub, t);
      const sj = await deriveSas(j.priv, i.pub, t);
      expect(si.symbols).toEqual(sv.symbols);
      expect(sj.symbols).toEqual(sv.symbols);
      expect(Buffer.from(await confirmTag(si, "issuer", sv.windowIssuer)).toString("base64url")).toBe(sv.confirmIssuer);
      expect(Buffer.from(await confirmTag(sj, "joiner", sv.windowJoiner)).toString("base64url")).toBe(sv.confirmJoiner);
      // S27-1: the window is under the MAC.
      expect(Buffer.from(await confirmTag(sj, "joiner", sv.windowJoiner + 1)).toString("base64url")).not.toBe(sv.confirmJoiner);
      if (sv.commitI) expect(await sasCommit(i.pub)).toBe(sv.commitI);
      if (sv.commitJ) expect(await sasCommit(j.pub)).toBe(sv.commitJ);
      // Another transcript (one field changed) gives other symbols or other confirmations.
      const other = await deriveSas(i.priv, j.pub, { ...t, counter: t.counter + 1 });
      expect(Buffer.from(await confirmTag(other, "issuer", sv.windowIssuer)).toString("base64url")).not.toBe(sv.confirmIssuer);
    }
  });
});

/**
 * Make docs/sync-protocol-vectors.json (plan W1.7) with the app's own code:
 *   node --experimental-transform-types scripts/sync-protocol/make-vectors.mts
 * (run with a loader that resolves extension-less TypeScript imports, or via
 * vitest: src/__tests__/e2eeVectors.test.ts checks the committed file against
 * the same code). The vectors are random each time they are made; they are
 * checked, not compared byte for byte.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { memoryProvider } from "../../src/sync/e2ee/provider";
import { createVault, E2eeSync, unlockVault } from "../../src/sync/e2ee/engine";
import { memoryFiles } from "../../src/sync/e2ee/localFiles";
import { memoryStateStore } from "../../src/sync/e2ee/state";
import { generateIdentity, ageEncrypt } from "../../src/sync/e2ee/age";
import { argon2id } from "../../src/sync/e2ee/primitives/argon2";
import { createPairingAnswer, createPairingCode, createPairingRequest, pairingRequestHash, readPairingCode } from "../../src/sync/e2ee/pairing";
import { confirmTag, deriveSas, sasCommit, sasKeyPair, transcriptBytes, type SasTranscript } from "../../src/sync/e2ee/sas";
import type { VaultKeys } from "../../src/sync/e2ee/keys";
import { HEADER_NAME } from "../../src/sync/e2ee/header";
import { KEYRING_NAME } from "../../src/sync/e2ee/keyring";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const NOTES: Record<string, string> = { "שלום.md": "# שלום עולם\n\nנִקּוּד וגרש׳ 123", "notes/a.md": "plain ASCII", "notes/empty.md": "", "big.md": "x".repeat(5000) };

/** `cut(name)` true: that write fails once (a re-key cut off), for the frozen and pending-header vaults. */
let cut: ((name: string) => boolean) | null = null;
async function vault(name: string, passphrase: string, kdf: { pbkdf2Iterations?: number }, steps: (s: E2eeSync, files: ReturnType<typeof memoryFiles>) => Promise<unknown>) {
  const p = memoryProvider({
    fault(op, n, phase) {
      if (cut && op === "put" && phase === "before" && cut(n)) {
        cut = null;
        throw new Error("cut off");
      }
    },
  });
  const { keys, anchor } = await createVault(p, passphrase, kdf);
  const files = memoryFiles();
  const sync = new E2eeSync({ provider: p, keys, local: files, store: memoryStateStore() });
  await sync.markCreated(anchor);
  const extra = (await steps(sync, files)) as Record<string, unknown> | undefined;
  const objects: Record<string, string> = {};
  for (const [n, o] of p.objects) objects[n] = b64(o.data);
  const expect: Record<string, string> = {};
  for (const [path] of files.files) expect[path] = files.text(path) ?? "";
  return { name, passphrase, objects, expect: { epoch: sync.keys().epoch, files: expect }, ...extra };
}

/*
 * --pairing-only: keep the vaults, Argon2id and age vectors of the committed
 * file and make only the pairing and comparison vectors again (plan W8.5
 * changed those formats; the rest didn't change).
 */
const OLD = process.argv.includes("--pairing-only") ? JSON.parse(readFileSync("docs/sync-protocol-vectors.json", "utf8")) : null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vaults: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let argon: any[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let ageVectors: any[] = [];
if (OLD) {
  vaults = OLD.vaults;
  argon = OLD.argon2id;
  ageVectors = OLD.age;
} else {
  // 1. Epoch 0 (no keyring), PBKDF2.
  vaults.push(await vault("pbkdf2, epoch 0", "סיסמה ארוכה מאוד 2026", { pbkdf2Iterations: 1000 }, async (s, f) => {
    for (const [k, v] of Object.entries(NOTES)) f.set(k, v);
    await s.sync();
  }));
  // 2. Argon2id (production parameters), re-keyed twice, a device enrolled, a blob from each epoch.
  const dev = await generateIdentity();
  vaults.push(await vault("argon2id, keyring epoch 2, blobs from epochs 0–2", "correct horse battery staple ✓", {}, async (s, f) => {
    f.set("e0.md", "written at epoch 0");
    await s.sync();
    await s.rekey({ enroll: { "device-1": dev.recipient } });
    f.set("e1.md", "written at epoch 1");
    await s.sync();
    await s.rekey({ revoke: ["nobody"] });
    f.set("e2.md", "written at epoch 2 — שלום");
    await s.sync();
    await s.enroll("device-2", (await generateIdentity()).recipient); // keyring 2.1: a same-epoch rewrite in the chain
    return { device: { id: "device-1", identity: dev.identity, recipient: dev.recipient } };
  }));
  // 3. A re-key cut off before its commit: epoch 1's manifest is frozen (protocol 2), the keyring is still epoch 1.
  vaults.push(await vault("pbkdf2, epoch 1, frozen manifest (re-key cut off before the keyring)", "frozen passphrase 2026", { pbkdf2Iterations: 1000 }, async (s, f) => {
    f.set("a.md", "before the freeze");
    await s.sync();
    await s.rekey();
    cut = (n) => n === KEYRING_NAME;
    await s.rekey().catch(() => undefined);
    return { frozen: true };
  }));
  // 4. A passphrase change cut off before its header: the keyring (epoch 2) carries the new header and `prev`.
  vaults.push(await vault("pbkdf2, epoch 2, passphrase change pending (header not written; prev kept)", "the old passphrase 2026", { pbkdf2Iterations: 1000 }, async (s, f) => {
    f.set("a.md", "kept through the change");
    await s.sync();
    await s.rekey();
    cut = (n) => n === HEADER_NAME;
    await s.rekey({ newPassphrase: "the new passphrase 2026", pbkdf2Iterations: 1000 }).catch(() => undefined);
    return { passphrase: "the new passphrase 2026", pending: { oldPassphrase: "the old passphrase 2026", oldEpoch: 1, oldFiles: ["a.md"] } };
  }));

  // 3. Primitives.
  argon = [];
  for (const [m, t, pl] of [[64, 2, 1], [256, 3, 2], [47104, 1, 1]] as const) {
    const password = new TextEncoder().encode(`pw-${m}-שלום`);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    argon.push({ password: b64(password), salt: b64(salt), memoryKiB: m, iterations: t, parallelism: pl, tag: b64(argon2id({ password, salt, memoryKiB: m, iterations: t, parallelism: pl, tagLength: 32 })) });
  }
  ageVectors = [];
  const id = await generateIdentity();
  for (const len of [0, 1, 65536, 65537]) {
    const pt = new Uint8Array(len).map((_, i) => (i * 131 + len) & 255);
    ageVectors.push({ identity: id.identity, plaintext: b64(pt), file: b64(await ageEncrypt(pt, [{ x25519: id.recipient }])) });
  }
  const pp = new TextEncoder().encode("שלום age");
  ageVectors.push({ passphrase: "סיסמה", plaintext: b64(pp), file: b64(await ageEncrypt(pp, [{ passphrase: "סיסמה", logN: 12 }])) });

}

// 5. Pairing: one-way codes and two-way request/answer pairs (fifth review 12.11, F1: the
//    kind is inside the MAC), for vault 1 (epoch 0) and vault 2 (epoch 2, the epoch's
//    pairing key; the keyring anchor).
const { pairing, pairingTwoWay, sas } = await pairingVectors(vaults);
async function pairingVectors(vs: Array<{ objects: Record<string, string>; passphrase: string }>) {
  const pairing = [];
  const pairingTwoWay = [];
  const sas = [];
  const now = 1_800_000_000_000;
  for (const i of [0, 1]) {
    const p1 = memoryProvider();
    for (const [n, o] of Object.entries(vs[i].objects)) await p1.put(n, Buffer.from(o, "base64"));
    const k1: VaultKeys = (await unlockVault(p1, vs[i].passphrase, { minPbkdf2Iterations: 1000 })).keys;
    const ring = k1.ring ? { epoch: k1.epoch, rev: k1.ring.rev, digest: k1.ring.digest } : { epoch: 0, rev: 0, digest: "" };
    // The comparison keys (plan W8.5): fixed private keys, so the commitments and the symbols below are checkable.
    const issuer = await sasKeyPair(new Uint8Array(32).fill(0x11 + i));
    const joiner = await sasKeyPair(new Uint8Array(32).fill(0x22 + i));
    const commitI = await sasCommit(issuer.pub);
    const code = await createPairingCode(k1, { counter: 2, digest: "d".repeat(64) }, now, ring, commitI);
    const codeNonce = (await readPairingCode(k1, code, now)).sas.nonce;
    pairing.push({ vault: i, code, body: { counter: 2, digest: "d".repeat(64), ring, sas: { session: await pairingRequestHash(code), answer: "", nonce: codeNonce, expires: now + 2 * 60 * 1000, commit: commitI } } });
    const manifest = { counter: 2, digest: "e".repeat(64) };
    const commitJ = await sasCommit(joiner.pub);
    const { code: request, request: req } = await createPairingRequest(k1, manifest, now, ring, commitJ);
    const answer = await createPairingAnswer(k1, req, { counter: 3, digest: "f".repeat(64) }, now + 1000, ring, issuer.pub);
    const answerHash = await pairingRequestHash(answer);
    pairingTwoWay.push({ vault: i, now, request, requestBody: { nonce: req.nonce, ring, manifest, issuedAt: now, hash: req.hash, commit: commitJ }, answer, answerBody: { counter: 3, digest: "f".repeat(64), ring, sas: { session: req.hash, answer: answerHash, nonce: req.nonce, expires: now + 1000 + 5 * 60 * 1000, pub: Buffer.from(issuer.pub).toString("base64url") } } });
    // The symbols and both confirmations, from each side (they must agree).
    for (const [flow, t] of [
      ["one-way", { flow: "one-way", vaultId: k1.vaultId, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, counter: 2, digest: "d".repeat(64), session: await pairingRequestHash(code), answer: "", nonce: codeNonce, pubI: issuer.pub, pubJ: joiner.pub }],
      ["two-way", { flow: "two-way", vaultId: k1.vaultId, epoch: ring.epoch, ringRev: ring.rev, ringDigest: ring.digest, counter: 3, digest: "f".repeat(64), session: req.hash!, answer: answerHash, nonce: req.nonce, pubI: issuer.pub, pubJ: joiner.pub }],
    ] as Array<[string, SasTranscript]>) {
      const si = await deriveSas(issuer.priv, joiner.pub, t);
      const sj = await deriveSas(joiner.priv, issuer.pub, t);
      if (si.symbols.join() !== sj.symbols.join()) throw new Error("the two sides' symbols differ");
      sas.push({
        vault: i,
        flow,
        issuerKey: Buffer.from(new Uint8Array(32).fill(0x11 + i)).toString("hex"),
        joinerKey: Buffer.from(new Uint8Array(32).fill(0x22 + i)).toString("hex"),
        transcript: Buffer.from(transcriptBytes(t)).toString("utf8"),
        commitI: flow === "one-way" ? commitI : undefined,
        commitJ: flow === "two-way" ? commitJ : undefined,
        symbols: si.symbols,
        confirmIssuer: Buffer.from(await confirmTag(si, "issuer")).toString("base64url"),
        confirmJoiner: Buffer.from(await confirmTag(sj, "joiner")).toString("base64url"),
      });
    }
  }
  return { pairing, pairingTwoWay, sas };
}

writeFileSync("docs/sync-protocol-vectors.json", JSON.stringify({ format: "lumen-sync-protocol-vectors/1", spec: "docs/sync-protocol.md", made: new Date().toISOString(), note: "Made by scripts/sync-protocol/make-vectors.mts; checked by src/__tests__/e2eeVectors.test.ts and, independently, scripts/sync-protocol/check_vectors.py.", vaults, argon2id: argon, age: ageVectors, pairing, pairingTwoWay, sas }, null, 1) + "\n");
console.log(`wrote ${vaults.length} vaults, ${argon.length} Argon2id, ${ageVectors.length} age vectors`);

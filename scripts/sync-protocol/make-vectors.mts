/**
 * Make docs/sync-protocol-vectors.json (plan W1.7) with the app's own code:
 *   node --experimental-transform-types scripts/sync-protocol/make-vectors.mts
 * (run with a loader that resolves extension-less TypeScript imports, or via
 * vitest: src/__tests__/e2eeVectors.test.ts checks the committed file against
 * the same code). The vectors are random each time they are made; they are
 * checked, not compared byte for byte.
 */
import { writeFileSync } from "node:fs";
import { memoryProvider } from "../../src/sync/e2ee/provider";
import { createVault, E2eeSync, unlockVault } from "../../src/sync/e2ee/engine";
import { memoryFiles } from "../../src/sync/e2ee/localFiles";
import { memoryStateStore } from "../../src/sync/e2ee/state";
import { generateIdentity, ageEncrypt } from "../../src/sync/e2ee/age";
import { argon2id } from "../../src/sync/e2ee/primitives/argon2";
import { createPairingCode } from "../../src/sync/e2ee/pairing";

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const NOTES: Record<string, string> = { "שלום.md": "# שלום עולם\n\nנִקּוּד וגרש׳ 123", "notes/a.md": "plain ASCII", "notes/empty.md": "", "big.md": "x".repeat(5000) };

async function vault(name: string, passphrase: string, kdf: { pbkdf2Iterations?: number }, steps: (s: E2eeSync, files: ReturnType<typeof memoryFiles>) => Promise<unknown>) {
  const p = memoryProvider();
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

const vaults = [];
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
  return { device: { id: "device-1", identity: dev.identity, recipient: dev.recipient } };
}));

// 3. Primitives.
const argon = [];
for (const [m, t, pl] of [[64, 2, 1], [256, 3, 2], [47104, 1, 1]] as const) {
  const password = new TextEncoder().encode(`pw-${m}-שלום`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  argon.push({ password: b64(password), salt: b64(salt), memoryKiB: m, iterations: t, parallelism: pl, tag: b64(argon2id({ password, salt, memoryKiB: m, iterations: t, parallelism: pl, tagLength: 32 })) });
}
const ageVectors = [];
const id = await generateIdentity();
for (const len of [0, 1, 65536, 65537]) {
  const pt = new Uint8Array(len).map((_, i) => (i * 131 + len) & 255);
  ageVectors.push({ identity: id.identity, plaintext: b64(pt), file: b64(await ageEncrypt(pt, [{ x25519: id.recipient }])) });
}
const pp = new TextEncoder().encode("שלום age");
ageVectors.push({ passphrase: "סיסמה", plaintext: b64(pp), file: b64(await ageEncrypt(pp, [{ passphrase: "סיסמה", logN: 12 }])) });

// 4. A pairing code from vault 1.
const p1 = memoryProvider();
for (const [n, o] of Object.entries(vaults[0].objects)) await p1.put(n, Buffer.from(o, "base64"));
const k1 = (await unlockVault(p1, vaults[0].passphrase, { minPbkdf2Iterations: 1000 })).keys;
const pairing = { vault: 0, code: await createPairingCode(k1, { counter: 2, digest: "d".repeat(64) }, 1_800_000_000_000), body: { counter: 2, digest: "d".repeat(64) } };

writeFileSync("docs/sync-protocol-vectors.json", JSON.stringify({ format: "lumen-sync-protocol-vectors/1", spec: "docs/sync-protocol.md", made: new Date().toISOString(), note: "Made by scripts/sync-protocol/make-vectors.mts; checked by src/__tests__/e2eeVectors.test.ts and, independently, scripts/sync-protocol/check_vectors.py.", vaults, argon2id: argon, age: ageVectors, pairing }, null, 1) + "\n");
console.log(`wrote ${vaults.length} vaults, ${argon.length} Argon2id, ${ageVectors.length} age vectors`);

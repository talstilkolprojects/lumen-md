/**
 * Plan W1.7: key rotation and device revocation for the encrypted sync.
 * Real engine, real WebCrypto, the simulated provider folder.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { CAS_PROBE_NAME, memoryProvider, type SyncProvider } from "../sync/e2ee/provider";
import { E2eeSync, unlockVault, unlockWithDevice } from "../sync/e2ee/engine";
import { generateIdentity } from "../sync/e2ee/age";
import { KEYRING_NAME, KeyringRollbackError, RevokedError } from "../sync/e2ee/keyring";
import { manifestName, openManifest } from "../sync/e2ee/manifest";
import { DecryptError } from "../sync/e2ee/keys";
import { WrongPassphraseError, HEADER_NAME } from "../sync/e2ee/header";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { device, joinVault, mulberry32, newVault, PASSPHRASE, snapshot, TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

/** A provider that records the names written (not the conditional-write probe a re-key runs first). */
function recording(inner: SyncProvider) {
  const puts: string[] = [];
  const p: SyncProvider = { id: inner.id, get: (n) => inner.get(n), list: () => inner.list(), delete: (n) => inner.delete(n), put: (n, d, c) => (n !== CAS_PROBE_NAME && puts.push(n), inner.put(n, d, c)) };
  return { p, puts };
}

async function enrolledDevice(provider: SyncProvider, name: string, id: { identity: string }) {
  const { keys } = await unlockWithDevice(provider, name, id.identity);
  const files = memoryFiles();
  return { files, sync: new E2eeSync({ provider, keys, local: files, store: memoryStateStore(), access: { device: name, identity: id.identity } }) };
}

describe("re-key", () => {
  it("rotates the keys without uploading a blob again; every device keeps syncing", async () => {
    const base = memoryProvider();
    const { p, puts } = recording(base);
    const a = await newVault(p);
    for (let i = 0; i < 50; i++) a.files.set(`n/${i}.md`, `# ${i}\nשלום ${i}`);
    await a.sync.sync();
    const b = await joinVault("B", p);
    await b.sync.sync();
    puts.length = 0;
    const oldManifest = await manifestName(a.sync.keys());
    const r = await a.sync.rekey();
    expect(r.epoch).toBe(1);
    // Only the frozen old manifest, the new epoch's manifest and the keyring (the commit) were written: no blob.
    expect(puts).toEqual([oldManifest, await manifestName(a.sync.keys()), KEYRING_NAME]);
    expect(r.written).toEqual(puts);
    // B picks up the new epoch on its next round, through the passphrase.
    b.files.set("n/after.md", "after the re-key");
    await b.sync.sync();
    expect(b.sync.keys().epoch).toBe(1);
    await a.sync.sync();
    expect(snapshot(a)).toEqual(snapshot(b));
    expect(a.files.text("n/7.md")).toBe("# 7\nשלום 7");
    // A new device with the passphrase opens epoch 1 and reads blobs of both epochs.
    const c = await joinVault("C", p);
    expect(c.keys.epoch).toBe(1);
    await c.sync.sync();
    expect(snapshot(c)).toEqual(snapshot(a));
  });

  it("refuses an older keyring (rollback) once a newer epoch was seen", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    await a.sync.rekey();
    const old = p.objects.get(KEYRING_NAME)!;
    await a.sync.rekey();
    p.objects.set(KEYRING_NAME, { data: old.data, etag: "replayed" });
    await expect(a.sync.sync()).rejects.toBeInstanceOf(KeyringRollbackError);
  });
});

describe("revoking a device", () => {
  it("a revoked device can't open a manifest written after its revocation; the others can", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("a.md", "before");
    await a.sync.sync();
    const phone = await generateIdentity();
    const laptop = await generateIdentity();
    await a.sync.rekey({ enroll: { phone: phone.recipient, laptop: laptop.recipient } });
    const lost = await enrolledDevice(p, "phone", phone);
    const kept = await enrolledDevice(p, "laptop", laptop);
    await lost.sync.sync();
    await kept.sync.sync();
    expect(lost.files.text("a.md")).toBe("before");
    const lostKeys = lost.sync.keys();

    await a.sync.rekey({ revoke: ["phone"] });
    a.files.set("a.md", "after the revocation");
    await a.sync.sync();

    // The lost phone: no wrap for it in the new keyring…
    await expect(lost.sync.sync()).rejects.toBeInstanceOf(RevokedError);
    await expect(unlockWithDevice(p, "phone", phone.identity)).rejects.toBeInstanceOf(RevokedError);
    // …and its old keys don't open the new manifest (each epoch has its own object since review 12.11)…
    const name = await manifestName(a.sync.keys());
    expect(name).not.toBe(await manifestName(lostKeys));
    await expect(openManifest(lostKeys, p.objects.get(name)!.data, name)).rejects.toBeInstanceOf(DecryptError);
    // …while its own epoch's manifest is frozen at the state before the revocation.
    const old = await openManifest(lostKeys, p.objects.get(await manifestName(lostKeys))!.data);
    expect(old.manifest.frozen?.epoch).toBe(2);
    expect(Object.keys(old.manifest.files)).toEqual(["a.md"]);
    expect(lost.files.text("a.md")).toBe("before");

    // The laptop carries on with its own key.
    await kept.sync.sync();
    expect(kept.files.text("a.md")).toBe("after the revocation");
  });

  it("with a passphrase change, the old passphrase opens nothing any more", async () => {
    const p = memoryProvider();
    const a = await newVault(p);
    a.files.set("x.md", "x");
    await a.sync.sync();
    const r = await a.sync.rekey({ newPassphrase: "a brand new passphrase 2026", pbkdf2Iterations: TEST_ITERATIONS });
    expect(r.written).toContain(HEADER_NAME);
    await expect(unlockVault(p, PASSPHRASE, TEST_POLICY)).rejects.toBeInstanceOf(WrongPassphraseError);
    const { keys } = await unlockVault(p, "a brand new passphrase 2026", TEST_POLICY);
    const d = device("D", p, keys);
    await d.sync.sync();
    expect(d.files.text("x.md")).toBe("x");
  });
});

/* ─── Acceptance: 0 loss across re-keys ─────────────────────────────────── */

describe("re-key under load", () => {
  it("10,000 random rounds with re-keys and revocations in between: 0 lost", async () => {
    const p = memoryProvider();
    const rand = mulberry32(0x7a11);
    const a = await newVault(p);
    const b = await joinVault("B", p);
    await a.sync.sync();
    await b.sync.sync();
    await b.sync.pair(await a.sync.pairingCode()); // B re-keys too: only a verified device may (RR-5)
    const truth = new Map<string, string | null>();
    let rekeys = 0;
    for (let round = 0; round < 10_000; round++) {
      const who = rand() < 0.5 ? a : b;
      const path = `${who.name}/${Math.floor(rand() * 40)}.md`;
      const roll = rand();
      if (roll < 0.1 && who.files.files.has(path)) {
        who.files.delete(path);
        truth.set(path, null);
      } else if (roll < 0.8) {
        const text = `${who.name} ${round} ${Math.floor(rand() * 1e6)} שלום`;
        who.files.set(path, text);
        truth.set(path, text);
      }
      if (round % 250 === 125) {
        // Re-key (sometimes revoking a throwaway device) by either side, mid-flow.
        const id = await generateIdentity();
        const r = await who.sync.rekey(rand() < 0.5 ? { enroll: { [`d${round}`]: id.recipient } } : { revoke: [`d${round - 250}`] });
        expect(r.written).toHaveLength(3);
        expect(r.written).toContain(KEYRING_NAME);
        rekeys++;
      }
      await who.sync.sync();
      if (rand() < 0.3) await (who === a ? b : a).sync.sync();
    }
    for (let i = 0; i < 2; i++) {
      await a.sync.sync();
      await b.sync.sync();
    }
    expect(rekeys).toBe(40);
    expect(snapshot(a)).toEqual(snapshot(b));
    for (const [path, text] of truth) {
      if (text === null) expect(a.files.files.has(path), path).toBe(false);
      else expect(a.files.text(path), path).toBe(text);
    }
    expect(a.sync.keys().epoch).toBe(40);
  }, 600_000);

  it("re-keying a vault of 10,000 notes: no blob uploaded again, every note readable after", async () => {
    const base = memoryProvider();
    const { p, puts } = recording(base);
    const a = await newVault(p);
    for (let i = 0; i < 10_000; i++) a.files.set(`n/${i}.md`, `note ${i} — שלום`);
    await a.sync.sync();
    puts.length = 0;
    await a.sync.rekey();
    // The frozen manifest, the new manifest, the keyring: no blob.
    expect(puts).toHaveLength(3);
    expect(puts).toContain(KEYRING_NAME);
    const fresh = await joinVault("F", p);
    await fresh.sync.sync();
    expect(fresh.files.files.size).toBe(10_000);
    for (let i = 0; i < 10_000; i += 1) expect(fresh.files.text(`n/${i}.md`)).toBe(`note ${i} — שלום`);
  }, 900_000);
});

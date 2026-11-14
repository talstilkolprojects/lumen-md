/**
 * W6.36 — the vault index snapshot of an encrypted vault, sealed and signed
 * in the index worker (src/storage/snapshotSeal.ts). Until now an encrypted
 * vault had no snapshot (#420), so every open read and decrypted every note.
 *
 * What is checked: the snapshot keys are their own HKDF subkeys and can't be
 * exported; a sealed record holds no note text or path; every tampered,
 * foreign, swapped or wrong-kind record is refused and dropped (the open
 * reads every note instead); a locked vault writes none; and a restart of an
 * unlocked vault takes every unchanged note from the snapshot. The open trusts
 * the snapshot and checks it against the vault behind it: it does not wait
 * for the listing, a note changed, added or deleted while the app was closed
 * still shows up, and the first search waits for the check (W6.36).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import { deriveRestKeys } from "../storage/vault/encrypted/format";
import * as session from "../storage/vault/encrypted/session";
import { restSnapshotKeys } from "../storage/vault/restStore";
import { isSealedSnapshot, openSnapshot, SEAL_VERSION, sealSnapshot, snapshotAad, type SealedSnapshot, type SnapshotKeys } from "../storage/snapshotSeal";
import { __putSnapshotRecord, __snapshotRecord, encodeSnapshot, encodeSnapshotParts, readSnapshotManifest, readSnapshotRecord, snapshotRecord } from "../storage/indexSnapshot";
import { __resetWorkspaceIndex, __saveSnapshotNow, ensureIndex, findBacklinks, indexChecked, indexedFiles, indexedNoteText, searchWorkspace, snapshotCounters } from "../storage/workspaceIndex";
import { VaultIndex, localEngine } from "../storage/vaultIndexLocal";

const keysFor = async (vaultId = "vault-A"): Promise<SnapshotKeys> => (await deriveRestKeys(crypto.getRandomValues(new Uint8Array(32)), vaultId)).snapshot;
const FILES = [
  { path: "Daily/יומן.md", name: "יומן.md", modified: 11, content: "# יומן\nתוכניות סודיות" },
  { path: "Projects/Home.md", name: "Home.md", modified: 12, content: "secret plans [[Daily/יומן]]" },
];
const parts = (vault = "ws") => encodeSnapshotParts(vault, FILES);
const seal = (k: SnapshotKeys, vault = "ws") => sealSnapshot(k, vault, parts(vault).manifest, parts(vault).body);
const dec = (u: Uint8Array) => new TextDecoder().decode(u);
const flip = (u: Uint8Array, i = 0) => {
  const c = u.slice();
  c[i] ^= 1;
  return c;
};
const asText = (rec: unknown) => {
  const r = rec as SealedSnapshot;
  // Every byte of the record, read as UTF-8 and as Latin-1, plus its clear fields.
  const bytes = [r.manifest, r.body].flatMap((p) => [p.ct, p.nonce, p.mac]).map((b) => new TextDecoder().decode(b) + String.fromCharCode(...b.slice(0, 4096)));
  return JSON.stringify({ ...r, manifest: null, body: null }) + bytes.join("");
};

describe("sealing (snapshotSeal)", () => {
  it("keys are HKDF subkeys of their own, not extractable, and seal a record that opens back", async () => {
    const dataKey = crypto.getRandomValues(new Uint8Array(32));
    const rest = await deriveRestKeys(dataKey.slice(), "vault-A");
    for (const k of [rest.snapshot.enc, rest.snapshot.mac]) {
      expect(k.extractable).toBe(false);
      await expect(crypto.subtle.exportKey("raw", k)).rejects.toBeTruthy();
    }
    expect(rest.snapshot.enc).not.toBe(rest.store);
    const rec = await seal(rest.snapshot);
    expect(rec).toMatchObject({ sealed: 1, sv: SEAL_VERSION, vaultId: "vault-A", vault: "ws" });
    expect(rec.sid).toMatch(/^[0-9a-f]{32}$/);
    expect(dec(await openSnapshot(rest.snapshot, "ws", rec, "manifest"))).toBe(dec(parts().manifest));
    expect(dec(await openSnapshot(rest.snapshot, "ws", rec, "body"))).toBe(dec(parts().body));
    // The manifest holds no text: paths, times and summaries only.
    expect(dec(parts().manifest)).not.toMatch(/סודיות|secret plans/);
    // The same data key derives the same snapshot keys (a restart opens the old record)…
    const again = await deriveRestKeys(dataKey.slice(), "vault-A");
    await expect(openSnapshot(again.snapshot, "ws", rec, "body")).resolves.toBeTruthy();
    // …and the store key (a different subkey) does not decrypt it.
    await expect(crypto.subtle.decrypt({ name: "AES-GCM", iv: rec.body.nonce as BufferSource, additionalData: snapshotAad(SEAL_VERSION, "vault-A", "ws", "body", rec.sid) as BufferSource }, rest.store, rec.body.ct as BufferSource)).rejects.toBeTruthy();
  });

  it("a fresh nonce every time; the record says nothing of the notes", async () => {
    const k = await keysFor();
    const a = await seal(k);
    const b = await seal(k);
    expect(a.sid).not.toBe(b.sid);
    for (const part of ["manifest", "body"] as const) {
      expect(a[part].nonce).not.toEqual(b[part].nonce);
      expect(a[part].ct).not.toEqual(b[part].ct);
    }
    expect(a.manifest.nonce).not.toEqual(a.body.nonce);
    for (const r of [a, b]) expect(asText(r)).not.toMatch(/secret|סודיות|יומן|Daily|Projects|Home/);
  });

  it("refuses anything changed: ciphertext, nonce, signature, version, vault ids, a record sealed for another vault", async () => {
    const k = await keysFor("vault-A");
    const rec = await seal(k);
    const refused = (r: unknown, vault = "ws", keys = k, part: "manifest" | "body" = "body") => openSnapshot(keys, vault, r, part).then(() => "opened", (e: { reason?: string }) => e.reason);
    const withPart = (part: "manifest" | "body", p: Partial<SealedSnapshot["body"]>) => ({ ...rec, [part]: { ...rec[part], ...p } });
    for (const part of ["manifest", "body"] as const) {
      const c = rec[part];
      expect(await refused(withPart(part, { ct: flip(c.ct, 5) }), "ws", k, part)).toBe("signature");
      expect(await refused(withPart(part, { ct: flip(c.ct, c.ct.length - 1) }), "ws", k, part)).toBe("signature");
      expect(await refused(withPart(part, { nonce: flip(c.nonce) }), "ws", k, part)).toBe("signature");
      expect(await refused(withPart(part, { mac: flip(c.mac) }), "ws", k, part)).toBe("signature");
      expect(await refused(withPart(part, { ct: c.ct.subarray(0, 10) }), "ws", k, part)).toBe("signature");
      expect(await refused(withPart(part, { nonce: c.nonce.subarray(0, 8) }), "ws", k, part)).toBe("shape");
    }
    // The two parts swapped, a part of another seal (its own sid), or the sid changed: the signature fails.
    expect(await refused({ ...rec, manifest: rec.body, body: rec.manifest }, "ws", k, "manifest")).toBe("signature");
    const other = await seal(k);
    expect(await refused({ ...rec, body: other.body })).toBe("signature");
    expect(await refused({ ...other, manifest: rec.manifest }, "ws", k, "manifest")).toBe("signature");
    expect(await refused({ ...rec, sid: other.sid })).toBe("signature");
    expect(await refused({ ...rec, sid: "not hex" })).toBe("shape");
    expect(await refused({ ...rec, sv: SEAL_VERSION + 1 })).toBe("version");
    expect(await refused({ ...rec, vaultId: "vault-B" })).toBe("vault");
    expect(await refused(rec, "other-ws")).toBe("vault");
    // A record relabelled for the other workspace: the AAD and MAC no longer match.
    expect(await refused({ ...rec, vault: "other-ws" }, "other-ws")).toBe("signature");
    // Another vault's keys (same vault id claimed): the signature fails.
    const stranger = await keysFor("vault-A");
    expect(await refused(rec, "ws", stranger)).toBe("signature");
    expect(await refused(encodeSnapshot("ws", FILES))).toBe("shape");
    expect(await refused(null)).toBe("shape");
    expect(await refused(rec)).toBe("opened");
    expect(await refused(rec, "ws", k, "manifest")).toBe("opened");
  });

  it("2000 seals: no nonce repeats in either part; the keys stay non-extractable after a structured clone (review 12.11)", async () => {
    const k = await keysFor();
    const seen = new Set<string>();
    const one = new Uint8Array(1);
    for (let i = 0; i < 1000; i++) {
      const r = await sealSnapshot(k, "ws", one, one);
      for (const p of [r.manifest, r.body]) seen.add(Array.from(p.nonce).join(","));
    }
    expect(seen.size).toBe(2000);
    const cloned = structuredClone(k);
    expect([cloned.enc.extractable, cloned.mac.extractable]).toEqual([false, false]);
    await expect(crypto.subtle.exportKey("raw", cloned.enc)).rejects.toBeTruthy();
  });

  it("a plain record is refused when keys are given, a sealed one when they are not", async () => {
    const k = await keysFor();
    const sealed = await snapshotRecord("ws", FILES, k);
    expect(isSealedSnapshot(sealed)).toBe(true);
    expect((await readSnapshotRecord(sealed, "ws", k)).snap?.get("Daily/יומן.md")?.content).toBe(FILES[0].content);
    expect(await readSnapshotRecord(sealed, "ws")).toEqual({ snap: null, refused: true });
    expect(await readSnapshotRecord(encodeSnapshot("ws", FILES), "ws", k)).toEqual({ snap: null, refused: true });
    expect(await readSnapshotRecord(undefined, "ws", k)).toEqual({ snap: null, refused: false });
    // Valid crypto around a payload that is not a snapshot: refused too.
    const junk = await sealSnapshot(k, "ws", new TextEncoder().encode("[1,2"), parts().body);
    expect((await readSnapshotRecord(junk, "ws", k)).refused).toBe(true);
    // A manifest whose summaries are not summaries: refused, even though the crypto is valid.
    const m = JSON.parse(dec(parts().manifest));
    m.summaries[0].wikiTargets = "not a list";
    const bad = await sealSnapshot(k, "ws", new TextEncoder().encode(JSON.stringify(m)), parts().body);
    expect(await readSnapshotManifest(bad, "ws", k)).toEqual({ entries: null, refused: true });
  });
});

describe("an encrypted vault opens from its sealed snapshot (workspace index)", () => {
  const PASS = "a long enough passphrase";
  const N = 40;
  let inner: VaultBackend;
  let previous: VaultBackend | null;
  const engine = () => localEngine(new VaultIndex());
  const restart = async () => {
    __resetWorkspaceIndex(engine, { keepSnapshot: true });
    await ensureIndex();
    await indexChecked();
    return { ...snapshotCounters };
  };

  beforeEach(async () => {
    session.setKdfPolicyForTests({ minPbkdf2Iterations: 1000, minArgon2CostKiB: 8, argon2: { memoryKiB: 8, iterations: 1, parallelism: 1 } });
    inner = createMemoryBackend();
    for (let i = 0; i < N; i++) await inner.write(`notes/n${i}.md`, `# פתק ${i}\nsecret ${i} [[n${(i + 1) % N}]]`);
    previous = setVaultBackend(inner);
    await session.enableEncryption(PASS, { pbkdf2Iterations: 1000, confirmRecoveryKey: async () => true });
    __resetWorkspaceIndex(engine);
  });
  afterEach(() => {
    session.lock();
    setVaultBackend(previous);
  });

  it("first open reads every note; the snapshot is sealed (0 plain text in IndexedDB); the next open reads none", async () => {
    expect(restSnapshotKeys()).not.toBeNull();
    await ensureIndex();
    expect(snapshotCounters).toEqual({ fromSnapshot: 0, read: N });
    await __saveSnapshotNow();
    const rec = await __snapshotRecord();
    expect(isSealedSnapshot(rec)).toBe(true);
    expect(asText(rec)).not.toMatch(/secret|פתק|notes\/n|n1\.md/);
    expect(await restart()).toEqual({ fromSnapshot: N, read: 0 });
    expect(await indexedNoteText("notes/n7.md")).toBe(`# פתק 7\nsecret 7 [[n8]]`);
  });

  it("a note changed or deleted while closed is read again or dropped; the others come from the snapshot", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    await new Promise((r) => setTimeout(r, 5));
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    await writeWorkspaceFile("notes/n3.md", "changed secret");
    await deleteWorkspaceFile("notes/n4.md");
    expect(await restart()).toEqual({ fromSnapshot: N - 2, read: 1 });
    expect(await indexedNoteText("notes/n3.md")).toBe("changed secret");
    expect(await indexedNoteText("notes/n4.md")).toBeNull();
    expect((await searchWorkspace("secret", { limit: 100 })).map((h) => h.path)).not.toContain("notes/n4.md");
  });

  it("the open trusts the snapshot and does not wait for the listing; what changed while closed shows up, and the first search waits for the check", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    await new Promise((r) => setTimeout(r, 5));
    const { deleteWorkspaceFile, writeWorkspaceFile } = await import("../storage/workspace");
    // While the app is closed: one note edited, one deleted, one added by another program (a plain file in the folder).
    await writeWorkspaceFile("notes/n3.md", "edited while closed [[n9]]");
    await deleteWorkspaceFile("notes/n4.md");
    await inner.write("notes/added.md", "added while closed");
    // The vault's listing is held back until `release`.
    const list = inner.list.bind(inner);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    inner.list = async (dir) => {
      await gate;
      return list(dir);
    };
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      // Open, from the snapshot alone.
      expect(snapshotCounters).toEqual({ fromSnapshot: N, read: 0 });
      expect(indexedFiles()).toHaveLength(N);
      let answered = false;
      const first = searchWorkspace("closed", { limit: 100 }).then((hits) => ((answered = true), hits));
      const back = findBacklinks("notes/n9.md");
      await new Promise((r) => setTimeout(r, 20));
      expect(answered).toBe(false);
      release();
      // The first answer is already right.
      expect((await first).map((h) => h.path).sort()).toEqual(["notes/added.md", "notes/n3.md"]);
      expect((await back).map((h) => h.fromPath)).toContain("notes/n3.md");
      expect((await searchWorkspace("secret 4", { limit: 100 })).map((h) => h.path)).not.toContain("notes/n4.md");
      expect(indexedFiles().map((f) => f.path)).toContain("notes/added.md");
      expect(indexedFiles().map((f) => f.path)).not.toContain("notes/n4.md");
      expect(await indexedNoteText("notes/n3.md")).toBe("edited while closed [[n9]]");
      expect(snapshotCounters).toEqual({ fromSnapshot: N - 2, read: 2 });
    } finally {
      inner.list = list;
      release();
    }
  });

  it("when the vault can't be listed behind the open, the next use lists it again", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    await new Promise((r) => setTimeout(r, 5));
    await inner.write("notes/later.md", "found on the next use");
    const list = inner.list.bind(inner);
    let fail = true;
    inner.list = async (dir) => {
      if (fail) throw new Error("folder unavailable");
      return list(dir);
    };
    try {
      __resetWorkspaceIndex(engine, { keepSnapshot: true });
      await ensureIndex();
      await indexChecked();
      fail = false;
      expect((await searchWorkspace("found on the next use", { limit: 5 })).map((h) => h.path)).toContain("notes/later.md");
    } finally {
      inner.list = list;
    }
  });

  it("a tampered snapshot is refused and dropped: the open reads every note", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    const rec = (await __snapshotRecord()) as SealedSnapshot;
    await __putSnapshotRecord({ ...rec, manifest: { ...rec.manifest, ct: flip(rec.manifest.ct, 100) } });
    expect(await restart()).toEqual({ fromSnapshot: 0, read: N });
    expect(await __snapshotRecord()).toBeUndefined();
  });

  it("a snapshot whose texts were tampered with after its manifest: the open reads every note, and search is right", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    const rec = (await __snapshotRecord()) as SealedSnapshot;
    await __putSnapshotRecord({ ...rec, body: { ...rec.body, ct: flip(rec.body.ct, 100) } });
    expect(await restart()).toEqual({ fromSnapshot: 0, read: N });
    expect(await __snapshotRecord()).toBeUndefined();
    expect((await searchWorkspace("secret 7", { limit: 100 })).map((h) => h.path)).toContain("notes/n7.md");
    expect(await indexedNoteText("notes/n7.md")).toBe(`# פתק 7\nsecret 7 [[n8]]`);
  });

  it("a plain snapshot left in an encrypted vault is refused", async () => {
    await __putSnapshotRecord(encodeSnapshot(inner.id, [{ path: "notes/n1.md", name: "n1.md", modified: 1, content: "planted" }]));
    expect(await restart()).toEqual({ fromSnapshot: 0, read: N });
    expect(await indexedNoteText("notes/n1.md")).not.toBe("planted");
  });

  it("the vault goes unavailable while unlocked (a folder disconnected): nothing is written, never in the clear (review 12.11 S1)", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    const sealed = await __snapshotRecord();
    expect(isSealedSnapshot(sealed)).toBe(true);
    const available = inner.available.bind(inner);
    inner.available = () => false;
    try {
      await __saveSnapshotNow();
      const rec = await __snapshotRecord();
      expect(rec).toEqual(sealed);
      expect(asText(rec)).not.toMatch(/secret|פתק/);
    } finally {
      inner.available = available;
    }
  });

  it("an index filled from an encrypted vault is never saved in the clear, even if the vault then says it is plain (S1)", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    // The vault is converted back to plain while the index still holds its notes (no rebuild yet).
    expect((await session.disableEncryption(PASS)).done).toBe(true);
    await __saveSnapshotNow();
    const rec = await __snapshotRecord();
    expect(rec === undefined || isSealedSnapshot(rec)).toBe(true);
    expect(JSON.stringify(rec ?? null)).not.toMatch(/secret|פתק/);
  });

  it("locked: no keys, nothing written; the sealed snapshot stays for the next unlock", async () => {
    await ensureIndex();
    await __saveSnapshotNow();
    const before = await __snapshotRecord();
    session.lock();
    expect(restSnapshotKeys()).toBeNull();
    await __saveSnapshotNow();
    expect(await __snapshotRecord()).toEqual(before);
    await session.unlock(PASS);
    expect(await restart()).toEqual({ fromSnapshot: N, read: 0 });
  });
});

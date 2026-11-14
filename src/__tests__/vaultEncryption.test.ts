/**
 * Vault encryption at rest (plan 11.4). Data safety first: a wrong
 * passphrase changes nothing, an interrupted conversion leaves every note
 * readable and is finished by "check and repair", the recovery key opens the
 * vault (even without its header), and only ciphertext reaches the storage
 * of every VaultBackend. The contract suite runs on the encrypted layer too
 * (vaultBackend.contract.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { get } from "idb-keyval";
import { FakeDir, installFakeOpfs } from "./helpers/fakeOpfs";
import { fakeTauriVault } from "./helpers/fakeTauriVault";
import { createMemoryBackend, createOpfsBackend, getVaultBackend, setVaultBackend, unwrapVaultBackend, vaultEncryptionReady, type VaultBackend } from "../storage/vault";
import { createFolderBackend } from "../storage/vault/location";
import { createTauriBackend } from "../storage/vault/tauri";
import { createEncryptedBackend } from "../storage/vault/encrypted/backend";
import { HEADER_BACKUP_PATH, HEADER_PATH, TEMP_SUFFIX } from "../storage/vault/encrypted/paths";
import { convertFiles, readHeader, recoverInterrupted, scanVault } from "../storage/vault/encrypted/convert";
import {
  createRestHeader,
  decodeRestHeader,
  encodeRestHeader,
  encryptFile,
  isEncryptedFile,
  isSealedValue,
  MAGIC,
  normalizeRecoveryKey,
  unlockRestHeader,
  WrongPassphraseError,
} from "../storage/vault/encrypted/format";
import * as session from "../storage/vault/encrypted/session";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";

const ITER = 1000;
const PASS = "a long enough passphrase";
const NOTES: Record<string, string> = {
  "Daily/2026-11-09.md": "# יומן\nsecret plans for today",
  "Projects/Home.md": "- [ ] pay rent — secret",
  "img/pixel.png": "\u0089PNG secret bytes",
  ".trash/old.md": "deleted but secret",
};

const raw = async (b: VaultBackend, path: string) => new Uint8Array(await (await b.read(path)).arrayBuffer());
const text = (u: Uint8Array) => new TextDecoder().decode(u);

async function allPaths(b: VaultBackend, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await b.list(dir)) out.push(...(e.kind === "directory" ? await allPaths(b, e.path) : [e.path]));
  return out.sort();
}

/** Every file in `inner` (but the header) is ciphertext and says nothing of the notes. */
async function expectOnlyCiphertext(inner: VaultBackend): Promise<void> {
  const paths = (await allPaths(inner)).filter((p) => p !== HEADER_PATH && p !== HEADER_BACKUP_PATH);
  expect(paths.length).toBeGreaterThan(0);
  for (const p of paths) {
    const bytes = await raw(inner, p);
    expect(isEncryptedFile(bytes), p).toBe(true);
    expect(text(bytes)).not.toMatch(/secret|יומן/);
  }
  for (const h of [HEADER_PATH, HEADER_BACKUP_PATH]) expect(text(await raw(inner, h))).not.toMatch(/secret|יומן|Daily|Projects/);
}

/** Cheap Argon2id for the headers the session writes (production: this device's calibration, plan W4.20). */
const ARGON2_TEST = { memoryKiB: 8, iterations: 1, parallelism: 1 };

beforeEach(() => {
  session.setKdfPolicyForTests({ minPbkdf2Iterations: ITER, minArgon2CostKiB: 8, argon2: ARGON2_TEST });
});

describe("format", () => {
  it("wrong passphrase and wrong recovery key are refused; the recovery key is forgiving about how it is typed", async () => {
    const { header, recoveryKey } = await createRestHeader(PASS, { pbkdf2Iterations: ITER });
    expect(recoveryKey).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){5}$/);
    await expect(unlockRestHeader(header, "not it")).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(unlockRestHeader(header, "0".repeat(30), { recovery: true })).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(unlockRestHeader(header, recoveryKey.toLowerCase().replace(/-/g, " "), { recovery: true })).resolves.toBeTruthy();
    expect(normalizeRecoveryKey("ab-cd o i l")).toBe("ABCD011");
  });

  it("a header changed outside Lumen is refused: lower KDF cost, flipped direction, Argon2id below the floor", async () => {
    const { header } = await createRestHeader(PASS, { pbkdf2Iterations: ITER });
    const policy = { minPbkdf2Iterations: ITER };
    await expect(unlockRestHeader({ ...header, target: "plain" }, PASS)).rejects.toMatchObject({ name: "HeaderTamperedError" });
    const weaker = { ...header, passphrase: { ...header.passphrase, kdf: { ...header.passphrase.kdf, iterations: 10 } } };
    expect(() => decodeRestHeader(encodeRestHeader(weaker), policy)).toThrow(/below/);
    // Argon2id runs in this build (plan W4.20, W1.7's own TypeScript): a header asking for it is read…
    const argon = { ...header, passphrase: { ...header.passphrase, kdf: { alg: "argon2id", memoryKiB: 65536, iterations: 3, parallelism: 1, salt: header.passphrase.kdf.salt } } };
    expect(decodeRestHeader(encodeRestHeader(argon as typeof header), policy).passphrase.kdf).toMatchObject({ alg: "argon2id", memoryKiB: 65536, iterations: 3 });
    // …but not one below OWASP's floor (7 MiB, and 37 MiB × passes).
    const cheap = { ...argon, passphrase: { ...argon.passphrase, kdf: { ...argon.passphrase.kdf, memoryKiB: 4096, iterations: 1 } } };
    expect(() => decodeRestHeader(encodeRestHeader(cheap as typeof header), policy)).toThrow(/below/);
    // Unknown ids are still refused, never misread.
    const scrypt = { ...header, passphrase: { ...header.passphrase, kdf: { alg: "bcrypt", salt: header.passphrase.kdf.salt } } };
    expect(() => decodeRestHeader(encodeRestHeader(scrypt as unknown as typeof header), policy)).toThrow(/"bcrypt" is not available/);
    // Production floor: 600,000 PBKDF2 iterations.
    expect(() => decodeRestHeader(encodeRestHeader(header))).toThrow(/below 600000/);
  });

  it("the same Hebrew passphrase typed composed or decomposed opens the vault", async () => {
    const { header } = await createRestHeader("סִיסְמָה אֲרֻכָּה מְאוֹד", { pbkdf2Iterations: ITER });
    await expect(unlockRestHeader(header, "סִיסְמָה אֲרֻכָּה מְאוֹד".normalize("NFD"))).resolves.toBeTruthy();
  });
});

/** The encrypted layer over every VaultBackend: only ciphertext is stored. */
describe.each([
  ["memory", () => createMemoryBackend()],
  [
    "OPFS (fake)",
    () => {
      installFakeOpfs();
      return createOpfsBackend();
    },
  ],
  ["real folder in the browser (FileSystemDirectoryHandle, fake)", () => createFolderBackend(new FakeDir("Vault") as unknown as FileSystemDirectoryHandle)],
  ["desktop folder (Tauri, Rust commands faked)", () => createTauriBackend(fakeTauriVault("/home/tal/Notes").invoke, "/home/tal/Notes")],
] as const)("only ciphertext in storage — %s", (_label, make) => {
  it("notes, attachments and the trash are ciphertext; the layer reads them back", async () => {
    const inner: VaultBackend = make();
    const { header, keys } = await createRestHeader(PASS, { pbkdf2Iterations: ITER });
    await inner.write(HEADER_PATH, encodeRestHeader(header));
    await inner.write(HEADER_BACKUP_PATH, encodeRestHeader(header));
    const enc = createEncryptedBackend(inner, keys, { target: () => "encrypted" });
    for (const [p, c] of Object.entries(NOTES)) await enc.write(p, c);
    await expectOnlyCiphertext(inner);
    for (const [p, c] of Object.entries(NOTES)) expect(await enc.readText(p)).toBe(c);
    expect((await enc.list("")).map((e) => e.name)).not.toContain(HEADER_PATH);
    expect((await enc.stat("Projects/Home.md"))!.size).toBe(new TextEncoder().encode(NOTES["Projects/Home.md"]).length);
    const scan = await scanVault(inner, keys);
    expect(scan).toMatchObject({ encrypted: 4, plain: [], broken: [], temps: [] });
  });

  it("an existing plaintext vault is converted, and check-and-repair finds nothing left", async () => {
    const inner: VaultBackend = make();
    for (const [p, c] of Object.entries(NOTES)) await inner.write(p, c);
    const { header, keys } = await createRestHeader(PASS, { pbkdf2Iterations: ITER });
    await inner.write(HEADER_PATH, encodeRestHeader(header));
    await inner.write(HEADER_BACKUP_PATH, encodeRestHeader(header));
    const r = await convertFiles(inner, keys, "encrypted");
    expect(r).toMatchObject({ converted: 4, retry: [], broken: [] });
    await expectOnlyCiphertext(inner);
    expect(await scanVault(inner, keys)).toMatchObject({ encrypted: 4, plain: [], broken: [], temps: [] });
  });
});

describe("turning it on, locking, recovering, turning it off", () => {
  let inner: VaultBackend;
  let previous: VaultBackend | null;
  beforeEach(async () => {
    inner = createMemoryBackend();
    for (const [p, c] of Object.entries(NOTES)) await inner.write(p, c);
    previous = setVaultBackend(inner);
  });
  afterEach(() => {
    session.lock();
    setVaultBackend(previous);
  });

  const enable = async () => {
    let shown = "";
    const r = await session.enableEncryption(PASS, { pbkdf2Iterations: ITER, confirmRecoveryKey: async (k) => ((shown = k), true) });
    expect(r?.recoveryKey).toBe(shown);
    return r!;
  };

  it("cancelling at the recovery key writes nothing", async () => {
    expect(await session.enableEncryption(PASS, { pbkdf2Iterations: ITER, confirmRecoveryKey: async () => false })).toBeNull();
    expect(await inner.stat(HEADER_PATH)).toBeNull();
    expect(await inner.readText("Projects/Home.md")).toBe(NOTES["Projects/Home.md"]);
    expect(await vaultEncryptionReady()).toBe("none");
  });

  it("on: everything stored is ciphertext, Lumen reads the notes, new saves are encrypted", async () => {
    await enable();
    await expectOnlyCiphertext(inner);
    expect(await vaultEncryptionReady()).toBe("unlocked");
    expect(await readWorkspaceFile("Daily/2026-11-09.md")).toBe(NOTES["Daily/2026-11-09.md"]);
    await writeWorkspaceFile("New.md", "fresh secret");
    expect(isEncryptedFile(await raw(inner, "New.md"))).toBe(true);
    expect(unwrapVaultBackend(getVaultBackend())).toBe(inner);
  });

  it("locked: calls wait; a wrong passphrase changes nothing; the right one lets them through", async () => {
    await enable();
    session.lock();
    expect(await vaultEncryptionReady()).toBe("locked");
    const before = await raw(inner, "Projects/Home.md");
    let read: string | null = null;
    const pending = readWorkspaceFile("Projects/Home.md").then((t) => (read = t));
    await new Promise((r) => setTimeout(r, 10));
    expect(read).toBeNull();
    await expect(session.unlock("wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await raw(inner, "Projects/Home.md")).toEqual(before);
    expect(read).toBeNull();
    await session.unlock(PASS);
    await pending;
    expect(read).toBe(NOTES["Projects/Home.md"]);
  });

  it("lock forgets every encrypted vault's keys, not only the open one's (#529 re-review 14.11, T5)", async () => {
    await enable();
    const second = createMemoryBackend({ id: "second-vault" });
    await second.write("Other.md", "second secret");
    setVaultBackend(second);
    await session.enableEncryption(PASS, { pbkdf2Iterations: ITER, confirmRecoveryKey: async () => true });
    expect(await readWorkspaceFile("Other.md")).toBe("second secret");
    session.lock(); // while the second vault is open
    setVaultBackend(inner); // back to the first one
    expect(await vaultEncryptionReady()).toBe("locked");
    let read: string | null = null;
    const pending = readWorkspaceFile("Projects/Home.md").then((t) => (read = t));
    await new Promise((r) => setTimeout(r, 10));
    expect(read).toBeNull(); // waits for the passphrase
    await session.unlock(PASS);
    await pending;
    expect(read).toBe(NOTES["Projects/Home.md"]);
  });

  it("turning encryption off on one vault keeps auto-lock running for another that is unlocked (review 16, T5-1)", async () => {
    const minutesBefore = session.autoLockMinutes();
    const live = new Set<unknown>();
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    globalThis.setInterval = ((fn: () => void, ms?: number) => {
      const id = realSet(fn, ms);
      if (ms === 30_000) live.add(id);
      return id;
    }) as typeof setInterval;
    globalThis.clearInterval = ((id?: ReturnType<typeof setInterval>) => {
      live.delete(id);
      realClear(id);
    }) as typeof clearInterval;
    try {
      await enable(); // the first vault: unlocked
      const second = createMemoryBackend({ id: "second-vault" });
      await second.write("Other.md", "second secret");
      setVaultBackend(second);
      await session.enableEncryption(PASS, { pbkdf2Iterations: ITER, confirmRecoveryKey: async () => true });
      session.setAutoLockMinutes(1);
      expect((await session.disableEncryption(PASS)).done).toBe(true);
      expect(live.size).toBeGreaterThan(0); // the first vault's keys are still under auto-lock
      expect(session.checkAutoLock(Date.now() + 3_600_000)).toBe(true);
      setVaultBackend(inner);
      expect(await vaultEncryptionReady()).toBe("locked");
    } finally {
      globalThis.setInterval = realSet;
      globalThis.clearInterval = realClear;
      session.setAutoLockMinutes(minutesBefore);
    }
  });

  it("a vault made with PBKDF2 stays on it at unlock and at a passphrase change; it moves to Argon2id only when asked (review 12.11)", async () => {
    await enable();
    const alg = async () => (await readHeader(inner, { minPbkdf2Iterations: ITER, minArgon2CostKiB: 8 }))?.passphrase.kdf.alg;
    expect(await alg()).toBe("pbkdf2-sha256");
    const headerBytes = await raw(inner, HEADER_PATH);
    // An older Lumen on another device opens this folder too: unlocking never moves it.
    session.lock();
    await session.unlock(PASS);
    expect(await raw(inner, HEADER_PATH)).toEqual(headerBytes);
    expect(session.kdfUpgradeAvailable()).toBe(true);
    // Neither does a passphrase change.
    await session.changePassphrase(PASS, "another long passphrase");
    expect(await alg()).toBe("pbkdf2-sha256");
    await session.changePassphrase("another long passphrase", PASS);
    // The explicit switch: a wrong passphrase writes nothing…
    await expect(session.upgradeKdf("wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await alg()).toBe("pbkdf2-sha256");
    // …the right one re-wraps the header (both copies), and no other file changes.
    const files = await allPaths(inner);
    const before = new Map<string, Uint8Array>();
    for (const p of files) if (p !== HEADER_PATH && p !== HEADER_BACKUP_PATH) before.set(p, await raw(inner, p));
    await session.upgradeKdf(PASS);
    const policy = { minPbkdf2Iterations: ITER, minArgon2CostKiB: 8 };
    for (const path of [HEADER_PATH, HEADER_BACKUP_PATH]) {
      const h = decodeRestHeader(await raw(inner, path), policy);
      expect(h.passphrase.kdf).toMatchObject({ alg: "argon2id", ...ARGON2_TEST });
    }
    expect(session.kdfUpgradeAvailable()).toBe(false);
    for (const [p, bytes] of before) expect(await raw(inner, p), p).toEqual(bytes);
    expect(await readWorkspaceFile("Projects/Home.md")).toBe(NOTES["Projects/Home.md"]);
    session.lock();
    await expect(session.unlock("wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphraseError);
    await session.unlock(PASS);
    expect(await readWorkspaceFile("Daily/2026-11-09.md")).toBe(NOTES["Daily/2026-11-09.md"]);
    // An Argon2id vault keeps Argon2id at a passphrase change.
    await session.changePassphrase(PASS, "another long passphrase");
    expect(await alg()).toBe("argon2id");
  });

  it("a new vault gets Argon2id when no PBKDF2 is asked for (plan W4.20)", async () => {
    const r = await session.enableEncryption(PASS, { confirmRecoveryKey: async () => true });
    expect(r).not.toBeNull();
    const h = await readHeader(inner, { minArgon2CostKiB: 8 });
    expect(h?.passphrase.kdf).toMatchObject({ alg: "argon2id", ...ARGON2_TEST });
    session.lock();
    await session.unlock(PASS);
    expect(await readWorkspaceFile("Projects/Home.md")).toBe(NOTES["Projects/Home.md"]);
  });

  it("auto-lock after the chosen idle time", async () => {
    await enable();
    session.setAutoLockMinutes(15);
    expect(session.checkAutoLock(Date.now() + 14 * 60_000)).toBe(false);
    expect(session.checkAutoLock(Date.now() + 16 * 60_000)).toBe(true);
    expect(await vaultEncryptionReady()).toBe("locked");
    session.setAutoLockMinutes(0);
    await session.unlock(PASS);
    expect(session.checkAutoLock(Date.now() + 24 * 3600_000)).toBe(false);
  });

  it("recovery key: forgotten passphrase → new passphrase; the old one no longer opens it", async () => {
    const { recoveryKey } = await enable();
    session.lock();
    await expect(session.recover("0".repeat(30), "a brand new passphrase", { pbkdf2Iterations: ITER })).rejects.toBeInstanceOf(WrongPassphraseError);
    await session.recover(recoveryKey, "a brand new passphrase", { pbkdf2Iterations: ITER });
    expect(await readWorkspaceFile("Projects/Home.md")).toBe(NOTES["Projects/Home.md"]);
    const header = (await readHeader(inner, { minPbkdf2Iterations: ITER }))!;
    await expect(unlockRestHeader(header, PASS)).rejects.toBeInstanceOf(WrongPassphraseError);
    await expect(unlockRestHeader(header, "a brand new passphrase")).resolves.toBeTruthy();
  });

  it("both header files lost: ciphertext is never handed out as a note, and the recovery key alone brings the vault back", async () => {
    const { recoveryKey } = await enable();
    session.lock();
    await inner.remove(HEADER_PATH);
    await inner.remove(HEADER_BACKUP_PATH);
    setVaultBackend(inner);
    await expect(readWorkspaceFile("Projects/Home.md")).rejects.toMatchObject({ name: "EncryptedButNoHeaderError" });
    await session.recover(recoveryKey, "a brand new passphrase", { pbkdf2Iterations: ITER });
    expect(await readWorkspaceFile("Projects/Home.md")).toBe(NOTES["Projects/Home.md"]);
    expect(await inner.stat(HEADER_PATH)).not.toBeNull();
  });

  it("one damaged header copy: the other one opens the vault", async () => {
    await enable();
    session.lock();
    await inner.write(HEADER_PATH, "{ cut off");
    setVaultBackend(inner);
    const pending = readWorkspaceFile("Projects/Home.md");
    await session.unlock(PASS);
    expect(await pending).toBe(NOTES["Projects/Home.md"]);
  });

  it("interrupted conversion (crash part way): every note still reads; check and repair finishes it", async () => {
    // A storage that dies after a few writes, like a tab closed mid-way.
    let writes = 0;
    const dying: VaultBackend = {
      ...inner,
      write: async (p, d) => {
        if (++writes > 5) throw new Error("tab closed");
        return inner.write(p, d);
      },
    };
    setVaultBackend(dying);
    await expect(session.enableEncryption(PASS, { pbkdf2Iterations: ITER })).rejects.toThrow("tab closed");
    const mixed = await allPaths(inner);
    expect(mixed).toContain(HEADER_PATH);
    // Some notes encrypted, some not — and a copy may be left behind.
    const states = await Promise.all(Object.keys(NOTES).map(async (p) => isEncryptedFile(await raw(inner, p))));
    expect(states).toContain(true);
    expect(states).toContain(false);
    // Next start: a fresh gate over the same storage, locked.
    session.lock();
    setVaultBackend(inner);
    const pending = Promise.all(Object.keys(NOTES).map((p) => readWorkspaceFile(p)));
    await session.unlock(PASS);
    expect(await pending).toEqual(Object.values(NOTES));
    const { scan } = await session.repair();
    expect(scan).toMatchObject({ encrypted: 4, plain: [], broken: [], temps: [] });
    await expectOnlyCiphertext(inner);
  });

  it("interrupted inside the replace step: the checked copy becomes the file; a copy next to an intact file is dropped", async () => {
    const { keys } = await createRestHeader(PASS, { pbkdf2Iterations: ITER });
    // Cut off after the file was removed and before the copy took its place.
    const sealed = await encryptFile(keys, new TextEncoder().encode(NOTES["Daily/2026-11-09.md"]));
    await inner.remove("Daily/2026-11-09.md");
    await inner.write("Daily/2026-11-09.md" + TEMP_SUFFIX, sealed);
    // Cut off before the replace: the file is intact, the copy is left over.
    await inner.write("Projects/Home.md" + TEMP_SUFFIX, new Uint8Array([...MAGIC, 1, 2, 3]));
    expect(await recoverInterrupted(inner)).toBe(2);
    const enc = createEncryptedBackend(inner, keys, { target: () => "encrypted" });
    expect(await enc.readText("Daily/2026-11-09.md")).toBe(NOTES["Daily/2026-11-09.md"]);
    expect(await enc.readText("Projects/Home.md")).toBe(NOTES["Projects/Home.md"]);
    expect((await allPaths(inner)).filter((p) => p.endsWith(TEMP_SUFFIX))).toEqual([]);
  });

  it("a file that doesn't decrypt is reported and never overwritten", async () => {
    await enable();
    const bad = new Uint8Array([...MAGIC, ...new Uint8Array(40)]);
    await inner.write("broken.md", bad);
    const { scan } = await session.repair();
    expect(scan.broken).toEqual(["broken.md"]);
    expect(await raw(inner, "broken.md")).toEqual(bad);
    await expect(readWorkspaceFile("broken.md")).rejects.toMatchObject({ name: "NotDecryptableError" });
  });

  it("a plaintext file dropped into the folder reads as it is and is encrypted by check and repair", async () => {
    await enable();
    await inner.write("dropped.md", "dropped secret");
    expect(await readWorkspaceFile("dropped.md")).toBe("dropped secret");
    expect((await session.repair()).scan.plain).toEqual([]);
    expect(isEncryptedFile(await raw(inner, "dropped.md"))).toBe(true);
  });

  it("agent traces are inside the boundary: sealed when on, migrated on enabling, deleted when off", async () => {
    const trace = await import("../agents/trace");
    await trace.clearTrace();
    const run = { id: "r1", agentId: "summarize", startedAt: 1, endedAt: 2, status: "ok", attempts: 1, steps: [], tokens: { input: 1, output: 1 }, output: "a secret summary" };
    await trace.recordRun(run as unknown as Parameters<typeof trace.recordRun>[0]);
    expect(JSON.stringify(await get("lumen-agent-trace"))).toMatch(/secret/);
    await enable();
    const stored = await get("lumen-agent-trace");
    expect(isSealedValue(stored)).toBe(true);
    expect(JSON.stringify(stored)).not.toMatch(/secret/);
    session.lock();
    await trace.recordRun({ ...run, id: "r2" } as unknown as Parameters<typeof trace.recordRun>[0]);
    expect(await get("lumen-agent-trace")).toEqual(stored);
    await session.unlock(PASS);
    const off = await session.disableEncryption(PASS);
    expect(off.done).toBe(true);
    expect(await get("lumen-agent-trace")).toEqual([]);
  });

  it("history snapshots (backups) are sealed while on and come back in the clear when off", async () => {
    const history = await import("../storage/history");
    await enable();
    await history.recordSnapshot("Projects/Home.md", "a secret draft", "save");
    expect((await history.listSnapshots("Projects/Home.md"))[0].content).toBe("a secret draft");
    session.lock();
    expect(await history.listSnapshots("Projects/Home.md")).toEqual([]);
    expect(await history.recordSnapshot("Projects/Home.md", "written while locked", "save")).toBe(false);
    await session.unlock(PASS);
    expect((await session.disableEncryption(PASS)).done).toBe(true);
    expect((await history.listSnapshots("Projects/Home.md"))[0].content).toBe("a secret draft");
  });

  it("off: every file back to plain text, the header removed last, the vault plain again", async () => {
    await enable();
    await expect(session.disableEncryption("wrong passphrase!!")).rejects.toBeInstanceOf(WrongPassphraseError);
    expect(await inner.stat(HEADER_PATH)).not.toBeNull();
    const r = await session.disableEncryption(PASS);
    expect(r.done).toBe(true);
    for (const [p, c] of Object.entries(NOTES)) expect(await inner.readText(p)).toBe(c);
    expect(await inner.stat(HEADER_PATH)).toBeNull();
    expect(await inner.stat(HEADER_BACKUP_PATH)).toBeNull();
    expect(await vaultEncryptionReady()).toBe("none");
  });

  it("an encrypted vault is not moved (the move would copy decrypted notes)", async () => {
    await enable();
    const { moveVault, VaultEncryptedMoveError } = await import("../storage/vault/location");
    const target = Object.assign(new FakeDir("Elsewhere"), { queryPermission: async () => "granted", requestPermission: async () => "granted" });
    const to = { kind: "folder" as const, handle: target as unknown as FileSystemDirectoryHandle, name: "Elsewhere" };
    await expect(moveVault(to, { from: { kind: "opfs" } })).rejects.toBeInstanceOf(VaultEncryptedMoveError);
  });
});

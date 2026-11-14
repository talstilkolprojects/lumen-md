/**
 * 2.80 (Codex P2 4311163146 on #235): version history belongs to a vault.
 * Two vaults that both have `notes/a.md` never see, list or clear each
 * other's snapshots; the rows written before vaults had an identity stay
 * with the first vault; with no vault open nothing is recorded or listed.
 */
import { beforeEach, describe, expect, it } from "vitest";
import * as history from "../storage/history";
import { createMemoryBackend, setVaultBackend } from "../storage/vault";
import { snapshotVault } from "../sync/autoBackup";

beforeEach(async () => {
  history.__resetHistoryDb();
  // The global IndexedDB (fake-indexeddb in Vitest, the real one in a browser), emptied.
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase("lumen-history");
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
});

describe("history per vault", () => {
  it("another vault with the same path sees none of this vault's versions", async () => {
    history.setHistoryVault("");
    expect(await history.recordSnapshot("notes/a.md", "legacy vault text", "save", 1000)).toBe(true);
    history.setHistoryVault("vault-b");
    expect(await history.listSnapshots("notes/a.md")).toEqual([]);
    expect(await history.recordSnapshot("notes/a.md", "vault B text", "save", 2000)).toBe(true);
    expect((await history.listSnapshots("notes/a.md")).map((s) => s.content)).toEqual(["vault B text"]);
    // The rows from before identities stay with the first vault, unchanged.
    history.setHistoryVault("");
    expect((await history.listSnapshots("notes/a.md")).map((s) => s.content)).toEqual(["legacy vault text"]);
  });

  it("snapshots come back with the plain path and the vault they were listed from", async () => {
    history.setHistoryVault("vault-b");
    await history.recordSnapshot("notes/a.md", "B", "save", 1000);
    const [snap] = await history.listSnapshots("notes/a.md");
    expect(snap).toMatchObject({ name: "notes/a.md", content: "B", vault: "vault-b" });
  });

  it("listDocuments and clearHistory touch the active vault only", async () => {
    history.setHistoryVault("");
    await history.recordSnapshot("a.md", "legacy", "save", 1000);
    history.setHistoryVault("vault-b");
    await history.recordSnapshot("a.md", "b", "save", 2000);
    await history.recordSnapshot("b-only.md", "b", "save", 3000);
    expect((await history.listDocuments()).map((d) => d.name).sort()).toEqual(["a.md", "b-only.md"]);
    await history.clearHistory("a.md");
    expect(await history.listSnapshots("a.md")).toEqual([]);
    history.setHistoryVault("");
    expect((await history.listDocuments()).map((d) => d.name)).toEqual(["a.md"]);
    expect((await history.listSnapshots("a.md")).map((s) => s.content)).toEqual(["legacy"]);
  });

  it("a snapshot taken before a switch is filed under the vault it came from", async () => {
    history.setHistoryVault("vault-b");
    await history.recordSnapshot("a.md", "from A", "auto-backup", 1000, "vault-a");
    expect(await history.listSnapshots("a.md")).toEqual([]);
    history.setHistoryVault("vault-a");
    expect((await history.listSnapshots("a.md")).map((s) => s.content)).toEqual(["from A"]);
  });

  it("with no vault open (start-up restoring) nothing is recorded or listed", async () => {
    history.setHistoryVault("");
    await history.recordSnapshot("a.md", "legacy", "save", 1000);
    history.setHistoryVault(null);
    expect(await history.recordSnapshot("a.md", "while closed", "save", 2000)).toBe(false);
    expect(await history.listSnapshots("a.md")).toEqual([]);
    expect(await history.listDocuments()).toEqual([]);
    history.setHistoryVault("");
    expect((await history.listSnapshots("a.md")).map((s) => s.content)).toEqual(["legacy"]);
  });

  it("a vault snapshot pass stops when the vault switches under it (Codex P2 4575404796)", async () => {
    const a = createMemoryBackend({ id: "A" });
    const b = createMemoryBackend({ id: "B" });
    for (const [vault, text] of [[a, "A"], [b, "B"]] as const) {
      await vault.write("1.md", `${text} one`);
      await vault.write("2.md", `${text} two`);
    }
    const read = a.readText.bind(a);
    let switched = false;
    // The switch lands while the pass is reading its first note.
    a.readText = async (path: string) => {
      const text = await read(path);
      if (!switched) {
        switched = true;
        setVaultBackend(b);
        history.setHistoryVault("vault-b");
      }
      return text;
    };
    const previous = setVaultBackend(a);
    try {
      history.setHistoryVault("vault-a");
      await snapshotVault();
      history.setHistoryVault("vault-a");
      const filed = [...(await history.listSnapshots("1.md")), ...(await history.listSnapshots("2.md"))].map((s) => s.content);
      expect(filed.some((t) => t.startsWith("B"))).toBe(false);
      history.setHistoryVault("vault-b");
      expect(await history.listSnapshots("2.md")).toEqual([]);
    } finally {
      setVaultBackend(previous);
    }
  });
});

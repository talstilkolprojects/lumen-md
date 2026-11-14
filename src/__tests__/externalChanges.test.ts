/**
 * Plan 4.4: open notes follow changes made outside Lumen, and a concurrent
 * edit becomes a conflict with 0 data loss — the other version is kept as a
 * file before anything is asked, and saving never overwrites it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDirectoryHandleBackend, createMemoryBackend, setVaultBackend, type VaultBackend } from "../storage/vault";
import { FakeDir } from "./helpers/fakeOpfs";
import { useAppStore } from "../store/useStore";
import {
  __resetExternalChanges,
  __setConflictUi,
  saveOpenNote,
  startExternalChanges,
  type ConflictResolver,
} from "../store/externalChanges";
import { listWorkspace, readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";

let vault: VaultBackend;
let stop: () => void;
let resolver: ReturnType<typeof vi.fn<ConflictResolver>>;
const toasts: string[] = [];

function open(path: string, content: string, dirty = false) {
  useAppStore.setState({
    doc: { name: path, content, workspaceName: path, dirty },
    openTabs: [{ id: path, name: path, content, workspaceName: path, dirty }],
  } as never);
}
const doc = () => useAppStore.getState().doc;
/** Another program changes the file: the watcher reports it as external. */
async function outside(path: string, text: string | null, renameTo?: string) {
  if (renameTo) {
    await vault.rename(path, renameTo);
    vault.notifyExternal({ type: "rename", from: path, path: renameTo });
  } else if (text === null) {
    await vault.remove(path);
    vault.notifyExternal({ type: "delete", path });
  } else {
    await vault.write(path, text);
    vault.notifyExternal({ type: "write", path });
  }
}
const settle = () => vi.waitFor(() => undefined).then(() => new Promise((r) => setTimeout(r, 20)));

beforeEach(async () => {
  vault = createMemoryBackend();
  setVaultBackend(vault);
  __resetExternalChanges();
  toasts.length = 0;
  resolver = vi.fn<ConflictResolver>(async () => ({ kind: "local" }));
  __setConflictUi(resolver, (m) => void toasts.push(m));
  await writeWorkspaceFile("note.md", "base");
  open("note.md", "base");
  stop = startExternalChanges();
});
afterEach(() => {
  stop();
  setVaultBackend(null);
});

describe("a note without unsaved edits", () => {
  it("shows the text changed outside Lumen", async () => {
    await outside("note.md", "changed in Obsidian");
    await vi.waitFor(() => expect(doc().content).toBe("changed in Obsidian"));
    expect(doc().dirty).toBe(false);
    expect(useAppStore.getState().openTabs[0].content).toBe("changed in Obsidian");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("follows a rename made outside Lumen", async () => {
    await outside("note.md", "", "archive/note.md");
    await vi.waitFor(() => expect(doc().workspaceName).toBe("archive/note.md"));
    // Autosave now writes the new path, not the old one back.
    expect(await saveOpenNote("archive/note.md", "edited")).toBe(true);
    expect(await vault.stat("note.md")).toBeNull();
  });

  it("stays open, unsaved and detached when deleted outside Lumen (autosave does not recreate it)", async () => {
    await outside("note.md", null);
    await vi.waitFor(() => expect(doc().workspaceName).toBeNull());
    expect(doc()).toMatchObject({ content: "base", dirty: true });
    expect(await vault.stat("note.md")).toBeNull();
  });
});

describe("changes while Lumen was closed", () => {
  it("a note restored with unsaved edits is not saved over a change made while Lumen was closed", async () => {
    stop();
    __resetExternalChanges();
    // Last session: Lumen saw "base" on disk (hash persisted), the tab kept unsaved text.
    stop = startExternalChanges();
    await vi.waitFor(() => expect(localStorage.getItem("lumen-vault-known") ?? "").toContain("note.md"));
    stop();
    // Lumen closed; another program edits; Lumen restarts with the dirty tab.
    await vault.write("note.md", "edited while Lumen was closed");
    open("note.md", "unsaved from last session", true);
    stop = startExternalChanges();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    expect(resolver.mock.calls[0][0]).toMatchObject({ local: "unsaved from last session", remote: "edited while Lumen was closed" });
    await settle();
    const files = (await listWorkspace()).map((f) => f.path);
    expect(files).toHaveLength(2);
    const copy = files.find((p) => p !== "note.md")!;
    expect(await readWorkspaceFile(copy)).toBe("edited while Lumen was closed");
  });

  it("a clean restored note shows what is on disk now; a deleted one is detached", async () => {
    stop();
    await writeWorkspaceFile("gone.md", "g");
    useAppStore.setState({
      doc: { name: "note.md", content: "base", workspaceName: "note.md", dirty: false },
      openTabs: [
        { id: "note.md", name: "note.md", content: "base", workspaceName: "note.md", dirty: false },
        { id: "gone.md", name: "gone.md", content: "g", workspaceName: "gone.md", dirty: false },
      ],
    } as never);
    stop = startExternalChanges();
    await vi.waitFor(() => expect(localStorage.getItem("lumen-vault-known") ?? "").toContain("gone.md"));
    stop();
    await vault.write("note.md", "newer on disk");
    await vault.remove("gone.md");
    stop = startExternalChanges();
    await vi.waitFor(() => expect(doc().content).toBe("newer on disk"));
    await vi.waitFor(() => expect(useAppStore.getState().openTabs.find((t) => t.name === "gone.md")?.workspaceName).toBeNull());
  });

  it("a note whose file vanished (deleted or renamed outside, not yet reported) is not recreated by a save", async () => {
    // A folder vault whose file another program removes (no Lumen event).
    stop();
    const dir = new FakeDir("V");
    const folder = createDirectoryHandleBackend({ id: "folder", root: async () => dir as unknown as FileSystemDirectoryHandle });
    setVaultBackend(folder);
    await writeWorkspaceFile("note.md", "base");
    open("note.md", "base");
    stop = startExternalChanges();
    await vi.waitFor(() => expect(localStorage.getItem("lumen-vault-known") ?? "").toContain("note.md"));
    useAppStore.getState().setContent("mine");
    await dir.removeEntry("note.md");
    expect(await saveOpenNote("note.md", "mine")).toBe(false);
    expect(await folder.stat("note.md")).toBeNull();
    // Lumen's own delete is different: what was known goes with it.
    open("other.md", "o", true);
    expect(await saveOpenNote("other.md", "o")).toBe(true);
    await folder.remove("other.md");
    expect(await saveOpenNote("other.md", "o, typed on")).toBe(true);
  });
});

describe("review round 2", () => {
  it("a closed vault (start-up, a folder waiting for a click) does not make restored notes look deleted", async () => {
    const closed = createMemoryBackend({ id: "restoring" });
    closed.available = () => false;
    setVaultBackend(closed);
    open("note.md", "unsaved", true);
    const { reconcileOpenNotes } = await import("../store/externalChanges");
    await reconcileOpenNotes();
    expect(doc()).toMatchObject({ workspaceName: "note.md", content: "unsaved", dirty: true });
    expect(resolver).not.toHaveBeenCalled();
  });

  it("a note opened after start-up gets a persisted base at once, so a change made while Lumen is closed is caught", async () => {
    await writeWorkspaceFile("later.md", "L");
    open("later.md", "L");
    await vi.waitFor(() => expect(localStorage.getItem("lumen-vault-known") ?? "").toContain("later.md"));
    // The user edits, closes before autosave; another program edits; Lumen restarts.
    stop();
    await vault.write("later.md", "edited while closed");
    open("later.md", "my unsaved edit", true);
    stop = startExternalChanges();
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    await settle();
    expect(await readWorkspaceFile("later.md")).toBe("my unsaved edit");
    const copy = (await listWorkspace()).map((f) => f.path).find((p) => p.startsWith("later ("))!;
    expect(await readWorkspaceFile(copy)).toBe("edited while closed");
  });

  it("text typed while the conflict dialog is open is kept, not replaced by the merge", async () => {
    let answer!: (v: { kind: "merged"; content: string }) => void;
    resolver.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    useAppStore.getState().setContent("mine");
    await outside("note.md", "theirs");
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    useAppStore.getState().setContent("mine, and more typed behind the dialog");
    answer({ kind: "merged", content: "merge of the older text" });
    await settle();
    expect(doc()).toMatchObject({ content: "mine, and more typed behind the dialog", dirty: true });
    expect(await readWorkspaceFile("note.md")).toBe("theirs"); // untouched until the next save
    expect(toasts.some((m) => /kept typing|latest text/i.test(m))).toBe(true);
    // The next save goes through: the disk still holds what Lumen now knows.
    expect(await saveOpenNote("note.md", "mine, and more typed behind the dialog")).toBe(true);
  });

  it("trash / move / export (flushActiveWorkspaceDoc) wait for the conflict's answer and then save, or stop", async () => {
    const { flushActiveWorkspaceDoc } = await import("../store/openDocs");
    useAppStore.getState().setContent("mine");
    await vault.write("note.md", "theirs, unnoticed");
    let answer!: (v: { kind: "local" }) => void;
    resolver.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    let done = false;
    const flush = flushActiveWorkspaceDoc().then(() => (done = true));
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    await settle();
    expect(done).toBe(false); // not "completed" while unresolved
    expect(await readWorkspaceFile("note.md")).toBe("theirs, unnoticed");
    answer({ kind: "local" });
    await flush;
    expect(await readWorkspaceFile("note.md")).toBe("mine");
    expect(doc().dirty).toBe(false);

    // The file changes outside once more while the dialog is open: the flush
    // waits for the second conflict too, and only then reports the note saved.
    useAppStore.getState().setContent("mine 2");
    await vault.write("note.md", "theirs 2");
    resolver.mockImplementationOnce(async () => {
      await vault.write("note.md", "changed again outside");
      return { kind: "local" };
    });
    await flushActiveWorkspaceDoc();
    expect(resolver).toHaveBeenCalledTimes(3);
    expect(resolver.mock.calls[2][0]).toMatchObject({ remote: "changed again outside" });
    expect(await readWorkspaceFile("note.md")).toBe("mine 2");
    expect(doc().dirty).toBe(false);
  });

  it("the caller is stopped when the note still cannot be saved after the answer", async () => {
    const { flushActiveWorkspaceDoc } = await import("../store/openDocs");
    useAppStore.getState().setContent("mine");
    await vault.write("note.md", "theirs");
    // The user types during the dialog (kept, unsaved) and the file changes
    // again right after the answer, before the flush's own save.
    resolver.mockImplementationOnce(async () => {
      useAppStore.getState().setContent("mine, typed behind the dialog");
      return { kind: "local" };
    });
    // The "kept typing" toast is the last step of the resolution: the outside
    // change lands right then, before the flush's own save.
    __setConflictUi(resolver, (m) => {
      toasts.push(m);
      if (/kept typing|latest text/i.test(m)) void vault.write("note.md", "changed right after");
    });
    await expect(flushActiveWorkspaceDoc()).rejects.toThrow(/not saved/);
    expect(doc()).toMatchObject({ content: "mine, typed behind the dialog", dirty: true });
    await settle();
  });
});

describe("review round 3", () => {
  it("a file changed again while the dialog is open is not overwritten by the answer: a second conflict follows", async () => {
    let answer!: (v: { kind: "local" }) => void;
    resolver.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    useAppStore.getState().setContent("mine");
    await outside("note.md", "theirs 1");
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    // Another program writes once more while the user reads the dialog.
    await outside("note.md", "theirs 2, newer");
    answer({ kind: "local" });
    // The answer about "theirs 1" is not written over "theirs 2": the dialog returns for it.
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(2));
    expect(resolver.mock.calls[1][0]).toMatchObject({ local: "mine", remote: "theirs 2, newer" });
    await settle();
    const files = (await listWorkspace()).map((f) => f.path).sort();
    const copies = files.filter((p) => p.startsWith("note ("));
    expect(copies).toHaveLength(2);
    const texts = await Promise.all(copies.map((c) => readWorkspaceFile(c)));
    expect(texts.sort()).toEqual(["theirs 1", "theirs 2, newer"]);
    expect(await readWorkspaceFile("note.md")).toBe("mine");
    expect(doc()).toMatchObject({ content: "mine", dirty: false });
  });

  it("a file deleted while the dialog is open is not recreated by the answer: the note is detached", async () => {
    let answer!: (v: { kind: "local" }) => void;
    resolver.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    useAppStore.getState().setContent("mine");
    await outside("note.md", "theirs");
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    await vault.remove("note.md");
    answer({ kind: "local" });
    await vi.waitFor(() => expect(doc().workspaceName).toBeNull());
    expect(doc()).toMatchObject({ content: "mine", dirty: true });
    expect(await vault.stat("note.md")).toBeNull();
    const copy = (await listWorkspace()).map((f) => f.path).find((p) => p.startsWith("note ("))!;
    expect(await readWorkspaceFile(copy)).toBe("theirs");
  });
});

describe("a concurrent edit (unsaved text in Lumen, a change on disk)", () => {
  it("becomes a conflict: the other version is kept as a file first; 'keep mine' loses nothing", async () => {
    useAppStore.getState().setContent("mine, unsaved");
    await outside("note.md", "theirs, from another editor");
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    expect(resolver.mock.calls[0][0]).toMatchObject({ path: "note.md", base: "base", local: "mine, unsaved", remote: "theirs, from another editor" });
    await settle();
    const files = (await listWorkspace()).map((f) => f.path);
    const copy = files.find((p) => p.startsWith("note (changed outside Lumen"));
    expect(copy).toBeDefined();
    // 0 data loss: both versions are on disk.
    expect(await readWorkspaceFile(copy!)).toBe("theirs, from another editor");
    expect(await readWorkspaceFile("note.md")).toBe("mine, unsaved");
    expect(doc()).toMatchObject({ content: "mine, unsaved", dirty: false });
    expect(toasts.some((t) => t.includes(copy!))).toBe(true);
  });

  it("'take theirs' shows their text and drops the copy (the note holds it again)", async () => {
    resolver.mockResolvedValueOnce({ kind: "remote" });
    useAppStore.getState().setContent("mine, unsaved");
    await outside("note.md", "theirs");
    await vi.waitFor(() => expect(doc().content).toBe("theirs"));
    await settle();
    expect(doc().dirty).toBe(false);
    expect((await listWorkspace()).map((f) => f.path)).toEqual(["note.md"]);
  });

  it("a merge writes the merged text and keeps the copy", async () => {
    resolver.mockResolvedValueOnce({ kind: "merged", content: "mine + theirs" });
    useAppStore.getState().setContent("mine");
    await outside("note.md", "theirs");
    await vi.waitFor(() => expect(doc().content).toBe("mine + theirs"));
    await settle();
    expect(await readWorkspaceFile("note.md")).toBe("mine + theirs");
    expect((await listWorkspace()).length).toBe(2);
  });

  it("autosave is compare-and-swap: a change on disk not yet noticed is never overwritten", async () => {
    useAppStore.getState().setContent("mine");
    // Another program writes, and the watcher has not reported it yet.
    await vault.write("note.md", "theirs, not yet noticed");
    expect(await saveOpenNote("note.md", "mine")).toBe(false);
    await vi.waitFor(() => expect(resolver).toHaveBeenCalledTimes(1));
    await settle();
    const files = (await listWorkspace()).map((f) => f.path);
    const copy = files.find((p) => p !== "note.md")!;
    expect(await readWorkspaceFile(copy)).toBe("theirs, not yet noticed");
    expect(await readWorkspaceFile("note.md")).toBe("mine");
  });

  it("while a conflict waits for an answer, saving that note writes nothing", async () => {
    let answer!: (v: { kind: "local" }) => void;
    resolver.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    useAppStore.getState().setContent("mine");
    await outside("note.md", "theirs");
    await vi.waitFor(() => expect(resolver).toHaveBeenCalled());
    expect(await saveOpenNote("note.md", "mine, typed on")).toBe(false);
    expect(await readWorkspaceFile("note.md")).toBe("theirs");
    answer({ kind: "local" });
    await vi.waitFor(async () => expect(await readWorkspaceFile("note.md")).toBe("mine"));
  });

  it("the same text on both sides is not a conflict", async () => {
    useAppStore.getState().setContent("same");
    await outside("note.md", "same");
    await settle();
    expect(resolver).not.toHaveBeenCalled();
    expect(doc()).toMatchObject({ content: "same", dirty: false });
  });
});

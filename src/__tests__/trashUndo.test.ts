/**
 * Plan 3.1: Ctrl+Z outside the editor restores the last delete (a stack of
 * the last 20), and deleting a folder first writes the unsaved edits of
 * every open tab inside it, inactive tabs included.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { useAppStore } from "../store/useStore";
import { readWorkspaceFile, workspaceHasEntry, writeWorkspaceFile } from "../storage/workspace";
import { __resetTrashUndo, TRASH_UNDO_LIMIT, trashPaths, trashUndoDepth, undoLastTrash, undoTrash } from "../storage/fileOps";
import { listTrash, restoreFromTrash } from "../storage/trash";
import { flushOpenDocsUnder } from "../store/openDocs";
import { handleTrashUndoKey, isEditingTarget, isUndoKey } from "../ui/trashUndoShortcut";
import { __resetExternalChanges } from "../store/externalChanges";

beforeEach(() => {
  installFakeOpfs();
  __resetTrashUndo();
  // The outside-change guard (#258) remembers what each path held; a fresh vault starts with no memory.
  __resetExternalChanges();
  useAppStore.setState({ doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null }, openTabs: [] });
});

afterEach(() => {
  document.body.innerHTML = "";
});

function open(path: string, content: string) {
  useAppStore.getState().openTab({ name: path, content, workspaceName: path });
}

describe("undoLastTrash: a stack of deletes", () => {
  it("restores the most recent delete first, then the one before, then nothing", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await trashPaths(["a.md"]);
    await trashPaths(["b.md"]);
    expect(trashUndoDepth()).toBe(2);
    expect(await undoLastTrash()).toEqual(["b.md"]);
    expect(await workspaceHasEntry("a.md")).toBe(false);
    expect(await undoLastTrash()).toEqual(["a.md"]);
    expect(await readWorkspaceFile("a.md")).toBe("A");
    expect(await undoLastTrash()).toBeNull();
    expect(trashUndoDepth()).toBe(0);
  });

  it("a bulk delete is one entry: one Ctrl+Z brings all of it back", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await trashPaths(["a.md", "b.md"]);
    expect(trashUndoDepth()).toBe(1);
    expect((await undoLastTrash())?.sort()).toEqual(["a.md", "b.md"]);
  });

  it(`keeps only the last ${TRASH_UNDO_LIMIT} deletes; older ones stay in the trash`, async () => {
    for (let i = 0; i < TRASH_UNDO_LIMIT + 2; i++) {
      await writeWorkspaceFile(`n${i}.md`, `#${i}`);
      await trashPaths([`n${i}.md`]);
    }
    expect(trashUndoDepth()).toBe(TRASH_UNDO_LIMIT);
    for (let i = TRASH_UNDO_LIMIT + 1; i >= 2; i--) expect(await undoLastTrash()).toEqual([`n${i}.md`]);
    expect(await undoLastTrash()).toBeNull();
    expect((await listTrash()).map((i) => i.originalPath).sort()).toEqual(["n0.md", "n1.md"]);
  });

  it("a bulk delete that fails part way keeps what moved undoable (review: #218)", async () => {
    await writeWorkspaceFile("a.md", "A");
    await expect(trashPaths(["a.md", "missing.md"])).rejects.toThrow();
    expect(trashUndoDepth()).toBe(1);
    expect(await undoLastTrash()).toEqual(["a.md"]);
    expect(await readWorkspaceFile("a.md")).toBe("A");
  });

  it("the toast's Undo takes its entry off the stack", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await trashPaths(["a.md"]);
    const b = await trashPaths(["b.md"]);
    await undoTrash(b);
    expect(trashUndoDepth()).toBe(1);
    expect(await undoLastTrash()).toEqual(["a.md"]);
  });

  it("a toast Undo that fails leaves what is still in the trash on the Ctrl+Z stack (review: #218)", async () => {
    const root = installFakeOpfs();
    await writeWorkspaceFile("a.md", "A");
    const items = await trashPaths(["a.md"]);
    const handle = await root.getFileHandle("__probe", { create: true });
    await root.removeEntry("__probe");
    const proto = Object.getPrototypeOf(handle) as { createWritable: (this: { name: string }) => Promise<unknown> };
    const original = proto.createWritable;
    let failed = false;
    proto.createWritable = async function (this: { name: string }) {
      if (this.name === "a.md" && !failed) {
        failed = true;
        throw new DOMException("transient", "QuotaExceededError");
      }
      return original.call(this);
    };
    try {
      await expect(undoTrash(items)).rejects.toThrow("transient");
    } finally {
      proto.createWritable = original;
    }
    expect(trashUndoDepth()).toBe(1);
    expect(await undoLastTrash()).toEqual(["a.md"]);
    expect(await readWorkspaceFile("a.md")).toBe("A");
  });

  it("a failed restore during a storage outage keeps the entry for Ctrl+Z even when the trash index cannot be read either (W1.32, #218)", async () => {
    const root = installFakeOpfs();
    await writeWorkspaceFile("a.md", "A");
    const items = await trashPaths(["a.md"]);
    const handle = await root.getFileHandle("__probe", { create: true });
    await root.removeEntry("__probe");
    const fileProto = Object.getPrototypeOf(handle) as { createWritable: (this: { name: string }) => Promise<unknown> };
    const dirProto = Object.getPrototypeOf(root) as { getFileHandle: (this: unknown, name: string, opts?: { create?: boolean }) => Promise<unknown> };
    const createWritable = fileProto.createWritable;
    const getFileHandle = dirProto.getFileHandle;
    let outage = false;
    // The restore's write fails, and from then on the index cannot be read (not "missing": failing).
    fileProto.createWritable = async function (this: { name: string }) {
      if (this.name === "a.md" && !outage) {
        outage = true;
        throw new DOMException("transient", "QuotaExceededError");
      }
      return createWritable.call(this);
    };
    dirProto.getFileHandle = async function (this: unknown, name: string, opts?: { create?: boolean }) {
      if (outage && name === "index.json") throw new DOMException("storage unavailable", "InvalidStateError");
      return getFileHandle.call(this, name, opts);
    };
    try {
      await expect(undoTrash(items)).rejects.toThrow("transient");
    } finally {
      fileProto.createWritable = createWritable;
      dirProto.getFileHandle = getFileHandle;
    }
    // Storage is back: Ctrl+Z retries the restore.
    expect(trashUndoDepth()).toBe(1);
    expect(await undoLastTrash()).toEqual(["a.md"]);
    expect(await readWorkspaceFile("a.md")).toBe("A");
  });

  it("skips what the Trash panel already restored, and Undo on it again is a no-op", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await trashPaths(["a.md"]);
    const b = await trashPaths(["b.md"]);
    await restoreFromTrash(b[0].id); // from the Trash panel
    expect(await undoLastTrash()).toEqual(["a.md"]);
    await expect(undoTrash(b)).resolves.toEqual([]);
  });

  it("two quick presses restore two deletes, newest first, without corrupting the trash index", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await trashPaths(["a.md"]);
    await trashPaths(["b.md"]);
    const [first, second] = await Promise.all([undoLastTrash(), undoLastTrash()]);
    expect(first).toEqual(["b.md"]);
    expect(second).toEqual(["a.md"]);
    expect(await listTrash()).toEqual([]);
  });

  it("Ctrl+Z while a delete is still moving keeps both in the trash index (review: #218)", async () => {
    await writeWorkspaceFile("a.md", "A");
    for (let i = 0; i < 5; i++) await writeWorkspaceFile(`big/n${i}.md`, `#${i}`);
    await trashPaths(["a.md"]);
    // The folder move is still in flight when the restore starts.
    const [deleted, restored] = await Promise.all([trashPaths(["big"], { big: "directory" }), undoLastTrash()]);
    expect(restored).toEqual(["a.md"]);
    expect(await readWorkspaceFile("a.md")).toBe("A");
    expect((await listTrash()).map((i) => i.originalPath)).toEqual(["big"]);
    // ...and the deleted folder is still restorable from the index.
    expect(await undoTrash(deleted)).toEqual(["big"]);
    expect(await readWorkspaceFile("big/n4.md")).toBe("#4");
  });

  it("the Trash panel's restore is queued with deletes too", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    const [a] = await trashPaths(["a.md"]);
    await Promise.all([trashPaths(["b.md"]), restoreFromTrash(a.id)]);
    expect((await listTrash()).map((i) => i.originalPath)).toEqual(["b.md"]);
  });
});

describe("flushOpenDocsUnder", () => {
  it("deleting a folder saves every open tab inside it, inactive ones too, so Ctrl+Z brings back the latest text", async () => {
    await writeWorkspaceFile("proj/a.md", "A saved");
    await writeWorkspaceFile("proj/b.md", "B saved");
    open("proj/a.md", "A saved");
    useAppStore.getState().setContent("A unsaved edit"); // the debounced autosave has not run...
    open("proj/b.md", "B saved"); // ...and the user switched away: a.md is now an inactive dirty tab
    useAppStore.getState().setContent("B unsaved edit");
    expect(useAppStore.getState().openTabs.find((t) => t.id === "proj/a.md")).toMatchObject({ dirty: true, content: "A unsaved edit" });

    await flushOpenDocsUnder(["proj"]);
    await trashPaths(["proj"], { proj: "directory" });
    expect(await workspaceHasEntry("proj")).toBe(false);

    expect(await undoLastTrash()).toEqual(["proj"]);
    expect(await readWorkspaceFile("proj/a.md")).toBe("A unsaved edit");
    expect(await readWorkspaceFile("proj/b.md")).toBe("B unsaved edit");
    const s = useAppStore.getState();
    expect(s.doc.dirty).toBe(false);
    expect(s.openTabs.filter((t) => t.workspaceName?.startsWith("proj/")).every((t) => !t.dirty)).toBe(true);
  });

  it("leaves notes outside the deleted paths alone (a sibling with the same prefix included)", async () => {
    await writeWorkspaceFile("proj/a.md", "A");
    await writeWorkspaceFile("project/x.md", "X saved");
    await writeWorkspaceFile("other.md", "O saved");
    open("project/x.md", "X saved");
    useAppStore.getState().setContent("X edit");
    open("other.md", "O saved");
    useAppStore.getState().setContent("O edit");
    await flushOpenDocsUnder(["proj"]);
    expect(await readWorkspaceFile("project/x.md")).toBe("X saved");
    expect(await readWorkspaceFile("other.md")).toBe("O saved");
    const s = useAppStore.getState();
    expect(s.doc.dirty).toBe(true);
    expect(s.openTabs.find((t) => t.id === "project/x.md")?.dirty).toBe(true);
  });

  it("an edit typed while the delete is in flight lands in the trashed copy, so Ctrl+Z brings it back (review: #218)", async () => {
    const { trashWithOpenEdits } = await import("../store/openDocs");
    await writeWorkspaceFile("proj/a.md", "A saved");
    await writeWorkspaceFile("proj/b.md", "B saved");
    open("proj/a.md", "A saved");
    useAppStore.getState().setContent("A edit");
    open("proj/b.md", "B saved");
    useAppStore.getState().setContent("B edit");
    const deleting = trashWithOpenEdits(["proj"], { proj: "directory" });
    // The flush has taken its snapshot and is writing: the user keeps typing.
    useAppStore.getState().setContent("B edit, typed during the delete");
    const { items, settled } = await deleting;
    expect(settled).toBe(true);
    expect(items.map((i) => i.originalPath)).toEqual(["proj"]);
    expect(useAppStore.getState().doc.dirty).toBe(false);
    expect(await workspaceHasEntry("proj")).toBe(false);
    expect(await undoLastTrash()).toEqual(["proj"]);
    expect(await readWorkspaceFile("proj/b.md")).toBe("B edit, typed during the delete");
    expect(await readWorkspaceFile("proj/a.md")).toBe("A edit");
  });

  /** Type into the open note while each of the next `times` writes of `file` is in flight. */
  async function typeDuringWrites(root: Awaited<ReturnType<typeof installFakeOpfs>>, file: string, times: number) {
    const handle = await root.getFileHandle("__probe", { create: true });
    await root.removeEntry("__probe");
    const proto = Object.getPrototypeOf(handle) as { createWritable: (this: { name: string }) => Promise<unknown> };
    const original = proto.createWritable;
    let n = 0;
    proto.createWritable = async function (this: { name: string }) {
      const w = await original.call(this);
      if (this.name === file && n < times) useAppStore.getState().setContent(`typed ${++n}`);
      return w;
    };
    return () => {
      proto.createWritable = original;
    };
  }

  it("keeps writing into the trash until the open note stops changing (review: #218)", async () => {
    const root = installFakeOpfs();
    const { trashWithOpenEdits } = await import("../store/openDocs");
    await writeWorkspaceFile("proj/b.md", "B saved");
    open("proj/b.md", "B saved");
    useAppStore.getState().setContent("B edit");
    const restore = await typeDuringWrites(root, "b.md", 3); // during the flush and two post-trash writes
    try {
      const { settled } = await trashWithOpenEdits(["proj"], { proj: "directory" });
      expect(settled).toBe(true);
      expect(useAppStore.getState().doc).toMatchObject({ content: "typed 3", dirty: false });
    } finally {
      restore();
    }
    expect(await undoLastTrash()).toEqual(["proj"]);
    expect(await readWorkspaceFile("proj/b.md")).toBe("typed 3");
  });

  it("a Trash-panel restore during the post-trash write waits for it, so the restored copy has the newest text (review: #218)", async () => {
    const root = installFakeOpfs();
    const { trashWithOpenEdits } = await import("../store/openDocs");
    await writeWorkspaceFile("proj/b.md", "B saved");
    open("proj/b.md", "B saved");
    useAppStore.getState().setContent("B edit");
    const handle = await root.getFileHandle("__probe", { create: true });
    await root.removeEntry("__probe");
    const proto = Object.getPrototypeOf(handle) as { createWritable: (this: { name: string }) => Promise<unknown> };
    const original = proto.createWritable;
    let restoring: Promise<string> | null = null;
    let typed = false;
    proto.createWritable = async function (this: { name: string }) {
      if (this.name === "b.md" && !typed) {
        // The pre-trash flush: the user keeps typing, so a post-trash write follows.
        typed = true;
        useAppStore.getState().setContent("B typed during the delete");
      } else if (this.name === "b.md" && !restoring) {
        const [item] = await listTrash();
        // The first write once the folder is indexed in the trash: the Trash panel restores it now.
        if (item) {
          restoring = restoreFromTrash(item.id);
          // Give the restore its chance to run mid-write (it must wait for the queue instead).
          await Promise.race([restoring.catch(() => ""), new Promise((r) => setTimeout(r, 20))]);
        }
      }
      return original.call(this);
    };
    try {
      const { settled } = await trashWithOpenEdits(["proj"], { proj: "directory" });
      expect(settled).toBe(true);
    } finally {
      proto.createWritable = original;
    }
    expect(restoring).not.toBeNull();
    expect(await restoring).toBe("proj");
    expect(await readWorkspaceFile("proj/b.md")).toBe("B typed during the delete");
    expect(await listTrash()).toEqual([]);
    expect(await workspaceHasEntry(".trash")).toBe(true); // the index file
    const leftovers = [...(root.dirs.get(".trash")?.dirs.keys() ?? [])];
    expect(leftovers).toEqual([]); // no orphaned trashed copy
  });

  it("reports unsettled when the note changes during every write, so the tree keeps the document", async () => {
    const root = installFakeOpfs();
    const { trashWithOpenEdits } = await import("../store/openDocs");
    await writeWorkspaceFile("proj/b.md", "B saved");
    open("proj/b.md", "B saved");
    useAppStore.getState().setContent("B edit");
    const restore = await typeDuringWrites(root, "b.md", 1000);
    try {
      const { settled } = await trashWithOpenEdits(["proj"], { proj: "directory" });
      expect(settled).toBe(false);
      const doc = useAppStore.getState().doc;
      expect(doc.dirty).toBe(true); // the newest text is still held, not cleared
      expect(doc.content).toMatch(/^typed \d+$/);
      // Detached from the trashed path, so autosave can't recreate it.
      expect(doc.workspaceName).toBeNull();
      expect(useAppStore.getState().openTabs.some((t) => t.workspaceName?.startsWith("proj/"))).toBe(false);
    } finally {
      restore();
    }
  });

  it("a post-trash write that fails detaches the open note, so autosave does not recreate the deleted file (review: #218)", async () => {
    const root = installFakeOpfs();
    const { trashWithOpenEdits } = await import("../store/openDocs");
    await writeWorkspaceFile("proj/b.md", "B saved");
    open("proj/b.md", "B saved");
    useAppStore.getState().setContent("B edit");
    const handle = await root.getFileHandle("__probe", { create: true });
    await root.removeEntry("__probe");
    const proto = Object.getPrototypeOf(handle) as { createWritable: (this: { name: string }) => Promise<unknown> };
    const original = proto.createWritable;
    let writes = 0;
    proto.createWritable = async function (this: { name: string }) {
      // 1: the pre-trash flush (the user keeps typing); 2: the move's copy; 3: the post-trash write.
      if (this.name === "b.md" && ++writes === 1) useAppStore.getState().setContent("B typed during the delete");
      else if (this.name === "b.md" && writes === 3) throw new DOMException("quota", "QuotaExceededError");
      return original.call(this);
    };
    try {
      await expect(trashWithOpenEdits(["proj"], { proj: "directory" })).rejects.toThrow("quota");
    } finally {
      proto.createWritable = original;
    }
    const doc = useAppStore.getState().doc;
    expect(doc).toMatchObject({ content: "B typed during the delete", dirty: true, workspaceName: null });
    expect(useAppStore.getState().openTabs.some((t) => t.workspaceName?.startsWith("proj/"))).toBe(false);
    expect(await workspaceHasEntry("proj")).toBe(false);
    // What moved is still undoable.
    expect(await undoLastTrash()).toEqual(["proj"]);
    expect(await readWorkspaceFile("proj/b.md")).toBe("B edit"); // the pre-trash flush
  });

  it("deleting a single file saves that file's inactive tab", async () => {
    await writeWorkspaceFile("n.md", "saved");
    open("n.md", "saved");
    useAppStore.getState().setContent("recent edit");
    open("elsewhere.md", "");
    await flushOpenDocsUnder(["n.md"]);
    const items = await trashPaths(["n.md"]);
    await undoTrash(items);
    expect(await readWorkspaceFile("n.md")).toBe("recent edit");
  });
});

describe("the Ctrl+Z key handler", () => {
  function press(target: EventTarget, init: KeyboardEventInit = {}): { handled: boolean; event: KeyboardEvent } {
    const event = new KeyboardEvent("keydown", { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true, cancelable: true, ...init });
    let handled = false;
    const listener = (e: Event) => {
      handled = handleTrashUndoKey(e as KeyboardEvent);
    };
    window.addEventListener("keydown", listener);
    target.dispatchEvent(event);
    window.removeEventListener("keydown", listener);
    return { handled, event };
  }

  async function settle(): Promise<void> {
    // undoLastTrash runs in the background; wait until the stack has drained.
    for (let i = 0; i < 50 && (await listTrash()).length; i++) await new Promise((r) => setTimeout(r, 0));
  }

  it("outside an editor it restores the last delete", async () => {
    await writeWorkspaceFile("a.md", "A");
    await trashPaths(["a.md"]);
    const tree = document.createElement("aside");
    tree.className = "file-tree";
    const btn = document.createElement("button");
    tree.append(btn);
    document.body.append(tree);
    const { handled, event } = press(btn);
    expect(handled).toBe(true);
    expect(event.defaultPrevented).toBe(true);
    await settle();
    expect(await readWorkspaceFile("a.md")).toBe("A");
  });

  it("inside CodeMirror, the WYSIWYG editor, inputs, textareas and contenteditable it stays the editor's undo", async () => {
    await writeWorkspaceFile("a.md", "A");
    await trashPaths(["a.md"]);
    const cm = document.createElement("div");
    cm.className = "cm-editor";
    const cmContent = document.createElement("div");
    cm.append(cmContent);
    const pm = document.createElement("div");
    pm.className = "ProseMirror";
    const pmChild = document.createElement("p");
    pm.append(pmChild);
    const input = document.createElement("input");
    const textarea = document.createElement("textarea");
    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    const inner = document.createElement("span");
    editable.append(inner);
    document.body.append(cm, pm, input, textarea, editable);
    for (const el of [cmContent, pmChild, input, textarea, inner]) {
      expect(isEditingTarget(el)).toBe(true);
      const { handled, event } = press(el);
      expect(handled).toBe(false);
      expect(event.defaultPrevented).toBe(false);
    }
    expect(trashUndoDepth()).toBe(1);
    expect(await workspaceHasEntry("a.md")).toBe(false);
  });

  it("leaves the key alone when there is nothing to undo, when it was handled already, and for Shift+Z", async () => {
    expect(press(document.body).handled).toBe(false);
    await writeWorkspaceFile("a.md", "A");
    await trashPaths(["a.md"]);
    expect(press(document.body, { shiftKey: true }).handled).toBe(false);
    const stopper = (e: Event) => e.preventDefault();
    document.body.addEventListener("keydown", stopper);
    expect(press(document.body).handled).toBe(false);
    document.body.removeEventListener("keydown", stopper);
    expect(trashUndoDepth()).toBe(1);
  });

  it("matches ⌘Z and the physical Z key on a Hebrew layout, not AZERTY's W position", () => {
    const ev = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);
    expect(isUndoKey(ev({ key: "z", code: "KeyZ", metaKey: true }))).toBe(true);
    expect(isUndoKey(ev({ key: "Z", code: "KeyZ", ctrlKey: true }))).toBe(true);
    expect(isUndoKey(ev({ key: "ז", code: "KeyZ", ctrlKey: true }))).toBe(true);
    expect(isUndoKey(ev({ key: "z", code: "KeyW", ctrlKey: true }))).toBe(true); // AZERTY's Z
    expect(isUndoKey(ev({ key: "w", code: "KeyZ", ctrlKey: true }))).toBe(false); // AZERTY's W
    expect(isUndoKey(ev({ key: "z", code: "KeyZ" }))).toBe(false);
    expect(isUndoKey(ev({ key: "z", code: "KeyZ", ctrlKey: true, altKey: true }))).toBe(false);
  });
});

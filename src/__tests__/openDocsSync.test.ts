/**
 * T46 review fixes: open notes follow moves (folder renames included) and
 * get the same link rewrite as the files on disk; unsaved edits are written
 * before the note is trashed or exported.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installFakeOpfs } from "./helpers/fakeOpfs";
import { useAppStore } from "../store/useStore";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { safeMove, trashPaths, undoTrash } from "../storage/fileOps";
import { flushActiveWorkspaceDoc, syncOpenDocsAfterMove } from "../store/openDocs";

beforeEach(() => {
  installFakeOpfs();
  useAppStore.setState({ doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null }, openTabs: [] });
});

function open(path: string, content: string) {
  useAppStore.getState().openTab({ name: path, content, workspaceName: path });
}

describe("syncOpenDocsAfterMove", () => {
  it("detaches an open note whose path a move overwrote, so it can't write over the moved note (review: #194)", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    open("b.md", "B");
    useAppStore.getState().setContent("B edited"); // unsaved, then the user switches away
    open("a.md", "A");
    const r = await safeMove("a.md", "b.md", { confirmReplace: async () => true });
    expect(r?.replaced?.originalPath).toBe("b.md");
    syncOpenDocsAfterMove("a.md", r!.path, r!.rewrite, r!.replaced?.originalPath);
    const s = useAppStore.getState();
    expect(s.doc).toMatchObject({ workspaceName: "b.md", content: "A" });
    const ids = s.openTabs.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length); // no two tabs claim one path
    const old = s.openTabs.find((t) => t.content === "B edited");
    expect(old).toMatchObject({ workspaceName: null, dirty: true }); // kept, unsaved edits included
    expect(old!.id).not.toBe("b.md");
  });

  it("detaches the active note when it is the one overwritten", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    open("a.md", "A");
    open("b.md", "B");
    const r = await safeMove("a.md", "b.md", { confirmReplace: async () => true });
    syncOpenDocsAfterMove("a.md", r!.path, r!.rewrite, r!.replaced?.originalPath);
    const s = useAppStore.getState();
    expect(s.doc.workspaceName).toBeNull();
    expect(s.doc.content).toBe("B");
    expect(s.openTabs.find((t) => t.workspaceName === "b.md")?.content).toBe("A");
    expect(s.openTabs.filter((t) => t.id === s.doc.name)).toHaveLength(1);
  });

  it("retargets the active note when its folder is renamed", async () => {
    await writeWorkspaceFile("proj/a.md", "A");
    open("proj/a.md", "A");
    const r = await safeMove("proj", "work", { folder: true });
    syncOpenDocsAfterMove("proj", r!.path, r!.rewrite);
    const s = useAppStore.getState();
    expect(s.doc.workspaceName).toBe("work/a.md");
    expect(s.doc.name).toBe("work/a.md");
    expect(s.openTabs.map((t) => t.id)).toEqual(["work/a.md"]);
  });

  it("puts rewritten links into open tabs, keeping unsaved edits", async () => {
    await writeWorkspaceFile("Target.md", "# T");
    await writeWorkspaceFile("a.md", "[[Target]]");
    await writeWorkspaceFile("b.md", "[[Target]]");
    open("a.md", "[[Target]]");
    open("b.md", "[[Target]]");
    useAppStore.getState().setContent("[[Target]] typing");
    const r = await safeMove("Target.md", "Renamed.md");
    syncOpenDocsAfterMove("Target.md", r!.path, r!.rewrite);
    const s = useAppStore.getState();
    expect(s.doc.content).toBe("[[Renamed]] typing");
    expect(s.doc.dirty).toBe(true);
    expect(s.openTabs.find((t) => t.id === "a.md")?.content).toBe("[[Renamed]]");
    expect(await readWorkspaceFile("a.md")).toBe("[[Renamed]]");
  });
});

describe("flushActiveWorkspaceDoc", () => {
  it("writes unsaved edits so trashing and Undo keep them", async () => {
    await writeWorkspaceFile("n.md", "saved");
    open("n.md", "saved");
    useAppStore.getState().setContent("saved + recent edit");
    await flushActiveWorkspaceDoc();
    expect(useAppStore.getState().doc.dirty).toBe(false);
    const items = await trashPaths(["n.md"]);
    await undoTrash(items);
    expect(await readWorkspaceFile("n.md")).toBe("saved + recent edit");
  });

  it("does nothing for a clean or non-workspace document", async () => {
    useAppStore.setState({ doc: { name: "Scratch.md", content: "x", dirty: true, workspaceName: null } });
    await flushActiveWorkspaceDoc();
    expect(useAppStore.getState().doc.dirty).toBe(true);
  });
});

describe("tab runtime follows id changes (review: #206)", () => {
  it("a detached (overwritten) tab keeps its load id and disk handle under its new id", async () => {
    const { __tabRuntime } = await import("../store/useStore");
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    open("b.md", "B");
    open("a.md", "A"); // b.md's runtime is saved when switching away
    const before = __tabRuntime().get("b.md");
    expect(before?.loadId).toBeDefined();
    const r = await safeMove("a.md", "b.md", { confirmReplace: async () => true });
    syncOpenDocsAfterMove("a.md", r!.path, r!.rewrite, r!.replaced?.originalPath);
    const detached = useAppStore.getState().openTabs.find((t) => t.content === "B")!;
    expect(detached.id).not.toBe("b.md");
    expect(__tabRuntime().get(detached.id)).toEqual(before);
  });

  it("remaps colliding ids atomically: the moved tab and the overwritten one each keep their own runtime (review: #206)", async () => {
    const { __tabRuntime } = await import("../store/useStore");
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("b.md", "B");
    await writeWorkspaceFile("c.md", "C");
    open("a.md", "A"); // the source comes before the target in openTabs
    useAppStore.getState().setContent("A edited"); // unsaved
    open("b.md", "B");
    open("c.md", "C"); // both a.md and b.md are inactive, their runtimes stored
    const rtA = __tabRuntime().get("a.md");
    const rtB = __tabRuntime().get("b.md");
    expect(rtA?.loadId).toBeDefined();
    expect(rtA).not.toEqual(rtB);
    const r = await safeMove("a.md", "b.md", { confirmReplace: async () => true });
    syncOpenDocsAfterMove("a.md", r!.path, r!.rewrite, r!.replaced?.originalPath);
    const tabs = useAppStore.getState().openTabs;
    const moved = tabs.find((t) => t.content === "A edited")!;
    const detached = tabs.find((t) => t.content === "B")!;
    expect(moved.id).toBe("b.md");
    expect(__tabRuntime().get("b.md")).toEqual(rtA);
    expect(__tabRuntime().get(detached.id)).toEqual(rtB);
    // Selecting the moved tab keeps its unsaved state (the sameLoad check passes).
    useAppStore.getState().openTab({ name: "b.md", content: moved.content, workspaceName: "b.md" });
    expect(useAppStore.getState().doc).toMatchObject({ workspaceName: "b.md", content: "A edited", dirty: true });
  });

  it("a detached tab never takes the id of an active document that is outside openTabs (review: #206)", async () => {
    await writeWorkspaceFile("a.md", "A");
    await writeWorkspaceFile("dir/foo.md", "F");
    open("dir/foo.md", "F");
    useAppStore.getState().setContent("F edited"); // unsaved
    open("a.md", "A");
    // An ad-hoc foo.md opened with setDoc: active, but not in openTabs.
    useAppStore.setState({ doc: { name: "foo.md", content: "external", dirty: false, workspaceName: null } });
    expect(useAppStore.getState().openTabs.some((t) => t.id === "foo.md")).toBe(false);
    const r = await safeMove("a.md", "dir/foo.md", { confirmReplace: async () => true });
    syncOpenDocsAfterMove("a.md", r!.path, r!.rewrite, r!.replaced?.originalPath);
    const detached = useAppStore.getState().openTabs.find((t) => t.content === "F edited")!;
    expect(detached.workspaceName).toBeNull();
    expect(detached.id).not.toBe("foo.md");
    useAppStore.getState().setContent("external, edited");
    expect(useAppStore.getState().openTabs.find((t) => t.id === detached.id)?.content).toBe("F edited");
  });

  it("moveTabRuntimes reads every source before writing any target", async () => {
    const { __tabRuntime, moveTabRuntimes } = await import("../store/useStore");
    useAppStore.getState().openTab({ name: "x.md", content: "X", workspaceName: null });
    useAppStore.getState().openTab({ name: "y.md", content: "Y", workspaceName: null });
    useAppStore.getState().openTab({ name: "z.md", content: "Z", workspaceName: null });
    const rx = __tabRuntime().get("x.md");
    const ry = __tabRuntime().get("y.md");
    moveTabRuntimes([["x.md", "y.md"], ["y.md", "w.md"]]);
    expect(__tabRuntime().get("y.md")).toEqual(rx);
    expect(__tabRuntime().get("w.md")).toEqual(ry);
    expect(__tabRuntime().has("x.md")).toBe(false);
  });

  it("adopting an ad-hoc note into the workspace moves its runtime entry", async () => {
    const { __tabRuntime } = await import("../store/useStore");
    useAppStore.getState().openTab({ name: "Scratch.md", content: "S", workspaceName: null });
    useAppStore.getState().openTab({ name: "x.md", content: "X", workspaceName: null });
    useAppStore.getState().openTab({ name: "Scratch.md", content: "S", workspaceName: null });
    const rt = __tabRuntime().get("Scratch.md");
    useAppStore.getState().adoptWorkspaceName("notes/Scratch.md");
    expect(__tabRuntime().get("notes/Scratch.md")).toEqual(rt);
    expect(__tabRuntime().has("Scratch.md")).toBe(false);
  });
});

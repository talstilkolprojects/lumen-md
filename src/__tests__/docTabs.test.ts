/**
 * Tests for the multi-document tab actions in `useAppStore`.
 *
 * Covers:
 *   - openTab pushes new tabs and switches focus
 *   - re-opening an active tab is idempotent (no duplicates)
 *   - closeTab removes the tab and falls back to the neighbour
 *   - reorderTabs handles drag-source / drag-target index pairs
 *   - tabIdOf produces a stable identity for both workspace & ad-hoc docs
 */

import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore, tabIdOf } from "../store/useStore";

function reset() {
  useAppStore.setState({
    doc: { name: "Untitled.md", content: "", dirty: false, workspaceName: null },
    openTabs: [],
    tagFilter: null,
  });
}

describe("tabIdOf", () => {
  it("uses workspaceName when present (unique across the vault)", () => {
    expect(tabIdOf({ workspaceName: "notes/a.md", name: "a.md" })).toBe("notes/a.md");
  });
  it("falls back to display name for ad-hoc docs", () => {
    expect(tabIdOf({ workspaceName: null, name: "Scratch.md" })).toBe("Scratch.md");
  });
  it("returns a non-empty string even for an unnamed doc", () => {
    expect(tabIdOf({ name: "" })).toBeTruthy();
  });
});

describe("openTab", () => {
  beforeEach(reset);

  it("adds a new tab to the strip and makes it active", () => {
    useAppStore.getState().openTab({ name: "first.md", content: "1", workspaceName: "first.md" });
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual(["first.md"]);
    expect(useAppStore.getState().doc.name).toBe("first.md");
  });

  it("re-opening an already-open doc is idempotent", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    expect(useAppStore.getState().doc.workspaceName).toBe("a.md");
  });

  it("preserves unsaved edits in the previous tab when switching away", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "original-A", workspaceName: "a.md" });
    // Edit
    useAppStore.getState().setContent("dirty-A");
    expect(useAppStore.getState().doc.dirty).toBe(true);
    // Switch to a new tab
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    // Switch back
    useAppStore.getState().openTab({ name: "a.md", content: "anything", workspaceName: "a.md" });
    // The dirty edit is still on the tab record (not the original content)
    const aTab = useAppStore.getState().openTabs.find((t) => t.id === "a.md");
    expect(aTab?.content).toBe("dirty-A");
    expect(aTab?.dirty).toBe(true);
  });

  it("keeps a tab's unsaved marker when the tab is focused with the text it holds", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().setContent("A edited");
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    // The tab strip focuses a tab with the text the tab holds.
    useAppStore.getState().openTab({ name: "a.md", content: "A edited", workspaceName: "a.md" });
    expect(useAppStore.getState().doc).toMatchObject({ content: "A edited", dirty: true });
  });

  it("keeps the marker of a tab restored from the last session, or changed while in the background", () => {
    // As after a reload: the tabs come back from storage with their unsaved marker.
    useAppStore.setState({
      doc: { name: "a.md", content: "A", workspaceName: "a.md", dirty: false },
      openTabs: [
        { id: "a.md", name: "a.md", content: "A", workspaceName: "a.md", dirty: false },
        { id: "b.md", name: "b.md", content: "B unsaved", workspaceName: "b.md", dirty: true },
      ],
    });
    useAppStore.getState().openTab({ name: "b.md", content: "B unsaved", workspaceName: "b.md" });
    expect(useAppStore.getState().doc).toMatchObject({ content: "B unsaved", dirty: true });
    // Opened with other text (the file on disk): that text is not the unsaved one.
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B on disk", workspaceName: "b.md" });
    expect(useAppStore.getState().doc.dirty).toBe(false);
  });
});

describe("closeTab", () => {
  beforeEach(reset);

  it("removes the tab and keeps the active doc when a non-active tab closes", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    // active is b — close a (non-active)
    useAppStore.getState().closeTab("a.md");
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual(["b.md"]);
    expect(useAppStore.getState().doc.workspaceName).toBe("b.md");
  });

  it("falls back to the neighbour when the active tab is closed", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    useAppStore.getState().openTab({ name: "c.md", content: "C", workspaceName: "c.md" });
    // active is c — close it
    useAppStore.getState().closeTab("c.md");
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual(["a.md", "b.md"]);
    // Active should fall back to b (the previous neighbour).
    expect(useAppStore.getState().doc.workspaceName).toBe("b.md");
  });

  it("resets to a blank Untitled when the last tab closes", () => {
    useAppStore.getState().openTab({ name: "only.md", content: "x", workspaceName: "only.md" });
    useAppStore.getState().closeTab("only.md");
    expect(useAppStore.getState().openTabs).toEqual([]);
    expect(useAppStore.getState().doc.name).toBe("Untitled.md");
    expect(useAppStore.getState().doc.content).toBe("");
  });

  it("is a safe no-op when given an unknown id", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().closeTab("does-not-exist");
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual(["a.md"]);
  });
});

describe("reorderTabs", () => {
  beforeEach(reset);

  it("moves a tab from one index to another", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    useAppStore.getState().openTab({ name: "c.md", content: "C", workspaceName: "c.md" });
    // Move c (index 2) to position 0 → [c, a, b]
    useAppStore.getState().reorderTabs(2, 0);
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual([
      "c.md",
      "a.md",
      "b.md",
    ]);
  });

  it("clamps an out-of-range target index to the strip length", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    useAppStore.getState().reorderTabs(0, 999);
    expect(useAppStore.getState().openTabs.map((t) => t.id)).toEqual(["b.md", "a.md"]);
  });

  it("is a no-op when fromIndex === toIndex", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: "b.md" });
    const before = useAppStore.getState().openTabs;
    useAppStore.getState().reorderTabs(0, 0);
    expect(useAppStore.getState().openTabs).toEqual(before);
  });

  it("is a no-op when fromIndex is out of range", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: "a.md" });
    const before = useAppStore.getState().openTabs;
    useAppStore.getState().reorderTabs(42, 0);
    expect(useAppStore.getState().openTabs).toEqual(before);
  });
});

describe("switching back to an open tab keeps that load (review: #194)", () => {
  beforeEach(reset);
  const select = (id: string) => {
    const tab = useAppStore.getState().openTabs.find((x) => x.id === id)!;
    useAppStore.getState().openTab({ name: tab.name, content: tab.content, workspaceName: tab.workspaceName });
  };

  it("keeps the load id, so docIdentity (live-JS approval, worker scope) survives a tab switch", async () => {
    const { docIdentity } = await import("../renderer/previewDoc");
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: null });
    const first = docIdentity(useAppStore.getState().doc);
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: null });
    select("a.md");
    expect(docIdentity(useAppStore.getState().doc)).toBe(first);
  });

  it("keeps the disk handle of a launched file, so Save still writes back", () => {
    const handle = { kind: "file", name: "x.md" } as unknown as FileSystemFileHandle;
    useAppStore.getState().openTab({ name: "x.md", content: "X", workspaceName: null, handle });
    useAppStore.getState().openTab({ name: "y.md", content: "Y", workspaceName: null });
    expect(useAppStore.getState().doc.handle).toBeUndefined();
    select("x.md");
    expect(useAppStore.getState().doc.handle).toBe(handle);
  });

  it("keeps the unsaved marker of the tab it returns to", () => {
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: null });
    useAppStore.getState().setContent("A edited");
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: null });
    select("a.md");
    expect(useAppStore.getState().doc).toMatchObject({ content: "A edited", dirty: true });
  });

  it("a different text under the same name is a new load", async () => {
    const { docIdentity } = await import("../renderer/previewDoc");
    useAppStore.getState().openTab({ name: "a.md", content: "A", workspaceName: null });
    const first = docIdentity(useAppStore.getState().doc);
    useAppStore.getState().openTab({ name: "b.md", content: "B", workspaceName: null });
    useAppStore.getState().openTab({ name: "a.md", content: "another file", workspaceName: null });
    expect(docIdentity(useAppStore.getState().doc)).not.toBe(first);
    expect(useAppStore.getState().doc.dirty).toBe(false);
  });

  it("closing the active tab restores the neighbour's handle and load", () => {
    const handle = { kind: "file", name: "x.md" } as unknown as FileSystemFileHandle;
    useAppStore.getState().openTab({ name: "x.md", content: "X", workspaceName: null, handle });
    const loadId = useAppStore.getState().doc.loadId;
    useAppStore.getState().openTab({ name: "y.md", content: "Y", workspaceName: null });
    useAppStore.getState().closeTab("y.md");
    expect(useAppStore.getState().doc).toMatchObject({ name: "x.md", handle, loadId });
  });
});

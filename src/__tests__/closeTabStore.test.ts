/**
 * Integration: closing a tab via the Zustand store removes it from
 * `openTabs` and falls back to a sensible neighbour when the closed
 * tab was active.
 *
 * The component-level DocTabs render test only verifies the click
 * handler fires onClose with the right id — but the store's
 * closeTab() implementation handles the surrounding policy: which
 * tab becomes active, whether `doc` updates, what happens when only
 * one tab is open. Round-4 M7 pins these.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore, tabIdOf } from "../store/useStore";

describe("useAppStore — closeTab integration", () => {
  beforeEach(() => {
    // Reset the persisted store to a known multi-tab shape.
    const s = useAppStore.getState();
    s.setDoc({
      name: "a.md",
      content: "# A",
      workspaceName: null,
      handle: undefined,
      dirty: false,
    });
    s.openTab({ name: "a.md", content: "# A", workspaceName: null });
    s.openTab({ name: "b.md", content: "# B", workspaceName: null });
    s.openTab({ name: "c.md", content: "# C", workspaceName: null });
    // Make sure `doc` is `a.md` (openTab on existing focuses it).
    s.openTab({ name: "a.md", content: "# A", workspaceName: null });
  });

  it("removes the tab from openTabs when closed", () => {
    const s = useAppStore.getState();
    expect(s.openTabs.map((t) => t.name)).toEqual(["a.md", "b.md", "c.md"]);
    s.closeTab("b.md");
    expect(useAppStore.getState().openTabs.map((t) => t.name)).toEqual([
      "a.md",
      "c.md",
    ]);
  });

  it("does not change `doc` when the closed tab was not active", () => {
    const s = useAppStore.getState();
    expect(tabIdOf(s.doc)).toBe("a.md");
    s.closeTab("c.md");
    expect(tabIdOf(useAppStore.getState().doc)).toBe("a.md");
  });

  it("falls back to a neighbour when the active tab is closed", () => {
    const s = useAppStore.getState();
    expect(tabIdOf(s.doc)).toBe("a.md");
    s.closeTab("a.md");
    const after = useAppStore.getState();
    // Surviving tabs shouldn't include a.md, and `doc` must point at
    // one of the surviving tabs.
    expect(after.openTabs.map((t) => t.name)).not.toContain("a.md");
    expect(["b.md", "c.md"]).toContain(tabIdOf(after.doc));
  });

  it("falls back to a fresh Untitled doc when closing the last tab", () => {
    const s = useAppStore.getState();
    s.closeTab("b.md");
    s.closeTab("c.md");
    s.closeTab("a.md");
    const after = useAppStore.getState();
    expect(after.openTabs).toEqual([]);
    expect(after.doc.name).toMatch(/Untitled/);
    expect(after.doc.content).toBe("");
  });

  it("ignores a closeTab call for an unknown id (no-op)", () => {
    const s = useAppStore.getState();
    const before = s.openTabs.map((t) => t.name);
    s.closeTab("does-not-exist.md");
    expect(useAppStore.getState().openTabs.map((t) => t.name)).toEqual(before);
  });
});

describe("useAppStore — adoptWorkspaceName", () => {
  it("moves the active ad-hoc doc and its tab to the workspace identity", () => {
    const s = useAppStore.getState();
    s.openTab({ name: "Untitled.md", content: "# draft", workspaceName: null });
    s.setContent("# draft, edited");
    expect(useAppStore.getState().doc.dirty).toBe(true);
    expect(useAppStore.getState().openTabs.some((t) => t.id === "Untitled.md")).toBe(true);

    useAppStore.getState().adoptWorkspaceName("Untitled 2.md");

    const after = useAppStore.getState();
    expect(after.doc).toMatchObject({ name: "Untitled 2.md", workspaceName: "Untitled 2.md", dirty: false, content: "# draft, edited" });
    expect(after.doc.handle).toBeUndefined();
    // The tab followed: same slot, new id, clean — no orphan under the old id.
    const tab = after.openTabs.find((t) => t.id === "Untitled 2.md");
    expect(tab).toMatchObject({ name: "Untitled 2.md", workspaceName: "Untitled 2.md", dirty: false, content: "# draft, edited" });
    expect(after.openTabs.some((t) => t.id === "Untitled.md")).toBe(false);
    expect(tabIdOf(after.doc)).toBe("Untitled 2.md");
  });

  it("leaves the other tabs alone", () => {
    const s = useAppStore.getState();
    const others = s.openTabs.filter((t) => t.id !== tabIdOf(s.doc)).map((t) => t.id);
    s.adoptWorkspaceName("adopted.md");
    const after = useAppStore.getState().openTabs.filter((t) => t.id !== "adopted.md").map((t) => t.id);
    expect(after).toEqual(others);
  });
});

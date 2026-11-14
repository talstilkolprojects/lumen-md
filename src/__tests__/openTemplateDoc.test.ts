import { describe, it, expect, beforeEach } from "vitest";
import { useAppStore } from "../store/useStore";
import { openNewDoc, openTemplateDoc } from "../commands/useCommands";

describe("openTemplateDoc", () => {
  beforeEach(() => {
    useAppStore.setState({ openTabs: [], doc: { name: "Welcome.md", content: "", dirty: false } });
    useAppStore.getState().openTab({ name: "Draft.md", content: "my unsaved work", workspaceName: null });
    useAppStore.getState().setDoc({ content: "my unsaved work, edited", dirty: true });
  });

  it("opens the template in a new dirty tab without touching the active document", () => {
    openTemplateDoc("Meeting notes", "# Meeting");
    const s = useAppStore.getState();
    expect(s.doc).toMatchObject({ name: "Meeting notes.md", content: "# Meeting", dirty: true });
    expect(s.openTabs.find((t) => t.id === "Draft.md")).toMatchObject({ content: "my unsaved work, edited", dirty: true });
    expect(s.openTabs.map((t) => t.id)).toEqual(["Draft.md", "Meeting notes.md"]);
  });

  it("never reuses an open tab of the same name", () => {
    openTemplateDoc("Meeting notes", "# One");
    openTemplateDoc("Meeting notes", "# Two");
    const s = useAppStore.getState();
    expect(s.doc).toMatchObject({ name: "Meeting notes 2.md", content: "# Two" });
    expect(s.openTabs.find((t) => t.id === "Meeting notes.md")?.content).toBe("# One");
  });

  it("keeps an active document that has no tab", () => {
    useAppStore.setState({ openTabs: [], doc: { name: "Renamed.md", content: "keep me", dirty: true } });
    openTemplateDoc("Blank", "");
    expect(useAppStore.getState().openTabs.find((t) => t.id === "Renamed.md")).toMatchObject({ content: "keep me", dirty: true });
  });
});

describe("openNewDoc (share target, New Document shortcut)", () => {
  beforeEach(() => {
    useAppStore.setState({ openTabs: [], doc: { name: "Welcome.md", content: "", dirty: false } });
  });

  it("two shares with the same title stay two notes", () => {
    openNewDoc("example.org", "# first share", true);
    openNewDoc("example.org", "# second share", true);
    const s = useAppStore.getState();
    expect(s.doc).toMatchObject({ name: "example.org 2.md", content: "# second share", dirty: true });
    expect(s.openTabs.find((t) => t.id === "example.org.md")?.content).toBe("# first share");
  });

  it("New Document never lands on an existing Untitled tab with edits", () => {
    useAppStore.getState().openTab({ name: "Untitled.md", content: "", workspaceName: null });
    useAppStore.getState().setDoc({ content: "my edits", dirty: true });
    openNewDoc("Untitled", "", false);
    const s = useAppStore.getState();
    expect(s.doc).toMatchObject({ name: "Untitled 2.md", content: "", dirty: false });
    useAppStore.getState().setDoc({ content: "typed in the new one" });
    expect(s.openTabs.find((t) => t.id === "Untitled.md")).toMatchObject({ content: "my edits", dirty: true });
  });
});

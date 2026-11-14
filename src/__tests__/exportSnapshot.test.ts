/** Export commands export the note they were invoked on, even if the tab changes while the export chunk loads. */
import { describe, it, expect, vi } from "vitest";
import { renderHook } from "@testing-library/react";

const exported = vi.hoisted(() => ({ docx: [] as Array<[string, string]>, text: [] as Array<[string, string]> }));
const gate = vi.hoisted(() => {
  let release!: () => void;
  const ready = new Promise<void>((r) => (release = r));
  return { ready, release: () => release() };
});
vi.mock("../storage/exportDocx", async () => {
  await gate.ready; // the lazy chunk is still loading
  return { exportToDocx: vi.fn(async (content: string, name: string) => void exported.docx.push([content, name])) };
});
vi.mock("../storage/exportFormats", async (orig) => {
  await gate.ready;
  return { ...(await orig<object>()), downloadText: vi.fn((name: string, content: string) => void exported.text.push([name, content])) };
});

import { useCommands, type UseCommandsOptions } from "../commands/useCommands";
import { useAppStore } from "../store/useStore";

const noop = () => {};
const options = { handleNew: noop, handleOpen: noop, handleSave: noop, handleExportHtml: noop, handleSaveToWorkspace: noop, insertSnippet: noop, recents: [], setRecents: noop, handleReopenRecent: noop, collab: null, handleStartCollab: noop, handleStopCollab: noop, setSearchOpen: noop, setFindReplaceOpen: noop, setGraphOpen: noop, setHistoryOpen: noop, setTableEditorOpen: noop, setCanvasOpen: noop, setGalleryOpen: noop } as UseCommandsOptions;

describe("lazy export commands", () => {
  it("snapshot the document before awaiting the export chunk", async () => {
    useAppStore.setState({ doc: { ...useAppStore.getState().doc, name: "first.md", content: "# First" } });
    const { result } = renderHook(() => useCommands(options));
    const run = (id: string) => Promise.resolve(result.current.find((c) => c.id === id)!.action());
    const docx = run("file.exportDocx");
    const rtf = run("file.exportRtf");
    // The user switches tabs while the chunks load.
    useAppStore.setState({ doc: { ...useAppStore.getState().doc, name: "second.md", content: "# Second" } });
    gate.release();
    await Promise.all([docx, rtf]);
    expect(exported.docx).toEqual([["# First", "first.md"]]);
    expect(exported.text[0][0]).toBe("first.rtf");
    expect(exported.text[0][1]).toContain("First");
    expect(exported.text[0][1]).not.toContain("Second");
  });
});

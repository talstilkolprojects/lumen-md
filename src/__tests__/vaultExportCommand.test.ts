/**
 * "Export vault" command (T47 review fixes): the folder picker is called on
 * `window` (a WebIDL method — Illegal invocation otherwise), and edits the
 * debounced autosave has not written yet are in the export.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { installFakeOpfs, FakeDir } from "./helpers/fakeOpfs";
import { writeWorkspaceFile } from "../storage/workspace";
import { useAppStore } from "../store/useStore";
import { unzip } from "../storage/zip";

const select = vi.fn();
vi.mock("../ui/PromptDialog", async (orig) => ({ ...(await orig<object>()), uiSelect: (...a: unknown[]) => select(...a) }));
const toast = vi.fn();
vi.mock("../ui/AiToast", async (orig) => ({ ...(await orig<object>()), showAiToast: (...a: unknown[]) => toast(...a) }));
const download = vi.fn();
vi.mock("../storage/exportFormats", async (orig) => ({ ...(await orig<object>()), downloadBytes: (...a: unknown[]) => download(...a) }));

import { useCommands, type UseCommandsOptions } from "../commands/useCommands";

function options(): UseCommandsOptions {
  const noop = () => {};
  return {
    handleNew: noop, handleOpen: noop, handleSave: noop, handleExportHtml: noop, handleSaveToWorkspace: noop,
    insertSnippet: noop, recents: [], setRecents: noop, handleReopenRecent: noop, collab: null,
    handleStartCollab: noop, handleStopCollab: noop, setSearchOpen: noop, setFindReplaceOpen: noop,
    setGraphOpen: noop, setHistoryOpen: noop, setTableEditorOpen: noop, setCanvasOpen: noop, setGalleryOpen: noop,
  };
}

async function runExport() {
  const { result } = renderHook(() => useCommands(options()));
  await result.current.find((c) => c.id === "vault.export")!.action();
}

beforeEach(async () => {
  installFakeOpfs();
  select.mockReset();
  toast.mockReset();
  download.mockReset();
  await writeWorkspaceFile("n.md", "saved");
  useAppStore.setState({ doc: { name: "n.md", content: "saved + unsaved edit", dirty: true, workspaceName: "n.md" }, openTabs: [] });
});

afterEach(() => {
  delete (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker;
});

describe("vault.export", () => {
  it("calls showDirectoryPicker on window and exports the latest text", async () => {
    const out = new FakeDir("out");
    (window as unknown as { showDirectoryPicker: unknown }).showDirectoryPicker = function (this: unknown) {
      if (this !== window) return Promise.reject(new TypeError("Illegal invocation"));
      return Promise.resolve(out);
    };
    select.mockResolvedValue("folder");
    await runExport();
    expect(toast.mock.calls[0]?.[1]).toBe("info");
    const [[folder]] = [[...out.dirs.keys()]];
    const file = await (await out.getDirectoryHandle(folder)).getFileHandle("n.md");
    expect(await (await file.getFile()).text()).toBe("saved + unsaved edit");
  });

  it("the zip includes edits still waiting for autosave", async () => {
    await runExport();
    const bytes = download.mock.calls[0][1] as Uint8Array;
    const back = await unzip(bytes.buffer as ArrayBuffer);
    expect(new TextDecoder().decode(back.get("n.md"))).toBe("saved + unsaved edit");
  });
});

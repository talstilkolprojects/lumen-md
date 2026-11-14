/** "Voice dictation" loads the dictation module on use and starts it in the chosen language. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const dialogs = vi.hoisted(() => ({ prompt: null as string | null }));
vi.mock("../ui/PromptDialog", () => ({
  uiAlert: vi.fn(),
  uiConfirm: vi.fn(async () => true),
  uiPrompt: vi.fn(async () => dialogs.prompt),
  uiSelect: vi.fn(),
}));
const started = vi.hoisted(() => [] as string[]);
vi.mock("../ui/VoiceDictation", () => ({
  startVoiceRecording: (lang: string) => void started.push(lang),
  startVoiceMemo: vi.fn(async () => {}),
}));

import { useCommands, type UseCommandsOptions } from "../commands/useCommands";
import { useAppStore } from "../store/useStore";

const noop = () => {};
const options = { handleNew: noop, handleOpen: noop, handleSave: noop, handleExportHtml: noop, handleSaveToWorkspace: noop, insertSnippet: noop, recents: [], setRecents: noop, handleReopenRecent: noop, collab: null, handleStartCollab: noop, handleStopCollab: noop, setSearchOpen: noop, setFindReplaceOpen: noop, setGraphOpen: noop, setHistoryOpen: noop, setTableEditorOpen: noop, setCanvasOpen: noop, setGalleryOpen: noop } as UseCommandsOptions;

const dictate = async () => {
  const { result } = renderHook(() => useCommands(options));
  await result.current.find((c) => c.id === "voice.dictate")!.action();
};

describe("voice dictation command", () => {
  beforeEach(() => {
    started.length = 0;
    useAppStore.setState({ locale: "en" });
  });

  it("starts in the language picked", async () => {
    dialogs.prompt = "Hebrew (עברית)";
    await dictate();
    expect(started).toEqual(["he-IL"]);
  });

  it("falls back to the UI language when the prompt is cancelled", async () => {
    dialogs.prompt = null;
    useAppStore.setState({ locale: "he" });
    await dictate();
    expect(started).toEqual(["he-IL"]);
    useAppStore.setState({ locale: "en" });
    await dictate();
    expect(started).toEqual(["he-IL", "en-US"]);
  });
});

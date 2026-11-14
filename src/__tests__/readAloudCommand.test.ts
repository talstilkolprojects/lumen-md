/** "Read aloud" claims the reading before waiting for the voice list, so a second press stops it instead of starting a second reading. */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

vi.mock("../ui/AiToast", () => ({ showAiToast: vi.fn() }));
vi.mock("../ui/PromptDialog", () => ({ uiAlert: vi.fn(), uiConfirm: vi.fn(async () => false), uiPrompt: vi.fn(), uiSelect: vi.fn() }));

import { useCommands, type UseCommandsOptions } from "../commands/useCommands";
import { useAppStore } from "../store/useStore";
import { __resetTts, isSpeaking } from "../ai/tts";

const noop = () => {};
const options = { handleNew: noop, handleOpen: noop, handleSave: noop, handleExportHtml: noop, handleSaveToWorkspace: noop, insertSnippet: noop, recents: [], setRecents: noop, handleReopenRecent: noop, collab: null, handleStartCollab: noop, handleStopCollab: noop, setSearchOpen: noop, setFindReplaceOpen: noop, setGraphOpen: noop, setHistoryOpen: noop, setTableEditorOpen: noop, setCanvasOpen: noop, setGalleryOpen: noop } as UseCommandsOptions;

type V = Pick<SpeechSynthesisVoice, "name" | "lang" | "localService">;
const voices: V[] = [{ name: "Samantha", lang: "en-US", localService: true }];
let listVoices: () => V[] = () => voices;
const voiceListeners = new Set<() => void>();
const spoken: string[] = [];

beforeEach(() => {
  localStorage.clear();
  __resetTts();
  spoken.length = 0;
  voiceListeners.clear();
  listVoices = () => voices;
  vi.stubGlobal("SpeechSynthesisUtterance", class {
    text: string;
    lang = "";
    voice: V | null = null;
    rate = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  });
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: {
      getVoices: () => listVoices(),
      addEventListener: (_: string, f: () => void) => voiceListeners.add(f),
      removeEventListener: (_: string, f: () => void) => voiceListeners.delete(f),
      cancel: () => {},
      speak: (u: { text: string; onend: () => void }) => {
        spoken.push(u.text);
        u.onend();
      },
    },
  });
  useAppStore.getState().setContent("Hello there. How are you.");
});

const readAloud = () => {
  const { result } = renderHook(() => useCommands(options));
  return Promise.resolve(result.current.find((c) => c.id === "note.read")!.action());
};

describe("Read aloud while the voice list is still loading", () => {
  it("a second press stops the pending reading instead of starting another", async () => {
    listVoices = () => []; // a fresh page: no voices until voiceschanged
    const first = readAloud();
    await vi.waitFor(() => expect(voiceListeners.size).toBe(1)); // the first press is waiting for voices
    const second = readAloud(); // the second press
    await new Promise((r) => setTimeout(r, 20));
    listVoices = () => voices;
    for (const f of [...voiceListeners]) f();
    await Promise.all([first, second]);
    expect(spoken).toEqual([]); // stopped: neither press reads, and the two never overlap
    expect(isSpeaking()).toBe(false);
  });

  it("a single press reads the note once the voices arrive", async () => {
    listVoices = () => [];
    const first = readAloud();
    await vi.waitFor(() => expect(voiceListeners.size).toBe(1));
    listVoices = () => voices;
    for (const f of [...voiceListeners]) f();
    await first;
    expect(spoken).toEqual(["Hello there.", "How are you."]);
    expect(isSpeaking()).toBe(false);
  });
});

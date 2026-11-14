/**
 * T55 — every AI command is registered for cancellation: Esc / "AI: Cancel"
 * (cancelAllAi) aborts the request the command is waiting on, and the
 * command ends quietly instead of reporting an error.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";

const toasts: Array<[string, string]> = [];
vi.mock("../ui/AiToast", () => ({ showAiToast: (m: string, kind: string) => toasts.push([m, kind]) }));
const dialogs = vi.hoisted(() => ({ prompt: "" as string | null, select: "build" as string | null }));
vi.mock("../ui/PromptDialog", () => ({
  uiAlert: vi.fn(),
  uiConfirm: vi.fn(async () => true),
  uiPrompt: vi.fn(async () => dialogs.prompt),
  uiSelect: vi.fn(async () => dialogs.select),
}));
const para = "This is a long paragraph of my own writing, with enough words in it to count as prose for the style sample. ".repeat(4);
// The stylist reads the notes through the runtime's list_files + read_file (5.3.3).
vi.mock("../storage/workspace", async (orig) => ({
  ...(await orig<object>()),
  isOPFSAvailable: () => true,
  listWorkspace: async () => ["a.md", "b.md"].map((path) => ({ path, name: path, size: 1, modified: 1 })),
  readWorkspaceFile: async () => `${para}\n\n${para}`,
}));
const seen = vi.hoisted(() => ({ signals: [] as Array<AbortSignal | undefined> }));
vi.mock("../agents/runtime", async (orig) => ({
  ...(await orig<object>()),
  // Every agent call hangs until its signal aborts — as a slow model would.
  runAgentOrThrow: (_d: unknown, _i: unknown, o: { signal?: AbortSignal } = {}) => {
    seen.signals.push(o.signal);
    return new Promise((_, reject) => {
      if (!o.signal) return; // unregistered: would hang forever
      o.signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });
  },
}));

vi.mock("../sync/git", async (orig) => ({
  ...(await orig<object>()),
  gitStatusSummary: vi.fn(async () => ({ entries: [{ path: "a.md", state: "modified" }] })),
}));

import { useCommands, type UseCommandsOptions } from "../commands/useCommands";
import { __resetAiAbort, aiBusy, aiOperation, cancelAllAi } from "../ai/aiAbort";
import { generateAiCommitMessage } from "../ai/commands";
import { useAppStore } from "../store/useStore";

const noop = () => {};
const options = { handleNew: noop, handleOpen: noop, handleSave: noop, handleExportHtml: noop, handleSaveToWorkspace: noop, insertSnippet: noop, recents: [], setRecents: noop, handleReopenRecent: noop, collab: null, handleStartCollab: noop, handleStopCollab: noop, setSearchOpen: noop, setFindReplaceOpen: noop, setGraphOpen: noop, setHistoryOpen: noop, setTableEditorOpen: noop, setCanvasOpen: noop, setGalleryOpen: noop } as UseCommandsOptions;

async function cancelsCleanly(id: string | ((id: string) => boolean)) {
  const { result } = renderHook(() => useCommands(options));
  const cmd = result.current.find((c) => (typeof id === "string" ? c.id === id : id(c.id)));
  expect(cmd, String(id)).toBeTruthy();
  const done = Promise.resolve(cmd!.action());
  await vi.waitFor(() => expect(seen.signals.length).toBeGreaterThan(0), { timeout: 10_000 });
  expect(seen.signals[0]).toBeInstanceOf(AbortSignal);
  expect(aiBusy()).toBe(true);
  expect(cancelAllAi()).toBe(1);
  await done;
  expect(seen.signals[0]!.aborted).toBe(true);
  expect(toasts.filter(([, kind]) => kind === "error")).toEqual([]);
}

describe("AI commands are cancellable", () => {
  beforeEach(() => {
    __resetAiAbort();
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only"); // grammar goes to the local proofreader
    toasts.length = 0;
    seen.signals.length = 0;
    dialogs.prompt = "";
    dialogs.select = "build";
    useAppStore.getState().setContent(`# Notes\n\n${para}\n\nline\nline\nline\nline\nline\n`);
  });

  it("AI: Create Product", async () => {
    dialogs.prompt = "A todo app";
    await cancelsCleanly("ai.productAgent");
  });
  it("style profile", () => cancelsCleanly("ai.styleProfile"));
  it("grammar check", () => cancelsCleanly("tools.checkGrammar"));
  it("prompt templates", () => cancelsCleanly((id) => id.startsWith("ai.prompt.")));
  it("outline", () => cancelsCleanly("ai.outline"));
  it("commit message suggestion: cancelled quietly", async () => {
    const op = aiOperation();
    const p = generateAiCommitMessage("repo", op.signal);
    await vi.waitFor(() => expect(seen.signals).toHaveLength(1));
    expect(seen.signals[0]).toBe(op.signal);
    cancelAllAi();
    await expect(p).resolves.toBe("");
    expect(toasts).toEqual([]);
  });
});

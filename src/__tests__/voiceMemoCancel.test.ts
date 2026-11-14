/** Esc / "AI: Cancel" during the memo summary inserts nothing, even when chat() turns the abort into "". */
import { describe, it, expect, vi, beforeEach } from "vitest";

const toasts: Array<[string, string]> = [];
vi.mock("../ui/AiToast", () => ({ showAiToast: (m: string, kind: string) => toasts.push([m, kind]) }));
const ai = vi.hoisted(() => ({ cancelDuringSummary: false }));
vi.mock("../ai/transcribe", async (orig) => {
  const { cancelAllAi } = await import("../ai/aiAbort");
  return {
    ...(await orig<object>()),
    transcribe: vi.fn(async () => ({ text: "hello from the memo", backend: "cloud", ms: 5 })),
    // Like chat() with OpenAI: an aborted request resolves to "" instead of throwing.
    summarizeMemo: vi.fn(async (_text: string, signal?: AbortSignal) => {
      if (ai.cancelDuringSummary) cancelAllAi(); // the user presses Esc while the summary is in flight
      return signal?.aborted ? "" : "• the gist";
    }),
  };
});

import { startVoiceMemo } from "../ui/VoiceDictation";
import { summarizeMemo } from "../ai/transcribe";
import { aiBusy } from "../ai/aiAbort";
import { useAppStore } from "../store/useStore";

let recorder: FakeRecorder | null = null;
class FakeRecorder extends EventTarget {
  static isTypeSupported = () => false;
  mimeType = "audio/webm";
  constructor() {
    super();
    recorder = this;
  }
  start() {}
  stop() {
    const data = new Event("dataavailable") as Event & { data: Blob };
    data.data = new Blob(["audio"], { type: "audio/webm" });
    this.dispatchEvent(data);
    this.dispatchEvent(new Event("stop"));
  }
}

beforeEach(() => {
  toasts.length = 0;
  recorder = null;
  ai.cancelDuringSummary = false;
  vi.mocked(summarizeMemo).mockClear();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) },
  });
  useAppStore.getState().setContent("# Note\n");
});

async function recordAndStop(): Promise<void> {
  await startVoiceMemo();
  expect(recorder).not.toBeNull();
  recorder!.stop();
  await vi.waitFor(() => expect(summarizeMemo).toHaveBeenCalled());
  await vi.waitFor(() => expect(aiBusy()).toBe(false));
  await new Promise((r) => setTimeout(r, 0));
}

describe("voice memo cancellation", () => {
  it("a summary cancelled in flight leaves the note untouched", async () => {
    ai.cancelDuringSummary = true;
    await recordAndStop();
    expect(useAppStore.getState().doc.content).toBe("# Note\n");
    expect(toasts.some(([, kind]) => kind === "success")).toBe(false);
  });

  it("an uncancelled memo is inserted with its summary", async () => {
    await recordAndStop();
    const content = useAppStore.getState().doc.content;
    expect(content).toContain("hello from the memo");
    expect(content).toContain("• the gist");
    expect(toasts.at(-1)?.[1]).toBe("success");
  });
});

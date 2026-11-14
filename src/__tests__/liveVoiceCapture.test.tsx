/**
 * Audit W10.C8 (plan W1.13 step 1, plan 6.1): voice capture's live
 * transcription. The dictation session is scripted here, because the
 * Zipformer worker and its 72 MB model cannot run in a test. Everything
 * else is the real path: liveDictation's registration and engine,
 * voiceCapture's seam, and the QuickCapture box rendered with React. The
 * browser's MediaRecorder and getUserMedia are stood in for, since
 * happy-dom has neither.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const whisper = vi.hoisted(() => ({ calls: 0 }));
// Whisper after the recording (the fallback): counted, so a test sees whether it ran.
vi.mock("../ai/transformersEngine", () => ({
  decodeAudioTo16k: async () => new Float32Array(16),
  transcribeAudio: async () => {
    whisper.calls++;
    return { text: "after the recording" };
  },
  ortBaseUrl: () => "",
}));

import { hasLiveTranscriber, setVoiceTranscriber, startLiveTranscript } from "../capture/voiceCapture";
import { liveDictationTranscriber, registerLiveVoiceTranscriber, type LiveDictationDeps } from "../capture/liveDictation";
import type { DictationCallbacks } from "../ai/dictation/session";
import { QuickCapture } from "../ui/QuickCapture";

/** A scripted dictation session: the test says what the model "hears". */
function scripted(downloaded = true) {
  const s = { cb: null as DictationCallbacks | null, stopped: 0, starts: 0 };
  const deps: LiveDictationDeps = {
    downloaded: async () => downloaded,
    start: async (cb) => {
      s.starts++;
      s.cb = cb;
      return { stop: async () => void s.stopped++ };
    },
  };
  return { s, deps };
}

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;
  start() {
    this.state = "recording";
    queueMicrotask(() => this.onstart?.());
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"], { type: "audio/webm" }) });
    queueMicrotask(() => this.onstop?.());
  }
}

beforeEach(() => {
  whisper.calls = 0;
  (globalThis as unknown as { MediaRecorder: unknown }).MediaRecorder = FakeRecorder;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) } });
  document.documentElement.lang = "he";
});
afterEach(() => {
  cleanup();
  setVoiceTranscriber(null);
});

describe("liveDictation: the capture's live engine", () => {
  it("registers when the dictation model is on this device, not otherwise", async () => {
    expect(await registerLiveVoiceTranscriber(scripted(false).deps)).toBe(false);
    expect(hasLiveTranscriber()).toBe(false);
    expect(await registerLiveVoiceTranscriber(scripted(true).deps)).toBe(true);
    expect(hasLiveTranscriber()).toBe(true);
  });

  it("partial text arrives while the user speaks; the finished sentences are the transcript", async () => {
    const { s, deps } = scripted();
    await registerLiveVoiceTranscriber(deps);
    const parts: string[] = [];
    const live = await startLiveTranscript({ language: "he-IL", onPartial: (t) => parts.push(t) });
    expect(live).not.toBeNull();
    s.cb!.onInterim!("שלום");
    s.cb!.onFinal!("שלום עולם.", []);
    s.cb!.onInterim!("מה");
    s.cb!.onFinal!("מה שלומך?", []);
    expect(parts).toEqual(["שלום", "שלום עולם.", "שלום עולם. מה", "שלום עולם. מה שלומך?"]);
    expect(await live!.stop()).toBe("שלום עולם. מה שלומך?");
    expect(s.stopped).toBe(1);
  });

  it("a language the model does not know, or a failed session, goes to Whisper after the recording", async () => {
    const { s, deps } = scripted();
    setVoiceTranscriber(liveDictationTranscriber(deps));
    expect(await startLiveTranscript({ language: "en-US", onPartial: () => {} })).toBeNull();
    expect(s.starts).toBe(0);
    const live = await startLiveTranscript({ language: "he", onPartial: () => {} });
    s.cb!.onFinal!("חצי", []);
    s.cb!.onError!("worker died");
    expect(await live!.stop()).toBeNull();
  });
});

describe("QuickCapture with live transcription", () => {
  const box = () => render(createElement(QuickCapture, { open: true, onClose: () => {} }));
  const textarea = () => screen.getByRole("textbox") as HTMLTextAreaElement;

  it("with the engine registered, partial text shows during the recording and the transcript fills the box; Whisper does not run", async () => {
    const { s, deps } = scripted();
    await registerLiveVoiceTranscriber(deps);
    box();
    fireEvent.click(screen.getByTestId("capture-voice"));
    await waitFor(() => expect(screen.getByTestId("capture-voice").getAttribute("data-state")).toBe("recording"));
    await waitFor(() => expect(s.cb).not.toBeNull());
    expect(screen.queryByTestId("capture-voice-after-stop")).toBeNull();
    act(() => s.cb!.onInterim!("לקנות"));
    expect(screen.getByTestId("capture-voice-partial").textContent).toBe("לקנות");
    act(() => s.cb!.onFinal!("לקנות חלב.", []));
    expect(screen.getByTestId("capture-voice-partial").textContent).toBe("לקנות חלב.");
    fireEvent.click(screen.getByTestId("capture-voice"));
    await waitFor(() => expect(textarea().value).toBe("לקנות חלב."));
    expect(s.stopped).toBe(1);
    expect(whisper.calls).toBe(0);
    expect(screen.queryByTestId("capture-voice-partial")).toBeNull();
  });

  it("without the engine, the box says the recording is transcribed after it stops, and Whisper does it", async () => {
    box();
    fireEvent.click(screen.getByTestId("capture-voice"));
    await waitFor(() => expect(screen.getByTestId("capture-voice-after-stop")).toBeTruthy());
    expect(screen.queryByTestId("capture-voice-partial")).toBeNull();
    fireEvent.click(screen.getByTestId("capture-voice"));
    await waitFor(() => expect(textarea().value).toBe("after the recording"));
    expect(whisper.calls).toBe(1);
  });
});

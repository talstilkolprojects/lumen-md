/**
 * Plan 6.5 review: speak() loads the language detector lazily; a newer
 * speak() (or a stop) while that import is pending must end the older run
 * for good, so two documents are never read at once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { speak, stopSpeaking } from "../ai/tts";

class FakeUtterance {
  lang = "";
  rate = 1;
  voice: unknown = null;
  onend: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public text: string) {}
}

describe("speak()", () => {
  afterEach(() => {
    stopSpeaking();
    vi.unstubAllGlobals();
  });

  it("a newer call supersedes one still loading the detector", async () => {
    const spoken: string[] = [];
    vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
    vi.stubGlobal("speechSynthesis", {
      // A local voice: since #195 a sentence with no local voice is not spoken.
      getVoices: () => [{ name: "Local English", lang: "en-US", localService: true }],
      cancel: () => undefined,
      speak: (u: FakeUtterance) => {
        spoken.push(u.text);
        queueMicrotask(() => u.onend?.());
      },
    });
    Object.defineProperty(window, "speechSynthesis", { configurable: true, value: globalThis.speechSynthesis });
    const first = speak("The old document is here.", { uiLang: "en" });
    const second = speak("The new document is here.", { uiLang: "en" });
    await Promise.all([first, second]);
    expect(spoken).toEqual(["The new document is here."]);
  });
});

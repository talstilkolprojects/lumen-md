/** Plan W5.6: read-aloud reports each word as the voice reaches it, mapped to the note's source. */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { __resetTts, speak } from "../ai/tts";

type V = Pick<SpeechSynthesisVoice, "name" | "lang" | "localService">;
const voices: V[] = [{ name: "Carmit", lang: "he-IL", localService: true }];
let fire: (u: { text: string; onboundary?: ((e: { name: string; charIndex: number }) => void) | null; onend: () => void }) => void;

beforeEach(() => {
  localStorage.clear();
  __resetTts();
  vi.stubGlobal(
    "SpeechSynthesisUtterance",
    class {
      text: string;
      lang = "";
      voice: V | null = null;
      rate = 1;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onboundary: ((e: { name: string; charIndex: number }) => void) | null = null;
      constructor(text: string) {
        this.text = text;
      }
    },
  );
  // A voice that reports a boundary at the start of every word, and a sentence boundary first.
  fire = (u) => {
    u.onboundary?.({ name: "sentence", charIndex: 0 });
    for (const m of u.text.matchAll(/\S+/g)) u.onboundary?.({ name: "word", charIndex: m.index! });
    u.onend();
  };
  Object.defineProperty(window, "speechSynthesis", {
    configurable: true,
    value: { getVoices: () => voices, addEventListener: () => {}, removeEventListener: () => {}, cancel: () => {}, speak: (u: Parameters<typeof fire>[0]) => fire(u) },
  });
});

describe("read-aloud word highlight", () => {
  it("each word boundary gives the word's range in the note, Markdown included", async () => {
    const md = "שלום **עולם**. מה שלומך?";
    const words: string[] = [];
    const ok = await speak(md, { uiLang: "he", onWord: (r) => words.push(md.slice(r.from, r.to)) });
    expect(ok).toBe(true);
    expect(words).toEqual(["שלום", "עולם", "מה", "שלומך"]);
  });

  it("the rate reaches the utterance", async () => {
    const rates: number[] = [];
    fire = (u) => {
      rates.push((u as unknown as { rate: number }).rate);
      u.onend();
    };
    await speak("שלום.", { uiLang: "he", rate: 0.75 });
    expect(rates).toEqual([0.75]);
  });

  it("without onWord no boundary handler is set", async () => {
    let handler: unknown = "unset";
    fire = (u) => {
      handler = u.onboundary;
      u.onend();
    };
    await speak("שלום.", { uiLang: "he" });
    expect(handler).toBeNull();
  });
});

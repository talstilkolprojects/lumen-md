/**
 * Plan 6.1 — dictation text: voice commands, rule punctuation, the local
 * polish guard, and the engine choice (incl. "never browser speech under
 * local-only", 1.3).
 */
import { describe, it, expect, vi } from "vitest";
import { appendSegment, finishSegment, interimText } from "../ai/dictation/punctuate";
import { polishDictation } from "../ai/dictation/polish";
import { chooseEngine, type EngineContext, type EngineId } from "../ai/dictation/engines";

describe("finishSegment", () => {
  it("ends a segment with a full stop, or a question mark after a question word", () => {
    expect(finishSegment("אני הולך הביתה").text).toBe("אני הולך הביתה.");
    expect(finishSegment("האם אתה בא מחר").text).toBe("האם אתה בא מחר?");
    expect(finishSegment("where are you").text).toBe("Where are you?");
  });
  it("turns spoken punctuation into marks with the right spacing", () => {
    expect(finishSegment("שלום פסיק מה שלומך סימן שאלה").text).toBe("שלום, מה שלומך?");
    expect(finishSegment("רשימה נקודתיים חלב שורה חדשה לחם").text).toBe("רשימה: חלב\nלחם.");
    expect(finishSegment("hello comma world period new paragraph").text).toBe("Hello, world.\n\n");
    expect(finishSegment("פתח סוגריים הערה סגור סוגריים").text).toBe("(הערה).");
  });
  it("reports editing commands as actions", () => {
    expect(finishSegment("מחק את זה")).toEqual({ text: "", actions: [{ type: "delete-last" }] });
    expect(finishSegment("stop dictation").actions).toEqual([{ type: "stop" }]);
  });
  it("keeps every word when commands are off", () => {
    expect(finishSegment("נקודה חשובה", { commands: false }).text).toBe("נקודה חשובה.");
  });
  it("adds no terminal mark to interim text", () => {
    expect(interimText("שלום פסיק עולם")).toBe("שלום, עולם");
  });
  it("appends segments with one space", () => {
    expect(appendSegment("", "שלום.")).toBe("שלום.");
    expect(appendSegment("שלום.", "מה נשמע?")).toBe("שלום. מה נשמע?");
    expect(appendSegment("א\n", "ב.")).toBe("א\nב.");
    expect(appendSegment("א", ", ב")).toBe("א, ב");
  });
});

describe("polishDictation", () => {
  it("never calls a model that is not local", async () => {
    const chat = vi.fn();
    expect(await polishDictation("שלום עולם", { localModelReady: () => false, chat })).toEqual({ text: "שלום עולם", polished: false });
    expect(chat).not.toHaveBeenCalled();
  });
  it("accepts punctuation only, rejects a rewrite", async () => {
    const ok = await polishDictation("שלום מה שלומך היום", { localModelReady: () => true, chat: async () => "שלום, מה שלומך היום?" });
    expect(ok).toEqual({ text: "שלום, מה שלומך היום?", polished: true });
    const rewrite = await polishDictation("שלום מה שלומך היום", { localModelReady: () => true, chat: async () => "היי, איך אתה מרגיש?" });
    expect(rewrite.polished).toBe(false);
    const broken = await polishDictation("שלום", { localModelReady: () => true, chat: async () => Promise.reject(new Error("x")) });
    expect(broken).toEqual({ text: "שלום", polished: false });
  });
});

const ctx = (over: Partial<EngineContext> = {}): EngineContext => ({
  language: "he-IL",
  policy: "local-first",
  mode: "live",
  webgpu: false,
  f16: false,
  vramMB: 0,
  webSpeech: true,
  downloaded: new Set<EngineId>(),
  ...over,
});

describe("chooseEngine", () => {
  it("streams Hebrew with the Zipformer, after the user downloads it", () => {
    const c = chooseEngine(ctx());
    expect(c.candidates[0]).toBe("zipformer-he");
    expect(c.needsDownload).toBe("zipformer-he");
    expect(chooseEngine(ctx({ downloaded: new Set(["zipformer-he"]) })).needsDownload).toBeNull();
  });
  it("never offers browser speech under local-only", () => {
    for (const language of ["he", "en", "fr"]) {
      const c = chooseEngine(ctx({ policy: "local-only", language }));
      expect(c.candidates).not.toContain("web-speech");
      expect(c.webSpeechBlocked).toBe("local-only");
    }
  });
  it("no browser speech under local-first (plan 6.17); last under cloud, first under cloud with nothing downloaded", () => {
    expect(chooseEngine(ctx({ language: "en" })).candidates).toEqual(["whisper-live"]);
    expect(chooseEngine(ctx({ language: "en", policy: "cloud", downloaded: new Set(["whisper-live"]) })).candidates).toEqual(["whisper-live", "web-speech"]);
    expect(chooseEngine(ctx({ language: "en", policy: "cloud" })).candidates[0]).toBe("web-speech");
    expect(chooseEngine(ctx({ policy: "cloud", downloaded: new Set(["zipformer-he"]) })).candidates[0]).toBe("zipformer-he");
    expect(chooseEngine(ctx({ webSpeech: false })).webSpeechBlocked).toBe("unsupported");
  });
  it("transcribes files with ivrit.ai turbo only on a GPU that holds it, else whisper-base", () => {
    expect(chooseEngine(ctx({ mode: "file", webgpu: true, f16: true, vramMB: 2048 })).candidates).toEqual(["whisper-turbo-he", "whisper-base"]);
    expect(chooseEngine(ctx({ mode: "file", webgpu: true, f16: false, vramMB: 2048 })).candidates).toEqual(["whisper-base"]);
    expect(chooseEngine(ctx({ mode: "file", language: "en", webgpu: true, f16: true, vramMB: 4096 })).candidates).toEqual(["whisper-base"]);
    expect(chooseEngine(ctx({ mode: "file" })).candidates).not.toContain("web-speech");
  });
});

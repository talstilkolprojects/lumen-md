/**
 * Plan W4.13 — the Whisper pass over each finished sentence of live Hebrew
 * dictation: which text goes in, the deadline, the segment's audio.
 */
import { describe, it, expect } from "vitest";
import { CORRECTION_DEADLINE_MS, SegmentAudio, makeCorrector, pickText, similarity } from "../ai/dictation/correction";

describe("which text goes in", () => {
  it("takes Whisper's sentence when it reads as the same one, else keeps the streaming text", () => {
    expect(similarity("שלום עולם", "שָׁלוֹם, עוֹלָם!")).toBe(1);
    expect(pickText("הפגישה נדחתה ליום חמישי", "הפגישה נדחתה ליום חמישי.")).toBe("הפגישה נדחתה ליום חמישי.");
    expect(pickText("הפגישה נדחית ליום חמשי", "הפגישה נדחתה ליום חמישי")).toBe("הפגישה נדחתה ליום חמישי");
    // A moved segment boundary: the second pass heard another sentence.
    expect(pickText("הפגישה נדחתה ליום חמישי", "תודה רבה לכולם")).toBe("הפגישה נדחתה ליום חמישי");
    expect(pickText("שלום", "")).toBe("שלום");
    expect(pickText("שלום", null)).toBe("שלום");
    expect(pickText("", "שלום")).toBe("שלום");
  });
});

describe("the corrector", () => {
  const second = new Float32Array(16000);

  it("asks the engine's model for Hebrew and uses its text", async () => {
    const seen: Array<{ language: string; model: string }> = [];
    const c = makeCorrector("ozen-he", async (_a, o) => (seen.push({ language: o.language, model: o.model }), { text: "שלום עולם." }));
    expect(await c(second, "שלום עולם")).toBe("שלום עולם.");
    expect(seen).toEqual([{ language: "he", model: "itayinbar/Ozen-v1" }]);
    const t = makeCorrector("whisper-turbo-he", async (_a, o) => ({ text: o.model }));
    expect(await t(second, "ivrit-ai/whisper-large-v3-turbo-onnx")).toBe("ivrit-ai/whisper-large-v3-turbo-onnx");
  });

  it("keeps the streaming text after the deadline (and aborts the pass), on an error, and for empty or over-long audio", async () => {
    let aborted = false;
    const slow = makeCorrector("ozen-he", (_a, o) => new Promise((done) => o.signal.addEventListener("abort", () => ((aborted = true), done({ text: "late" })))), 20);
    expect(await slow(second, "בזמן")).toBe("בזמן");
    expect(aborted).toBe(true);
    const broken = makeCorrector("ozen-he", async () => {
      throw new Error("no WebGPU adapter");
    });
    expect(await broken(second, "שגיאה")).toBe("שגיאה");
    const never = makeCorrector("ozen-he", async () => ({ text: "x" }));
    expect(await never(new Float32Array(0), "ריק")).toBe("ריק");
    expect(await never(new Float32Array(31 * 16000), "ארוך")).toBe("ארוך");
    expect(CORRECTION_DEADLINE_MS).toBe(2000);
  });
});

describe("the segment's audio", () => {
  it("collects copies of the blocks since the last sentence and keeps the tail for the next one", () => {
    const s = new SegmentAudio(0.25);
    const block = new Float32Array(8000).fill(1);
    s.push(block);
    block.fill(9); // the caller transfers / reuses the block: the segment kept a copy
    s.push(new Float32Array(8000).fill(2));
    const first = s.take();
    expect(first.length).toBe(16000);
    expect(first[0]).toBe(1);
    expect(first[15999]).toBe(2);
    const next = s.take();
    expect(next.length).toBe(4000); // 0.25 s carried over
    expect(next[0]).toBe(2);
  });

  it("never holds more than Whisper's 30 s window", () => {
    const s = new SegmentAudio(0);
    for (let i = 0; i < 40; i++) s.push(new Float32Array(16000));
    expect(s.take().length).toBeLessThanOrEqual(30 * 16000);
  });
});

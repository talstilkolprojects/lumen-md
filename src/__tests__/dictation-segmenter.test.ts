/**
 * Plan 6.1 — live dictation's segmentation and audio plumbing: VAD
 * probabilities → segment start (with pre-roll) / end (after a pause),
 * the energy fallback, re-blocking into 512-sample frames, resampling.
 */
import { describe, it, expect } from "vitest";
import { EnergyVad, FRAME, Framer, Resampler, Segmenter } from "../ai/dictation/segmenter";
import { creditEntries } from "../ui/CreditsDialog";

const frame = (v = 0) => new Float32Array(FRAME).fill(v);

describe("Segmenter", () => {
  it("starts with the pre-roll, ends after the pause, counts speech", () => {
    const s = new Segmenter({ positive: 0.5, negative: 0.35, pauseMs: 96, preMs: 64, minSpeechMs: 32 });
    expect(s.push(frame(1), 0.1).type).toBe("idle");
    expect(s.push(frame(2), 0.1).type).toBe("idle");
    expect(s.push(frame(3), 0.1).type).toBe("idle"); // pre-roll keeps the last 64 ms = 2 frames
    const start = s.push(frame(4), 0.9);
    expect(start.type).toBe("start");
    expect(start.type === "start" && start.audio.map((a) => a[0])).toEqual([2, 3, 4]);
    expect(s.push(frame(5), 0.9).type).toBe("speech");
    expect(s.push(frame(6), 0.4).type).toBe("speech"); // between thresholds: neither speech nor pause
    expect(s.push(frame(7), 0.1).type).toBe("speech");
    expect(s.push(frame(8), 0.1).type).toBe("speech");
    const end = s.push(frame(9), 0.1);
    expect(end).toMatchObject({ type: "end", speechMs: 64 });
    expect(s.speaking).toBe(false);
  });
  it("a pause interrupted by speech does not end the segment", () => {
    const s = new Segmenter({ positive: 0.5, negative: 0.35, pauseMs: 96, preMs: 0, minSpeechMs: 0 });
    s.push(frame(), 0.9);
    s.push(frame(), 0.1);
    s.push(frame(), 0.1);
    s.push(frame(), 0.9);
    expect(s.push(frame(), 0.1).type).toBe("speech");
    expect(s.flush()).toMatchObject({ speechMs: 64 });
    expect(s.flush()).toBeNull();
  });
});

describe("EnergyVad", () => {
  it("rates loud frames over the noise floor as speech", () => {
    const v = new EnergyVad();
    for (let i = 0; i < 50; i++) v.prob(frame(0.001));
    expect(v.prob(frame(0.001))).toBeLessThan(0.35);
    expect(v.prob(frame(0.2))).toBeGreaterThan(0.5);
  });
});

describe("Framer and Resampler", () => {
  it("re-blocks into 512-sample frames and keeps the rest", () => {
    const f = new Framer();
    expect(f.push(new Float32Array(1000))).toHaveLength(1);
    expect(f.push(new Float32Array(100))).toHaveLength(1); // 488 + 100 = 588
    expect(f.push(new Float32Array(436))).toHaveLength(1); // 76 + 436 = 512
  });
  it("resamples 48 kHz to 16 kHz, 3:1, continuously across calls", () => {
    const r = new Resampler(48000);
    let n = 0;
    for (let i = 0; i < 10; i++) n += r.push(new Float32Array(4800).fill(0.5)).length;
    expect(Math.abs(n - 16000)).toBeLessThanOrEqual(2);
    const y = r.push(new Float32Array(480).fill(0.5));
    expect(y.every((v) => Math.abs(v - 0.5) < 1e-6)).toBe(true);
  });
  it("passes 16 kHz through", () => {
    expect(new Resampler(16000).push(new Float32Array(7))).toHaveLength(7);
  });
});

describe("credits", () => {
  it("credit the CC BY speech model and the VAD", () => {
    const ids = creditEntries().map((e) => e.id);
    expect(ids).toContain("ivrit-ai/zipformer2-66m-streaming-he");
    expect(ids).toContain("silero-vad-v5");
    expect(creditEntries().find((e) => e.id === "ivrit-ai/zipformer2-66m-streaming-he")?.attribution).toMatch(/CC BY 4\.0/);
  });
});

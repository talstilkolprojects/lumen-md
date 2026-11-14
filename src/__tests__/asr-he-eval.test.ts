/**
 * Plan 6.1 — the asr-he harness: the set's normalisation (NFC, no niqqud,
 * no punctuation), WER / CER and the latency bookkeeping of live decoding,
 * on a fake recognizer (the real model is measured in the ASR workflow).
 */
import { describe, it, expect } from "vitest";
// @ts-expect-error — plain .mjs module without types
import { editDistance, errors, normalizeAsr, percentile, rates, scoreWith, transcribeLive, wordLatencies, wordSpans } from "../../scripts/golden/evals/asr-he.mjs";

describe("normalizeAsr", () => {
  it("drops niqqud, cantillation and punctuation, keeps letters", () => {
    expect(normalizeAsr("שָׁלוֹם, עוֹלָם!")).toBe("שלום עולם");
    expect(normalizeAsr("בְּרֵאשִׁ֖ית")).toBe("בראשית");
    expect(normalizeAsr("  \"מה?\"  נשמע…  ")).toBe("מה נשמע");
  });
  it("splits on maqaf and dashes, composes to NFC, lower-cases Latin", () => {
    expect(normalizeAsr("בית־ספר")).toBe("בית ספר");
    expect(normalizeAsr("COVID-19")).toBe("covid 19");
    expect(normalizeAsr("é")).toBe("é");
  });
});

describe("error rates", () => {
  it("edit distance on words and characters", () => {
    expect(editDistance(["a", "b", "c"], ["a", "c"])).toBe(1);
    expect(editDistance([], ["x"])).toBe(1);
    expect(editDistance("kitten".split(""), "sitting".split(""))).toBe(3);
  });
  it("WER ignores niqqud and punctuation differences", () => {
    expect(errors("שָׁלוֹם, עוֹלָם.", "שלום עולם")).toEqual({ wordErrors: 0, words: 2, charErrors: 0, chars: 8 });
    const e = errors("אני הולך הביתה", "אני הלך הביתה");
    expect(e.wordErrors).toBe(1);
    expect(e.charErrors).toBe(1);
  });
  it("corpus rates sum edits over reference length", () => {
    expect(rates([{ wordErrors: 1, words: 4, charErrors: 2, chars: 10 }, { wordErrors: 0, words: 6, charErrors: 0, chars: 10 }])).toEqual({ wer: 0.1, cer: 0.1 });
  });
  it("percentiles", () => {
    expect(percentile([3, 1, 2, 4], 50)).toBe(2);
    expect(percentile([3, 1, 2, 4], 95)).toBe(4);
    expect(percentile([], 50)).toBe(0);
  });
});

/** A recognizer that emits one word per second of audio it has seen, stamped at the word's start. */
function fakeRecognizer(decodeCost = 0.05) {
  let clock = 0;
  const now = () => clock;
  const make = () => {
    let fed = 0;
    let decoded = 0;
    let finished = false;
    return {
      acceptWaveform: (s: Float32Array) => void (fed += s.length),
      inputFinished: () => void (finished = true),
      get ready() {
        return fed - decoded >= 16000 || (finished && fed > decoded);
      },
      decode() {
        decoded = Math.min(fed, decoded + 16000);
        clock += decodeCost;
      },
      get words() {
        return Math.floor(decoded / 16000);
      },
    };
  };
  type S = ReturnType<typeof make>;
  return {
    now,
    rec: {
      createStream: make,
      isReady: (s: S) => s.ready,
      decode: (s: S) => s.decode(),
      getResult: (s: S) => {
        const n = s.words;
        // sherpa-onnx returns the word marker as a space; Lumen's engine keeps "▁". Both count.
        return { text: Array.from({ length: n }, (_, i) => `w${i}`).join(" "), tokens: Array.from({ length: n }, (_, i) => `${i % 2 ? " " : "▁"}w${i}`), timestamps: Array.from({ length: n }, (_, i) => i) };
      },
    },
  };
}

describe("transcribeLive", () => {
  it("feeds real-time slices and measures each word's delay from when it was spoken", async () => {
    const { rec, now } = fakeRecognizer(0.05);
    const out = await transcribeLive(rec, new Float32Array(3 * 16000), now);
    // The recogniser also decodes the flush padding, as the real one does with silence.
    expect(out.text.startsWith("w0 w1 w2")).toBe(true);
    expect(out.duration).toBe(3);
    // Word i is stamped at i s and decoded once its second of audio is in — at the end of the
    // first 64 ms slice that completes it — plus the decode cost: 1.024 + 0.05 − 0, 2.048 + 0.05 − 1.
    expect(out.latencies[0]).toBeCloseTo(1.074, 3);
    expect(out.latencies[1]).toBeCloseTo(1.098, 3);
    // Then the app's segment end: the VAD's 0.7 s pause in real time (clock 3.7 s), then the 1.5 s
    // flush padding at once — 3 decodes of compute, no wall time. 3.7 + 0.7 s pause + 1.5 s pad = 5 "words".
    expect(out.latencies).toHaveLength(5);
    // w3 (stamped 3 s) is committed by the flush: 3.7 + 3 × 0.05 − 3 = 0.85 s — not 1.5 s + the pause.
    expect(out.latencies[3]).toBeCloseTo(0.85, 3);
    expect(out.compute).toBeGreaterThan(0);
  });
  it("scores per part, overall, with latency percentiles and the real-time factor", async () => {
    const items = [
      { part: "fleurs", text: "שלום עולם" },
      { part: "common-voice", text: "אחת שתיים שלוש" },
    ];
    const s = await scoreWith(async (it: { text: string }) => ({ text: it.text === "שלום עולם" ? "שלום עולם" : "אחת שתיים", latencies: [0.4, 0.8], compute: 1, duration: 4 }), items);
    expect(s["wer.fleurs"]).toBe(0);
    expect(s["wer.common-voice"]).toBeCloseTo(1 / 3, 3);
    expect(s.wer).toBeCloseTo(1 / 5, 3);
    expect(s["latency.p50Ms"]).toBe(400);
    expect(s["latency.p95Ms"]).toBe(800);
    expect(s.rtf).toBe(0.25);
  });
});

describe("word latency", () => {
  it("splits tokens into words at the SentencePiece marker or a leading space", () => {
    expect(wordSpans(["▁של", "ום", "▁עו", "לם", " x"])).toEqual([[0, 1], [2, 3], [4, 4]]);
  });
  it("counts a word as shown from the first hypothesis that agrees with the final text through it", () => {
    const final = { tokens: ["▁a", "b", "▁c"], timestamps: [0.1, 0.3, 0.9] };
    const snaps = [
      { clock: 0.5, tokens: ["▁a"] }, // word 1 incomplete
      { clock: 0.7, tokens: ["▁a", "b", "▁x"] }, // word 1 right, word 2 wrong
      { clock: 1.6, tokens: ["▁a", "b", "▁c"] },
    ];
    const l = wordLatencies(final, snaps);
    expect(l[0]).toBeCloseTo(0.4, 6); // 0.7 − 0.3
    expect(l[1]).toBeCloseTo(0.7, 6); // 1.6 − 0.9
  });
  it("uses interim hypotheses when the engine can peek", async () => {
    let decoded = 0;
    let fed = 0;
    let clock = 0;
    const rec = {
      createStream: () => ({ acceptWaveform: (x: Float32Array) => void (fed += x.length), inputFinished: () => undefined }),
      isReady: () => fed - decoded >= 32000,
      decode: () => void ((decoded += 32000), (clock += 0.01)),
      getResult: () => ({ text: "", tokens: Array.from({ length: Math.floor(decoded / 16000) }, (_, i) => `▁w${i}`), timestamps: Array.from({ length: Math.floor(decoded / 16000) }, (_, i) => i + 1) }),
      peek: () => ({ text: "", tokens: Array.from({ length: Math.floor(fed / 16000) }, (_, i) => `▁w${i}`), timestamps: [] }),
    };
    const out = await transcribeLive(rec, new Float32Array(4.5 * 16000), () => clock);
    // Word 0 ends at 1 s: committed with the 2 s chunk (at 2.048 s), shown by the first peek after 1 s.
    expect(out.latencies[0]).toBeCloseTo(1.058, 3);
    expect(out.shownLatencies[0]).toBeLessThan(0.4);
    // The flush padding costs no wall time: w4 (stamped 5 s) is in the chunk that only the flush
    // completes, so it is committed at the clip's end plus the VAD pause (5.2 s) plus compute —
    // about 0.2 s, not 1.5 s of padding on top of that.
    expect(out.latencies[4]).toBeGreaterThan(0.19);
    expect(out.latencies[4]).toBeLessThan(0.3);
  });
});

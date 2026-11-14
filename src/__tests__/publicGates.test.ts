/**
 * W11.H8 / H9 / H14 — capabilities shown only after a public benchmark
 * passes, against the committed eval/public/_verdicts.json and
 * models/registry.json. W11.H7 — live dictation's files and the recording
 * path through the same engine. W11.H18 — the Yiddish desktop model seam.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { exposedNeuralVoices, handwritingOffered, NEURAL_VOICE_CANDIDATES, type Verdicts } from "../ai/publicGates";
import { speakChatterbox } from "../ai/tts/chatterbox";
import { HEBREW_VOICES } from "../ai/tts/voices";
import { ZIPFORMER_FILES, ZIPFORMER_FP16_FILES, zipformerFilesFor, dictationDownloadBytes } from "../ai/dictation/models";
import { transcribeSamples, isHebrew, SLICE, type WorkerLike } from "../ai/dictation/fileTranscriber";
import { WHISPER_GGML, WHISPER_GGML_YI, ggmlFor, isPinned } from "../ai/dictation/whisperDesktop";
// @ts-expect-error — plain .mjs helper without types
import { validateEntry } from "../../scripts/lib/licenses.mjs";

const verdicts = JSON.parse(readFileSync("eval/public/_verdicts.json", "utf8")) as Verdicts;
const registry = JSON.parse(readFileSync("models/registry.json", "utf8")).models as { id: string; class: string; verified: boolean; files?: { path: string; sha256: string; bytes: number }[] }[];

describe("W11.H8 neural voice candidate: hidden until the CER screen passes", () => {
  it("with the committed verdicts (no passing result) no neural voice is offered", () => {
    expect(NEURAL_VOICE_CANDIDATES.map((c) => c.id)).toEqual(["chatterbox-multilingual"]);
    expect(exposedNeuralVoices(NEURAL_VOICE_CANDIDATES, verdicts, registry)).toEqual([]);
    expect(HEBREW_VOICES).toEqual([]);
  });
  it("a failing CER result keeps it hidden, even with a hand-set pass flag", () => {
    const allowed = registry.map((e) => (e.id === "chatterbox-multilingual" ? { ...e, class: "allowed", verified: true } : e));
    const v: Verdicts = { voices: { "chatterbox-multilingual": { pass: true, cer: 0.12, naturalCer: 0.03, result: "x" } }, handwriting: {} };
    expect(exposedNeuralVoices(NEURAL_VOICE_CANDIDATES, v, allowed)).toEqual([]);
  });
  it("a passing result is not enough while the licence is unsettled (registry class unknown)", () => {
    const v: Verdicts = { voices: { "chatterbox-multilingual": { pass: true, cer: 0.04, naturalCer: 0.03, result: "x" } }, handwriting: {} };
    expect(exposedNeuralVoices(NEURAL_VOICE_CANDIDATES, v, registry)).toEqual([]);
    const allowed = registry.map((e) => (e.id === "chatterbox-multilingual" ? { ...e, class: "allowed", verified: true } : e));
    expect(exposedNeuralVoices(NEURAL_VOICE_CANDIDATES, v, allowed).map((c) => c.id)).toEqual(["chatterbox-multilingual"]);
  });
  it("the pipeline dots Hebrew before synthesis, and leaves dotted text alone", async () => {
    const calls: string[] = [];
    const deps = {
      nikud: vi.fn(async (t: string) => (calls.push(`nikud:${t}`), "שָׁלוֹם")),
      runtime: { synthesize: async (d: string) => (calls.push(`tts:${d}`), { samples: new Float32Array(4), sampleRate: 24_000 }) },
    };
    await speakChatterbox("שלום", deps);
    expect(calls).toEqual(["nikud:שלום", "tts:שָׁלוֹם"]);
    await speakChatterbox("כְּבָר מְנֻקָּד", deps);
    expect(deps.nikud).toHaveBeenCalledTimes(1);
    expect((await speakChatterbox("   ", deps)).samples.length).toBe(0);
  });
});

describe("W11.H14 handwriting is offered only at median CER ≤ 20 %", () => {
  it("no committed verdict: not offered; above the bar: not offered; at it: offered", () => {
    expect(handwritingOffered("tesseract-heb", verdicts)).toBe(false);
    expect(handwritingOffered("e", { voices: {}, handwriting: { e: { exposed: true, medianCer: 0.31, result: "x" } } })).toBe(false);
    expect(handwritingOffered("e", { voices: {}, handwriting: { e: { exposed: true, medianCer: 0.18, result: "x" } } })).toBe(true);
  });
});

describe("W11.H7 live dictation on ivrit-ai/zipformer2-66m-streaming-he", () => {
  const entry = registry.find((e) => e.id === "ivrit-ai/zipformer2-66m-streaming-he")!;
  it("the loader picks the int8 files, and fp16 only once pinned and on WebGPU with f16", () => {
    for (const k of ["encoder", "decoder", "joiner"] as const) expect(ZIPFORMER_FILES[k].path).toMatch(/\.int8\.onnx$/);
    expect(ZIPFORMER_FP16_FILES).toBeNull();
    expect(zipformerFilesFor({ webgpu: true, f16: true })).toBe(ZIPFORMER_FILES);
    expect(zipformerFilesFor({ webgpu: false, f16: false })).toBe(ZIPFORMER_FILES);
  });
  it("the files are the registry's (same sha256 and size), and the download is ≤ 80 MB", () => {
    for (const k of ["encoder", "decoder", "joiner"] as const) {
      const f = entry.files!.find((x) => x.path === ZIPFORMER_FILES[k].path)!;
      expect([f.sha256, f.bytes]).toEqual([ZIPFORMER_FILES[k].sha256, ZIPFORMER_FILES[k].bytes]);
    }
    expect(entry.files!.reduce((s, f) => s + f.bytes, 0)).toBeLessThanOrEqual(80e6);
    expect(dictationDownloadBytes()).toBeLessThanOrEqual(80e6);
  });
  it("the registration passes the licence gate's entry check (CC-BY-4.0 with credit, allowed)", () => {
    expect(validateEntry(entry)).toEqual([]);
    expect(entry.class).toBe("allowed");
  });

  /** A worker stand-in that speaks the dictation worker's protocol: ready, then a final per second of audio. */
  function fakeWorker(opts: { fail?: boolean } = {}) {
    const sent: { type: string; n?: number }[] = [];
    let samples = 0;
    const w: WorkerLike & { terminated: boolean } = {
      onmessage: null,
      onerror: null,
      terminated: false,
      terminate() {
        this.terminated = true;
      },
      postMessage(m) {
        sent.push({ type: m.type, ...(m.type === "audio" ? { n: m.samples.length } : {}) });
        const reply = (data: unknown) => queueMicrotask(() => w.onmessage?.({ data } as MessageEvent));
        if (m.type === "load") reply(opts.fail ? { type: "error", message: "bad model" } : { type: "ready", vad: "energy", loadMs: 1 });
        else if (m.type === "audio") samples += m.samples.length;
        else if (m.type === "stop") {
          for (let s = 0; s < Math.round(samples / 16000); s++) reply({ type: "final", text: `משפט ${s + 1}` });
          reply({ type: "stopped" });
        }
      },
    };
    return { w, sent };
  }
  const files = { encoder: new Uint8Array(4), decoder: new Uint8Array(2), joiner: new Uint8Array(2), tokens: "a 1", vad: null };

  it("a recording goes through the same worker protocol: load, 1024-sample slices, stop; finals joined", async () => {
    const { w, sent } = fakeWorker();
    const text = await transcribeSamples(new Float32Array(32000), files, { worker: w, ortBase: "/ort/" });
    expect(text).toBe("משפט 1 משפט 2");
    expect(sent[0].type).toBe("load");
    expect(sent.filter((m) => m.type === "audio")).toHaveLength(Math.ceil(32000 / SLICE));
    expect(sent.at(-1)!.type).toBe("stop");
    expect(w.terminated).toBe(true);
  });
  it("a worker error rejects (the capture then falls back to Whisper) and the worker is released", async () => {
    const { w } = fakeWorker({ fail: true });
    await expect(transcribeSamples(new Float32Array(16), files, { worker: w, ortBase: "/" })).rejects.toThrow(/bad model/);
    expect(w.terminated).toBe(true);
  });
  it("only Hebrew recordings take the Hebrew-only model", () => {
    expect(isHebrew("he-IL")).toBe(true);
    expect(isHebrew("he")).toBe(true);
    expect(isHebrew("en")).toBe(false);
    expect(isHebrew(undefined)).toBe(false);
  });
});

describe("W11.H18 Yiddish on the desktop whisper.cpp track", () => {
  it("is registered, unpinned (never offered), and chosen for 'yi'", () => {
    const e = registry.find((x) => x.id === "ivrit-ai/yi-whisper-large-v3-turbo")!;
    expect(validateEntry(e)).toEqual([]);
    expect(WHISPER_GGML_YI.sourceRepo).toBe(e.id);
    expect(isPinned(WHISPER_GGML_YI)).toBe(false);
    expect(ggmlFor("yi")).toBe(WHISPER_GGML_YI);
    expect(ggmlFor("he-IL")).toBe(WHISPER_GGML);
    expect(ggmlFor(undefined)).toBe(WHISPER_GGML);
  });
});

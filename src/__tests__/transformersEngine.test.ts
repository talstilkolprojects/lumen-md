import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WorkerIn, WorkerOut } from "../ai/transformers.worker";
import type { Hardware } from "../ai/modelManager";

let hardware: Hardware = { webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false };
vi.mock("../ai/modelManager", async (orig) => {
  const real = await orig<typeof import("../ai/modelManager")>();
  return { ...real, detectHardware: async () => hardware };
});

import {
  transcribeAudio,
  embedTextsLocal,
  preloadTransformersModel,
  unloadTransformers,
  onTransformersProgress,
  whisperModelFor,
  whisperModelForLanguage,
  transformersDevice,
  decodeAudioTo16k,
  isWebKit,
  ortSuffixFor,
  ortBaseUrl,
  WHISPER_MODELS,
  EMBEDDING_MODEL,
  __resetTransformersEngine,
} from "../ai/transformersEngine";

let script: (msg: WorkerIn, reply: (out: WorkerOut) => void) => void;
let received: Array<WorkerIn & { ortBase?: string }> = [];
let transfers: Transferable[][] = [];
const terminate = vi.fn();
let created = 0;

class FakeWorker {
  onmessage: ((ev: MessageEvent<WorkerOut>) => void) | null = null;
  onerror: ((ev: { message: string }) => void) | null = null;
  terminate = terminate;
  constructor(public url: URL) {
    created++;
    (globalThis as unknown as { __lastWorker?: FakeWorker }).__lastWorker = this;
  }
  postMessage(msg: WorkerIn & { ortBase?: string }, transfer: Transferable[] = []) {
    received.push(msg);
    transfers.push(transfer);
    queueMicrotask(() => script(msg, (out) => this.onmessage?.({ data: out } as MessageEvent<WorkerOut>)));
  }
}

describe("transformersEngine (worker client)", () => {
  beforeEach(() => {
    __resetTransformersEngine();
    received = [];
    transfers = [];
    created = 0;
    terminate.mockClear();
    hardware = { webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false };
    vi.stubGlobal("Worker", FakeWorker);
    script = (msg, reply) => reply({ id: msg.id, type: "result", value: true });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("picks Whisper by device: turbo on a strong GPU, small on a modest one, tiny on wasm", async () => {
    expect(whisperModelFor(hardware)).toBe(WHISPER_MODELS.turbo);
    expect(whisperModelFor({ ...hardware, deviceMemoryGB: 4 })).toBe(WHISPER_MODELS.small);
    expect(whisperModelFor({ ...hardware, mobile: true })).toBe(WHISPER_MODELS.small);
    expect(whisperModelFor({ ...hardware, webgpu: false })).toBe(WHISPER_MODELS.tiny);
    expect(await transformersDevice()).toBe("webgpu");
    hardware = { ...hardware, webgpu: false };
    expect(await transformersDevice()).toBe("wasm");
  });

  it("picks ivrit.ai's turbo for Hebrew on a GPU with f16 and the VRAM, else whisper-base (plan 6.1)", () => {
    expect(whisperModelForLanguage(hardware, "webgpu", "he")).toBe(WHISPER_MODELS.turboHe);
    expect(whisperModelForLanguage({ ...hardware, f16: false }, "webgpu", "he")).toBe(WHISPER_MODELS.base);
    expect(whisperModelForLanguage({ ...hardware, mobile: true }, "webgpu", "he")).toBe(WHISPER_MODELS.base);
    expect(whisperModelForLanguage({ ...hardware, webgpu: false }, "wasm", "he")).toBe(WHISPER_MODELS.base);
    expect(whisperModelForLanguage(hardware, "webgpu", "en")).toBe(WHISPER_MODELS.turbo);
    expect(whisperModelForLanguage({ ...hardware, webgpu: false }, "wasm", undefined)).toBe(WHISPER_MODELS.tiny);
  });

  it("transcribes through the worker, transferring the samples and passing the ORT base", async () => {
    script = (msg, reply) => {
      if (msg.type === "transcribe") {
        reply({ id: msg.id, type: "progress", file: "model.onnx", progress: 50, loaded: 1, total: 2 });
        reply({ id: msg.id, type: "result", value: { text: "שלום", language: "he" } });
      }
    };
    const seen: number[] = [];
    const off = onTransformersProgress((p) => seen.push(p.progress));
    const samples = new Float32Array(32_000);
    const res = await transcribeAudio(samples, { language: "he" });
    off();
    expect(res).toEqual({ text: "שלום", language: "he" });
    expect(seen).toEqual([50]);
    // Hebrew on a GPU that holds it: ivrit.ai's Hebrew turbo (plan 6.1).
    expect(received[0]).toMatchObject({ type: "transcribe", model: WHISPER_MODELS.turboHe, device: "webgpu", language: "he", task: "transcribe" });
    expect(received[0].ortBase).toMatch(/\/ort\/$/);
    expect(transfers[0][0]).toBe(samples.buffer);
    expect(created).toBe(1);
  });

  it("embeds, preloads and unloads; errors reject; an aborted signal is refused up front", async () => {
    script = (msg, reply) => {
      if (msg.type === "embed") reply({ id: msg.id, type: "result", value: { vectors: [[0.1, 0.2]], dims: 2 } });
      else if (msg.type === "load") reply({ id: msg.id, type: "error", message: "download failed" });
      else reply({ id: msg.id, type: "result", value: true });
    };
    expect(await embedTextsLocal(["a"])).toEqual({ vectors: [[0.1, 0.2]], dims: 2 });
    expect(received[0]).toMatchObject({ type: "embed", model: EMBEDDING_MODEL, texts: ["a"] });
    expect(await embedTextsLocal([])).toEqual({ vectors: [], dims: 384 });
    await expect(preloadTransformersModel("feature-extraction")).rejects.toThrow("download failed");
    const aborted = new AbortController();
    aborted.abort();
    await expect(transcribeAudio(new Float32Array(1), { signal: aborted.signal })).rejects.toMatchObject({ name: "AbortError" });
    await unloadTransformers();
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(received.at(-1)?.type).toBe("unload");
  });

  it("aborting after dispatch rejects the call and tells the worker to cancel that job", async () => {
    script = (msg, reply) => {
      if (msg.type === "cancel") reply({ id: msg.id, type: "result", value: true });
      // the transcribe job never answers
    };
    const ctrl = new AbortController();
    const p = transcribeAudio(new Float32Array(16), { signal: ctrl.signal });
    await new Promise((r) => setTimeout(r, 0));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(received.map((m) => m.type)).toEqual(["transcribe", "cancel"]);
    expect((received[1] as { target?: number }).target).toBe(received[0].id);
  });

  it("aborting while the hardware probe is pending posts nothing", async () => {
    script = () => {};
    const ctrl = new AbortController();
    const p = transcribeAudio(new Float32Array(16), { signal: ctrl.signal });
    ctrl.abort(); // before detectHardware() resolves
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(received.filter((m) => m.type === "transcribe")).toEqual([]);
  });

  it("discards a worker that failed at the top level so the next call starts fresh", async () => {
    script = () => {};
    const p = embedTextsLocal(["x"]);
    await new Promise((r) => setTimeout(r, 0));
    const w = (globalThis as unknown as { __lastWorker?: FakeWorker }).__lastWorker;
    w!.onerror?.({ message: "ort failed to load" });
    await expect(p).rejects.toThrow(/ort failed to load/);
    expect(terminate).toHaveBeenCalledTimes(1);
    script = (msg, reply) => reply({ id: msg.id, type: "result", value: { vectors: [[1]], dims: 1 } });
    await embedTextsLocal(["y"]);
    expect(created).toBe(2);
  });

  it("uses the plain ONNX runtime and the wasm device on WebKit; ORT base follows the Vite base", async () => {
    expect(isWebKit("Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15")).toBe(true);
    expect(isWebKit("Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130 Safari/537.36")).toBe(false);
    expect(isWebKit("Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 CriOS/130 Mobile Safari")).toBe(false);
    expect(ortSuffixFor(true)).toBe("");
    expect(ortSuffixFor(false)).toBe(".asyncify");
    expect(ortBaseUrl("/")).toMatch(/\/ort\/$/);
    expect(ortBaseUrl("/app/")).toMatch(/\/app\/ort\/$/);
    expect(ortBaseUrl("/app")).toMatch(/\/app\/ort\/$/);
    const ua = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15", configurable: true });
    try {
      expect(await transformersDevice()).toBe("wasm");
      script = (msg, reply) => reply({ id: msg.id, type: "result", value: { vectors: [], dims: 384 } });
      await embedTextsLocal(["x"]);
      expect((received[0] as { ortSuffix?: string }).ortSuffix).toBe("");
    } finally {
      Object.defineProperty(navigator, "userAgent", { value: ua, configurable: true });
    }
  });

  it("decodeAudioTo16k reports a missing Web Audio API", async () => {
    await expect(decodeAudioTo16k(new Blob(["x"]))).rejects.toThrow(/Web Audio/);
  });
});

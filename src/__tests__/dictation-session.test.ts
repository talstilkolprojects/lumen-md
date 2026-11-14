/**
 * Plan 6.1 — a dictation session that does not start never keeps the
 * microphone or the worker: cancel while loading, a worker that fails to
 * start, Web Audio that cannot be set up.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { startDictationSession } from "../ai/dictation/session";

const files = { encoder: new Uint8Array(1), decoder: new Uint8Array(1), joiner: new Uint8Array(1), tokens: "", vad: null };

let workers: FakeWorker[] = [];
class FakeWorker {
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  constructor() {
    workers.push(this);
  }
  postMessage(m: { type: string }) {
    if (m.type === "load" && mode === "ready") queueMicrotask(() => this.onmessage?.({ data: { type: "ready", vad: "silero", loadMs: 1 } } as MessageEvent));
    if (m.type === "load" && mode === "crash") queueMicrotask(() => this.onerror?.({ message: "module failed" } as ErrorEvent));
  }
}
let mode: "ready" | "never" | "crash" = "never";

function mic() {
  const stop = vi.fn();
  const stream = { getTracks: () => [{ stop }] } as unknown as MediaStream;
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) } });
  return stop;
}

afterEach(() => {
  vi.unstubAllGlobals();
  workers = [];
});

describe("startDictationSession", () => {
  it("cancel while the model loads stops the microphone and the worker at once", async () => {
    mode = "never";
    vi.stubGlobal("Worker", FakeWorker);
    const stop = mic();
    const ctl = new AbortController();
    const p = startDictationSession(files, {}, { signal: ctl.signal });
    await new Promise((r) => setTimeout(r, 0));
    ctl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(stop).toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it("a worker that crashes before it is ready rejects the start and releases the microphone", async () => {
    mode = "crash";
    vi.stubGlobal("Worker", FakeWorker);
    const stop = mic();
    await expect(startDictationSession(files, {})).rejects.toThrow(/module failed/);
    expect(stop).toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalled();
  });

  it("Web Audio that cannot be set up releases the microphone and the worker", async () => {
    mode = "ready";
    vi.stubGlobal("Worker", FakeWorker);
    vi.stubGlobal(
      "AudioContext",
      class {
        constructor() {
          throw new Error("no audio device");
        }
      },
    );
    const stop = mic();
    await expect(startDictationSession(files, {})).rejects.toThrow(/no audio device/);
    expect(stop).toHaveBeenCalled();
    expect(workers[0].terminate).toHaveBeenCalled();
  });
});

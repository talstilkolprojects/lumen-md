/**
 * Neural voice worker (plan W2.6): a Piper-format VITS voice in
 * onnxruntime-web (MIT), WASM, one thread (no cross-origin isolation
 * needed). Same loading pattern as the niqqud worker.
 *
 *   → { type: "load", id, model: ArrayBuffer, ortBase }
 *   → { type: "synth", id, ids: number[], scales: [noise, length, noise_w], speaker? }
 *   ← { type: "result", id, value } | { type: "error", id, message }
 *
 * `synth` answers { audio: Float32Array (transferred), ms } — the audio at
 * the voice's sample rate, and how long inference took.
 */
import * as ort from "onnxruntime-web/wasm";

type In =
  | { type: "load"; id: number; model: ArrayBuffer; ortBase: string }
  | { type: "synth"; id: number; ids: number[]; scales: [number, number, number]; speaker?: number };

let session: ort.InferenceSession | null = null;

const post = (m: unknown, transfer: Transferable[] = []) => (self as unknown as { postMessage(m: unknown, t: Transferable[]): void }).postMessage(m, transfer);

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  try {
    if (msg.type === "load") {
      ort.env.wasm.wasmPaths = { mjs: `${msg.ortBase}ort-wasm-simd-threaded.mjs`, wasm: `${msg.ortBase}ort-wasm-simd-threaded.wasm` };
      ort.env.wasm.numThreads = 1;
      session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: ["wasm"] });
      post({ type: "result", id: msg.id, value: true });
      return;
    }
    if (!session) throw new Error("voice not loaded");
    const t0 = performance.now();
    const ids = BigInt64Array.from(msg.ids.map((x) => BigInt(x)));
    const feeds: Record<string, ort.Tensor> = {
      input: new ort.Tensor("int64", ids, [1, ids.length]),
      input_lengths: new ort.Tensor("int64", BigInt64Array.from([BigInt(ids.length)]), [1]),
      scales: new ort.Tensor("float32", Float32Array.from(msg.scales), [3]),
    };
    if (msg.speaker !== undefined && session.inputNames.includes("sid")) feeds.sid = new ort.Tensor("int64", BigInt64Array.from([BigInt(msg.speaker)]), [1]);
    const out = await session.run(feeds);
    const audio = Float32Array.from(out[session.outputNames[0]].data as Float32Array);
    post({ type: "result", id: msg.id, value: { audio, ms: performance.now() - t0 } }, [audio.buffer]);
  } catch (err) {
    post({ type: "error", id: msg.id, message: (err as Error)?.message ?? String(err) });
  }
};

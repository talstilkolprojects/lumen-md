/// <reference lib="webworker" />
/**
 * Niqqud worker (plan 6.3): Nakdimon (MIT, ≈ 21 MB ONNX) in onnxruntime-web
 * on wasm. The model bytes come from the main thread (downloaded with
 * consent and verified against models/registry.json); nothing is fetched
 * here except ONNX Runtime's own same-origin wasm (public/ort/).
 */
import * as ort from "onnxruntime-web/wasm";
import { addNikud } from "../text/nikudRun";

type In =
  | { type: "load"; id: number; model: ArrayBuffer; ortBase: string }
  | { type: "point"; id: number; text: string; partial?: boolean }
  | { type: "cancel"; target: number };
type Out = { type: "result"; id: number; value: unknown } | { type: "error"; id: number; message: string; name?: string };

let session: ort.InferenceSession | null = null;
const cancelled = new Set<number>();
const post = (m: Out) => (self as unknown as Worker).postMessage(m);

async function infer(ids: Int32Array, rows: number, length: number) {
  const s = session!;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("int32", ids, [rows, length]) });
  return { N: out.N.data as Float32Array, D: out.D.data as Float32Array, S: out.S.data as Float32Array };
}

self.onmessage = async (e: MessageEvent<In>) => {
  const msg = e.data;
  if (msg.type === "cancel") {
    cancelled.add(msg.target);
    return;
  }
  try {
    if (msg.type === "load") {
      ort.env.wasm.wasmPaths = { mjs: `${msg.ortBase}ort-wasm-simd-threaded.mjs`, wasm: `${msg.ortBase}ort-wasm-simd-threaded.wasm` };
      ort.env.wasm.numThreads = 1; // no cross-origin isolation needed
      session = await ort.InferenceSession.create(new Uint8Array(msg.model), { executionProviders: ["wasm"] });
      post({ type: "result", id: msg.id, value: true });
      return;
    }
    if (!session) throw new Error("niqqud model not loaded");
    const signal = { get aborted() {
      return cancelled.has(msg.id);
    } } as AbortSignal;
    const value = await addNikud(msg.text, infer, { partial: msg.partial, signal });
    post({ type: "result", id: msg.id, value });
  } catch (err) {
    post({ type: "error", id: msg.id, message: (err as Error)?.message ?? String(err), name: (err as Error)?.name });
  } finally {
    if (msg.type === "point") cancelled.delete(msg.id);
  }
};

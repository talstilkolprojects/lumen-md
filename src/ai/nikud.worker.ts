/// <reference lib="webworker" />
/**
 * Niqqud worker (plan 6.3): Nakdimon (MIT, ≈ 21 MB ONNX) in onnxruntime-web
 * on wasm — or, as the high-quality layer (plan W2.5), DictaBERT-char-menaked
 * (CC BY 4.0, int8 ONNX) with its menaked.json. The model bytes come from the main thread (downloaded with
 * consent and verified against models/registry.json); nothing is fetched
 * here except ONNX Runtime's own same-origin wasm (public/ort/).
 */
import * as ort from "onnxruntime-web/wasm";
import { decodeMenaked, encodeMenaked, type MenakedSpec } from "../text/menaked";
import { addNikudDetailed, nakdimonEngine, type NikudEngine } from "../text/nikudRun";

type In =
  | { type: "load"; id: number; model: ArrayBuffer; ortBase: string; kind?: "nakdimon" | "menaked"; spec?: MenakedSpec }
  | { type: "point"; id: number; text: string; partial?: boolean }
  | { type: "cancel"; target: number };
type Out = { type: "result"; id: number; value: unknown } | { type: "error"; id: number; message: string; name?: string };

let session: ort.InferenceSession | null = null;
let engine: NikudEngine | null = null;
const cancelled = new Set<number>();
const post = (m: Out) => (self as unknown as Worker).postMessage(m);

async function infer(ids: Int32Array, rows: number, length: number) {
  const s = session!;
  const out = await s.run({ [s.inputNames[0]]: new ort.Tensor("int32", ids, [rows, length]) });
  return { N: out.N.data as Float32Array, D: out.D.data as Float32Array, S: out.S.data as Float32Array };
}

/** DictaBERT-char-menaked behind the engine interface: [CLS] chars [SEP] in, niqqud and shin logits out. */
function menakedEngine(s: ort.InferenceSession, spec: MenakedSpec): NikudEngine {
  return {
    maxlen: spec.maxTokens - 1,
    async run(batch) {
      const { ids, mask, length } = encodeMenaked(batch, spec);
      const dims = [batch.length, length];
      const feeds: Record<string, ort.Tensor> = { [spec.inputs.ids]: new ort.Tensor("int64", ids, dims), [spec.inputs.mask]: new ort.Tensor("int64", mask, dims) };
      if (spec.inputs.types) feeds[spec.inputs.types] = new ort.Tensor("int64", new BigInt64Array(ids.length), dims);
      const out = await s.run(feeds);
      const logits = { nikud: out[spec.outputs.nikud].data as Float32Array, shin: out[spec.outputs.shin].data as Float32Array };
      return batch.map((chunk, row) => decodeMenaked(chunk, logits, row, length, spec));
    },
  };
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
      engine = msg.kind === "menaked" && msg.spec ? menakedEngine(session, msg.spec) : nakdimonEngine(infer);
      post({ type: "result", id: msg.id, value: true });
      return;
    }
    if (!session || !engine) throw new Error("niqqud model not loaded");
    const signal = { get aborted() {
      return cancelled.has(msg.id);
    } } as AbortSignal;
    // The text and, per pointed word, its alternatives (W2.5).
    const value = await addNikudDetailed(msg.text, engine, { partial: msg.partial, signal });
    post({ type: "result", id: msg.id, value });
  } catch (err) {
    post({ type: "error", id: msg.id, message: (err as Error)?.message ?? String(err), name: (err as Error)?.name });
  } finally {
    if (msg.type === "point") cancelled.delete(msg.id);
  }
};

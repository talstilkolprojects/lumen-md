/**
 * Plan 6.1 — the live dictation engine's pure parts: Kaldi fbank (frame
 * count, streaming = batch, a tone lands in its mel bin), the ONNX metadata
 * reader, the encoder's state layout and detokenisation. The model itself
 * is exercised end to end in the ASR workflow (WER parity with sherpa-onnx).
 */
import { describe, it, expect } from "vitest";
import { OnlineFbank, framesReady, NUM_BINS } from "../ai/dictation/fbank";
import { onnxMetadata, intList } from "../ai/dictation/onnxMeta";
import { detokenize, encoderLayout, parseTokens } from "../ai/dictation/zipformer";

const tone = (hz: number, seconds: number) => Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * hz * i) / 16000));

describe("OnlineFbank", () => {
  it("counts frames like Kaldi with snip_edges = false", () => {
    expect(framesReady(16000, true)).toBe(100);
    expect(framesReady(16000, false)).toBe(99);
    expect(framesReady(100, false)).toBe(0);
    expect(framesReady(100, true)).toBe(1);
  });

  it("gives the same frames whether the audio comes at once or in slices", () => {
    const x = tone(440, 1.3);
    const a = new OnlineFbank();
    a.accept(x);
    a.finish();
    const all = a.frames();
    const b = new OnlineFbank();
    const sliced: Float32Array[] = [];
    for (let i = 0; i < x.length; i += 1234) {
      b.accept(x.subarray(i, i + 1234));
      sliced.push(...b.frames());
    }
    b.finish();
    sliced.push(...b.frames());
    expect(sliced.length).toBe(all.length);
    expect(all.length).toBe(130);
    for (let f = 0; f < all.length; f++) for (let k = 0; k < NUM_BINS; k++) expect(sliced[f][k]).toBeCloseTo(all[f][k], 4);
  });

  it("puts a 1 kHz tone in the mel bin centred near 1 kHz", () => {
    const fb = new OnlineFbank();
    fb.accept(tone(1000, 0.5));
    const frame = fb.frames()[20];
    const mel = (f: number) => 1127 * Math.log(1 + f / 700);
    const delta = (mel(7600) - mel(20)) / 81;
    const expected = Math.round((mel(1000) - mel(20)) / delta - 1);
    const argmax = frame.indexOf(Math.max(...frame));
    expect(Math.abs(argmax - expected)).toBeLessThanOrEqual(1);
  });

  it("floors silence at log(FLT_EPSILON)", () => {
    const fb = new OnlineFbank();
    fb.accept(new Float32Array(1600));
    fb.finish();
    expect(fb.frames()[3][10]).toBeCloseTo(Math.log(1.1920928955078125e-7), 4);
  });
});

/** A protobuf varint. */
const v = (n: number) => {
  const out = [];
  while (n >= 0x80) {
    out.push((n & 0x7f) | 0x80);
    n = Math.floor(n / 128);
  }
  out.push(n);
  return out;
};
const bytes = (field: number, data: number[]) => [...v(field * 8 + 2), ...v(data.length), ...data];
const str = (field: number, s: string) => bytes(field, [...new TextEncoder().encode(s)]);
const entry = (k: string, value: string) => bytes(14, [...str(1, k), ...str(2, value)]);

describe("onnxMetadata", () => {
  it("reads metadata_props and skips the other fields", () => {
    const model = new Uint8Array([...v(1 * 8), ...v(8), ...bytes(7, new Array(300).fill(7)), ...entry("model_type", "zipformer2"), ...entry("T", "77"), ...entry("encoder_dims", "192,256,384")]);
    const meta = onnxMetadata(model);
    expect(meta).toEqual({ model_type: "zipformer2", T: "77", encoder_dims: "192,256,384" });
    expect(intList(meta, "encoder_dims")).toEqual([192, 256, 384]);
    expect(() => intList(meta, "nope")).toThrow(/missing/);
  });
});

describe("encoderLayout", () => {
  it("lays out six cached tensors per layer, then embed_states and processed_lens", () => {
    const meta = {
      encoder_dims: "192,256",
      query_head_dims: "32,32",
      value_head_dims: "12,12",
      num_heads: "4,8",
      num_encoder_layers: "2,1",
      cnn_module_kernels: "31,15",
      left_context_len: "128,64",
      T: "77",
      decode_chunk_len: "64",
    };
    const l = encoderLayout(meta);
    expect(l.T).toBe(77);
    expect(l.decodeChunkLen).toBe(64);
    expect(l.states).toHaveLength(3 * 6 + 2);
    expect(l.states[0].dims).toEqual([128, 1, 128]); // cached_key: left, N, 32·4
    expect(l.states[1].dims).toEqual([1, 1, 128, 144]); // nonlin attn: 3·192/4
    expect(l.states[2].dims).toEqual([128, 1, 48]); // val1: 12·4
    expect(l.states[4].dims).toEqual([1, 192, 15]); // conv: kernel / 2
    expect(l.states[12].dims).toEqual([64, 1, 256]); // stack 2: 32·8
    expect(l.states[18].dims).toEqual([1, 128, 3, 19]);
    expect(l.states[19]).toEqual({ dims: [1], int64: true });
  });
});

describe("tokens", () => {
  it("parses tokens.txt and joins SentencePiece pieces", () => {
    const syms = parseTokens("<blk> 0\n<sos/eos> 1\n▁של 2\nום 3\n▁עולם 4\n");
    expect(syms[2]).toBe("▁של");
    expect(detokenize([syms[2], syms[3], syms[4]])).toBe("שלום עולם");
  });
  it("decodes byte tokens as UTF-8", () => {
    expect(detokenize(["▁a", "<0xE2>", "<0x82>", "<0xAA>"])).toBe("a₪");
  });
});

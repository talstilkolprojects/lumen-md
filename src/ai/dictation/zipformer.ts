/**
 * Streaming Zipformer2 transducer on ONNX Runtime Web — live dictation's
 * engine (plan 6.1), a TypeScript port of what sherpa-onnx does with the
 * same files (OnlineZipformer2TransducerModel + greedy search):
 *
 *   audio → OnlineFbank (80-dim, Kaldi) → every `decodeChunkLen` frames the
 *   encoder runs on T frames with its cached states → for each output frame
 *   the joiner picks a token (greedy, ≤ 1 per frame) → the decoder is re-run
 *   on the last `contextSize` tokens after each one.
 *
 * Model: the ivrit.ai Zipformer2 streaming export for sherpa-onnx
 * (encoder / decoder / joiner .int8.onnx + tokens.txt). The encoder's layer
 * sizes come from its ONNX metadata, as in sherpa-onnx. ONNX Runtime is
 * passed in (the app's same-origin wasm build; onnxruntime-web in Node for
 * the CI eval), so this module loads nothing by itself.
 */
import type * as Ort from "onnxruntime-web";
import { OnlineFbank, NUM_BINS } from "./fbank";
import { intList, onnxMetadata } from "./onnxMeta";

type OrtModule = Pick<typeof Ort, "InferenceSession" | "Tensor">;
type Session = Ort.InferenceSession;
type Tensor = Ort.Tensor;

export interface ZipformerFiles {
  encoder: Uint8Array;
  decoder: Uint8Array;
  joiner: Uint8Array;
  tokens: string;
}

export interface Hypothesis {
  text: string;
  tokens: string[];
  /** Start time of each token, seconds from the start of the stream. */
  timestamps: number[];
}

/** Seconds per encoder output frame: 10 ms features, subsampled 4×. */
const OUTPUT_FRAME_S = 0.04;
/** icefall's padding value for features (log 1e-10). */
const LOG_EPS = Math.log(1e-10);

export function parseTokens(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(.*)\s+(\d+)$/.exec(line);
    if (m) out[Number(m[2])] = m[1];
  }
  return out;
}

/** Text of a token sequence: SentencePiece word markers become spaces, byte tokens are decoded as UTF-8. */
export function detokenize(symbols: string[]): string {
  const bytes: number[] = [];
  let text = "";
  const flush = () => {
    if (bytes.length) text += new TextDecoder().decode(new Uint8Array(bytes.splice(0)));
  };
  for (const s of symbols) {
    const b = /^<0x([0-9A-Fa-f]{2})>$/.exec(s);
    if (b) bytes.push(Number.parseInt(b[1], 16));
    else {
      flush();
      text += s;
    }
  }
  flush();
  return text.replace(/▁/g, " ").replace(/\s+/g, " ").trim();
}

export interface EncoderLayout {
  T: number;
  decodeChunkLen: number;
  /** Initial state shapes, in the encoder's input order after `x`. */
  states: { dims: number[]; int64: boolean }[];
}

/** The encoder's chunk sizes and initial states from its metadata (sherpa-onnx GetEncoderInitStates). */
export function encoderLayout(meta: Record<string, string>): EncoderLayout {
  const dims = intList(meta, "encoder_dims");
  const qk = intList(meta, "query_head_dims");
  const v = intList(meta, "value_head_dims");
  const heads = intList(meta, "num_heads");
  const layers = intList(meta, "num_encoder_layers");
  const kernels = intList(meta, "cnn_module_kernels");
  const left = intList(meta, "left_context_len");
  const states: EncoderLayout["states"] = [];
  for (let i = 0; i < dims.length; i++) {
    const keyDim = qk[i] * heads[i];
    const valueDim = v[i] * heads[i];
    const nonlin = (3 * dims[i]) / 4;
    for (let j = 0; j < layers[i]; j++) {
      states.push({ dims: [left[i], 1, keyDim], int64: false }); // cached_key
      states.push({ dims: [1, 1, left[i], nonlin], int64: false }); // cached_nonlin_attn
      states.push({ dims: [left[i], 1, valueDim], int64: false }); // cached_val1
      states.push({ dims: [left[i], 1, valueDim], int64: false }); // cached_val2
      states.push({ dims: [1, dims[i], Math.floor(kernels[i] / 2)], int64: false }); // cached_conv1
      states.push({ dims: [1, dims[i], Math.floor(kernels[i] / 2)], int64: false }); // cached_conv2
    }
  }
  const featDim = Number(meta.feature_dim ?? NUM_BINS);
  states.push({ dims: [1, 128, 3, Math.floor((Math.floor((featDim - 1) / 2) - 1) / 2)], int64: false }); // embed_states
  states.push({ dims: [1], int64: true }); // processed_lens
  return { T: Number(meta.T), decodeChunkLen: Number(meta.decode_chunk_len), states };
}

/** Loaded model, shared by every stream. */
export class ZipformerModel {
  private constructor(
    readonly ort: OrtModule,
    readonly encoder: Session,
    readonly decoder: Session,
    readonly joiner: Session,
    readonly layout: EncoderLayout,
    readonly contextSize: number,
    readonly symbols: string[],
  ) {}

  static async load(ort: OrtModule, files: ZipformerFiles, options: Ort.InferenceSession.SessionOptions = {}): Promise<ZipformerModel> {
    const opts: Ort.InferenceSession.SessionOptions = { executionProviders: ["wasm"], graphOptimizationLevel: "all", ...options };
    const layout = encoderLayout(onnxMetadata(files.encoder));
    const contextSize = Number(onnxMetadata(files.decoder).context_size ?? 2);
    const [encoder, decoder, joiner] = await Promise.all([
      ort.InferenceSession.create(files.encoder, opts),
      ort.InferenceSession.create(files.decoder, opts),
      ort.InferenceSession.create(files.joiner, opts),
    ]);
    if (encoder.inputNames.length !== layout.states.length + 1) {
      throw new Error(`zipformer: the encoder has ${encoder.inputNames.length} inputs, its metadata describes ${layout.states.length + 1}`);
    }
    return new ZipformerModel(ort, encoder, decoder, joiner, layout, contextSize, parseTokens(files.tokens));
  }

  createStream(): ZipformerStream {
    return new ZipformerStream(this);
  }

  async release(): Promise<void> {
    await Promise.all([this.encoder.release(), this.decoder.release(), this.joiner.release()]);
  }
}

export class ZipformerStream {
  private readonly fbank = new OnlineFbank();
  private features: Float32Array[] = [];
  /** Absolute index of features[0]. */
  private featBase = 0;
  private processed = 0;
  private states: Tensor[];
  private decoderOut: Tensor | null = null;
  private context: number[];
  private outFrames = 0;
  private finished = false;
  readonly ids: number[] = [];
  readonly times: number[] = [];

  constructor(private readonly m: ZipformerModel) {
    const { Tensor } = m.ort;
    this.states = m.layout.states.map((s) => {
      const size = s.dims.reduce((a, b) => a * b, 1);
      return s.int64 ? new Tensor("int64", new BigInt64Array(size), s.dims) : new Tensor("float32", new Float32Array(size), s.dims);
    });
    this.context = Array.from({ length: m.contextSize }, (_, i) => (i === m.contextSize - 1 ? 0 : -1));
  }

  /** Audio at 16 kHz, samples in [-1, 1]. */
  acceptWaveform(samples: Float32Array): void {
    this.fbank.accept(samples);
    this.features.push(...this.fbank.frames());
  }

  inputFinished(): void {
    this.finished = true;
    this.fbank.finish();
    this.features.push(...this.fbank.frames());
  }

  /** Is a chunk of features ready for the encoder? */
  isReady(): boolean {
    return this.featBase + this.features.length - this.processed >= this.m.layout.T;
  }

  /** Run every ready chunk. */
  async decode(): Promise<void> {
    while (this.isReady()) await this.decodeChunk();
  }

  private async decodeChunk(): Promise<void> {
    const { T, decodeChunkLen } = this.m.layout;
    const x = new Float32Array(T * NUM_BINS);
    for (let i = 0; i < T; i++) x.set(this.features[this.processed - this.featBase + i], i * NUM_BINS);
    this.processed += decodeChunkLen;
    const drop = this.processed - this.featBase;
    this.features.splice(0, drop);
    this.featBase += drop;

    const { encoderOut, states } = await this.runEncoder(x);
    const old = this.states;
    this.states = states;
    for (const s of old) s.dispose?.();
    const search = { context: this.context, decoderOut: this.decoderOut ?? (await this.runDecoder(this.context)), ids: this.ids, times: this.times };
    await this.greedy(encoderOut, search, Infinity, true);
    this.context = search.context;
    this.decoderOut = search.decoderOut;
    this.outFrames += encoderOut.dims[1] as number;
    encoderOut.dispose?.();
  }

  private async runEncoder(x: Float32Array): Promise<{ encoderOut: Tensor; states: Tensor[] }> {
    const { T } = this.m.layout;
    const { Tensor } = this.m.ort;
    const enc = this.m.encoder;
    const feeds: Record<string, Tensor> = { [enc.inputNames[0]]: new Tensor("float32", x, [1, T, NUM_BINS]) };
    this.states.forEach((s, i) => (feeds[enc.inputNames[i + 1]] = s));
    const out = await enc.run(feeds);
    return { encoderOut: out[enc.outputNames[0]], states: enc.outputNames.slice(1).map((n) => out[n]) };
  }

  private async runDecoder(context: number[]): Promise<Tensor> {
    const { Tensor } = this.m.ort;
    const dec = this.m.decoder;
    const y = new Tensor("int64", BigInt64Array.from(context.map(BigInt)), [1, this.m.contextSize]);
    const out = await dec.run({ [dec.inputNames[0]]: y });
    return out[dec.outputNames[0]];
  }

  /** Greedy search over `frames` encoder frames; `commit` = the search state is the stream's own. */
  private async greedy(encoderOut: Tensor, st: { context: number[]; decoderOut: Tensor; ids: number[]; times: number[] }, maxFrames: number, commit: boolean): Promise<void> {
    const { Tensor } = this.m.ort;
    const [, total, dim] = encoderOut.dims as number[];
    const frames = Math.min(total, maxFrames);
    const data = encoderOut.data as Float32Array;
    const join = this.m.joiner;
    const [encName, decName] = join.inputNames.includes("encoder_out") ? ["encoder_out", "decoder_out"] : join.inputNames;
    let owned = false; // a decoder output this search created (never the stream's committed one, when peeking)
    for (let t = 0; t < frames; t++) {
      const e = new Tensor("float32", data.slice(t * dim, (t + 1) * dim), [1, dim]);
      const out = await join.run({ [encName]: e, [decName]: st.decoderOut });
      e.dispose?.();
      const logits = out[join.outputNames[0]].data as Float32Array;
      let best = 0;
      for (let k = 1; k < logits.length; k++) if (logits[k] > logits[best]) best = k;
      if (best !== 0 && this.m.symbols[best] !== "<unk>") {
        st.ids.push(best);
        st.times.push((this.outFrames + t) * OUTPUT_FRAME_S);
        st.context = [...st.context.slice(1), best];
        if (commit || owned) st.decoderOut.dispose?.();
        st.decoderOut = await this.runDecoder(st.context);
        owned = true;
      }
    }
    if (!commit && owned) st.decoderOut.dispose?.();
  }

  /**
   * An interim hypothesis before the next chunk is complete: the encoder
   * runs on the frames received so far, padded with silence (log 1e-10, as
   * icefall pads), from the committed states — which are left untouched —
   * and the search continues only over frames backed by real audio. Costs
   * one encoder run; the committed result is unchanged.
   */
  async peek(): Promise<Hypothesis> {
    const { T } = this.m.layout;
    const have = this.featBase + this.features.length - this.processed;
    if (have < 16) return this.result();
    const x = new Float32Array(T * NUM_BINS).fill(LOG_EPS);
    for (let i = 0; i < Math.min(have, T); i++) x.set(this.features[this.processed - this.featBase + i], i * NUM_BINS);
    const { encoderOut, states } = await this.runEncoder(x);
    for (const s of states) s.dispose?.();
    const search = { context: this.context, decoderOut: this.decoderOut ?? (await this.runDecoder(this.context)), ids: [...this.ids], times: [...this.times] };
    if (!this.decoderOut) this.decoderOut = search.decoderOut;
    await this.greedy(encoderOut, search, Math.floor(have / 4), false);
    encoderOut.dispose?.();
    const tokens = search.ids.map((i) => this.m.symbols[i] ?? "");
    return { text: detokenize(tokens), tokens, timestamps: search.times };
  }

  result(): Hypothesis {
    const tokens = this.ids.map((i) => this.m.symbols[i] ?? "");
    return { text: detokenize(tokens), tokens, timestamps: [...this.times] };
  }

  get isFinished(): boolean {
    return this.finished;
  }
}

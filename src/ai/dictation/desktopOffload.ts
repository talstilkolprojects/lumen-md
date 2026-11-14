/**
 * "Send this dictation to my desktop" (plan W6.19). Hebrew dictation on a
 * phone runs the streaming Zipformer, measured at 23.6 % WER on FLEURS-he
 * (plan 6.1), and a phone rarely holds the turbo Whisper that re-reads each
 * sentence. When this device's WER is over the 15 % target (measured, or
 * estimated from the engines this class of device runs) and the user's own
 * desktop is linked over the LAN sync (plan W2.19), each finished sentence's
 * audio goes to the desktop instead, is transcribed there with the bigger
 * model (whisper.cpp with ivrit.ai turbo, W1.17, or turbo on WebGPU), and the
 * text comes back.
 *
 * Privacy: the only transport is the LAN link — a WebRTC data channel with no
 * STUN, TURN or signaling server, between local-network addresses only — and
 * the audio and the text are also sealed with the vault's own keys
 * (AES-256-GCM, bound to the request id and direction), so they would stay
 * opaque even to a transport that could read them. No third-party server is
 * involved; nothing leaves the local network.
 *
 *   peer → host  svc.dictation.status                        → {v, ready, engine, reason?}
 *   peer → host  svc.dictation.transcribe {v, rid, language, samples, deadlineMs}
 *                + seal(blobs, "dictation-audio", rid, PCM16) → {v, rid, engine, computeMs}
 *                                                               + seal(blobs, "dictation-text", rid, JSON {text})
 *   peer → host  svc.dictation.cancel {v, rid}                 → {v, rid, cancelled}
 *
 * The desktop's side (review 6): a sentence the phone gave up on (its
 * deadline passed, or it cancelled) gives back its place at once and never
 * starts, and only the device that sent it can cancel it; the payload's size
 * is checked against the header before anything is decrypted; and a link
 * whose address is unknown counts as not local.
 *
 * Never costs the user their words: a sentence the desktop doesn't answer in
 * time (OFFLOAD_MS_PER_MINUTE) keeps this device's streaming text.
 *
 * Either device may be the one that hosts the vault: the phone asks the
 * desktop over whichever side of the link it has (LAN services run both
 * ways, lan/rpc.ts).
 *
 * Lazy: loaded by the dictation panel and by the LAN pairing dialog.
 */
import { fromB64u, randomBytes, toB64u, utf8 } from "../../sync/e2ee/bytes";
import { padLength, seal, unseal, type VaultKeys } from "../../sync/e2ee/keys";
import { isLanHost } from "../../sync/e2ee/lan/address";
import type { LanService, LanServiceReply } from "../../sync/e2ee/lan/rpc";
import { CORRECTION_MAX_SECONDS, pickText, type SegmentCorrector } from "./correction";
import type { EngineId } from "./engines";
import measuredWer from "./measuredWer.json";

/** The engines a measurement may name (engines.ts EngineId). */
const KNOWN_ENGINES: ReadonlySet<string> = new Set<EngineId>(["zipformer-he", "whisper-cpp-he", "whisper-turbo-he", "ozen-he", "whisper-base", "whisper-live", "web-speech"]);

export const OFFLOAD_PROTOCOL = 1;
export const OP_STATUS = "svc.dictation.status";
export const OP_TRANSCRIBE = "svc.dictation.transcribe";
export const OP_CANCEL = "svc.dictation.cancel";
const AUDIO_KIND = "dictation-audio";
const TEXT_KIND = "dictation-text";
const RATE = 16_000;

/** Plan W6.19: the round trip, desktop transcription included, stays under 10 s per minute of audio. */
export const OFFLOAD_MS_PER_MINUTE = 10_000;
/** A short sentence still gets this long (the link's round trip and the desktop's model warm-up). */
export const OFFLOAD_MIN_MS = 2_500;
/** The plan's dictation target on a phone (W4.13, W6.19). */
export const MOBILE_WER_TARGET = 0.15;
/** Sentences the desktop holds at once; more are refused ("busy") and keep this device's text. */
export const MAX_QUEUE = 4;
/** A deadline shorter than this can't be met by any model over the link: refused at once, never run. */
export const MIN_DEADLINE_MS = 250;
const MAX_SAMPLES = CORRECTION_MAX_SECONDS * RATE;
/** The sealed size of `samples` 16-bit samples (keys.ts seal: format byte, nonce, padded data, tag). */
export const sealedAudioBytes = (samples: number): number => 1 + 12 + padLength(samples * 2) + 16;

/** How long one sentence may take on the desktop before this device's text goes in. */
export function offloadDeadlineMs(samples: number): number {
  return Math.max(OFFLOAD_MIN_MS, Math.ceil((samples / RATE / 60) * OFFLOAD_MS_PER_MINUTE));
}

/* ─── How good is dictation on this device ─────────────────────────────── */

export interface WerFigure {
  wer: number;
  split: string;
  source: string;
}

/**
 * WER per engine as measured, never guessed (measuredWer.json). `npm run
 * models:cloud -- dictation` fills it from the signed report (W6.18/W6.19):
 * the held-out asr-he number where there is one, else FLEURS-he validation.
 * An engine that is not there has no measurement yet; a malformed entry is
 * dropped rather than trusted.
 */
export const MEASURED_WER: Partial<Record<EngineId, WerFigure>> = readMeasured(measuredWer);

export function readMeasured(raw: unknown): Partial<Record<EngineId, WerFigure>> {
  const out: Partial<Record<EngineId, WerFigure>> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [engine, v] of Object.entries(raw as Record<string, unknown>)) {
    const f = v as Partial<WerFigure> | null;
    if (!KNOWN_ENGINES.has(engine) || !f || typeof f.wer !== "number" || !Number.isFinite(f.wer) || f.wer < 0 || f.wer > 2) continue;
    out[engine as EngineId] = { wer: f.wer, split: typeof f.split === "string" ? f.split : "?", source: typeof f.source === "string" ? f.source : "?" };
  }
  return out;
}

export type DeviceClass = "phone" | "computer";

export interface WerEstimate {
  /** null: not measured for anything this device runs. */
  wer: number | null;
  basis: "measured-here" | "measured-engine" | "streaming-floor" | "unknown";
  /** The engine whose number it is. */
  engine: EngineId | null;
}

/**
 * The WER this device gets for live Hebrew dictation. A number measured on
 * this device wins. Otherwise the engines it runs decide: the Whisper that
 * re-reads each sentence (chooseCorrection) when that engine has a measured
 * WER, else the streaming Zipformer's — what the user gets at worst, since a
 * re-read only replaces a sentence it heard the same way.
 */
export function estimateDictationWer(ctx: { measuredHere?: number | null; correction: EngineId | null; table?: Partial<Record<EngineId, WerFigure>> }): WerEstimate {
  if (typeof ctx.measuredHere === "number" && Number.isFinite(ctx.measuredHere)) return { wer: ctx.measuredHere, basis: "measured-here", engine: ctx.correction ?? "zipformer-he" };
  const table = ctx.table ?? MEASURED_WER;
  const corrected = ctx.correction ? table[ctx.correction] : undefined;
  if (ctx.correction && corrected) return { wer: corrected.wer, basis: "measured-engine", engine: ctx.correction };
  const floor = table["zipformer-he"];
  if (floor) return { wer: floor.wer, basis: "streaming-floor", engine: "zipformer-he" };
  return { wer: null, basis: "unknown", engine: null };
}

/** What a phone of this class runs, for the estimate (engines.ts: chooseCorrection). */
export function deviceClassOf(hw: { mobile: boolean }): DeviceClass {
  return hw.mobile ? "phone" : "computer";
}

export interface DesktopStatus {
  ready: boolean;
  engine: EngineId | null;
  /** Why not, when not ready ("no-model", "locked", "unsupported", "unreachable", …). */
  reason?: string;
}

export interface OfferDecision {
  offer: boolean;
  reason: "not-hebrew" | "meets-target" | "unknown-wer" | "no-desktop" | "desktop-not-ready" | "desktop-not-better" | "offer";
  estimate: WerEstimate;
}

/**
 * Offer "send to my desktop" when this device's Hebrew dictation is over the
 * target and the linked desktop can do better: it runs a bigger model whose
 * WER is measured lower, or not measured yet (the desktop's engines are the
 * ones the plan measures for ≤ 10 %).
 */
export function shouldOfferDesktop(ctx: { language: string; estimate: WerEstimate; desktop: DesktopStatus | null; table?: Partial<Record<EngineId, WerFigure>> }): OfferDecision {
  const { estimate } = ctx;
  const no = (reason: OfferDecision["reason"]): OfferDecision => ({ offer: false, reason, estimate });
  if (ctx.language.split(/[-_]/)[0].toLowerCase() !== "he") return no("not-hebrew");
  if (estimate.wer === null) return no("unknown-wer");
  if (estimate.wer <= MOBILE_WER_TARGET) return no("meets-target");
  if (!ctx.desktop) return no("no-desktop");
  if (!ctx.desktop.ready || !ctx.desktop.engine) return no("desktop-not-ready");
  const theirs = (ctx.table ?? MEASURED_WER)[ctx.desktop.engine];
  if (theirs && theirs.wer >= estimate.wer) return no("desktop-not-better");
  return { offer: true, reason: "offer", estimate };
}

/* ─── The phone's side ─────────────────────────────────────────────────── */

/** The linked host's services (lan/index.ts peerService()), or an in-memory pair in the tests. */
export interface DesktopLink {
  /** The other device's LAN address, when the link knows it (null: the browser hides it). */
  address: string | null;
  keys: VaultKeys;
  call(op: string, header: Record<string, unknown>, payload?: Uint8Array, opts?: { timeoutMs?: number }): Promise<{ header: Record<string, unknown>; payload: Uint8Array }>;
}

export class NotLocalError extends Error {
  constructor() {
    super("The other device is not on the local network");
    this.name = "NotLocalError";
  }
}

/**
 * The link must be a local-network one; the LAN link already closes any
 * other, this checks again. An address the link doesn't know counts as not
 * local (review 6, RR6-520-3): the audio goes nowhere it can't be placed.
 */
function assertLocal(link: DesktopLink): void {
  if (link.address === null || !isLanHost(link.address)) throw new NotLocalError();
}

/** Can the linked desktop transcribe, and with what? Never throws: an unreachable desktop is "not ready". */
export async function desktopStatus(link: DesktopLink | null, timeoutMs = 1500): Promise<DesktopStatus | null> {
  if (!link) return null;
  try {
    assertLocal(link);
    const r = await link.call(OP_STATUS, { v: OFFLOAD_PROTOCOL }, undefined, { timeoutMs });
    const engine = typeof r.header.engine === "string" ? (r.header.engine as EngineId) : null;
    return { ready: r.header.ready === true && !!engine, engine, ...(typeof r.header.reason === "string" ? { reason: r.header.reason } : {}) };
  } catch (e) {
    return { ready: false, engine: null, reason: e instanceof NotLocalError ? "not-local" : ((e as { code?: string }).code ?? "unreachable") };
  }
}

/**
 * Of the devices linked over the LAN sync (lan/index.ts serviceLinks: the
 * host this device joined and the peers of the vault it hosts), the first
 * that is ready and gets the offer. The status checks run side by side, so a
 * device that doesn't answer costs one timeout, not one each.
 */
export async function chooseDesktopLink<L extends DesktopLink>(links: readonly L[], ctx: { language: string; estimate: WerEstimate; table?: Partial<Record<EngineId, WerFigure>>; timeoutMs?: number }): Promise<{ link: L; decision: OfferDecision } | null> {
  const statuses = await Promise.all(links.map((l) => desktopStatus(l, ctx.timeoutMs)));
  for (let i = 0; i < links.length; i++) {
    const decision = shouldOfferDesktop({ language: ctx.language, estimate: ctx.estimate, desktop: statuses[i], table: ctx.table });
    if (decision.offer) return { link: links[i], decision };
  }
  return null;
}

/** 16 kHz float samples → 16-bit little-endian PCM (whisperDesktop.ts toPcm16, kept here so this module stays small). */
export function pcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const x = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(i * 2, x < 0 ? Math.round(x * 0x8000) : Math.round(x * 0x7fff), true);
  }
  return out;
}

export function fromPcm16(bytes: Uint8Array): Float32Array {
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true);
    out[i] = v < 0 ? v / 0x8000 : v / 0x7fff;
  }
  return out;
}

export interface DesktopTranscript {
  text: string;
  engine: EngineId | null;
  computeMs: number | null;
  roundTripMs: number;
}

/** Send one sentence's audio to the desktop and get its text back. Rejects on a refusal, a timeout or a bad reply. */
export async function transcribeOnDesktop(link: DesktopLink, samples: Float32Array, opts: { language?: string; timeoutMs?: number; now?: () => number } = {}): Promise<DesktopTranscript> {
  assertLocal(link);
  if (!samples.length || samples.length > CORRECTION_MAX_SECONDS * RATE) throw new RangeError("a sentence is 0–30 s of audio");
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const rid = toB64u(randomBytes(16));
  const { keys } = link;
  const sealed = await seal(keys.blobs, keys.vaultId, AUDIO_KIND, rid, pcm16(samples));
  const deadlineMs = opts.timeoutMs ?? offloadDeadlineMs(samples.length);
  let r: Awaited<ReturnType<DesktopLink["call"]>>;
  try {
    // The deadline goes with it: the desktop drops the sentence once this device stops waiting (review 6, RR6-520-1).
    r = await link.call(OP_TRANSCRIBE, { v: OFFLOAD_PROTOCOL, rid, language: opts.language ?? "he", samples: samples.length, deadlineMs }, sealed, { timeoutMs: deadlineMs });
  } catch (e) {
    // Given up on here: tell the desktop, so it stops spending its model on it.
    void link.call(OP_CANCEL, { v: OFFLOAD_PROTOCOL, rid }, undefined, { timeoutMs: OFFLOAD_MIN_MS }).catch(() => undefined);
    throw e;
  }
  if (r.header.rid !== rid) throw new Error("the desktop answered another request");
  const body = JSON.parse(new TextDecoder().decode(await unseal(keys.blobs, keys.vaultId, TEXT_KIND, rid, r.payload))) as { text?: unknown };
  return {
    text: typeof body.text === "string" ? body.text : "",
    engine: typeof r.header.engine === "string" ? (r.header.engine as EngineId) : null,
    computeMs: typeof r.header.computeMs === "number" ? r.header.computeMs : null,
    roundTripMs: Math.round(now() - t0),
  };
}

/**
 * A live-dictation corrector (correction.ts SegmentCorrector) that re-reads
 * each sentence on the desktop. Never throws: a refusal, a dropped link or a
 * late answer keeps the streaming text, and `onMiss` says so once per kind.
 */
export function makeDesktopCorrector(link: DesktopLink, opts: { onMiss?: (why: string) => void; onResult?: (r: DesktopTranscript) => void } = {}): SegmentCorrector {
  return async (audio, streamingText) => {
    if (!audio.length || audio.length > CORRECTION_MAX_SECONDS * RATE) return streamingText;
    try {
      const r = await transcribeOnDesktop(link, audio);
      opts.onResult?.(r);
      return pickText(streamingText, r.text);
    } catch (e) {
      opts.onMiss?.((e as { code?: string }).code ?? (e as Error).name ?? "error");
      return streamingText;
    }
  };
}

/* ─── The desktop's side ───────────────────────────────────────────────── */

export interface DesktopEngine {
  status(): Promise<DesktopStatus>;
  /** 16 kHz mono samples → text, with the language forced. */
  transcribe(samples: Float32Array, language: string): Promise<{ text: string; engine: EngineId }>;
}

/** Serve dictation for the linked phones on this device (a LanHost's `serve`). Returns the function that stops serving. */
export function serveDesktopDictation(host: { serve(op: string, service: LanService): () => void }, engine: DesktopEngine, opts: { now?: () => number; maxQueue?: number } = {}): () => void {
  const now = opts.now ?? (() => performance.now());
  const maxQueue = opts.maxQueue ?? MAX_QUEUE;
  let queue: Promise<unknown> = Promise.resolve();
  /** Sentences taken and not finished: rid → its place (released at once when given up on). */
  const jobs = new Map<string, { peer: string; done: boolean; cancelled: boolean; release: () => void }>();
  const peerKey = (peer: { address: string | null; connectedAt?: number }) => `${peer.address ?? "?"}|${peer.connectedAt ?? 0}`;

  const status: LanService = async () => {
    const s = await engine.status().catch((): DesktopStatus => ({ ready: false, engine: null, reason: "error" }));
    return { header: { v: OFFLOAD_PROTOCOL, ready: s.ready, engine: s.engine, ...(s.reason ? { reason: s.reason } : {}) } };
  };

  const cancel: LanService = async ({ header, peer }) => {
    const rid = typeof header.rid === "string" ? header.rid : "";
    const job = jobs.get(rid);
    // Only the device that sent it can take it back.
    if (!job || job.peer !== peerKey(peer)) return { header: { v: OFFLOAD_PROTOCOL, rid, cancelled: false } };
    job.cancelled = true;
    job.release();
    return { header: { v: OFFLOAD_PROTOCOL, rid, cancelled: true } };
  };

  const transcribe: LanService = async ({ header, payload, keys, peer }): Promise<LanServiceReply> => {
    const rid = typeof header.rid === "string" ? header.rid : "";
    try {
      if (fromB64u(rid).length !== 16) return { header: { error: "bad-request" } };
    } catch {
      return { header: { error: "bad-request" } };
    }
    // An address the link doesn't know is not local (RR6-520-3).
    if (peer.address === null || !isLanHost(peer.address)) return { header: { error: "not-local" } };
    // Size before anything is decrypted (RR6-520-2): the header names the samples, the payload must be their sealed size.
    const n = header.samples;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_SAMPLES) return { header: { error: "too-long" } };
    if (payload.length !== sealedAudioBytes(n)) return { header: { error: "bad-request" } };
    const deadlineMs = typeof header.deadlineMs === "number" && Number.isFinite(header.deadlineMs) ? header.deadlineMs : offloadDeadlineMs(n);
    if (deadlineMs < MIN_DEADLINE_MS) return { header: { error: "deadline" } };
    if (jobs.has(rid)) return { header: { error: "bad-request" } };
    const who = peerKey(peer);
    // A place in the queue is taken before the first await, so a burst can't slip past the limit.
    if (jobs.size >= maxQueue) return { header: { error: "busy" } };
    const job = { peer: who, done: false, cancelled: false, release: () => {} };
    jobs.set(rid, job);
    // The phone stops waiting at its deadline: from then on this sentence costs nothing here.
    const timer = setTimeout(() => {
      job.cancelled = true;
      job.release();
    }, Math.min(deadlineMs, offloadDeadlineMs(MAX_SAMPLES) * 2));
    job.release = () => {
      if (job.done) return;
      job.done = true;
      clearTimeout(timer);
      jobs.delete(rid);
    };
    try {
      let audio: Uint8Array;
      try {
        audio = await unseal(keys.blobs, keys.vaultId, AUDIO_KIND, rid, payload);
      } catch {
        return { header: { error: "key" } };
      }
      const samples = fromPcm16(audio);
      if (samples.length !== n) return { header: { error: "bad-request" } };
      const language = typeof header.language === "string" && /^[a-z]{2,3}$/.test(header.language) ? header.language : "he";
      // One sentence at a time: the model is the bottleneck, and the order is the user's. One given up on is skipped.
      const run = queue.then(async () => {
        if (job.cancelled) return null;
        const t0 = now();
        const out = await engine.transcribe(samples, language);
        return { ...out, computeMs: Math.round(now() - t0) };
      });
      queue = run.catch(() => undefined);
      const out = await run;
      if (!out || job.cancelled) return { header: { error: "cancelled" } };
      const sealed = await seal(keys.blobs, keys.vaultId, TEXT_KIND, rid, utf8(JSON.stringify({ text: out.text })));
      return { header: { v: OFFLOAD_PROTOCOL, rid, engine: out.engine, computeMs: out.computeMs }, payload: sealed };
    } catch {
      return { header: { error: "engine" } };
    } finally {
      job.release();
    }
  };

  const offs = [host.serve(OP_STATUS, status), host.serve(OP_TRANSCRIBE, transcribe), host.serve(OP_CANCEL, cancel)];
  return () => {
    for (const off of offs) off();
  };
}

/**
 * The bigger model this desktop has, best first: whisper.cpp with the pinned
 * ivrit.ai turbo ggml in the desktop app (W1.17), else ivrit.ai turbo on
 * WebGPU when its files are already in this browser. Never downloads.
 */
export function appDesktopEngine(cacheMs = 60_000): DesktopEngine {
  type Choice = { engine: EngineId; transcribe: (s: Float32Array, language: string) => Promise<string> } | { reason: string };
  // The desktop app checks the model's size and sha256 on each status: once a minute is enough.
  let cached: { at: number; choice: Promise<Choice> } | null = null;
  const pick = (): Promise<Choice> => {
    if (!cached || performance.now() - cached.at > cacheMs) {
      const choice = choose();
      cached = { at: performance.now(), choice };
      choice.catch(() => (cached = null));
    }
    return cached.choice;
  };
  const choose = async (): Promise<Choice> => {
    const wd = await import("./whisperDesktop");
    const s = await wd.desktopWhisperStatus();
    if (s.kind === "ready") return { engine: "whisper-cpp-he", transcribe: async (x, language) => (await wd.transcribeDesktop(x, { language })).map((g) => g.text).join(" ").trim() };
    const { detectHardware, vramBudgetMB } = await import("../modelManager");
    const hw = await detectHardware();
    const { downloadedCorrectionModels } = await import("./correction");
    const { TURBO_VRAM_MB } = await import("./engines");
    if (!hw.mobile && hw.webgpu && hw.f16 && vramBudgetMB(hw) >= TURBO_VRAM_MB && (await downloadedCorrectionModels()).has("whisper-turbo-he")) {
      const te = await import("../transformersEngine");
      return { engine: "whisper-turbo-he", transcribe: async (x, language) => (await te.transcribeAudio(x, { language, model: te.WHISPER_MODELS.turboHe })).text };
    }
    return { reason: s.kind === "web" ? "no-model" : `whisper-${s.kind}` };
  };
  return {
    async status() {
      const p = await pick();
      return "engine" in p ? { ready: true, engine: p.engine } : { ready: false, engine: null, reason: p.reason };
    },
    async transcribe(samples, language) {
      const p = await pick();
      if (!("engine" in p)) throw new Error(p.reason);
      return { text: await p.transcribe(samples, language), engine: p.engine };
    },
  };
}

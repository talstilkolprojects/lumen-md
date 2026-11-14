/**
 * Plan W6.19 — "send this dictation to my desktop": when Hebrew dictation on
 * this device is over 15 % WER (measured, or estimated from what this class
 * of device runs), each finished sentence's audio goes to the user's own
 * desktop over the LAN sync link (W2.19), sealed with the vault's keys, is
 * transcribed there with the bigger model, and the text comes back.
 *
 * The real LAN host and peer (lan/rpc.ts) over an in-memory channel with LAN
 * latency, the real vault keys and sealing; the desktop's Whisper is a fake
 * with a set speed. The WebRTC link itself is lanSync's e2e test.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { deriveVaultKeys, seal, type VaultKeys } from "../sync/e2ee/keys";
import { memoryProvider } from "../sync/e2ee/provider";
import { memoryChannelPair } from "../sync/e2ee/lan/channel";
import { lanHost, remoteLanProvider, LanAuthError, LanHostLockedError } from "../sync/e2ee/lan/rpc";
import { randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import {
  MEASURED_WER,
  MOBILE_WER_TARGET,
  NotLocalError,
  OFFLOAD_MS_PER_MINUTE,
  OP_STATUS,
  OP_TRANSCRIBE,
  desktopStatus,
  estimateDictationWer,
  fromPcm16,
  makeDesktopCorrector,
  offloadDeadlineMs,
  pcm16,
  sealedAudioBytes,
  serveDesktopDictation,
  shouldOfferDesktop,
  transcribeOnDesktop,
  type DesktopEngine,
  type DesktopLink,
} from "../ai/dictation/desktopOffload";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function forbidFetch(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.reject(new Error("no network in a LAN offload"));
  }) as typeof fetch;
  return calls;
}

const master = (n: number) => new Uint8Array(32).fill(n);
const vault = (n = 7) => deriveVaultKeys(master(n), "vault-w619");

/** A sentence of audio: a 440 Hz tone, `seconds` long, at 16 kHz. */
const tone = (seconds: number) => Float32Array.from({ length: Math.round(seconds * 16000) }, (_, i) => 0.3 * Math.sin((2 * Math.PI * 440 * i) / 16000));

/** A fake desktop Whisper: `rtf` × the audio's length of compute (whisper.cpp turbo on a desktop GPU is about 0.05–0.15). */
function fakeDesktop(opts: { rtf?: number; text?: string; ready?: boolean; fail?: boolean } = {}) {
  const seen: Array<{ samples: number; language: string }> = [];
  const engine: DesktopEngine = {
    status: async () => (opts.ready === false ? { ready: false, engine: null, reason: "no-model" } : { ready: true, engine: "whisper-cpp-he" }),
    transcribe: async (samples, language) => {
      seen.push({ samples: samples.length, language });
      await new Promise((r) => setTimeout(r, Math.round((samples.length / 16) * (opts.rtf ?? 0.02))));
      if (opts.fail) throw new Error("whisper-cli failed");
      return { text: opts.text ?? "הפגישה נדחתה ליום חמישי.", engine: "whisper-cpp-he" };
    },
  };
  return { engine, seen };
}

/** A desktop host and a phone linked to it, both unlocked with the same vault, the phone proven. */
async function linked(opts: { latencyMs?: number; address?: string | null; phoneKeys?: VaultKeys; desktop?: ReturnType<typeof fakeDesktop>; prove?: boolean; lockHost?: boolean } = {}) {
  const keys = await vault();
  let hostKeys: VaultKeys | null = keys;
  const host = lanHost({ bucket: memoryProvider(), keys: () => hostKeys });
  const desktop = opts.desktop ?? fakeDesktop();
  const stop = serveDesktopDictation(host, desktop.engine);
  const frames: Uint8Array[] = [];
  const [hostEnd, phoneEnd] = memoryChannelPair({ latencyMs: opts.latencyMs ?? 2, onFrame: (_f, d) => frames.push(d) });
  host.attach(hostEnd, { address: opts.address === undefined ? "192.168.1.20" : opts.address });
  const remote = remoteLanProvider(phoneEnd);
  const phoneKeys = opts.phoneKeys ?? keys;
  if (opts.prove !== false) await remote.authenticate(phoneKeys);
  if (opts.lockHost) hostKeys = null;
  const link: DesktopLink = { address: opts.address === undefined ? "192.168.1.20" : opts.address, keys: phoneKeys, call: (op, h, p, o) => remote.service(op, h, p, o) };
  return { host, remote, link, desktop, frames, stop, keys };
}

const has = (hay: Uint8Array, needle: Uint8Array) => {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
};

describe("W6.19 when to offer the desktop", () => {
  it("estimates this device's WER: a number measured here wins, else the re-reading Whisper's measured WER, else the streaming Zipformer's 23.6 % (plan 6.1)", () => {
    expect(estimateDictationWer({ measuredHere: 0.31, correction: null })).toEqual({ wer: 0.31, basis: "measured-here", engine: "zipformer-he" });
    // A phone without a turbo on the device: the streaming engine's number.
    expect(estimateDictationWer({ correction: null })).toEqual({ wer: 0.236, basis: "streaming-floor", engine: "zipformer-he" });
    // Turbo re-reads, but nobody measured it yet: still the streaming floor, never a guess.
    expect(MEASURED_WER["whisper-turbo-he"]).toBeUndefined();
    expect(estimateDictationWer({ correction: "whisper-turbo-he" }).basis).toBe("streaming-floor");
    // Once the cloud run measures it, its number counts.
    expect(estimateDictationWer({ correction: "whisper-turbo-he", table: { ...MEASURED_WER, "whisper-turbo-he": { wer: 0.12, split: "held-out asr-he", source: "models:cloud" } } })).toEqual({ wer: 0.12, basis: "measured-engine", engine: "whisper-turbo-he" });
  });

  it("offers it only for Hebrew over 15 %, with a linked desktop that is ready and not known to be worse", () => {
    const over = estimateDictationWer({ correction: null });
    const ready = { ready: true, engine: "whisper-cpp-he" as const };
    expect(shouldOfferDesktop({ language: "he-IL", estimate: over, desktop: ready })).toMatchObject({ offer: true, reason: "offer" });
    expect(shouldOfferDesktop({ language: "en", estimate: over, desktop: ready }).reason).toBe("not-hebrew");
    expect(shouldOfferDesktop({ language: "he", estimate: { wer: MOBILE_WER_TARGET, basis: "measured-here", engine: "zipformer-he" }, desktop: ready }).reason).toBe("meets-target");
    expect(shouldOfferDesktop({ language: "he", estimate: { wer: null, basis: "unknown", engine: null }, desktop: ready }).reason).toBe("unknown-wer");
    expect(shouldOfferDesktop({ language: "he", estimate: over, desktop: null }).reason).toBe("no-desktop");
    expect(shouldOfferDesktop({ language: "he", estimate: over, desktop: { ready: false, engine: null, reason: "no-model" } }).reason).toBe("desktop-not-ready");
    expect(shouldOfferDesktop({ language: "he", estimate: over, desktop: ready, table: { ...MEASURED_WER, "whisper-cpp-he": { wer: 0.3, split: "x", source: "y" } } }).reason).toBe("desktop-not-better");
  });

  it("gives a sentence 10 s per minute of audio (at least 2.5 s for the round trip)", () => {
    expect(OFFLOAD_MS_PER_MINUTE).toBe(10_000);
    expect(offloadDeadlineMs(30 * 16000)).toBe(5000);
    expect(offloadDeadlineMs(16000)).toBe(2500);
  });
});

describe("W6.19 a sentence to the desktop and back, over the LAN link", () => {
  it("the desktop's text comes back, the audio and the text are sealed on the wire, and nothing leaves the device but the link", async () => {
    const fetches = forbidFetch();
    const d = await linked();
    expect(await desktopStatus(d.link)).toEqual({ ready: true, engine: "whisper-cpp-he" });
    const audio = tone(3);
    const correct = makeDesktopCorrector(d.link);
    expect(await correct(audio, "הפגישה נדחית ליום חמשי")).toBe("הפגישה נדחתה ליום חמישי.");
    expect(d.desktop.seen).toEqual([{ samples: audio.length, language: "he" }]);
    // On the wire: neither the PCM nor the transcript in the clear, in any frame.
    const wire = new Uint8Array(d.frames.reduce((n, f) => n + f.length, 0));
    let at = 0;
    for (const f of d.frames) {
      wire.set(f, at);
      at += f.length;
    }
    expect(has(wire, pcm16(audio).subarray(4000, 4032))).toBe(false);
    expect(has(wire, utf8("הפגישה נדחתה"))).toBe(false);
    expect(fetches).toEqual([]);
    d.stop();
  });

  it("a minute of dictation (two 30 s sentences) comes back in under 10 s, with LAN latency and a desktop at RTF 0.06", async () => {
    const d = await linked({ latencyMs: 5, desktop: fakeDesktop({ rtf: 0.06 }) });
    let total = 0;
    for (let i = 0; i < 2; i++) {
      const r = await transcribeOnDesktop(d.link, tone(30));
      expect(r.engine).toBe("whisper-cpp-he");
      total += r.roundTripMs;
    }
    expect(total).toBeLessThan(OFFLOAD_MS_PER_MINUTE);
    d.stop();
  });

  it("PCM survives the trip: 16-bit samples within one step", () => {
    const x = tone(0.1);
    const y = fromPcm16(pcm16(x));
    expect(y.length).toBe(x.length);
    expect(Math.max(...x.map((v, i) => Math.abs(v - y[i])))).toBeLessThan(1 / 16000);
  });

  it("never costs the user their words: a late, failed, busy or refused desktop keeps this device's text", async () => {
    const misses: string[] = [];
    const slow = await linked({ desktop: fakeDesktop({ rtf: 2 }) });
    expect(await makeDesktopCorrector(slow.link, { onMiss: (w) => misses.push(w) })(tone(2), "הטקסט של הטלפון")).toBe("הטקסט של הטלפון");
    const failing = await linked({ desktop: fakeDesktop({ fail: true }) });
    expect(await makeDesktopCorrector(failing.link, { onMiss: (w) => misses.push(w) })(tone(1), "הטקסט של הטלפון")).toBe("הטקסט של הטלפון");
    // Another vault's keys on the phone: the desktop can't open the audio.
    const other = await vault(9);
    const stranger = await linked({ phoneKeys: other, prove: false });
    expect(await makeDesktopCorrector(stranger.link, { onMiss: (w) => misses.push(w) })(tone(1), "שלום")).toBe("שלום");
    expect(misses).toEqual(["ProviderUnavailableError", "engine", "LanAuthError"]);
    // More sentences at once than the desktop holds: the extra ones are refused at once, in order.
    const busy = await linked({ desktop: fakeDesktop({ rtf: 0.2 }) });
    const results = await Promise.allSettled([1, 2, 3, 4, 5, 6].map(() => transcribeOnDesktop(busy.link, tone(1))));
    expect(results.filter((r) => r.status === "fulfilled").length).toBe(4);
    expect(results.filter((r) => r.status === "rejected").map((r) => ((r as PromiseRejectedResult).reason as { code?: string }).code)).toEqual(["busy", "busy"]);
    for (const d of [slow, failing, stranger, busy]) d.stop();
  });

  it("only a device that proved it knows the passphrase is served, and only while the desktop's vault is unlocked", async () => {
    const unproven = await linked({ prove: false });
    await expect(unproven.remote.service(OP_STATUS, { v: 1 })).rejects.toBeInstanceOf(LanAuthError);
    await expect(unproven.remote.service(OP_TRANSCRIBE, { v: 1, rid: "x" }, new Uint8Array(8))).rejects.toBeInstanceOf(LanAuthError);
    expect(unproven.desktop.seen).toEqual([]);
    const locked = await linked({ lockHost: true });
    await expect(locked.remote.service(OP_STATUS, { v: 1 })).rejects.toBeInstanceOf(LanHostLockedError);
    expect(await desktopStatus(locked.link)).toMatchObject({ ready: false });
    // A host without the service says so; the bucket ops are not services.
    const keys = await vault();
    const bare = lanHost({ bucket: memoryProvider(), keys: () => keys });
    const [a, b] = memoryChannelPair();
    bare.attach(a);
    const r = remoteLanProvider(b);
    await r.authenticate(keys);
    expect(await desktopStatus({ address: "192.168.1.20", keys, call: (op, h, p, o) => r.service(op, h, p, o) })).toEqual({ ready: false, engine: null, reason: "unsupported" });
    // An address the link doesn't know counts as not local (review 6, RR6-520-3).
    expect(await desktopStatus({ address: null, keys, call: (op, h, p, o) => r.service(op, h, p, o) })).toEqual({ ready: false, engine: null, reason: "not-local" });
    expect(() => bare.serve("list", async () => ({ header: {} }))).toThrow();
    await expect(r.service("list", {})).rejects.toThrow();
    for (const d of [unproven, locked]) d.stop();
  });

  it("local network only: a link to a public address is refused on both sides", async () => {
    const d = await linked({ address: "203.0.113.7" });
    await expect(transcribeOnDesktop(d.link, tone(1))).rejects.toBeInstanceOf(NotLocalError);
    expect(await desktopStatus(d.link)).toEqual({ ready: false, engine: null, reason: "not-local" });
    // The desktop checks the phone's address too, whatever the phone claims.
    const lying: DesktopLink = { ...d.link, address: "192.168.1.30" };
    await expect(transcribeOnDesktop(lying, tone(1))).rejects.toMatchObject({ code: "not-local" });
    expect(d.desktop.seen).toEqual([]);
    d.stop();
  });

  it("a sentence given up on costs the desktop nothing; the size is checked before decrypting; an unknown address is not local (review 6)", async () => {
    const d = await linked();
    // A deadline no model can meet is refused at once, never run.
    await expect(transcribeOnDesktop(d.link, tone(1), { timeoutMs: 20 })).rejects.toThrow();
    expect(d.desktop.seen).toEqual([]);
    // A payload that is not the sealed size of the samples the header names is refused before it is opened.
    const rid = toB64u(randomBytes(16));
    const sealed = await seal(d.link.keys.blobs, d.link.keys.vaultId, "dictation-audio", rid, new Uint8Array(4 * 1024 * 1024));
    await expect(d.link.call(OP_TRANSCRIBE, { v: 1, rid, language: "he", samples: 16_000 }, sealed)).rejects.toMatchObject({ code: "bad-request" });
    await expect(d.link.call(OP_TRANSCRIBE, { v: 1, rid, language: "he", samples: 2_000_000 }, sealed)).rejects.toMatchObject({ code: "too-long" });
    expect(sealedAudioBytes(16_000)).toBe((await seal(d.link.keys.blobs, d.link.keys.vaultId, "dictation-audio", rid, new Uint8Array(32_000))).length);
    // The phone refuses a link whose address it doesn't know.
    await expect(transcribeOnDesktop({ ...d.link, address: null }, tone(1))).rejects.toBeInstanceOf(NotLocalError);
    d.stop();
  });

  it("a slow transcription never holds up the vault's sync on the same link", async () => {
    const d = await linked({ desktop: fakeDesktop({ rtf: 0.5 }) });
    const sentence = transcribeOnDesktop(d.link, tone(4)); // ~2 s on the fake desktop
    const t0 = Date.now();
    await d.remote.list();
    expect(Date.now() - t0).toBeLessThan(500);
    await sentence;
    d.stop();
  });

  it("a desktop with nothing to transcribe with is not offered", async () => {
    const d = await linked({ desktop: fakeDesktop({ ready: false }) });
    const status = await desktopStatus(d.link);
    expect(status).toEqual({ ready: false, engine: null, reason: "no-model" });
    expect(shouldOfferDesktop({ language: "he", estimate: estimateDictationWer({ correction: null }), desktop: status }).offer).toBe(false);
    d.stop();
  });
});

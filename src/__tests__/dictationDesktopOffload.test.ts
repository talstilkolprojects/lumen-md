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
import { memoryChannelPair, messenger } from "../sync/e2ee/lan/channel";
import { lanHost, remoteLanProvider, LanAuthError, LanHostLockedError } from "../sync/e2ee/lan/rpc";
import { randomBytes, toB64u, utf8 } from "../sync/e2ee/bytes";
import {
  MEASURED_WER,
  chooseDesktopLink,
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
  readMeasured,
  sealedAudioBytes,
  serveDesktopDictation,
  shouldOfferDesktop,
  transcribeOnDesktop,
  type DesktopEngine,
  type DesktopLink,
} from "../ai/dictation/desktopOffload";

const realFetch = globalThis.fetch;
/** The table as it stood before the first cloud run (plan 6.1's Zipformer only), so these tests don't move when measuredWer.json is filled. */
const TABLE = { "zipformer-he": { wer: 0.236, split: "FLEURS-he validation", source: "plan 6.1, CI (WASM)" } };
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

describe("W6.19 the measured table (measuredWer.json)", () => {
  it("holds only measured, well-formed numbers for known engines; the Zipformer's is always there", () => {
    expect(MEASURED_WER["zipformer-he"]?.wer).toBeGreaterThan(0);
    for (const [engine, f] of Object.entries(MEASURED_WER)) {
      expect(["zipformer-he", "whisper-cpp-he", "whisper-turbo-he"], engine).toContain(engine);
      expect(f!.wer).toBeGreaterThanOrEqual(0);
      expect(f!.split.length).toBeGreaterThan(0);
    }
    expect(readMeasured({ "whisper-cpp-he": { wer: 0.081, split: "asr-he held-out", source: "models:cloud r @ abc" }, "made-up": { wer: 0.01 }, "whisper-turbo-he": { wer: "0.1" }, "zipformer-he": { wer: Number.NaN } })).toEqual({ "whisper-cpp-he": { wer: 0.081, split: "asr-he held-out", source: "models:cloud r @ abc" } });
    expect(readMeasured(null)).toEqual({});
  });
});

describe("W6.19 when to offer the desktop", () => {
  it("estimates this device's WER: a number measured here wins, else the re-reading Whisper's measured WER, else the streaming Zipformer's 23.6 % (plan 6.1)", () => {
    expect(estimateDictationWer({ table: TABLE, measuredHere: 0.31, correction: null })).toEqual({ wer: 0.31, basis: "measured-here", engine: "zipformer-he" });
    // A phone without a turbo on the device: the streaming engine's number.
    expect(estimateDictationWer({ table: TABLE, correction: null })).toEqual({ wer: 0.236, basis: "streaming-floor", engine: "zipformer-he" });
    // Turbo re-reads, but nobody measured it yet: still the streaming floor, never a guess.
    expect(estimateDictationWer({ table: TABLE, correction: "whisper-turbo-he" }).basis).toBe("streaming-floor");
    // Once the cloud run measures it, its number counts.
    expect(estimateDictationWer({ correction: "whisper-turbo-he", table: { ...TABLE, "whisper-turbo-he": { wer: 0.12, split: "held-out asr-he", source: "models:cloud" } } })).toEqual({ wer: 0.12, basis: "measured-engine", engine: "whisper-turbo-he" });
  });

  it("offers it only for Hebrew over 15 %, with a linked desktop that is ready and not known to be worse", () => {
    const over = estimateDictationWer({ table: TABLE, correction: null });
    const ready = { ready: true, engine: "whisper-cpp-he" as const };
    expect(shouldOfferDesktop({ language: "he-IL", estimate: over, desktop: ready, table: TABLE })).toMatchObject({ offer: true, reason: "offer" });
    expect(shouldOfferDesktop({ language: "en", estimate: over, desktop: ready, table: TABLE }).reason).toBe("not-hebrew");
    expect(shouldOfferDesktop({ language: "he", estimate: { wer: MOBILE_WER_TARGET, basis: "measured-here", engine: "zipformer-he" }, desktop: ready, table: TABLE }).reason).toBe("meets-target");
    expect(shouldOfferDesktop({ language: "he", estimate: { wer: null, basis: "unknown", engine: null }, desktop: ready, table: TABLE }).reason).toBe("unknown-wer");
    expect(shouldOfferDesktop({ language: "he", estimate: over, desktop: null, table: TABLE }).reason).toBe("no-desktop");
    expect(shouldOfferDesktop({ language: "he", estimate: over, desktop: { ready: false, engine: null, reason: "no-model" }, table: TABLE }).reason).toBe("desktop-not-ready");
    expect(shouldOfferDesktop({ language: "he", estimate: over, desktop: ready, table: { ...TABLE, "whisper-cpp-he": { wer: 0.3, split: "x", source: "y" } } }).reason).toBe("desktop-not-better");
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
    expect(shouldOfferDesktop({ language: "he", estimate: estimateDictationWer({ table: TABLE, correction: null }), desktop: status, table: TABLE }).offer).toBe(false);
    d.stop();
  });
});

/** The other way round: the phone hosts the vault, the desktop joined it (services host → peer, lan/rpc.ts). */
async function phoneHosts(opts: { address?: string | null; desktopKeys?: VaultKeys; desktopProves?: boolean; desktop?: ReturnType<typeof fakeDesktop> } = {}) {
  const keys = await vault();
  const phoneHost = lanHost({ bucket: memoryProvider(), keys: () => keys });
  const frames: Uint8Array[] = [];
  const [hostEnd, deskEnd] = memoryChannelPair({ latencyMs: 2, onFrame: (_f, d) => frames.push(d) });
  const address = opts.address === undefined ? "192.168.1.20" : opts.address;
  phoneHost.attach(hostEnd, { address });
  // The desktop joined the phone's vault: it serves dictation to its host.
  const desk = remoteLanProvider(deskEnd, { address: "192.168.1.30" });
  const desktop = opts.desktop ?? fakeDesktop();
  const stop = serveDesktopDictation(desk, desktop.engine);
  if (opts.desktopProves !== false) await desk.authenticate(opts.desktopKeys ?? keys);
  const links = phoneHost.peerLinks().map((p): DesktopLink => ({ address: p.info.address, keys, call: (op, h, pl, o) => p.call(op, h, pl, o) }));
  return { phoneHost, desk, desktop, links, frames, stop, keys };
}

describe("W6.19 a phone that hosts the vault sends its dictation to the desktop that joined it", () => {
  it("the desktop (a peer) transcribes, the text comes back sealed, and the vault's sync on the link is untouched", async () => {
    const fetches = forbidFetch();
    const d = await phoneHosts();
    expect(d.links).toHaveLength(1);
    const chosen = await chooseDesktopLink(d.links, { language: "he", estimate: estimateDictationWer({ table: TABLE, correction: null }), table: TABLE });
    expect(chosen?.decision.reason).toBe("offer");
    const audio = tone(2);
    expect(await makeDesktopCorrector(chosen!.link)(audio, "הפגישה נדחית")).toBe("הפגישה נדחתה ליום חמישי.");
    expect(d.desktop.seen).toEqual([{ samples: audio.length, language: "he" }]);
    const wire = d.frames.reduce((acc, f) => {
      const n = new Uint8Array(acc.length + f.length);
      n.set(acc);
      n.set(f, acc.length);
      return n;
    }, new Uint8Array());
    expect(has(wire, pcm16(audio).subarray(4000, 4032))).toBe(false);
    expect(has(wire, utf8("הפגישה נדחתה"))).toBe(false);
    // The desktop still syncs against the phone's bucket on the same link.
    await d.desk.put("obj-1", new Uint8Array([1, 2, 3]));
    expect(await d.phoneHost.provider.list()).toContain("obj-1");
    expect(fetches).toEqual([]);
    d.stop();
  });

  it("asks only a desktop that proved it knows the passphrase, and the desktop answers only a host that proved it too", async () => {
    // Not proven: the host has no link to ask on.
    const unproven = await phoneHosts({ desktopProves: false });
    expect(unproven.links).toEqual([]);
    // A desktop that hasn't checked the host's proof refuses anything the "host" asks: here a raw end that never proved itself.
    const keys = await vault();
    const [a, b] = memoryChannelPair({ latencyMs: 1 });
    const fakeHost = messenger(a);
    const desk = remoteLanProvider(b, { address: "192.168.1.30" });
    const seen = fakeDesktop();
    serveDesktopDictation(desk, seen.engine);
    const answer = new Promise<Record<string, unknown>>((resolve) => fakeHost.onMessage((m) => resolve(m.header)));
    fakeHost.send({ rq: 1, op: OP_STATUS, v: 1 });
    expect(await answer).toMatchObject({ rs: 1, error: "auth" });
    expect(seen.seen).toEqual([]);
    // The real host, proven both ways.
    const h = lanHost({ bucket: memoryProvider(), keys: () => keys });
    const [c, e] = memoryChannelPair({ latencyMs: 1 });
    h.attach(c, { address: "192.168.1.20" });
    const desk2 = remoteLanProvider(e, { address: "192.168.1.30" });
    serveDesktopDictation(desk2, seen.engine);
    await desk2.authenticate(keys);
    // Proven both ways: the host may ask, the desktop answers.
    expect(await desktopStatus({ address: "192.168.1.20", keys, call: (op, hd, pl, o) => h.peerLinks()[0].call(op, hd, pl, o) })).toEqual({ ready: true, engine: "whisper-cpp-he" });
    // A service the desktop doesn't serve: "unsupported", never a bucket op.
    await expect(h.peerLinks()[0].call("svc.nothing", {})).rejects.toMatchObject({ code: "unsupported" });
    await expect(h.peerLinks()[0].call("list", {})).rejects.toThrow(/svc\./);
    expect(seen.seen).toEqual([]);
  });

  it("refuses a desktop whose address is not on the local network, on both sides", async () => {
    const d = await phoneHosts({ address: "8.8.8.8" });
    await expect(transcribeOnDesktop(d.links[0], tone(1))).rejects.toBeInstanceOf(NotLocalError);
    expect((await desktopStatus(d.links[0]))?.reason).toBe("not-local");
    expect(d.desktop.seen).toEqual([]);
    d.stop();
  });

  it("of several linked devices, offers the first that is ready", async () => {
    const notReady = await phoneHosts({ desktop: fakeDesktop({ ready: false }) });
    const ready = await phoneHosts();
    const est = estimateDictationWer({ table: TABLE, correction: null });
    const chosen = await chooseDesktopLink([...notReady.links, ...ready.links], { language: "he", estimate: est, table: TABLE });
    expect(chosen?.link).toBe(ready.links[0]);
    expect(await chooseDesktopLink(notReady.links, { language: "he", estimate: est, table: TABLE })).toBeNull();
    expect(await chooseDesktopLink(ready.links, { language: "en", estimate: est, table: TABLE })).toBeNull();
    notReady.stop();
    ready.stop();
  });
});

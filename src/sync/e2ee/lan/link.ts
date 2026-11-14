/**
 * The direct link between two devices on the local network (plan W2.19):
 * a WebRTC data channel with no signaling server and no STUN or TURN.
 *
 *   host  makes an offer code  ──(QR code or copy & paste)──▶  peer
 *   host  ◀──(QR code or copy & paste)──  answer code         peer
 *
 * Each code is the device's SDP (its DTLS fingerprint and its LAN host
 * candidates), deflated and base64url-encoded behind `lumen-lan:1:`. Only
 * candidates on the local network go into a code or are taken from one
 * (./address.ts), and once connected the selected pair is checked again: a
 * link whose other end isn't on the LAN is closed. So the link works with no
 * internet at all, and it never reaches past the local network.
 *
 * The codes carry no key material: the vault's passphrase is still needed,
 * and the host checks it (./rpc.ts) before serving anything but the header.
 */

import { fromB64u, toB64u } from "../bytes";
import { isLanHost, lanOnlySdp } from "./address";
import type { LanChannel } from "./channel";
import type { LinkFingerprints } from "./rpc";

export const CODE_PREFIX = "lumen-lan:1:";
export const GATHER_TIMEOUT_MS = 3000;
export const OPEN_TIMEOUT_MS = 30_000;
const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 1024 * 1024;

export type LanLinkReason = "no-webrtc" | "bad-code" | "wrong-code" | "no-lan-address" | "not-lan" | "timeout" | "closed";

export class LanLinkError extends Error {
  constructor(public readonly reason: LanLinkReason) {
    super(`LAN link: ${reason}`);
    this.name = "LanLinkError";
  }
}

/* ─── Codes ────────────────────────────────────────────────────────────── */

async function pipe(bytes: Uint8Array, stream: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> }): Promise<Uint8Array> {
  const out = new Response(stream.readable).arrayBuffer();
  const w = stream.writable.getWriter();
  await w.write(new Uint8Array(bytes));
  await w.close();
  return new Uint8Array(await out);
}

const canDeflate = () => typeof CompressionStream === "function" && typeof DecompressionStream === "function";

/** `lumen-lan:1:` + `z` (deflated) or `u` (plain) + base64url(JSON {k, s}). */
export async function encodeCode(kind: "offer" | "answer", sdp: string): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify({ k: kind, s: sdp }));
  if (canDeflate()) return `${CODE_PREFIX}z${toB64u(await pipe(json, new CompressionStream("deflate-raw")))}`;
  return `${CODE_PREFIX}u${toB64u(json)}`;
}

export async function decodeCode(code: string, kind: "offer" | "answer"): Promise<string> {
  const s = code.replace(/\s+/g, "");
  if (!s.startsWith(CODE_PREFIX)) throw new LanLinkError("bad-code");
  const mode = s[CODE_PREFIX.length];
  let json: Uint8Array;
  try {
    const raw = fromB64u(s.slice(CODE_PREFIX.length + 1));
    if (mode === "z") json = await pipe(raw, new DecompressionStream("deflate-raw"));
    else if (mode === "u") json = raw;
    else throw new Error("mode");
  } catch {
    throw new LanLinkError("bad-code");
  }
  let v: { k?: unknown; s?: unknown };
  try {
    v = JSON.parse(new TextDecoder().decode(json)) as { k?: unknown; s?: unknown };
  } catch {
    throw new LanLinkError("bad-code");
  }
  if (typeof v.s !== "string") throw new LanLinkError("bad-code");
  if (v.k !== kind) throw new LanLinkError("wrong-code");
  return v.s;
}

/* ─── The data channel as a LanChannel ─────────────────────────────────── */

export interface LanLink {
  channel: LanChannel;
  /** The other device's address (as the browser reports the selected pair), or null when it hides it. */
  remoteAddress: string | null;
  /** The DTLS fingerprints of this connection (this device's, the other's): the passphrase proof is bound to them (review 28, L1). */
  fingerprints: LinkFingerprints | null;
  /** Bytes sent and received so far. */
  bytes(): { out: number; in: number };
  close(): void;
}

function dataChannel(pc: RTCPeerConnection, dc: RTCDataChannel, counters: { out: number; in: number }): LanChannel {
  const msg = new Set<(d: Uint8Array) => void>();
  const closeFns = new Set<() => void>();
  let closed = false;
  const queue: Uint8Array[] = [];
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = LOW_WATER;
  const flush = () => {
    while (queue.length && dc.readyState === "open" && dc.bufferedAmount < HIGH_WATER) {
      const f = queue.shift()!;
      counters.out += f.length;
      dc.send(f as Uint8Array<ArrayBuffer>);
    }
  };
  dc.addEventListener("bufferedamountlow", flush);
  dc.addEventListener("message", (ev: MessageEvent) => {
    const d = ev.data instanceof ArrayBuffer ? new Uint8Array(ev.data) : ArrayBuffer.isView(ev.data) ? new Uint8Array(ev.data.buffer, ev.data.byteOffset, ev.data.byteLength) : null;
    if (!d) return;
    counters.in += d.length;
    for (const fn of [...msg]) fn(d);
  });
  const shut = () => {
    if (closed) return;
    closed = true;
    queue.length = 0;
    for (const fn of [...closeFns]) fn();
    try {
      dc.close();
      pc.close();
    } catch {
      /* already closed */
    }
  };
  dc.addEventListener("close", shut);
  pc.addEventListener("connectionstatechange", () => {
    if (pc.connectionState === "failed" || pc.connectionState === "closed") shut();
  });
  return {
    get closed() {
      return closed;
    },
    send(data) {
      if (closed) return;
      queue.push(new Uint8Array(data));
      flush();
    },
    onMessage(fn) {
      msg.add(fn);
      return () => msg.delete(fn);
    },
    onClose(fn) {
      closeFns.add(fn);
      return () => closeFns.delete(fn);
    },
    close: shut,
  };
}

/** An SDP's DTLS fingerprint ("sha-256 ab:cd:…", lowercased), or null. */
export function sdpFingerprint(sdp: string | null | undefined): string | null {
  const m = /^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\s*$/m.exec(sdp ?? "");
  return m ? `${m[1].toLowerCase()} ${m[2].toLowerCase()}` : null;
}

/* ─── Connecting ───────────────────────────────────────────────────────── */

export interface LinkDeps {
  /** The RTCPeerConnection constructor (default: the browser's). */
  RTCPeerConnection?: typeof RTCPeerConnection;
  gatherTimeoutMs?: number;
  openTimeoutMs?: number;
}

function peerConnection(deps: LinkDeps): RTCPeerConnection {
  const PC = deps.RTCPeerConnection ?? (typeof RTCPeerConnection === "function" ? RTCPeerConnection : undefined);
  if (!PC) throw new LanLinkError("no-webrtc");
  // No STUN, no TURN: only this device's own addresses become candidates.
  return new PC({ iceServers: [] });
}

function gathered(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const check = () => pc.iceGatheringState === "complete" && done();
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Our SDP with LAN host candidates only; throws when there is none. */
function localLanSdp(pc: RTCPeerConnection): string {
  const { sdp, kept } = lanOnlySdp(pc.localDescription?.sdp ?? "");
  if (kept.length === 0) throw new LanLinkError("no-lan-address");
  return sdp;
}

function remoteLanSdp(sdp: string): string {
  const out = lanOnlySdp(sdp);
  if (out.kept.length === 0) throw new LanLinkError("no-lan-address");
  return out.sdp;
}

/** The selected candidate pair's remote address; throws when it is off the LAN. */
async function checkSelectedPair(pc: RTCPeerConnection): Promise<string | null> {
  let address: string | null = null;
  try {
    const stats = await pc.getStats();
    const byId = new Map<string, Record<string, unknown>>();
    stats.forEach((s: Record<string, unknown>) => byId.set(String(s.id), s));
    for (const s of byId.values()) {
      const selected = s.type === "candidate-pair" && (s.selected === true || (s.nominated === true && s.state === "succeeded"));
      if (!selected) continue;
      const remote = byId.get(String(s.remoteCandidateId));
      const a = remote?.address ?? remote?.ip;
      if (typeof a === "string" && a) address = a;
      if (remote && remote.candidateType !== undefined && remote.candidateType !== "host" && remote.candidateType !== "prflx") throw new LanLinkError("not-lan");
    }
  } catch (e) {
    if (e instanceof LanLinkError) throw e;
  }
  if (address && !isLanHost(address)) throw new LanLinkError("not-lan");
  return address;
}

function opened(pc: RTCPeerConnection, dc: RTCDataChannel, timeoutMs: number): Promise<LanLink> {
  const counters = { out: 0, in: 0 };
  return new Promise<LanLink>((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.close();
      reject(new LanLinkError("timeout"));
    }, timeoutMs);
    const onOpen = async () => {
      clearTimeout(timer);
      try {
        const remoteAddress = await checkSelectedPair(pc);
        const channel = dataChannel(pc, dc, counters);
        const local = sdpFingerprint(pc.localDescription?.sdp);
        const remote = sdpFingerprint(pc.remoteDescription?.sdp);
        resolve({ channel, remoteAddress, fingerprints: local && remote ? { local, remote } : null, bytes: () => ({ ...counters }), close: () => channel.close() });
      } catch (e) {
        pc.close();
        reject(e);
      }
    };
    if (dc.readyState === "open") void onOpen();
    else dc.addEventListener("open", () => void onOpen(), { once: true });
    pc.addEventListener("connectionstatechange", () => {
      if (pc.connectionState === "failed") {
        clearTimeout(timer);
        reject(new LanLinkError("closed"));
      }
    });
  });
}

const channelFor = (pc: RTCPeerConnection) => pc.createDataChannel("lumen-lan", { negotiated: true, id: 0, ordered: true });

/** Host: an offer code to show, then `accept` the peer's answer code. */
export async function hostOffer(deps: LinkDeps = {}): Promise<{ code: string; accept(answer: string): Promise<LanLink>; cancel(): void }> {
  const pc = peerConnection(deps);
  const dc = channelFor(pc);
  await pc.setLocalDescription(await pc.createOffer());
  await gathered(pc, deps.gatherTimeoutMs ?? GATHER_TIMEOUT_MS);
  let sdp: string;
  try {
    sdp = localLanSdp(pc);
  } catch (e) {
    pc.close();
    throw e;
  }
  return {
    code: await encodeCode("offer", sdp),
    async accept(answer) {
      const remote = remoteLanSdp(await decodeCode(answer, "answer"));
      await pc.setRemoteDescription({ type: "answer", sdp: remote });
      return opened(pc, dc, deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);
    },
    cancel: () => pc.close(),
  };
}

/** Peer: answer the host's offer code; show `code`, and `link` resolves once the host accepted it. */
export async function joinOffer(offer: string, deps: LinkDeps = {}): Promise<{ code: string; link: Promise<LanLink>; cancel(): void }> {
  const remote = remoteLanSdp(await decodeCode(offer, "offer"));
  const pc = peerConnection(deps);
  const dc = channelFor(pc);
  await pc.setRemoteDescription({ type: "offer", sdp: remote });
  await pc.setLocalDescription(await pc.createAnswer());
  await gathered(pc, deps.gatherTimeoutMs ?? GATHER_TIMEOUT_MS);
  let sdp: string;
  try {
    sdp = localLanSdp(pc);
  } catch (e) {
    pc.close();
    throw e;
  }
  const link = opened(pc, dc, deps.openTimeoutMs ?? OPEN_TIMEOUT_MS);
  link.catch(() => undefined);
  return { code: await encodeCode("answer", sdp), link, cancel: () => pc.close() };
}

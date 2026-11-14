/**
 * The LAN link's message layer (plan W2.19): a reliable, ordered channel of
 * byte messages (an RTCDataChannel, or an in-memory pair in the tests), and
 * the framing on top of it.
 *
 * A message is a JSON header plus optional bytes:
 *
 *   [u32 header length][header, UTF-8 JSON][payload]
 *
 * Data channels deliver messages of up to 64 KiB everywhere (larger ones
 * fail on some browsers), so a message is cut into chunks of CHUNK bytes:
 *
 *   [u8 version = 1][u32 message id][u32 chunk index][u32 chunk count][bytes]
 *
 * and reassembled in order (the channel is ordered). A message larger than
 * MAX_MESSAGE is refused on both sides.
 */

export interface LanChannel {
  send(data: Uint8Array): void;
  /** Returns the unsubscribe function. */
  onMessage(fn: (data: Uint8Array) => void): () => void;
  onClose(fn: () => void): () => void;
  close(): void;
  /** True once closed (by either side). */
  readonly closed: boolean;
}

export const CHUNK = 16 * 1024;
/** The largest message: a sealed note blob is far below this. */
export const MAX_MESSAGE = 256 * 1024 * 1024;
const VERSION = 1;
const HEAD = 13;

export interface Message {
  header: Record<string, unknown>;
  payload: Uint8Array;
}

export function encodeMessage(header: Record<string, unknown>, payload: Uint8Array = new Uint8Array()): Uint8Array {
  const h = new TextEncoder().encode(JSON.stringify(header));
  const out = new Uint8Array(4 + h.length + payload.length);
  new DataView(out.buffer).setUint32(0, h.length);
  out.set(h, 4);
  out.set(payload, 4 + h.length);
  return out;
}

export function decodeMessage(bytes: Uint8Array): Message | null {
  if (bytes.length < 4) return null;
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + len > bytes.length) return null;
  try {
    const header = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(4, 4 + len))) as unknown;
    if (!header || typeof header !== "object" || Array.isArray(header)) return null;
    return { header: header as Record<string, unknown>, payload: bytes.slice(4 + len) };
  } catch {
    return null;
  }
}

/** Cut one message into chunk frames. */
export function chunk(id: number, message: Uint8Array, size = CHUNK): Uint8Array[] {
  const count = Math.max(1, Math.ceil(message.length / size));
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = message.subarray(i * size, (i + 1) * size);
    const f = new Uint8Array(HEAD + part.length);
    const v = new DataView(f.buffer);
    v.setUint8(0, VERSION);
    v.setUint32(1, id);
    v.setUint32(5, i);
    v.setUint32(9, count);
    f.set(part, HEAD);
    frames.push(f);
  }
  return frames;
}

/** Reassembles chunk frames; `push` returns a whole message, null while one is incomplete, or throws on a bad frame. */
export function reassembler(max = MAX_MESSAGE) {
  let id = -1;
  let parts: Uint8Array[] = [];
  let size = 0;
  return {
    push(frame: Uint8Array): Uint8Array | null {
      if (frame.length < HEAD) throw new Error("short frame");
      const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
      if (v.getUint8(0) !== VERSION) throw new Error("unknown frame version");
      const fid = v.getUint32(1);
      const index = v.getUint32(5);
      const count = v.getUint32(9);
      if (count < 1 || index >= count) throw new Error("bad frame");
      if (index === 0) {
        id = fid;
        parts = [];
        size = 0;
      } else if (fid !== id || index !== parts.length) throw new Error("frame out of order");
      const body = frame.subarray(HEAD);
      size += body.length;
      if (size > max) throw new Error("message too large");
      parts.push(body);
      if (parts.length < count) return null;
      const out = new Uint8Array(size);
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      id = -1;
      parts = [];
      size = 0;
      return out;
    },
  };
}

/**
 * Messages over a channel: `send` frames and chunks, `onMessage` gets whole
 * decoded messages. A bad frame closes the channel.
 */
export function messenger(channel: LanChannel) {
  let nextId = 1;
  const asm = reassembler();
  const listeners = new Set<(m: Message) => void>();
  channel.onMessage((frame) => {
    let whole: Uint8Array | null;
    try {
      whole = asm.push(frame);
    } catch {
      channel.close();
      return;
    }
    if (!whole) return;
    const m = decodeMessage(whole);
    if (!m) {
      channel.close();
      return;
    }
    for (const l of [...listeners]) l(m);
  });
  return {
    channel,
    send(header: Record<string, unknown>, payload?: Uint8Array): void {
      if (channel.closed) return;
      const id = nextId++ >>> 0;
      for (const f of chunk(id, encodeMessage(header, payload))) channel.send(f);
    },
    onMessage(fn: (m: Message) => void): () => void {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}
export type Messenger = ReturnType<typeof messenger>;

/**
 * Two connected in-memory channels (the tests' "local network"). Delivery is
 * ordered; `latencyMs` delays each frame (a fixed or random delay).
 */
export function memoryChannelPair(opts: { latencyMs?: number | (() => number); onFrame?: (from: "a" | "b", data: Uint8Array) => void } = {}): [LanChannel, LanChannel] {
  const make = (name: "a" | "b") => {
    const msg = new Set<(d: Uint8Array) => void>();
    const close = new Set<() => void>();
    let closed = false;
    // Frames in flight to the peer, delivered strictly in order.
    const queue: Array<{ at: number; data: Uint8Array }> = [];
    let pumping = false;
    const pump = () => {
      if (pumping) return;
      const next = queue[0];
      if (!next) return;
      pumping = true;
      const run = () => {
        pumping = false;
        const now = Date.now();
        while (queue.length && queue[0].at <= now) end.peer?.deliver(queue.shift()!.data);
        pump();
      };
      const wait = next.at - Date.now();
      if (wait <= 0) queueMicrotask(run);
      else setTimeout(run, wait);
    };
    const end: LanChannel & { deliver(d: Uint8Array): void; shut(): void; peer?: ReturnType<typeof make> } = {
      get closed() {
        return closed;
      },
      send(data) {
        if (closed || !end.peer) return;
        opts.onFrame?.(name, data);
        const lat = typeof opts.latencyMs === "function" ? opts.latencyMs() : (opts.latencyMs ?? 0);
        queue.push({ at: Date.now() + lat, data: data.slice() });
        pump();
      },
      onMessage(fn) {
        msg.add(fn);
        return () => msg.delete(fn);
      },
      onClose(fn) {
        close.add(fn);
        return () => close.delete(fn);
      },
      close() {
        if (closed) return;
        end.shut();
        end.peer?.shut();
      },
      deliver(d) {
        if (!closed) for (const fn of [...msg]) fn(d);
      },
      shut() {
        if (closed) return;
        closed = true;
        for (const fn of [...close]) fn();
      },
    };
    return end;
  };
  const a = make("a");
  const b = make("b");
  a.peer = b;
  b.peer = a;
  return [a, b];
}

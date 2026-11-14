/**
 * Plan W2.20: live sharing, end-to-end encrypted, through a server that never
 * sees the content. Runs the real collab server in-process (as
 * collabSharing.test.ts does) with the real @hocuspocus/provider, and the
 * client exactly as `connectCollab` wires a password room: the note and its
 * comments in plaintext documents that no provider touches, ciphertext
 * transport documents (`wireE2E`) and sealed presence (`wireE2EAwareness`)
 * on the wire.
 *
 * Every WebSocket frame of the run is recorded (both directions; the server's
 * only peers are these clients), and the "server" side of the check reads
 * the stored states and every file in the server's data directory.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { wireE2E, E2E_REMOTE_ORIGIN, type E2EChannel } from "../collab/e2e";
import { wireE2EAwareness, type AwarenessLike, type E2EAwarenessBridge } from "../collab/e2eAwareness";
import { commentsDocName, tokenRequest } from "../collab/sharing";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { isEnvelope, isSealedAwarenessJson, isSealedState, parseMessage, sealedMessageProblem, sealedUpdateProblem } from "../../sync-server/collab/sealed.mjs";

/* ─── Every frame on the wire ──────────────────────────────────────────── */

// Installed before any import runs, so the provider and `tokenRequest` both use it.
const traffic = vi.hoisted(() => {
  const frames: Array<Uint8Array | Promise<Uint8Array>> = [];
  const toBytes = (d: unknown): Uint8Array | Promise<Uint8Array> => {
    if (typeof d === "string") return new TextEncoder().encode(d);
    if (d instanceof ArrayBuffer) return new Uint8Array(d.slice(0));
    if (ArrayBuffer.isView(d)) return new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
    if (typeof Blob !== "undefined" && d instanceof Blob) return d.arrayBuffer().then((b) => new Uint8Array(b));
    return new Uint8Array();
  };
  const Native = globalThis.WebSocket;
  class Tapped extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener("message", (ev: MessageEvent) => frames.push(toBytes(ev.data)));
    }
    override send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      frames.push(toBytes(data));
      super.send(data as never);
    }
  }
  globalThis.WebSocket = Tapped as unknown as typeof WebSocket;
  return {
    clear: () => void frames.splice(0),
    all: async (): Promise<Uint8Array[]> => Promise.all(frames),
  };
});

interface Store {
  load(name: string): Uint8Array | null;
  isSealed(room: string): boolean;
}
interface App {
  listen(): Promise<number>;
  close(): Promise<void>;
  store: Store;
}

const ACCESS = "operator-access-key-for-tests";
const SECRET = "y".repeat(40);
const dirs: string[] = [];
const apps: App[] = [];
const providers: HocuspocusProvider[] = [];
const cleanups: Array<() => void> = [];

async function start(opts: { requireE2ee?: boolean } = {}): Promise<{ app: App; url: string; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), "lumen-e2ee-"));
  dirs.push(dir);
  const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir: dir, accessKey: ACCESS, tokenSecret: SECRET, debounceMs: 20, maxDebounceMs: 50, backupIntervalMs: 0, revokeCheckMs: 0, ...opts }) as App;
  apps.push(app);
  const port = await app.listen();
  return { app, url: `ws://127.0.0.1:${port}`, dir };
}

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const p of providers.splice(0)) p.destroy();
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  traffic.clear();
});

const token = (url: string, room: string, e2ee: boolean) => () => tokenRequest<{ token: string }>(url, { room, key: ACCESS, ...(e2ee ? { e2ee: true } : {}) }).then((r) => r.token);

function connect(url: string, name: string, document: Y.Doc, awareness: Awareness | null, tok: () => Promise<string>, extra: { onClose?: () => void } = {}): Promise<HocuspocusProvider> {
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url,
      name,
      document,
      ...(awareness ? { awareness } : {}),
      token: tok,
      onSynced: () => resolve(provider),
      onAuthenticationFailed: ({ reason }) => reject(new Error(`auth failed: ${reason}`)),
      onClose: () => extra.onClose?.(),
    });
    providers.push(provider);
  });
}

interface Client {
  text: Y.Text;
  plain: Y.Doc;
  comments: Y.Doc;
  awareness: Awareness;
  channels: E2EChannel[];
  bridge: E2EAwarenessBridge;
  idle(): Promise<void>;
}

/** A participant wired as `connectCollab` wires a password room (server-only). */
async function e2eClient(url: string, room: string, password: string, name: string, compactThreshold?: number): Promise<Client> {
  const plain = new Y.Doc();
  const transport = new Y.Doc();
  transport.clientID = plain.clientID;
  const comments = new Y.Doc();
  comments.clientID = plain.clientID;
  const commentsTransport = new Y.Doc();
  commentsTransport.clientID = plain.clientID;
  const opts = compactThreshold === undefined ? {} : { compactThreshold };
  const channels = [wireE2E(plain, transport, { password, room, ...opts }), wireE2E(comments, commentsTransport, { password, room: commentsDocName(room), ...opts })];
  const awareness = new Awareness(plain);
  const transportAwareness = new Awareness(transport);
  const bridge = wireE2EAwareness(awareness as unknown as AwarenessLike, transportAwareness as unknown as AwarenessLike, { password, room });
  awareness.setLocalStateField("user", { name, color: "hsl(10 70% 55%)" });
  cleanups.push(() => {
    bridge.destroy();
    for (const c of channels) c.destroy();
    awareness.destroy();
    transportAwareness.destroy();
  });
  await connect(url, room, transport, transportAwareness, token(url, room, true));
  await connect(url, commentsDocName(room), commentsTransport, null, token(url, room, true));
  return {
    text: plain.getText("lumen"),
    plain,
    comments,
    awareness,
    channels,
    bridge,
    idle: async () => {
      for (const c of channels) await c.whenIdle();
      await bridge.whenIdle();
    },
  };
}

/* ─── Looking for plaintext ────────────────────────────────────────────── */

const utf8 = (s: string) => new TextEncoder().encode(s);
const has = (hay: Uint8Array, needle: Uint8Array) => Buffer.from(hay.buffer, hay.byteOffset, hay.byteLength).includes(Buffer.from(needle));

function filesUnder(dir: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) out.push(...filesUnder(p));
    else out.push(new Uint8Array(readFileSync(p)));
  }
  return out;
}

/** Where each needle shows up: in the frames, in the stored states, in the data files. */
async function findPlaintext(app: App, dir: string, docNames: string[], needles: string[]): Promise<string[]> {
  const frames: Uint8Array[] = await traffic.all();
  const states = docNames.map((n) => app.store.load(n)).filter((s): s is Uint8Array => !!s);
  await app.close(); // stores pending documents and takes a backup
  const files = filesUnder(dir);
  const hits: string[] = [];
  for (const n of needles) {
    const b = utf8(n);
    if (frames.some((f) => has(f, b))) hits.push(`traffic:${n}`);
    if (states.some((s) => has(s, b))) hits.push(`stored:${n}`);
    if (files.some((f) => has(f, b))) hits.push(`file:${n}`);
  }
  return hits;
}

/* ─── Acceptance 1: no plaintext on the server, stored or in transit ───── */

describe("a server that can't see the content", () => {
  it("0 plaintext strings of the note, its comments or presence in the server's storage and traffic", async () => {
    const { app, url, dir } = await start();
    const room = "lumen-e2ee-sealed";
    const password = "room-key-0123456789abcdef";
    const stamp = Date.now().toString(36);
    const hebrew = `סוד-עברי-${stamp}`;
    const english = `TOP-SECRET-${stamp}`;
    const comment = `COMMENT-${stamp}`;
    const nameA = `Alice-${stamp}`;
    const nameB = `Bob-${stamp}`;

    const a = await e2eClient(url, room, password, nameA);
    const b = await e2eClient(url, room, password, nameB);
    a.text.insert(0, `${hebrew} ${english}\n`);
    a.comments.getMap("lumen-comments").set("c1", { body: comment, quote: hebrew });
    a.awareness.setLocalStateField("cursor", { anchor: hebrew, head: english });

    // It all reaches the other participant…
    await vi.waitFor(() => expect(b.text.toString()).toContain(english), { timeout: 5000 });
    await vi.waitFor(() => expect(JSON.stringify(b.comments.getMap("lumen-comments").toJSON())).toContain(comment), { timeout: 5000 });
    await vi.waitFor(() => expect(JSON.stringify([...b.awareness.getStates().values()])).toContain(nameA), { timeout: 5000 });
    await vi.waitFor(() => expect(JSON.stringify([...a.awareness.getStates().values()])).toContain(nameB), { timeout: 5000 });
    expect(JSON.stringify([...b.awareness.getStates().values()])).toContain(hebrew);
    await a.idle();
    await b.idle();
    // …the room was sealed by the clients' `e2ee: true`, and what is stored is envelopes only.
    expect(app.store.isSealed(room)).toBe(true);
    await vi.waitFor(() => expect(app.store.load(room)).not.toBeNull(), { timeout: 5000 });
    expect(isSealedState(app.store.load(room), Y)).toBe(true);

    // …and none of it, in any form the server could read.
    expect(await findPlaintext(app, dir, [room, commentsDocName(room)], [hebrew, english, comment, nameA, nameB, password])).toEqual([]);
  });

  it("the same search finds the text of a room that isn't encrypted (the check can fail)", async () => {
    const { app, url, dir } = await start();
    const room = "lumen-plain-control";
    const secret = `VISIBLE-${Date.now().toString(36)}`;
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    cleanups.push(() => awareness.destroy());
    awareness.setLocalStateField("user", { name: `Carol-${secret}` });
    await connect(url, room, doc, awareness, token(url, room, false));
    doc.getText("lumen").insert(0, secret);
    await vi.waitFor(() => expect(app.store.load(room)).not.toBeNull(), { timeout: 5000 });
    expect(app.store.isSealed(room)).toBe(false);
    const hits = await findPlaintext(app, dir, [room], [secret]);
    expect(hits).toEqual(expect.arrayContaining([`traffic:${secret}`, `stored:${secret}`, `file:${secret}`]));
  });

  it("a sealed room refuses a client that writes plaintext, and stores nothing of it", async () => {
    const { app, url, dir } = await start();
    const room = "lumen-e2ee-refuse";
    const a = await e2eClient(url, room, "the-room-key-abcdefgh", "Alice");
    a.text.insert(0, "encrypted");
    await a.idle();
    await vi.waitFor(() => expect(app.store.load(room)).not.toBeNull(), { timeout: 5000 });

    // A plain client in the same room (it has a token: the room name is the capability here).
    const evil = new Y.Doc();
    let closed = 0;
    const p = await connect(url, room, evil, null, token(url, room, false), { onClose: () => closed++ });
    evil.getText("lumen").insert(0, "PLAINTEXT-WRITE");
    await vi.waitFor(() => expect(closed).toBeGreaterThan(0), { timeout: 5000 });
    p.destroy();

    // The room still works, and holds ciphertext only.
    const b = await e2eClient(url, room, "the-room-key-abcdefgh", "Bob");
    await vi.waitFor(() => expect(b.text.toString()).toBe("encrypted"), { timeout: 5000 });
    a.text.insert(0, "more ");
    await vi.waitFor(() => expect(b.text.toString()).toBe("more encrypted"), { timeout: 5000 });
    await a.idle();
    await app.close(); // stores the room and takes a backup
    expect(filesUnder(dir).some((f) => has(f, utf8("PLAINTEXT-WRITE")))).toBe(false);
  });

  it("COLLAB_REQUIRE_E2EE seals every room: plaintext presence is refused too", async () => {
    const { url } = await start({ requireE2ee: true });
    const room = "lumen-e2ee-required";
    const doc = new Y.Doc();
    const awareness = new Awareness(doc);
    cleanups.push(() => awareness.destroy());
    let closed = 0;
    await connect(url, room, doc, awareness, token(url, room, false), { onClose: () => closed++ });
    awareness.setLocalStateField("user", { name: "plain name" });
    await vi.waitFor(() => expect(closed).toBeGreaterThan(0), { timeout: 5000 });
  });
});

/* ─── Acceptance 2: latency between two participants < 150 ms ──────────── */

describe("live", () => {
  it("an edit reaches the other participant in < 150 ms (local network: loopback)", async () => {
    const { url } = await start();
    const room = "lumen-e2ee-latency";
    const a = await e2eClient(url, room, "latency-room-key-0123456", "A");
    const b = await e2eClient(url, room, "latency-room-key-0123456", "B");
    a.text.insert(0, "warm-up ");
    await vi.waitFor(() => expect(b.text.toString()).toContain("warm-up"), { timeout: 5000 });

    const samples: number[] = [];
    for (let i = 0; i < 40; i++) {
      const marker = `m${i}|`;
      const arrived = new Promise<number>((resolve) => {
        const check = () => {
          if (!b.text.toString().includes(marker)) return;
          b.plain.off("update", check);
          resolve(performance.now());
        };
        b.plain.on("update", check);
      });
      const t0 = performance.now();
      a.text.insert(a.text.length, marker);
      samples.push((await arrived) - t0);
    }
    samples.sort((x, y) => x - y);
    const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
    expect(p95).toBeLessThan(150);
    expect(samples[Math.floor(samples.length / 2)]).toBeLessThan(150);
  });
});

/* ─── Acceptance 3: 1 MB, 5 participants, 1,000 random edits, 0 lost ───── */

function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("many participants", () => {
  it("a 1 MB note, 5 participants, 1,000 random edits: every edit arrives everywhere", async () => {
    const { app, url } = await start();
    const room = "lumen-e2ee-load";
    const password = "load-room-key-0123456789";
    const filler = "אבגדהוזחטיכלמנסעפצקרשת ";
    const unit = utf8(filler).length;
    const seed = filler.repeat(Math.ceil((1024 * 1024) / unit)).slice(0, Math.ceil((1024 * 1024) / unit) * filler.length);
    expect(utf8(seed).length).toBeGreaterThanOrEqual(1024 * 1024);

    const clients: Client[] = [await e2eClient(url, room, password, "P0")];
    clients[0].text.insert(0, seed);
    await clients[0].idle();
    for (let i = 1; i < 5; i++) clients.push(await e2eClient(url, room, password, `P${i}`));
    await vi.waitFor(() => clients.forEach((c) => expect(c.text.length).toBe(seed.length)), { timeout: 30_000 });

    // The note before the edits, and what each participant then changed itself: the reference.
    const base = Y.encodeStateAsUpdate(clients[0].plain);
    const own: Uint8Array[] = [];
    for (const c of clients) c.plain.on("update", (u: Uint8Array, origin: unknown) => origin !== E2E_REMOTE_ORIGIN && own.push(u));

    const rand = prng(0x5eed);
    const markers: string[] = [];
    const fillerOnly = /^[א-ת ]+$/;
    for (let i = 0; i < 1000; i++) {
      const c = clients[Math.floor(rand() * clients.length)];
      const len = c.text.length;
      if (rand() < 0.7 || len < 10) {
        const m = `⟦${i}⟧`;
        markers.push(m);
        c.text.insert(Math.floor(rand() * (len + 1)), m);
      } else {
        // Delete 1–3 characters of the original text (never a marker).
        const n = 1 + Math.floor(rand() * 3);
        const s = c.text.toString();
        for (let tries = 0; tries < 20; tries++) {
          const at = Math.floor(rand() * (len - n));
          if (fillerOnly.test(s.slice(at, at + n))) {
            c.text.delete(at, n);
            break;
          }
        }
      }
      // Let the network run between bursts, so edits are concurrent but flowing.
      if (i % 20 === 19) await new Promise((r) => setImmediate(r));
    }

    for (const c of clients) await c.idle();
    const reference = new Y.Doc();
    Y.applyUpdate(reference, Y.mergeUpdates([base, ...own]));
    const expected = reference.getText("lumen").toString();
    await vi.waitFor(
      async () => {
        for (const c of clients) await c.idle();
        for (const c of clients) expect(c.text.toString()).toBe(clients[0].text.toString());
      },
      { timeout: 90_000, interval: 250 },
    );
    const final = clients[0].text.toString();
    expect(final.length).toBe(expected.length);
    expect(final).toBe(expected);
    for (const m of markers) expect(final.split(m).length - 1).toBe(1);

    // A sixth participant, from the server's copy alone, gets the same note.
    await vi.waitFor(() => expect(app.store.load(room)).not.toBeNull(), { timeout: 5000 });
    const late = await e2eClient(url, room, password, "late");
    await vi.waitFor(() => expect(late.text.toString()).toBe(final), { timeout: 30_000 });
  }, 180_000);
});

/* ─── The server's shape checks, on real yjs updates ───────────────────── */

describe("sealed shape", () => {
  const syncMessage = (update: Uint8Array) => {
    const name = utf8("room");
    const head = [name.length, ...name, 0, 2];
    const len: number[] = [];
    let n = update.length;
    while (n > 127) {
      len.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    len.push(n);
    return new Uint8Array([...head, ...len, ...update]);
  };

  it("envelopes pass; text, map entries, nested types and foreign array elements do not", async () => {
    const plain = new Y.Doc();
    const transport = new Y.Doc();
    const ch = wireE2E(plain, transport, { password: "k", room: "room" });
    const updates: Uint8Array[] = [];
    transport.on("update", (u: Uint8Array) => updates.push(u));
    plain.getText("lumen").insert(0, "שלום");
    await ch.whenIdle();
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) expect(sealedUpdateProblem(u, Y)).toBeNull();
    expect(sealedMessageProblem(syncMessage(updates[0]), Y)).toBeNull();
    expect(isSealedState(Y.encodeStateAsUpdate(transport), Y)).toBe(true);
    ch.destroy();

    const bad = (fn: (d: Y.Doc) => void) => {
      const d = new Y.Doc();
      fn(d);
      return sealedUpdateProblem(Y.encodeStateAsUpdate(d), Y);
    };
    expect(bad((d) => d.getText("lumen").insert(0, "plain"))).toMatch(/^root:lumen/);
    expect(bad((d) => d.getMap("e2e").set("x", 1))).toBe("map-entry");
    expect(bad((d) => d.getArray("e2e").push([new Y.Map()]))).toMatch(/^content:/);
    expect(bad((d) => d.getArray("e2e").push(["plain words"]))).toBe("not-an-envelope");
    expect(bad((d) => d.getArray("e2e").push([{ v: 2, iv: new Uint8Array(12), ct: new Uint8Array(16), note: "x" }]))).toBe("not-an-envelope");
    expect(sealedMessageProblem(syncMessage(Y.encodeStateAsUpdate((() => {
      const d = new Y.Doc();
      d.getText("t").insert(0, "x");
      return d;
    })())), Y)).toMatch(/^root:/);
    expect(isEnvelope({ v: 2, iv: new Uint8Array(12), ct: new Uint8Array(16), s: 1 })).toBe(true);
  });

  it("presence: sealed or empty only", () => {
    expect(isSealedAwarenessJson("null")).toBe(true);
    expect(isSealedAwarenessJson("{}")).toBe(true);
    expect(isSealedAwarenessJson('{"e2e":"AAAA"}')).toBe(true);
    expect(isSealedAwarenessJson('{"user":{"name":"x"}}')).toBe(false);
    expect(isSealedAwarenessJson('{"e2e":"AAAA","user":1}')).toBe(false);
    expect(parseMessage(new Uint8Array([0xff])).kind).toBe("malformed");
  });
});

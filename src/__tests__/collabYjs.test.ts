/**
 * Unit tests for helpers in src/collab/yjs.ts:
 *   makeRoomName, readRoomFromHash, setRoomInHash, snapshotPeers.
 *
 * connectCollab lifecycle behavior is also tested with transport-safe mocks.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

// Mock heavy collab deps that would try to open WebSocket connections.
// The persistent provider (Hocuspocus, plan 3.6) is replaced by a double
// with the same `sync` surface; `WebsocketProvider` is the double's class.
vi.mock("../collab/persistentProvider", () => {
  const instances: unknown[] = [];
  class WebsocketProvider {
    static instances: unknown[] = instances;
    /** Set by a test to model the server's sync handshake; plain stubs settle at once. */
    static withSync = false;
    destroy = vi.fn(() => {
      return;
    });
    synced = false;
    syncListeners = new Set<(s: boolean) => void>();
    on?: (e: string, fn: (s: boolean) => void) => void;
    off?: (e: string, fn: (s: boolean) => void) => void;
    constructor() {
      WebsocketProvider.instances.push(this);
      if (WebsocketProvider.withSync) {
        this.on = (_e, fn) => this.syncListeners.add(fn);
        this.off = (_e, fn) => this.syncListeners.delete(fn);
      }
    }
    emitSync(v: boolean) {
      this.synced = v;
      this.syncListeners.forEach((fn) => fn(v));
    }
  }
  return { WebsocketProvider, createPersistentProvider: async () => new WebsocketProvider() };
});
type PersistentMock = { WebsocketProvider: { instances: unknown[]; withSync: boolean } };
vi.mock("y-webrtc", () => ({
  // Minimal stand-in: an event emitter with controllable awareness peers and
  // WebRTC connections so tests can drive the `synced` seeding logic.
  WebrtcProvider: class {
    static lastDoc: unknown = null;
    static lastOpts: unknown = null;
    constructor(_room: string, doc: unknown, opts?: unknown) {
      (this.constructor as unknown as { lastDoc: unknown }).lastDoc = doc;
      (this.constructor as unknown as { lastOpts: unknown }).lastOpts = opts;
    }
    listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    awarenessStates = new Map<number, unknown>([[1, {}]]);
    room: { webrtcConns: Map<string, unknown> } = { webrtcConns: new Map() };
    awareness = {
      getStates: () => this.awarenessStates,
      setLocalStateField: vi.fn(),
    };
    destroy = vi.fn();
    on(name: string, fn: (...args: unknown[]) => void) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(fn);
    }
    off(name: string, fn: (...args: unknown[]) => void) {
      this.listeners.get(name)?.delete(fn);
    }
    emit(name: string, args: unknown[]) {
      this.listeners.get(name)?.forEach((fn) => fn(...args));
    }
  },
}));
vi.mock("yjs", async () => {
  const actual = await vi.importActual<typeof import("yjs")>("yjs");
  return actual;
});
vi.mock("../lib/logger", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/cryptoRandom", () => ({
  randomChoice: (arr: unknown[]) => arr[0],
  randomInt: () => 42,
  randomId: () => "test-id",
}));

afterEach(() => {
  localStorage.removeItem("lumen.collab.ws");
});

describe("makeRoomName", () => {
  it("returns a non-empty string", async () => {
    const { makeRoomName } = await import("../collab/yjs");
    const name = makeRoomName();
    expect(typeof name).toBe("string");
    expect(name.length).toBeGreaterThan(0);
  });

  it("contains a hyphen separator between adjective and noun", async () => {
    const { makeRoomName } = await import("../collab/yjs");
    const name = makeRoomName();
    expect(name).toContain("-");
  });

  it("always generates a URL-safe string (no spaces or special chars)", async () => {
    const { makeRoomName } = await import("../collab/yjs");
    for (let i = 0; i < 20; i++) {
      const name = makeRoomName();
      expect(name).toMatch(/^[\w-]+$/);
    }
  });

  it("is built from the crypto-random id (128 bits — see secureRooms.test)", async () => {
    const { makeRoomName } = await import("../collab/yjs");
    expect(makeRoomName()).toMatch(/^lumen-/);
  });
});

describe("readRoomFromHash", () => {
  const origLocation = globalThis.location;

  afterEach(() => {
    Object.defineProperty(globalThis, "location", {
      value: origLocation,
      writable: true,
    });
  });

  it("returns null when hash is empty", async () => {
    Object.defineProperty(globalThis, "location", {
      value: { hash: "" },
      writable: true,
    });
    const { readRoomFromHash } = await import("../collab/yjs");
    expect(readRoomFromHash()).toBeNull();
  });

  it("returns the room name when #room= is in hash", async () => {
    Object.defineProperty(globalThis, "location", {
      value: { hash: "#room=calm-river-42" },
      writable: true,
    });
    const { readRoomFromHash } = await import("../collab/yjs");
    expect(readRoomFromHash()).toBe("calm-river-42");
  });

  it("returns room name when &room= appears in hash params", async () => {
    Object.defineProperty(globalThis, "location", {
      value: { hash: "#other=foo&room=bright-comet-7" },
      writable: true,
    });
    const { readRoomFromHash } = await import("../collab/yjs");
    expect(readRoomFromHash()).toBe("bright-comet-7");
  });

  it("returns null when hash does not contain room param", async () => {
    Object.defineProperty(globalThis, "location", {
      value: { hash: "#theme=dark" },
      writable: true,
    });
    const { readRoomFromHash } = await import("../collab/yjs");
    expect(readRoomFromHash()).toBeNull();
  });
});

describe("snapshotPeers", () => {
  it("returns empty array when awareness has no user states", async () => {
    const { snapshotPeers } = await import("../collab/yjs");
    const Y = await vi.importActual<typeof import("yjs")>("yjs");
    const doc = new (Y as any).Doc();
    const session = {
      doc,
      awareness: {
        getStates: () => new Map([[doc.clientID, {}]]), // no .user field
      },
    } as any;
    const peers = snapshotPeers(session);
    expect(peers).toEqual([]);
  });

  it("returns peers with user info from awareness states", async () => {
    const { snapshotPeers } = await import("../collab/yjs");
    const Y = await vi.importActual<typeof import("yjs")>("yjs");
    const doc = new (Y as any).Doc();
    const selfUser = { name: "Alice", color: "hsl(200 70% 55%)", colorLight: "hsl(200 70% 85%)" };
    const peerUser = { name: "Bob", color: "hsl(100 70% 55%)", colorLight: "hsl(100 70% 85%)" };
    const states = new Map([
      [doc.clientID, { user: selfUser }],
      [999, { user: peerUser }],
    ]);
    const session = {
      doc,
      awareness: { getStates: () => states },
    } as any;
    const peers = snapshotPeers(session);
    expect(peers.length).toBe(2);
    const self = peers.find((p) => p.isSelf);
    expect(self?.user.name).toBe("Alice");
    const other = peers.find((p) => !p.isSelf);
    expect(other?.user.name).toBe("Bob");
  });

  it("puts self first in the returned list", async () => {
    const { snapshotPeers } = await import("../collab/yjs");
    const Y = await vi.importActual<typeof import("yjs")>("yjs");
    const doc = new (Y as any).Doc();
    const selfUser = { name: "Self", color: "blue", colorLight: "lightblue" };
    const peerUser = { name: "Peer", color: "red", colorLight: "pink" };
    const states = new Map([
      [999, { user: peerUser }],   // lower client ID, added first
      [doc.clientID, { user: selfUser }],
    ]);
    const session = {
      doc,
      awareness: { getStates: () => states },
    } as any;
    const peers = snapshotPeers(session);
    expect(peers[0].isSelf).toBe(true);
    expect(peers[0].user.name).toBe("Self");
  });
});

describe("connectCollab lifecycle", () => {
  it("does not seed content if the session is destroyed before timeout", async () => {
    const mod = await import("../collab/yjs");
    vi.useFakeTimers();
    try {
      const session = mod.connectCollab("lumen-seed-room", "seed");
      session.destroy();
      vi.advanceTimersByTime(500);
      expect(session.ytext.toString()).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not attach a saved persistent server when the plan doesn't include it", async () => {
    localStorage.setItem("lumen.collab.ws", "ws://localhost:4444");
    const { useEntitlement, __setEntitlementEndpointForTesting } = await import("../billing/useEntitlement");
    const { FREE_CAPS } = await import("../billing/types");
    __setEntitlementEndpointForTesting("https://billing.lumen.test/entitlements");
    useEntitlement.setState({ capabilities: FREE_CAPS, entitlement: null, loading: false });
    try {
      const mod = await import("../collab/yjs");
      const moduleMock = ((await import("../collab/persistentProvider")) as unknown as PersistentMock);
      const before = (moduleMock.WebsocketProvider as unknown as { instances: unknown[] }).instances.length;
      const session = mod.connectCollab("lumen-free-room", "");
      await new Promise((r) => setTimeout(r, 20));
      expect((moduleMock.WebsocketProvider as unknown as { instances: unknown[] }).instances.length).toBe(before);
      session.destroy();
    } finally {
      __setEntitlementEndpointForTesting(null);
    }
  });

  it("waits for a loading entitlement before deciding on the persistent server", async () => {
    localStorage.setItem("lumen.collab.ws", "ws://localhost:4444");
    const { useEntitlement, __setEntitlementEndpointForTesting } = await import("../billing/useEntitlement");
    const { FREE_CAPS, capabilitiesFor } = await import("../billing/types");
    __setEntitlementEndpointForTesting("https://billing.lumen.test/entitlements");
    // Returning paid user: the plan is still loading, placeholder FREE_CAPS.
    useEntitlement.setState({ capabilities: FREE_CAPS, entitlement: null, loading: true, failed: false });
    try {
      const mod = await import("../collab/yjs");
      const moduleMock = ((await import("../collab/persistentProvider")) as unknown as PersistentMock);
      const count = () => (moduleMock.WebsocketProvider as unknown as { instances: unknown[] }).instances.length;
      const before = count();
      const session = mod.connectCollab("lumen-paid-room", "");
      await new Promise((r) => setTimeout(r, 20));
      expect(count()).toBe(before); // undecided, not skipped
      const pro = { tier: "pro" as const, status: "active" as const };
      useEntitlement.setState({ capabilities: capabilitiesFor(pro), entitlement: pro, loading: false, failed: false });
      await vi.waitFor(() => expect(count()).toBe(before + 1));
      session.destroy();
    } finally {
      __setEntitlementEndpointForTesting(null);
      useEntitlement.setState({ loading: false, failed: false });
    }
  });

  it("does not retain websocket provider when destroy happens before attach completes", async () => {
    localStorage.setItem("lumen.collab.ws", "ws://localhost:4444");
    const mod = await import("../collab/yjs");
    const moduleMock = ((await import("../collab/persistentProvider")) as unknown as PersistentMock);
    const instancesBefore = (moduleMock.WebsocketProvider as unknown as { instances: unknown[] }).instances.length;

    const session = mod.connectCollab("lumen-seed-room", "");
    session.destroy();
    // The attach path is `await import('./persistentProvider')` →
    // `createPersistentProvider(...)` → the consumer's `.then(p => …)`. Microtask
    // counts differ between vitest module runners, so poll instead of
    // flushing a fixed number of ticks.
    await vi.waitFor(() => {
      expect(
        (moduleMock.WebsocketProvider as unknown as { instances: unknown[] }).instances.length,
      ).toBe(instancesBefore + 1);
    });
    expect(session.websocketProvider).toBeNull();

    for (const instance of (moduleMock.WebsocketProvider as unknown as { instances: unknown[] }).instances) {
      const destroy = (instance as { destroy: () => void }).destroy;
      if (typeof destroy === "function") {
        expect(destroy).toHaveBeenCalledTimes(1);
      }
    }
  });

  it("password rooms encrypt y-webrtc signaling (so presence only reaches password holders)", async () => {
    const mod = await import("../collab/yjs");
    const { WebrtcProvider } = await import("y-webrtc");
    const secret = mod.connectCollab("lumen-secret-presence", "", { password: "pw-123456" });
    expect((WebrtcProvider as unknown as { lastOpts: { password?: string } }).lastOpts.password).toBe("pw-123456");
    secret.destroy();
    const open = mod.connectCollab("lumen-open-presence", "", { password: null });
    expect((WebrtcProvider as unknown as { lastOpts: { password?: string } }).lastOpts.password).toBeUndefined();
    open.destroy();
  });

  it("plain rooms sync the editor doc directly", async () => {
    const mod = await import("../collab/yjs");
    const { WebrtcProvider } = await import("y-webrtc");
    const session = mod.connectCollab("lumen-plain-room", "", { password: null });
    expect(session.encrypted).toBe(false);
    expect(session.transportDoc).toBeNull();
    expect((WebrtcProvider as unknown as { lastDoc: unknown }).lastDoc).toBe(session.doc);
    session.destroy();
  });

  it("password rooms attach providers to the ciphertext transport doc only", async () => {
    const mod = await import("../collab/yjs");
    const { WebrtcProvider } = await import("y-webrtc");
    const session = mod.connectCollab("lumen-secret-room", "", { password: "pw-123456" });
    expect(session.encrypted).toBe(true);
    expect(session.transportDoc).not.toBeNull();
    const attached = (WebrtcProvider as unknown as { lastDoc: unknown }).lastDoc;
    expect(attached).toBe(session.transportDoc);
    expect(attached).not.toBe(session.doc);
    // Awareness self-detection relies on matching client ids.
    expect(session.transportDoc!.clientID).toBe(session.doc.clientID);
    session.destroy();
  });
});

type MockProvider = {
  emit: (name: string, args: unknown[]) => void;
  listeners: Map<string, Set<unknown>>;
  awarenessStates: Map<number, unknown>;
  room: { webrtcConns: Map<string, unknown> };
};

describe("connectCollab join-time seeding", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("seeds a new room synchronously", async () => {
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-new", "hello", { isNewRoom: true });
    expect(session.ytext.toString()).toBe("hello");
    session.destroy();
  });

  it("does not seed before synced or the fallback timeout", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    vi.advanceTimersByTime(mod.SEED_FALLBACK_MS - 1);
    expect(session.ytext.toString()).toBe("");
    session.destroy();
  });

  it("seeds via the fallback timer when no peers ever appear", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    vi.advanceTimersByTime(mod.SEED_FALLBACK_MS);
    expect(session.ytext.toString()).toBe("seed");
    // The synced listener is removed once we've decided.
    const p = session.provider as unknown as MockProvider;
    expect(p.listeners.get("synced")?.size ?? 0).toBe(0);
    session.destroy();
  });

  it("never auto-seeds an encrypted room it joins alone; seeds only on request", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    let share: (() => void) | null = null;
    const session = mod.connectCollab("lumen-join-secret", "seed", {
      password: "pw-123456",
      onEncryptedRoomEmpty: (fn) => {
        share = fn;
      },
    });
    vi.advanceTimersByTime(mod.SEED_FALLBACK_MS);
    expect(session.ytext.toString()).toBe(""); // a wrong password must not fork the room
    expect(share).not.toBeNull();
    share!();
    expect(session.ytext.toString()).toBe("seed");
    session.destroy();
  });

  it("keeps the room's own password on the session for later invite links, never a stored default", async () => {
    const mod = await import("../collab/yjs");
    const created = mod.connectCollab("lumen-created", "", { isNewRoom: true, password: "gen-pw" });
    expect(created.sharePassword).toBe("gen-pw");
    created.destroy();
    localStorage.setItem("lumen.collab.password", "my-default");
    try {
      const joined = mod.connectCollab("lumen-joined", "");
      expect(joined.encrypted).toBe(true); // the stored default still encrypts
      expect(joined.sharePassword).toBeNull(); // but is never put into a link
      joined.destroy();
    } finally {
      localStorage.removeItem("lumen.collab.password");
    }
  });

  it("the share link's password wins over a stored default", async () => {
    const mod = await import("../collab/yjs");
    const { WebrtcProvider } = await import("y-webrtc");
    localStorage.setItem("lumen.collab.password", "old-default");
    const orig = globalThis.location;
    Object.defineProperty(globalThis, "location", {
      value: { ...orig, hash: "#room=new-room&password=from-link" },
      configurable: true,
      writable: true,
    });
    try {
      const session = mod.connectCollab("new-room", "");
      expect((WebrtcProvider as unknown as { lastOpts: { password?: string } }).lastOpts.password).toBe("from-link");
      expect(session.sharePassword).toBe("from-link");
      session.destroy();
    } finally {
      Object.defineProperty(globalThis, "location", { value: orig, configurable: true, writable: true });
      localStorage.removeItem("lumen.collab.password");
    }
  });

  it("seeds on synced when still empty and alone, and cancels the fallback timer", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    const p = session.provider as unknown as MockProvider;
    p.emit("synced", [{ synced: true }]);
    expect(session.ytext.toString()).toBe("seed");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(mod.SEED_FALLBACK_MS * 2);
    expect(session.ytext.toString()).toBe("seed"); // not seeded twice
    session.destroy();
  });

  it("ignores synced:false", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    const p = session.provider as unknown as MockProvider;
    p.emit("synced", [{ synced: false }]);
    expect(session.ytext.toString()).toBe("");
    expect(vi.getTimerCount()).toBe(1);
    session.destroy();
  });

  it("does not seed when remote content arrived before synced", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    const p = session.provider as unknown as MockProvider;
    session.ytext.insert(0, "remote doc");
    p.emit("synced", [{ synced: true }]);
    vi.advanceTimersByTime(mod.SEED_FALLBACK_MS * 2);
    expect(session.ytext.toString()).toBe("remote doc");
    session.destroy();
  });

  it("waits for synced instead of seeding on timeout when peers are connected", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    const p = session.provider as unknown as MockProvider;
    p.room.webrtcConns.set("peer-1", {});
    p.awarenessStates.set(2, {});
    vi.advanceTimersByTime(mod.SEED_FALLBACK_MS);
    expect(session.ytext.toString()).toBe("");
    // Still listening for synced.
    expect(p.listeners.get("synced")?.size).toBe(1);
    // Peer delivers its (non-empty) state, then synced fires.
    session.ytext.insert(0, "peer content");
    p.emit("synced", [{ synced: true }]);
    expect(session.ytext.toString()).toBe("peer content");
    session.destroy();
  });

  it("removes the synced listener and timer on destroy", async () => {
    vi.useFakeTimers();
    const mod = await import("../collab/yjs");
    const session = mod.connectCollab("lumen-join", "seed");
    const p = session.provider as unknown as MockProvider;
    session.destroy();
    expect(p.listeners.get("synced")?.size ?? 0).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("seeding with a persistent (Hocuspocus) server", () => {
  afterEach(() => {
    localStorage.removeItem("lumen.collab.ws");
  });

  it("waits for the server's sync before seeding, and doesn't seed over its history", async () => {
    localStorage.setItem("lumen.collab.ws", "ws://localhost:4444");
    const ws = (((await import("../collab/persistentProvider")) as unknown as PersistentMock)) as unknown as {
      WebsocketProvider: { withSync: boolean; instances: { emitSync(v: boolean): void }[] };
    };
    ws.WebsocketProvider.withSync = true;
    try {
      const mod = await import("../collab/yjs");
      const session = mod.connectCollab("lumen-persisted", "local draft");
      const p = session.provider as unknown as MockProvider;
      p.emit("synced", [{ synced: true }]); // WebRTC: alone, nothing from peers
      expect(session.ytext.toString()).toBe(""); // not seeded yet: server pending
      await vi.waitFor(() => expect(session.websocketProvider).not.toBeNull());
      // Server delivers the room's history, then reports synced.
      session.ytext.insert(0, "server history");
      ws.WebsocketProvider.instances.at(-1)!.emitSync(true);
      expect(session.ytext.toString()).toBe("server history"); // no merge with the local draft
      session.destroy();
    } finally {
      ws.WebsocketProvider.withSync = false;
    }
  });

  it("seeds once the server reports an empty room", async () => {
    localStorage.setItem("lumen.collab.ws", "ws://localhost:4444");
    const ws = (((await import("../collab/persistentProvider")) as unknown as PersistentMock)) as unknown as {
      WebsocketProvider: { withSync: boolean; instances: { emitSync(v: boolean): void }[] };
    };
    ws.WebsocketProvider.withSync = true;
    try {
      const mod = await import("../collab/yjs");
      const session = mod.connectCollab("lumen-empty-persisted", "local draft");
      (session.provider as unknown as MockProvider).emit("synced", [{ synced: true }]);
      await vi.waitFor(() => expect(session.websocketProvider).not.toBeNull());
      expect(session.ytext.toString()).toBe("");
      ws.WebsocketProvider.instances.at(-1)!.emitSync(true);
      expect(session.ytext.toString()).toBe("local draft");
      session.destroy();
    } finally {
      ws.WebsocketProvider.withSync = false;
    }
  });

  it("falls back to WebRTC-only seeding when the server never syncs (offline)", async () => {
    localStorage.setItem("lumen.collab.ws", "ws://localhost:4444");
    const ws = (((await import("../collab/persistentProvider")) as unknown as PersistentMock)) as unknown as {
      WebsocketProvider: { withSync: boolean };
    };
    ws.WebsocketProvider.withSync = true;
    try {
      const mod = await import("../collab/yjs");
      vi.useFakeTimers();
      const session = mod.connectCollab("lumen-offline-server", "local draft");
      for (let i = 0; i < 20 && !session.websocketProvider; i++) await vi.advanceTimersByTimeAsync(1);
      expect(session.websocketProvider).not.toBeNull();
      (session.provider as unknown as MockProvider).emit("synced", [{ synced: true }]);
      expect(session.ytext.toString()).toBe("");
      const provider = session.websocketProvider as unknown as { destroy: ReturnType<typeof vi.fn> };
      vi.advanceTimersByTime(mod.PERSISTENT_SYNC_TIMEOUT_MS);
      expect(session.ytext.toString()).toBe("local draft");
      // Torn down, so a later reconnect can't merge server history into the seeded doc.
      expect(provider.destroy).toHaveBeenCalled();
      expect(session.websocketProvider).toBeNull();
      session.destroy();
    } finally {
      vi.useRealTimers();
      ws.WebsocketProvider.withSync = false;
    }
  });
});

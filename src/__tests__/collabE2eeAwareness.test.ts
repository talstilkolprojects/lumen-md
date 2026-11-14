/**
 * Plan W2.20: presence (names, colours, cursors) end-to-end encrypted. Two
 * participants, each with a plain awareness (what the editor reads) and a
 * transport awareness (what a provider would sync), joined by a relay that
 * plays the server: it sees and forwards transport states only.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import { E2E_AWARENESS_FIELD, sealAwarenessState, wireE2EAwareness, type AwarenessLike, type E2EAwarenessBridge } from "../collab/e2eAwareness";

const live: Array<{ destroy(): void }> = [];
afterEach(() => {
  for (const x of live.splice(0)) x.destroy();
});

interface Peer {
  plain: Awareness;
  transport: Awareness;
  bridge: E2EAwarenessBridge;
  errors: string[];
}

function peer(password: string, room = "room-aw"): Peer {
  const doc = new Y.Doc();
  const plain = new Awareness(doc);
  const transport = new Awareness(doc); // same client id, as connectCollab arranges
  const errors: string[] = [];
  const bridge = wireE2EAwareness(plain as unknown as AwarenessLike, transport as unknown as AwarenessLike, { password, room, onDecryptError: (r) => errors.push(r) });
  live.push(bridge, plain, transport);
  return { plain, transport, bridge, errors };
}

/** Forward every transport change between the peers; returns what "the server" saw. */
function relay(...peers: Peer[]): string[] {
  const seen: string[] = [];
  for (const from of peers) {
    from.transport.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === "relay") return;
      const update = encodeAwarenessUpdate(from.transport, [...added, ...updated, ...removed]);
      seen.push(new TextDecoder().decode(update));
      for (const to of peers) if (to !== from) applyAwarenessUpdate(to.transport, update, "relay");
    });
  }
  return seen;
}

const settle = (...peers: Peer[]) => Promise.all(peers.map((p) => p.bridge.whenIdle()));

describe("encrypted presence", () => {
  it("each participant sees the other's name and cursor; the relay sees only sealed states", async () => {
    const a = peer("room-key");
    const b = peer("room-key");
    const seen = relay(a, b);
    a.plain.setLocalStateField("user", { name: "דנה", color: "#f00" });
    a.plain.setLocalStateField("cursor", { anchor: "שלום", head: 3 });
    b.plain.setLocalStateField("user", { name: "Bob", color: "#00f" });

    await vi.waitFor(async () => {
      await settle(a, b);
      expect(b.plain.getStates().get(a.plain.clientID)).toEqual({ user: { name: "דנה", color: "#f00" }, cursor: { anchor: "שלום", head: 3 } });
      expect(a.plain.getStates().get(b.plain.clientID)).toEqual({ user: { name: "Bob", color: "#00f" } });
    });
    const wire = seen.join("\n");
    expect(wire).not.toContain("דנה");
    expect(wire).not.toContain("Bob");
    expect(wire).not.toContain("cursor");
    for (const st of b.transport.getStates().values()) expect(Object.keys(st).every((k) => k === E2E_AWARENESS_FIELD)).toBe(true);
  });

  it("the plain awareness emits change events the editor's cursors listen to, and a departure removes the peer", async () => {
    const a = peer("room-key");
    const b = peer("room-key");
    relay(a, b);
    const changes: Array<{ added: number[]; updated: number[]; removed: number[] }> = [];
    b.plain.on("change", (c: { added: number[]; updated: number[]; removed: number[] }) => changes.push(c));
    a.plain.setLocalStateField("user", { name: "A" });
    await vi.waitFor(async () => {
      await settle(a, b);
      expect(changes.some((c) => c.added.includes(a.plain.clientID) || c.updated.includes(a.plain.clientID))).toBe(true);
    });
    a.plain.setLocalState(null);
    await vi.waitFor(async () => {
      await settle(a, b);
      expect(b.plain.getStates().has(a.plain.clientID)).toBe(false);
    });
  });

  it("a wrong key shows nothing and reports it once", async () => {
    const a = peer("room-key");
    const b = peer("another-key");
    relay(a, b);
    a.plain.setLocalStateField("user", { name: "A" });
    a.plain.setLocalStateField("cursor", { head: 1 });
    await vi.waitFor(async () => {
      await settle(a, b);
      expect(b.errors).toEqual(["decrypt-failed"]);
    });
    expect(b.plain.getStates().has(a.plain.clientID)).toBe(false);
  });

  it("a relay can't show one participant's state as another's, or replay an older one", async () => {
    const b = peer("room-key");
    const victim = 4242;
    const sealedFor = (id: number, n: number, name: string) => sealAwarenessState("room-key", "room-aw", id, n, { user: { name } });
    const inject = async (id: number, clock: number, state: Record<string, unknown>) => {
      const fake = new Awareness(new Y.Doc());
      live.push(fake);
      fake.states.set(id, state);
      fake.meta.set(id, { clock, lastUpdated: Date.now() });
      applyAwarenessUpdate(b.transport, encodeAwarenessUpdate(fake, [id]), "relay");
      await b.bridge.whenIdle();
    };
    // Sealed for 1111, presented as 4242: rejected (the client id is in the tag).
    await inject(victim, 1, await sealedFor(1111, 1, "mallory"));
    expect(b.plain.getStates().has(victim)).toBe(false);
    // The real thing is shown…
    await inject(victim, 2, await sealedFor(victim, 5, "victim-new"));
    expect(b.plain.getStates().get(victim)).toEqual({ user: { name: "victim-new" } });
    // …and an older state of the same participant, replayed later, is not.
    await inject(victim, 3, await sealedFor(victim, 4, "victim-old"));
    expect(b.plain.getStates().get(victim)).toEqual({ user: { name: "victim-new" } });
    // A state that isn't sealed is never shown, and hides what was there.
    await inject(victim, 4, { user: { name: "plain" } });
    expect(b.plain.getStates().has(victim)).toBe(false);
  });
});

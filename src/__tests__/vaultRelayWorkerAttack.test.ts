/**
 * Review t5 attack tests on the vault relay Worker (#531 port), in the train's own
 * Durable Object simulation, adopted with the fixes (L3: exact health paths; M2: the
 * day's counts in memory, persisted as a bounded journal + snapshot). A2 and A4 are
 * the storage budget: rows written per refused request, and rows kept (and read at
 * every start) after 200 addresses. @vitest-environment node
 */
import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain ESM Worker module
import worker, { VaultRelay, JOURNAL_MAX } from "../../edge-workers/vault-relay/worker.mjs";
import { FakeStorage, fakeState } from "./helpers/durableObject";

type Env = Record<string, unknown>;
function host(vars: Env = {}, storage = new FakeStorage()) {
  let obj: { fetch(r: Request): Promise<Response> } | null = null;
  let state = fakeState(storage);
  const env: Env = {
    VAULT_RELAY_RATE: "100000",
    ...vars,
    RELAY: { idFromName: (n: string) => n, get: () => ({ fetch: async (r: Request) => { if (!obj) { state = fakeState(storage); obj = new VaultRelay(state, env); } await state.ready; return obj!.fetch(r); } }) },
  };
  const call = (method: string, tok: string, name: string, ip: string, body?: Uint8Array, headers: Record<string, string> = {}) =>
    (worker as { fetch(r: Request, e: Env): Promise<Response> }).fetch(new Request(`https://relay.example.com/v1/vault/o/${name}`, { method, body: body as BodyInit | undefined, headers: { Authorization: `Bearer ${tok}`, "cf-connecting-ip": ip, ...headers } }), env);
  return { storage, call, evict: () => (obj = null) };
}
const tok = (i: number) => `tok-${String(i).padStart(4, "0")}-${"x".repeat(32)}`;

describe("vault relay Worker (review t5)", () => {
  it("A1: an object named `health` is stored like any other (the front Worker's health route must not swallow it)", async () => {
    const h = host();
    const put = await h.call("PUT", tok(1), "health", "198.51.100.1", new Uint8Array(10).fill(1));
    expect(put.status).toBe(201);
    const got = await h.call("GET", tok(1), "health", "198.51.100.1");
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(new Uint8Array(10).fill(1));
  });

  it("A2: a refused PUT (412) writes no storage rows", async () => {
    const h = host();
    expect((await h.call("PUT", tok(2), "a", "198.51.100.2", new Uint8Array(8))).status).toBe(201);
    const before = h.storage.writes;
    const N = 50;
    for (let i = 0; i < N; i++) expect((await h.call("PUT", tok(2), "a", "198.51.100.2", new Uint8Array(8), { "If-Match": '"nope"' })).status).toBe(412);
    const perRequest = (h.storage.writes - before) / N;
    console.log(`rows written per refused PUT: ${perRequest}`);
    expect(perRequest).toBe(0);
  });

  it("A3: 413 over the object limit, also past 4x (the cancel path), and nothing stored", async () => {
    const h = host({ VAULT_RELAY_MAX_OBJECT: "1024" });
    expect((await h.call("PUT", tok(3), "b", "198.51.100.3", new Uint8Array(1025))).status).toBe(413);
    expect((await h.call("PUT", tok(3), "c", "198.51.100.3", new Uint8Array(64 * 1024))).status).toBe(413);
    expect([...h.storage.data.keys()].filter((k) => k.startsWith("m|") || k.startsWith("d|"))).toEqual([]);
    // the space was never opened: the daily new-space count was given back
    expect((await h.call("PUT", tok(3), "d", "198.51.100.3", new Uint8Array(10))).status).toBe(201);
  });

  it("A4: rows read when the object starts again do not grow with the day's addresses", async () => {
    const h = host();
    for (let i = 0; i < 200; i++) await h.call("PUT", tok(100 + i), "x", `203.0.113.${i % 250}`, new Uint8Array(4));
    await new Promise((r) => setTimeout(r, 20)); // the snapshot's journal clean-up
    const rows = [...h.storage.data.keys()].filter((k) => k.startsWith("c|")).length;
    console.log(`counter rows after 200 addresses: ${rows} (all listed at every start)`);
    expect(rows).toBeLessThan(200);
    // The bound: a snapshot (here one row and its meta row) and fewer than JOURNAL_MAX journal rows per snapshot row.
    expect(rows).toBeLessThanOrEqual(JOURNAL_MAX + 2);
  });

  it("A5: each counted PUT writes one counter row; the counts survive eviction across snapshots", async () => {
    const h = host({ VAULT_RELAY_NEW_SPACES_PER_DAY: "2" });
    // 40 addresses open one space each: more journal rows than JOURNAL_MAX, so a snapshot is taken.
    for (let i = 0; i < 40; i++) {
      const before = [...h.storage.data.keys()].filter((k) => k.includes("|j|")).length;
      expect((await h.call("PUT", tok(500 + i), "x", `192.0.2.${i}`, new Uint8Array(4))).status).toBe(201);
      const after = [...h.storage.data.keys()].filter((k) => k.includes("|j|")).length;
      if (after > before) expect(after - before).toBe(1);
    }
    await new Promise((r) => setTimeout(r, 20));
    expect([...h.storage.data.keys()].some((k) => /^c\|\d+\|m$/.test(k))).toBe(true);
    h.evict();
    // Address 192.0.2.0 opened one space before the snapshot, 192.0.2.39 one after it: each may open one more, not two.
    for (const ip of ["192.0.2.0", "192.0.2.39"]) {
      expect((await h.call("PUT", tok(600 + Number(ip.split(".")[3])), "x", ip, new Uint8Array(4))).status).toBe(201);
      h.evict();
      expect((await h.call("PUT", tok(700 + Number(ip.split(".")[3])), "x", ip, new Uint8Array(4))).status).toBe(429);
    }
  });

  it("A6: health answers only on its exact paths; /v1/vault/o/healthz is an object", async () => {
    const h = host();
    const raw = (path: string) => (worker as { fetch(r: Request, e: Record<string, unknown>): Promise<Response> }).fetch(new Request(`https://relay.example.com${path}`), {} as never);
    for (const p of ["/", "/health", "/healthz", "/healthz/"]) expect(await (await raw(p)).json(), p).toMatchObject({ service: "lumen-vault-relay" });
    expect((await raw("/x/healthz")).status).toBe(404);
    expect((await h.call("PUT", tok(9), "healthz", "198.51.100.9", new Uint8Array(3).fill(7))).status).toBe(201);
    expect([...new Uint8Array(await (await h.call("GET", tok(9), "healthz", "198.51.100.9")).arrayBuffer())]).toEqual([7, 7, 7]);
  });
});

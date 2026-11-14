/**
 * Plan W6.23: the encrypted vault relay (sync-server/vault-relay.js, #483) on
 * Cloudflare Workers (edge-workers/vault-relay/worker.mjs), in a simulation
 * of the Durable Object runtime (helpers/durableObject.ts), and its limits
 * on both hosts:
 *   - the global ceiling (VAULT_RELAY_MAX_TOTAL): past it, 507 "relay full";
 *   - per address and UTC day: new spaces (VAULT_RELAY_NEW_SPACES_PER_DAY)
 *     and bytes written (VAULT_RELAY_ADDRESS_BYTES_PER_DAY): 429;
 *   - on the Worker, both survive the object being evicted and started
 *     again (the counts are in storage), the next day starts again and
 *     drops the old day's counts, and the address is Cloudflare's
 *     CF-Connecting-IP, never a header the client sent.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
// @ts-expect-error -- plain ESM Worker module, no types
import worker, { CHUNK, VaultRelay } from "../../edge-workers/vault-relay/worker.mjs";
import { FakeStorage, fakeState } from "./helpers/durableObject";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createVaultRelay, powOk } = require("../../sync-server/vault-relay.js") as {
  createVaultRelay: (o?: Record<string, unknown>) => { handle(req: IncomingMessage, res: ServerResponse): boolean; close(): void };
  powOk: (space: string, nonce: string, bits: number) => boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http") as typeof import("node:http");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const nodeCrypto = require("node:crypto") as typeof import("node:crypto");

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const token = (i: number | string) => `tok-${String(i).padStart(4, "0")}-${"x".repeat(32)}`;
const body = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

type Env = Record<string, unknown>;
interface Host {
  put(tok: string, name: string, data: Uint8Array, ip: string, headers?: Record<string, string>): Promise<Response>;
  get(tok: string, name: string, ip?: string): Promise<Response>;
  del(tok: string, name: string, ip?: string): Promise<Response>;
  list(tok: string, ip?: string): Promise<Response>;
}

/** The Worker, its one Durable Object, and a way to evict it (storage stays). */
function workerHost(vars: Env = {}, storage = new FakeStorage()) {
  let obj: { fetch(r: Request): Promise<Response>; alarm(): Promise<void> } | null = null;
  let state = fakeState(storage);
  const env: Env = {
    VAULT_RELAY_RATE: "100000",
    ...vars,
    RELAY: {
      idFromName: (n: string) => n,
      get: () => ({
        fetch: async (r: Request) => {
          if (!obj) {
            state = fakeState(storage);
            obj = new VaultRelay(state, env);
          }
          await state.ready;
          return obj!.fetch(r);
        },
      }),
    },
  };
  const call = (method: string, tok: string, name: string, ip: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}) =>
    (worker as { fetch(r: Request, e: Env): Promise<Response> }).fetch(
      new Request(`https://relay.example.com/v1/vault/o/${name}`, {
        method,
        body: init.body as BodyInit | undefined,
        headers: { Authorization: `Bearer ${tok}`, "cf-connecting-ip": ip, ...(init.headers ?? {}) },
      }),
      env,
    );
  const host: Host & { storage: FakeStorage; evict(): void; alarm(): Promise<void>; raw(r: Request): Promise<Response> } = {
    storage,
    put: (tok, name, data, ip, headers) => call("PUT", tok, name, ip, { body: data, headers }),
    get: (tok, name, ip = "198.51.100.1") => call("GET", tok, name, ip),
    del: (tok, name, ip = "198.51.100.1") => call("DELETE", tok, name, ip),
    list: (tok, ip = "198.51.100.1") => call("GET", tok, "", ip),
    evict: () => {
      obj = null;
    },
    alarm: async () => {
      if (!obj) {
        state = fakeState(storage);
        obj = new VaultRelay(state, env);
      }
      await state.ready;
      await obj!.alarm();
    },
    raw: (r) => (worker as { fetch(r: Request, e: Env): Promise<Response> }).fetch(r, env),
  };
  return host;
}

/** The Node relay (sync-server/vault-relay.js) on a real HTTP server, the client address from a test header. */
async function nodeHost(opts: Record<string, unknown>): Promise<Host> {
  const relay = createVaultRelay({ sweep: false, ratePerMinute: 100000, clientAddress: (req: IncomingMessage) => String(req.headers["x-test-ip"] ?? "unknown"), ...opts });
  const server: Server = http.createServer((req, res) => {
    if (!relay.handle(req, res)) res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  cleanups.push(() => relay.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/vault/o/`;
  const call = (method: string, tok: string, name: string, ip: string, init: { body?: Uint8Array; headers?: Record<string, string> } = {}) =>
    fetch(base + name, { method, body: init.body as BodyInit | undefined, headers: { Authorization: `Bearer ${tok}`, "x-test-ip": ip, ...(init.headers ?? {}) } });
  return {
    put: (tok, name, data, ip, headers) => call("PUT", tok, name, ip, { body: data, headers }),
    get: (tok, name, ip = "198.51.100.1") => call("GET", tok, name, ip),
    del: (tok, name, ip = "198.51.100.1") => call("DELETE", tok, name, ip),
    list: (tok, ip = "198.51.100.1") => call("GET", tok, "", ip),
  };
}

const errorOf = async (r: Response) => ((await r.json().catch(() => ({}))) as { error?: string }).error;

describe("the vault relay on Workers (simulated Durable Object)", () => {
  it("stores, lists, reads and deletes objects, chunked past one storage value", async () => {
    const h = workerHost();
    const health = await h.raw(new Request("https://relay.example.com/healthz"));
    expect(await health.json()).toMatchObject({ ok: true, service: "lumen-vault-relay" });
    const big = new Uint8Array(CHUNK * 2 + 1234).map((_, i) => (i * 31) & 255);
    const put = await h.put(token(1), "blob", big, "198.51.100.1", { "If-None-Match": "*" });
    expect(put.status).toBe(201);
    const etag = put.headers.get("ETag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    expect((await h.put(token(1), "blob", big, "198.51.100.1", { "If-None-Match": "*" })).status).toBe(412);
    const got = await h.get(token(1), "blob");
    expect(got.status).toBe(200);
    expect(got.headers.get("ETag")).toBe(etag);
    expect(new Uint8Array(await got.arrayBuffer())).toEqual(big);
    // Three chunks of the object in storage, none larger than CHUNK.
    const chunks = [...h.storage.data].filter(([k]) => k.startsWith("d|"));
    expect(chunks.length).toBe(3);
    expect(chunks.every(([, v]) => (v as Uint8Array).byteLength <= CHUNK)).toBe(true);
    // A replace keeps only the new version's chunks.
    expect((await h.put(token(1), "blob", body(10), "198.51.100.1", { "If-Match": etag! })).status).toBe(201);
    expect([...h.storage.data.keys()].filter((k) => k.startsWith("d|")).length).toBe(1);
    expect(await (await h.list(token(1))).json()).toEqual({ names: ["blob"] });
    expect((await h.del(token(1), "blob")).status).toBe(204);
    expect((await h.get(token(1), "blob")).status).toBe(404);
    expect(h.storage.data.get("T")).toBe(0);
    expect((await h.get("short", "x")).status).toBe(401);
  });

  it("prints a PUT's CPU time by object size (the Free plan gives a request 10 ms)", async () => {
    const h = workerHost({ VAULT_RELAY_MAX_OBJECT: String(8 * 1024 * 1024) });
    const rows: string[] = [];
    for (const mib of [0.25, 1, 2, 4]) {
      const data = new Uint8Array(mib * 1024 * 1024).map((_, i) => i & 255);
      const cpu: number[] = [];
      for (let i = 0; i < 7; i++) {
        const c0 = process.cpuUsage();
        const r = await h.put(token(1), `s${i}`, data, "198.51.100.1");
        const c = process.cpuUsage(c0);
        expect(r.status).toBe(201);
        if (i >= 2) cpu.push((c.user + c.system) / 1000);
      }
      cpu.sort((a, b) => a - b);
      rows.push(`${mib} MiB: CPU p50 ${cpu[2].toFixed(1)} ms, max ${cpu[4].toFixed(1)} ms`);
    }
    console.log(`vault relay Worker PUT (simulated DO, this machine): ${rows.join("; ")}`);
  });

  it("refuses a body over VAULT_RELAY_MAX_OBJECT without storing it", async () => {
    const h = workerHost({ VAULT_RELAY_MAX_OBJECT: "1000" });
    const r = await h.put(token(1), "x", body(5000), "198.51.100.1");
    expect(r.status).toBe(413);
    expect([...h.storage.data.keys()].filter((k) => !k.startsWith("c|") && !k.startsWith("k|"))).toEqual([]);
  });

  it("asks for a proof of work for a new space, and takes a solved one", async () => {
    const h = workerHost({ VAULT_RELAY_POW_BITS: "8" });
    const r = await h.put(token(1), "x", body(10), "198.51.100.1");
    expect(r.status).toBe(428);
    expect(await r.json()).toEqual({ error: "pow", bits: 8 });
    const space = nodeCrypto.createHash("sha256").update(`lumen-vault-relay v1|${token(1)}`).digest("hex");
    let nonce = 0;
    while (!powOk(space, String(nonce), 8)) nonce++;
    expect((await h.put(token(1), "x", body(10), "198.51.100.1", { "X-Lumen-Pow": String(nonce) })).status).toBe(201);
  });
});

/** The limits, the same on both hosts. */
for (const kind of ["node", "worker"] as const) {
  const make = async (limits: { maxTotal?: number; spacesPerDay?: number; bytesPerDay?: number; maxSpace?: number }): Promise<Host> =>
    kind === "node"
      ? nodeHost({ maxTotalBytes: limits.maxTotal, newSpacesPerDay: limits.spacesPerDay, addressBytesPerDay: limits.bytesPerDay, maxSpaceBytes: limits.maxSpace })
      : workerHost({
          VAULT_RELAY_MAX_TOTAL: limits.maxTotal && String(limits.maxTotal),
          VAULT_RELAY_NEW_SPACES_PER_DAY: limits.spacesPerDay && String(limits.spacesPerDay),
          VAULT_RELAY_ADDRESS_BYTES_PER_DAY: limits.bytesPerDay && String(limits.bytesPerDay),
          VAULT_RELAY_MAX_SPACE: limits.maxSpace && String(limits.maxSpace),
        });

  describe(`relay limits (${kind})`, () => {
    it("the global ceiling: all spaces together stop at VAULT_RELAY_MAX_TOTAL (507), and a delete makes room", async () => {
      // 4 KiB blocks: 10 objects of 4 KiB fill 40 KiB.
      const h = await make({ maxTotal: 40 * 1024, spacesPerDay: 100 });
      for (let i = 0; i < 10; i++) expect((await h.put(token(i), "o", body(4000), `198.51.100.${i + 1}`)).status).toBe(201);
      const full = await h.put(token(10), "o", body(100), "198.51.100.77");
      expect(full.status).toBe(507);
      expect(await errorOf(full)).toBe("relay full");
      // Every address, every space: the ceiling is global.
      expect((await h.put(token(3), "more", body(100), "203.0.113.9")).status).toBe(507);
      expect((await h.del(token(0), "o")).status).toBe(204);
      expect((await h.put(token(10), "o", body(100), "198.51.100.77")).status).toBe(201);
    });

    it("per address and day: new spaces stop at VAULT_RELAY_NEW_SPACES_PER_DAY (429); other addresses go on", async () => {
      const h = await make({ spacesPerDay: 3 });
      for (let i = 0; i < 3; i++) expect((await h.put(token(i), "o", body(10), "198.51.100.1")).status).toBe(201);
      const r = await h.put(token(3), "o", body(10), "198.51.100.1");
      expect(r.status).toBe(429);
      expect(await errorOf(r)).toBe("new spaces today");
      // Writing to a space it already has is not a new space.
      expect((await h.put(token(0), "o2", body(10), "198.51.100.1")).status).toBe(201);
      expect((await h.put(token(3), "o", body(10), "198.51.100.2")).status).toBe(201);
      // An IPv6 address counts by its /64.
      for (let i = 0; i < 3; i++) expect((await h.put(token(`v6${i}`), "o", body(10), `2001:db8:1:2::${i + 1}`)).status).toBe(201);
      expect((await h.put(token("v6x"), "o", body(10), "2001:db8:1:2:ffff::9")).status).toBe(429);
    });

    it("per address and day: bytes written stop at VAULT_RELAY_ADDRESS_BYTES_PER_DAY (429)", async () => {
      const h = await make({ bytesPerDay: 5 * 4096, spacesPerDay: 100 });
      for (let i = 0; i < 5; i++) expect((await h.put(token(1), `o${i}`, body(4000), "198.51.100.1")).status).toBe(201);
      const r = await h.put(token(1), "o5", body(10), "198.51.100.1");
      expect(r.status).toBe(429);
      expect(await errorOf(r)).toBe("bytes today");
      expect((await h.put(token(1), "o5", body(10), "198.51.100.2")).status).toBe(201);
    });
  });
}

describe("the Worker's limits survive eviction and follow the day", () => {
  it("counts of today stay after the object is evicted; the global total too", async () => {
    const h = workerHost({ VAULT_RELAY_NEW_SPACES_PER_DAY: "2", VAULT_RELAY_MAX_TOTAL: String(5 * 4096) });
    expect((await h.put(token(1), "o", body(10), "198.51.100.1")).status).toBe(201);
    expect((await h.put(token(2), "o", body(10), "198.51.100.1")).status).toBe(201);
    h.evict();
    expect((await h.put(token(3), "o", body(10), "198.51.100.1")).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await h.put(token(10 + i), "o", body(10), `198.51.100.${20 + i}`)).status).toBe(201);
    h.evict();
    const r = await h.put(token(20), "o", body(10), "198.51.100.99");
    expect(r.status).toBe(507);
  });

  it("a new UTC day starts the counts again and drops the old day's counts and key", async () => {
    const realNow = Date.now;
    cleanups.push(() => (Date.now = realNow));
    let now = Date.UTC(2026, 10, 12, 23, 0);
    Date.now = () => now;
    const h = workerHost({ VAULT_RELAY_NEW_SPACES_PER_DAY: "1" });
    expect((await h.put(token(1), "o", body(10), "198.51.100.1")).status).toBe(201);
    expect((await h.put(token(2), "o", body(10), "198.51.100.1")).status).toBe(429);
    const day1 = [...h.storage.data.keys()].filter((k) => k.startsWith("c|") || k.startsWith("k|"));
    expect(day1.length).toBeGreaterThan(0);
    now += 2 * 3_600_000; // past midnight UTC
    h.evict();
    expect((await h.put(token(2), "o", body(10), "198.51.100.1")).status).toBe(201);
    // Wait for the stale-count cleanup the reset started.
    for (let i = 0; i < 50 && day1.some((k) => h.storage.data.has(k)); i++) await new Promise((r) => setTimeout(r, 5));
    expect(day1.filter((k) => h.storage.data.has(k))).toEqual([]);
    // No address in storage, in any form: only HMAC cells and the day's key.
    const all = h.storage.dump().map(([k, v]) => k + Buffer.from(v).toString("latin1")).join("\n");
    expect(all.includes("198.51.100.1")).toBe(false);
  });

  it("the address is CF-Connecting-IP; an X-Lumen-Client or X-Forwarded-For the client sends is ignored", async () => {
    const h = workerHost({ VAULT_RELAY_NEW_SPACES_PER_DAY: "1" });
    expect((await h.put(token(1), "o", body(10), "198.51.100.1")).status).toBe(201);
    const forged = await h.put(token(2), "o", body(10), "198.51.100.1", { "x-lumen-client": "203.0.113.50", "x-forwarded-for": "203.0.113.51" });
    expect(forged.status).toBe(429);
  });

  it("retention: the daily alarm deletes spaces nobody used for VAULT_RELAY_RETENTION_DAYS, and the total with them", async () => {
    const realNow = Date.now;
    cleanups.push(() => (Date.now = realNow));
    let now = Date.UTC(2026, 0, 1);
    Date.now = () => now;
    const h = workerHost({ VAULT_RELAY_RETENTION_DAYS: "30", VAULT_RELAY_NEW_SPACES_PER_DAY: "10" });
    expect((await h.put(token(1), "old", body(CHUNK + 5), "198.51.100.1")).status).toBe(201);
    now += 20 * 86_400_000;
    expect((await h.put(token(2), "new", body(10), "198.51.100.1")).status).toBe(201);
    expect(h.storage.alarm).not.toBeNull();
    now += 15 * 86_400_000;
    await h.alarm();
    expect((await h.get(token(1), "old")).status).toBe(404);
    expect((await h.get(token(2), "new")).status).toBe(200);
    expect([...h.storage.data.keys()].filter((k) => k.startsWith("d|")).length).toBe(1);
    expect(h.storage.data.get("T")).toBe(4096);
  });
});

describe("the owner session's limit check (scripts/share-deploy.mjs)", () => {
  it("passes on a relay deployed with CHECK_LIMITS, and fails on one without them", async () => {
    // @ts-expect-error -- plain ESM script, no types
    const { checkLimits, CHECK_LIMITS } = (await import("../../scripts/share-deploy.mjs")) as {
      checkLimits: (origin: string, f: (u: string, i: RequestInit) => Promise<Response>) => Promise<{ ok: boolean; perAddress: boolean; ceiling: boolean }>;
      CHECK_LIMITS: Record<string, number>;
    };
    const via = (h: ReturnType<typeof workerHost>) => (u: string, init: RequestInit) =>
      h.raw(new Request(u, { ...init, headers: { ...(init.headers as Record<string, string>), "cf-connecting-ip": "198.51.100.200" } }));
    const vars = Object.fromEntries(Object.entries(CHECK_LIMITS).map(([k, v]) => [k, String(v)]));
    const limited = workerHost(vars);
    expect(await checkLimits("https://relay.example.com", via(limited))).toMatchObject({ ok: true, perAddress: true, ceiling: true });
    const open = workerHost({ VAULT_RELAY_NEW_SPACES_PER_DAY: "100" });
    expect(await checkLimits("https://relay.example.com", via(open))).toMatchObject({ ok: false, perAddress: false, ceiling: false });
  });

  it("--dry-run --session prints every command, runs none, and exits 0", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
    const r = spawnSync(process.execPath, ["scripts/share-deploy.mjs", "--dry-run", "--session"], { encoding: "utf8", cwd: new URL("../..", import.meta.url).pathname });
    expect(r.status).toBe(0);
    for (const line of ["wrangler@4.20.0 whoami", "scripts/collab-deploy.mjs --dry-run", "(cd edge-workers/vault-relay) npx --yes wrangler@4.20.0 deploy", "--name lumen-vault-relay-limits --var VAULT_RELAY_MAX_TOTAL:65536", "delete --name lumen-vault-relay-limits", "tail lumen-vault-relay --format json", "VITE_SYNC_RELAY_URL="])
      expect(r.stdout).toContain(line);
  });
});

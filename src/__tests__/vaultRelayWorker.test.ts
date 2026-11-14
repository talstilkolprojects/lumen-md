// @vitest-environment node
/**
 * Decision 5.16 (#483 on #469's Worker): the encrypted vault relay's four
 * routes in the public live-share Worker, with sync-server/vault-relay.js's
 * protocol (the app's relay provider), one Durable Object per space, the
 * rooms' rules (ciphertext only, 90-day retention, no addresses), and limits
 * sized for the Workers Free plan. Runs on a simulated Durable Object runtime.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs module without type declarations
import { handleVault, VaultSpace, VaultQuota, spaceOf, powOk, charge, etagOf, vaultLimits, isVaultPath } from "../../edge-workers/collab/vaultRelay.mjs";

type Val = unknown;
class FakeStorage {
  map = new Map<string, Val>();
  alarm: number | null = null;
  async get(k: string | string[]) {
    if (Array.isArray(k)) return new Map(k.filter((x) => this.map.has(x)).map((x) => [x, this.map.get(x)]));
    return this.map.get(k);
  }
  async put(k: string | Record<string, Val>, v?: Val) {
    if (typeof k === "string") this.map.set(k, v);
    else for (const [a, b] of Object.entries(k)) this.map.set(a, b);
  }
  async delete(k: string | string[]) {
    for (const x of Array.isArray(k) ? k : [k]) this.map.delete(x);
  }
  async list({ prefix = "" } = {}) {
    return new Map([...this.map].filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => (a < b ? -1 : 1)));
  }
  async deleteAll() {
    this.map.clear();
  }
  async setAlarm(t: number) {
    this.alarm = t;
  }
}

type Obj = { fetch(r: Request): Promise<Response>; alarm?: () => Promise<void> };
function namespace(make: (state: { storage: FakeStorage }) => Obj) {
  const objects = new Map<string, { obj: Obj; storage: FakeStorage }>();
  return {
    objects,
    idFromName: (n: string) => n,
    get(id: string) {
      if (!objects.has(id)) {
        const storage = new FakeStorage();
        objects.set(id, { obj: make({ storage }), storage });
      }
      return objects.get(id)!.obj;
    },
  };
}

const SECRET = "s".repeat(40);
const TOKEN_A = "A".repeat(43);
const TOKEN_B = "B".repeat(43);
const BASE = "https://relay.example/v1/vault/o/";
let env: Record<string, unknown>;
let spaces: ReturnType<typeof namespace>;
let quotas: ReturnType<typeof namespace>;

function setup(vars: Record<string, string> = {}) {
  env = { COLLAB_TOKEN_SECRET: SECRET, ...vars };
  spaces = namespace((state) => new VaultSpace(state, env));
  quotas = namespace((state) => new VaultQuota(state, env));
  env.VAULT = spaces;
  env.VAULT_QUOTA = quotas;
}

const req = (name: string, init: { method?: string; token?: string | null; body?: Uint8Array | string; headers?: Record<string, string>; ip?: string } = {}) => {
  const headers: Record<string, string> = { "cf-connecting-ip": init.ip ?? "203.0.113.7", ...(init.headers ?? {}) };
  if (init.token !== null) headers.authorization = `Bearer ${init.token ?? TOKEN_A}`;
  const body = typeof init.body === "string" ? new TextEncoder().encode(init.body) : init.body;
  return handleVault(new Request(BASE + name, { method: init.method ?? "GET", headers, body }), env) as Promise<Response>;
};
const put = (name: string, body: Uint8Array | string, headers: Record<string, string> = {}, more: { token?: string; ip?: string } = {}) =>
  req(name, { method: "PUT", body, headers: { "content-type": "application/octet-stream", ...headers }, ...more });
const bytes = (n: number, seed = 1) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 255);
const solve = (space: string, bits: number) => {
  for (let i = 0; ; i++) if (powOk(space, `n${i}`, bits)) return `n${i}`;
};
const totalStored = () => (quotas.objects.get("vault")?.storage.map.get("t") as number | undefined) ?? 0;

beforeEach(() => setup());

describe("vault relay routes in the Worker (decision 5.16)", () => {
  it("the protocol of vault-relay.js: list, conditional create, read with ETag, list again", async () => {
    expect(isVaultPath("/v1/vault/o/")).toBe(true);
    expect(await (await req("")).json()).toEqual({ names: [] });
    const created = await put("manifest", "sealed-1", { "if-none-match": "*" });
    expect(created.status).toBe(201);
    const etag = created.headers.get("ETag");
    expect(etag).toBe(etagOf(new TextEncoder().encode("sealed-1")));
    const got = await req("manifest");
    expect(got.status).toBe(200);
    expect(got.headers.get("ETag")).toBe(etag);
    expect(got.headers.get("access-control-expose-headers")).toBe("ETag");
    expect(new TextDecoder().decode(await got.arrayBuffer())).toBe("sealed-1");
    await put("obj-1", "x");
    expect(await (await req("")).json()).toEqual({ names: ["manifest", "obj-1"] });
    expect((await req("missing")).status).toBe(404);
  });

  it("If-None-Match: * and If-Match: a lost race is 412; the right ETag wins", async () => {
    const e1 = (await put("manifest", "v1", { "if-none-match": "*" })).headers.get("ETag")!;
    expect((await put("manifest", "v1b", { "if-none-match": "*" })).status).toBe(412);
    expect((await put("manifest", "v2", { "if-match": '"stale"' })).status).toBe(412);
    expect((await put("absent", "v2", { "if-match": e1 })).status).toBe(412);
    const r = await put("manifest", "v2", { "if-match": e1 });
    expect(r.status).toBe(201);
    expect(r.headers.get("ETag")).not.toBe(e1);
  });

  it("two concurrent creates of one name: exactly one lands", async () => {
    const [a, b] = await Promise.all([put("manifest", "a", { "if-none-match": "*" }), put("manifest", "b", { "if-none-match": "*" })]);
    expect([a.status, b.status].sort()).toEqual([201, 412]);
  });

  it("objects past one Durable Object value are chunked, and a shorter rewrite drops old chunks", async () => {
    const big = bytes(2_500_000);
    expect((await put("blob", big)).status).toBe(201);
    expect(new Uint8Array(await (await req("blob")).arrayBuffer())).toEqual(big);
    const space = spaces.objects.get(spaceOf(TOKEN_A))!.storage;
    expect([...space.map.keys()].filter((k) => k.startsWith("c:blob:")).length).toBe(3);
    expect((await put("blob", "small")).status).toBe(201);
    expect([...space.map.keys()].filter((k) => k.startsWith("c:blob:")).length).toBe(1);
    expect(new TextDecoder().decode(await (await req("blob")).arrayBuffer())).toBe("small");
  });

  it("checks the token, the name and the method before any object is touched; CORS for the app", async () => {
    expect((await req("x", { token: null })).status).toBe(401);
    expect((await req("x", { token: "short" })).status).toBe(401);
    expect((await req("bad%2Fname")).status).toBe(400);
    expect((await req("", { method: "PUT", body: "x" })).status).toBe(405);
    expect((await req("x", { method: "POST", body: "x" })).status).toBe(405);
    const pre = await req("x", { method: "OPTIONS", token: null });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-headers")).toContain("If-None-Match");
    expect(pre.headers.get("access-control-allow-headers")).toContain("X-Lumen-Pow");
    expect(spaces.objects.size).toBe(0);
  });

  it("keeps no token and no address: the space is SHA-256 of the token, the counters are keyed hashes", async () => {
    await put("manifest", "sealed", {}, { ip: "198.51.100.23" });
    expect([...spaces.objects.keys()]).toEqual([createHash("sha256").update(`lumen-vault-relay v1|${TOKEN_A}`).digest("hex")]);
    const dump = JSON.stringify([...spaces.objects.values(), ...quotas.objects.values()].map((o) => [...o.storage.map].map(([k, v]) => [k, v instanceof Uint8Array ? [...v] : v])));
    expect(dump).not.toContain(TOKEN_A);
    expect(dump).not.toContain("198.51.100.23");
    expect(dump).not.toContain("198.51.100");
  });

  it("separate tokens are separate spaces", async () => {
    await put("manifest", "a");
    await put("manifest", "b", {}, { token: TOKEN_B });
    expect(new TextDecoder().decode(await (await req("manifest")).arrayBuffer())).toBe("a");
    expect(new TextDecoder().decode(await (await req("manifest", { token: TOKEN_B })).arrayBuffer())).toBe("b");
  });

  it("opening a space: proof of work (428 with its bits) and invite, as the app expects; an existing space is not asked", async () => {
    setup({ VAULT_RELAY_POW_BITS: "8", VAULT_RELAY_INVITE: "school-secret" });
    expect((await put("manifest", "x")).status).toBe(403);
    const ask = await put("manifest", "x", { "x-lumen-invite": "school-secret" });
    expect(ask.status).toBe(428);
    expect(await ask.json()).toEqual({ error: "pow", bits: 8 });
    const nonce = solve(spaceOf(TOKEN_A), 8);
    expect((await put("manifest", "x", { "x-lumen-invite": "school-secret", "x-lumen-pow": nonce })).status).toBe(201);
    expect((await put("obj", "y")).status).toBe(201);
    expect(vaultLimits({ VAULT_RELAY_POW_BITS: "40" }).powBits).toBe(24);
  });

  it("new spaces per address a day, then 429; another address still opens one", async () => {
    setup({ VAULT_RELAY_NEW_SPACES_PER_DAY: "2" });
    const tok = (i: number) => `T${i}`.padEnd(40, "x");
    expect((await put("m", "1", {}, { token: tok(1) })).status).toBe(201);
    expect((await put("m", "1", {}, { token: tok(2) })).status).toBe(201);
    const third = await put("m", "1", {}, { token: tok(3) });
    expect(third.status).toBe(429);
    expect(await third.json()).toEqual({ error: "new spaces today" });
    expect((await put("m", "1", {}, { token: tok(3), ip: "192.0.2.9" })).status).toBe(201);
    // A space that exists takes more writes.
    expect((await put("n", "2", {}, { token: tok(1) })).status).toBe(201);
  });

  it("caps: object 413, space 507, bytes per address a day 429, all spaces 507", async () => {
    setup({ VAULT_RELAY_MAX_OBJECT: "10000", VAULT_RELAY_MAX_SPACE: "12288", VAULT_RELAY_ADDRESS_BYTES_PER_DAY: "16384", VAULT_RELAY_MAX_TOTAL: "24576" });
    expect((await put("big", bytes(10001))).status).toBe(413);
    expect((await put("a", bytes(8000))).status).toBe(201); // 8 KiB charged
    expect((await put("b", bytes(5000))).status).toBe(507); // +8 KiB > 12 KiB space
    expect(await (await put("b", bytes(5000))).json()).toEqual({ error: "space full" });
    expect((await put("c", bytes(4096), {}, { token: TOKEN_B })).status).toBe(201); // 4 KiB: 12 KiB today
    const today = await put("d", bytes(5000), {}, { token: TOKEN_B }); // fits space B, but +8 KiB > 16 KiB today
    expect(today.status).toBe(429);
    expect(await today.json()).toEqual({ error: "bytes today" });
    const other = { token: "C".repeat(43), ip: "192.0.2.50" };
    expect((await put("e", bytes(8192), {}, other)).status).toBe(201); // total 20 KiB
    const full = await put("f", bytes(8192), {}, { token: "D".repeat(43), ip: "192.0.2.51" });
    expect(full.status).toBe(507);
    expect(await full.json()).toEqual({ error: "relay full" });
    expect(totalStored()).toBe(charge(8000) + charge(4096) + charge(8192));
  });

  it("DELETE frees the space's and the relay's bytes", async () => {
    await put("a", bytes(5000));
    expect(totalStored()).toBe(8192);
    expect((await req("a", { method: "DELETE" })).status).toBe(204);
    expect((await req("a")).status).toBe(404);
    expect(totalStored()).toBe(0);
    expect((await req("never", { method: "DELETE" })).status).toBe(204);
  });

  it("retention: the alarm deletes a space unused for 90 days and gives its bytes back; a read keeps it", async () => {
    const real = Date.now;
    let now = Date.UTC(2026, 10, 1);
    Date.now = () => now;
    try {
      await put("a", bytes(100));
      const id = spaceOf(TOKEN_A);
      const { obj, storage } = spaces.objects.get(id)!;
      expect(storage.alarm).toBe(now + 90 * 86400000);
      now += 60 * 86400000;
      await req("a"); // a read, more than a day later, moves the clock
      expect(storage.alarm).toBe(now + 90 * 86400000);
      now += 89 * 86400000;
      await obj.alarm!();
      expect(storage.map.size).toBeGreaterThan(0);
      now += 2 * 86400000;
      await obj.alarm!();
      expect(storage.map.size).toBe(0);
      expect(totalStored()).toBe(0);
      expect(await (await req("")).json()).toEqual({ names: [] });
    } finally {
      Date.now = real;
    }
  });

  it("requests per minute per space, then 429", async () => {
    setup({ VAULT_RELAY_RATE: "3" });
    for (let i = 0; i < 3; i++) expect((await req("")).status).toBe(200);
    expect((await req("")).status).toBe(429);
  });
});

describe("the Worker and its config", () => {
  const toml = readFileSync("edge-workers/collab/wrangler.toml", "utf8");
  const v = (k: string) => Number(new RegExp(`^${k} = "(\\d+)"`, "m").exec(toml)?.[1]);

  it("routes /v1/vault/o/ to the relay and exports its Durable Objects", () => {
    const src = readFileSync("edge-workers/collab/worker.mjs", "utf8");
    expect(src).toContain("if (isVaultPath(url.pathname)) return handleVault(request, env);");
    expect(src.indexOf("isVaultPath(url.pathname)")).toBeLessThan(src.indexOf('"websocket only"'));
    expect(src).toContain('export { VaultSpace, VaultQuota } from "./vaultRelay.mjs";');
    expect(toml).toMatch(/name = "VAULT"\nclass_name = "VaultSpace"/);
    expect(toml).toMatch(/name = "VAULT_QUOTA"\nclass_name = "VaultQuota"/);
    expect(toml).toMatch(/new_sqlite_classes = \["VaultSpace", "VaultQuota"\]/);
  });

  it("the rooms' rules: the same retention, logs off", () => {
    expect(v("VAULT_RELAY_RETENTION_DAYS")).toBe(v("RETENTION_DAYS"));
    expect(v("RETENTION_DAYS")).toBe(90);
    expect(toml).toMatch(/\[observability\]\s*\nenabled = false/);
  });

  it("rooms and vault spaces together fit the Free plan's 5 GB of Durable Object storage", () => {
    expect(v("COLLAB_MAX_STORED_BYTES") + v("VAULT_RELAY_MAX_TOTAL")).toBeLessThanOrEqual(5_000_000_000);
    expect(v("VAULT_RELAY_MAX_SPACE")).toBeLessThanOrEqual(v("VAULT_RELAY_MAX_TOTAL"));
    expect(v("VAULT_RELAY_POW_BITS")).toBeLessThanOrEqual(24);
  });
});

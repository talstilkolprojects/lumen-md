/**
 * Blind tests (plan W6.15, lane B): the vault relay and its quotas (#483).
 *
 * Written from the spec only: PR #483's body (with its review 12.11 fixes),
 * docs/src/content/docs/sync/two-clicks.md and the public API of
 * sync-server/vault-relay.js and src/sync/e2ee/providers/relay.ts (declarations emitted
 * by tsc, no function bodies). The test list (Q1–Q15) was written before any
 * implementation was read. The implementation was then opened only for wiring: the
 * option names createVaultRelay reads, the token pattern and module.exports.
 *
 * #483 is not on verify/train-2 yet, so the modules are looked up at run time and the
 * suite skips while they are absent. It was run on the feat/sync-two-clicks head
 * (aa47bbb20); it runs here by itself once #483 is merged. Failing cases are `it.fails`
 * entries that link to a finding in the W6.15 findings list (PR body of test/blind-tests).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

interface Store {
  list(id: string): Promise<string[]>;
  get(id: string, name: string): Promise<unknown>;
  put(id: string, name: string, data: Uint8Array): Promise<void>;
  delete(id: string, name: string): Promise<void>;
  bytes(id: string): Promise<number>;
  has(id: string): Promise<boolean>;
  touch(id: string): Promise<void>;
  totalBytes(): Promise<number>;
  sweep(olderThan: number): Promise<number>;
}
interface RelayModule {
  createVaultRelay(opts?: Record<string, unknown>): { handle(req: unknown, res: unknown): boolean; sweep(): Promise<number>; close(): void };
  memoryStore(): Store;
  diskStore(dir: string): Store;
  powOk(space: string, nonce: string, bits: number): boolean;
  zeroBits(buf: Uint8Array): number;
}
interface ProviderModule {
  relaySpaceId(token: string): Promise<string>;
  solveRelayPow(space: string, bits: number): Promise<string>;
  relayProvider(cfg: { url: string; token: string; invite?: string }): { put(name: string, data: Uint8Array, opts?: unknown): Promise<unknown> };
}

const relayPath = fileURLToPath(new URL("../../../sync-server/vault-relay.js", import.meta.url));
const relay = existsSync(relayPath) ? (createRequire(import.meta.url)(relayPath) as RelayModule) : undefined;
const providers = import.meta.glob("../../sync/e2ee/providers/rela*.ts", { eager: true });
const provider = Object.entries(providers).find(([k]) => k.endsWith("/relay.ts"))?.[1] as ProviderModule | undefined;

const tok = (n: number) => `blindtoken_${String(n).padStart(4, "0")}_${"x".repeat(24)}`;
const MiB = 1024 * 1024;

async function serve(opts: Record<string, unknown> = {}) {
  const store = (opts.store as Store | undefined) ?? relay!.memoryStore();
  const r = relay!.createVaultRelay({ store, ...opts });
  const server = createServer((req, res) => {
    if (!r.handle(req, res)) {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (method: string, name: string, token: string | null, body?: Uint8Array | string, headers: Record<string, string> = {}) =>
    fetch(`${origin}/v1/vault/o/${name}`, { method, body: body as BodyInit | undefined, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers } });
  return {
    origin,
    store,
    call,
    relay: r,
    close: () => {
      r.close();
      return new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe.skipIf(!relay)("vault relay (#483)", () => {
  describe("the four verbs (Q1–Q3)", () => {
    it("PUT, GET, list and DELETE over real HTTP; no token, no access", async () => {
      const s = await serve();
      try {
        expect((await s.call("PUT", "a", tok(1), "hello")).status).toBeLessThan(300);
        const g = await s.call("GET", "a", tok(1));
        expect(g.status).toBe(200);
        expect(await g.text()).toBe("hello");
        expect(g.headers.get("etag")).toBeTruthy();
        const l = await s.call("GET", "", tok(1));
        expect(((await l.json()) as { names: string[] }).names).toEqual(["a"]);
        expect((await s.call("GET", "a", tok(2))).status).toBe(404); // another space
        expect((await s.call("GET", "a", null)).status).toBe(401);
        expect((await s.call("GET", "a", "short")).status).toBe(401);
        expect((await s.call("DELETE", "a", tok(1))).status).toBeLessThan(300);
        expect((await s.call("GET", "a", tok(1))).status).toBe(404);
      } finally {
        await s.close();
      }
    });

    it("conditional writes: a lost race is a 412, and 10 racing creates make exactly one object", async () => {
      const s = await serve();
      try {
        await s.call("PUT", "m", tok(1), "v1");
        expect((await s.call("PUT", "m", tok(1), "v2", { "if-none-match": "*" })).status).toBe(412);
        expect((await s.call("PUT", "m", tok(1), "v2", { "if-match": '"not-the-etag"' })).status).toBe(412);
        const etag = (await s.call("GET", "m", tok(1))).headers.get("etag")!;
        expect((await s.call("PUT", "m", tok(1), "v2", { "if-match": etag })).status).toBeLessThan(300);
        const race = await Promise.all(Array.from({ length: 10 }, (_, i) => s.call("PUT", "race", tok(1), `w${i}`, { "if-none-match": "*" })));
        expect(race.filter((r) => r.status < 300)).toHaveLength(1);
        expect(race.filter((r) => r.status === 412)).toHaveLength(9);
      } finally {
        await s.close();
      }
    });

    it("the store never sees the token, only a hash of it", async () => {
      const ids = new Set<string>();
      const inner = relay!.memoryStore();
      const spy = new Proxy(inner, {
        get(t, k) {
          const v = t[k as keyof Store];
          return typeof v === "function" ? (...a: unknown[]) => (typeof a[0] === "string" && ids.add(a[0]), (v as (...x: unknown[]) => unknown).apply(t, a)) : v;
        },
      });
      const s = await serve({ store: spy });
      try {
        await s.call("PUT", "a", tok(7), "x");
        await s.call("GET", "a", tok(7));
        expect(ids.size).toBeGreaterThan(0);
        for (const id of ids) expect(id).not.toContain(tok(7));
        const expected = createHash("sha256").update(`lumen-vault-relay v1|${tok(7)}`).digest("hex");
        expect([...ids]).toContain(expected);
      } finally {
        await s.close();
      }
    });
  });

  describe("quotas (Q4–Q7, Q13–Q15)", () => {
    it("an object over the limit is refused and nothing is stored", async () => {
      const s = await serve({ maxObjectBytes: 1000 });
      try {
        // F-10 (ambiguity, Low): the relay may close the connection on an oversized body
        // instead of answering, so the client sees a network error, not a status.
        const status = await s.call("PUT", "big", tok(1), new Uint8Array(1001)).then((r) => r.status, () => "closed");
        expect(status === "closed" || (status as number) >= 400).toBe(true);
        expect((await s.call("GET", "big", tok(1))).status).toBe(404);
        expect((await s.call("PUT", "ok", tok(1), new Uint8Array(1000))).status).toBeLessThan(300);
      } finally {
        await s.close();
      }
    });

    it("a full space is a 507; overwriting counts the new size; a delete frees room", async () => {
      const s = await serve({ maxSpaceBytes: 100_000, addressBytesPerDay: 10 * MiB });
      try {
        expect((await s.call("PUT", "a", tok(1), new Uint8Array(60_000))).status).toBeLessThan(300);
        expect((await s.call("PUT", "a", tok(1), new Uint8Array(60_000))).status).toBeLessThan(300); // replace, not add
        expect((await s.call("PUT", "b", tok(1), new Uint8Array(60_000))).status).toBe(507);
        expect((await s.call("DELETE", "a", tok(1))).status).toBeLessThan(300);
        expect((await s.call("PUT", "b", tok(1), new Uint8Array(60_000))).status).toBeLessThan(300);
      } finally {
        await s.close();
      }
    });

    it("the total cap is a 507 across spaces", async () => {
      const s = await serve({ maxTotalBytes: 100_000, maxSpaceBytes: 1 * MiB, addressBytesPerDay: 10 * MiB });
      try {
        expect((await s.call("PUT", "a", tok(1), new Uint8Array(60_000))).status).toBeLessThan(300);
        expect((await s.call("PUT", "a", tok(2), new Uint8Array(60_000))).status).toBe(507);
      } finally {
        await s.close();
      }
    });

    it("one address opens at most N new spaces a day, and more the next day", async () => {
      let now = Date.UTC(2026, 10, 12, 10);
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const s = await serve({ newSpacesPerDay: 3 });
      try {
        for (let i = 0; i < 3; i++) expect((await s.call("PUT", "a", tok(10 + i), "x")).status).toBeLessThan(300);
        expect((await s.call("PUT", "a", tok(20), "x")).status).toBe(429);
        expect((await s.call("PUT", "b", tok(10), "x")).status).toBeLessThan(300); // an existing space is not affected
        now += 25 * 3600_000;
        expect((await s.call("PUT", "a", tok(21), "x")).status).toBeLessThan(300);
      } finally {
        await s.close();
      }
    });

    it("a concurrent burst of new spaces is counted in full (adversarial)", async () => {
      const s = await serve({ newSpacesPerDay: 3 });
      try {
        const out = await Promise.all(Array.from({ length: 12 }, (_, i) => s.call("PUT", "a", tok(100 + i), "x")));
        expect(out.filter((r) => r.status < 300).length).toBeLessThanOrEqual(3);
      } finally {
        await s.close();
      }
    });

    it("bytes per address per day is a 429", async () => {
      const s = await serve({ addressBytesPerDay: 20_000, maxSpaceBytes: 1 * MiB });
      try {
        expect((await s.call("PUT", "a", tok(1), new Uint8Array(15_000))).status).toBeLessThan(300);
        expect((await s.call("PUT", "b", tok(1), new Uint8Array(15_000))).status).toBe(429);
      } finally {
        await s.close();
      }
    });

    it("X-Forwarded-For doesn't make one client many addresses (adversarial)", async () => {
      const s = await serve({ newSpacesPerDay: 2 });
      try {
        const out = [];
        for (let i = 0; i < 6; i++) out.push((await s.call("PUT", "a", tok(200 + i), "x", { "x-forwarded-for": `198.51.100.${i}`, "x-real-ip": `203.0.113.${i}` })).status);
        expect(out.filter((st) => st < 300).length).toBeLessThanOrEqual(2);
      } finally {
        await s.close();
      }
    });

    it("the request rate per address is limited (429)", async () => {
      const s = await serve({ ratePerMinute: 20 });
      try {
        const st: number[] = [];
        for (let i = 0; i < 30; i++) st.push((await s.call("GET", "", tok(1))).status);
        expect(st.slice(0, 20).every((x) => x !== 429)).toBe(true);
        expect(st.slice(20)).toContain(429);
      } finally {
        await s.close();
      }
    });
  });

  describe("invite and proof of work (Q8, Q9)", () => {
    it("an invite is needed to open a space, not to use one", async () => {
      const store = relay!.memoryStore();
      const open = await serve({ store });
      await open.call("PUT", "a", tok(1), "x");
      await open.close();
      const s = await serve({ store, invite: "the-invite-secret" });
      try {
        expect((await s.call("PUT", "a", tok(2), "x")).status).toBeGreaterThanOrEqual(400);
        expect((await s.call("PUT", "a", tok(2), "x", { "x-lumen-invite": "the-invite-secreT" })).status).toBeGreaterThanOrEqual(400);
        expect((await s.call("PUT", "a", tok(2), "x", { "x-lumen-invite": "the-invite-secret" })).status).toBeLessThan(300);
        expect((await s.call("PUT", "b", tok(1), "y")).status).toBeLessThan(300);
      } finally {
        await s.close();
      }
    });

    it("zeroBits and powOk", () => {
      expect(relay!.zeroBits(new Uint8Array([0, 0, 0x0f]))).toBe(20);
      expect(relay!.zeroBits(new Uint8Array([0x80]))).toBe(0);
      expect(relay!.powOk("space", "!!bad nonce!!", 1)).toBe(false);
    });

    it.skipIf(!provider)("a new space asks for work (428); the app solves it once; a nonce is bound to its space", async () => {
      const p = provider!;
      const s = await serve({ powBits: 8 });
      try {
        const r = await s.call("PUT", "a", tok(1), "x");
        expect(r.status).toBe(428);
        const body = (await r.json()) as { error: string; bits: number };
        expect(body).toEqual({ error: "pow", bits: 8 });
        const spaceA = await p.relaySpaceId(tok(1));
        const spaceB = await p.relaySpaceId(tok(2));
        const nonce = await p.solveRelayPow(spaceA, 8);
        expect(relay!.powOk(spaceA, nonce, 8)).toBe(true);
        let other = 0;
        for (let i = 0; i < 20; i++) other += relay!.powOk(spaceB, await p.solveRelayPow(spaceA, 8), 8) ? 1 : 0;
        expect(other).toBeLessThan(5); // 1/256 per try by chance
        const res = await p.relayProvider({ url: s.origin, token: tok(3) }).put("a", new TextEncoder().encode("hello"));
        expect(res).toBeDefined();
      } finally {
        await s.close();
      }
    });
  });

  describe("retention, names and CORS (Q10–Q12)", () => {
    it("a space untouched for 180 days is swept; one that is only read is kept", async () => {
      let now = Date.UTC(2026, 0, 1);
      vi.spyOn(Date, "now").mockImplementation(() => now);
      const s = await serve({ retentionDays: 180 });
      try {
        await s.call("PUT", "a", tok(1), "kept by reads");
        await s.call("PUT", "a", tok(2), "forgotten");
        for (let d = 0; d < 200; d += 20) {
          now += 20 * 86_400_000;
          await s.call("GET", "a", tok(1));
        }
        await s.relay.sweep();
        expect((await s.call("GET", "a", tok(1))).status).toBe(200);
        expect((await s.call("GET", "a", tok(2))).status).toBe(404);
      } finally {
        await s.close();
      }
    });

    it("odd names are refused and never reach the disk outside the space (adversarial)", async () => {
      const dir = mkdtempSync(join(tmpdir(), "blind-relay-"));
      const store = relay!.diskStore(dir);
      const s = await serve({ store });
      try {
        expect((await s.call("PUT", "neighbour", tok(9), "other vault")).status).toBeLessThan(300);
        const before = readdirSync(dir).sort();
        for (const name of ["..", ".", "%2e%2e", "..%2f..%2fx", "a%2fb", "%00", "x".repeat(65)]) {
          const p = await s.call("PUT", name, tok(1), "evil");
          expect(p.status).toBeGreaterThanOrEqual(400);
          await s.call("DELETE", name, tok(1));
          await s.call("GET", name, tok(1));
        }
        expect(readdirSync(dir).sort()).toEqual(before);
        const g = await s.call("GET", "neighbour", tok(9));
        expect(g.status).toBe(200);
        expect(await g.text()).toBe("other vault");
      } finally {
        await s.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("CORS: any origin, with the headers the provider sends", async () => {
      const s = await serve();
      try {
        const r = await fetch(`${s.origin}/v1/vault/o/a`, {
          method: "OPTIONS",
          headers: { origin: "https://app.example", "access-control-request-method": "PUT", "access-control-request-headers": "authorization,if-match,if-none-match,x-lumen-invite,content-type" },
        });
        expect(r.status).toBeLessThan(300);
        expect(r.headers.get("access-control-allow-origin")).toBe("*");
        const allowed = (r.headers.get("access-control-allow-headers") ?? "").toLowerCase();
        for (const h of ["authorization", "if-match", "if-none-match", "x-lumen-invite"]) expect(allowed).toContain(h);
        expect((r.headers.get("access-control-expose-headers") ?? "").toLowerCase()).toContain("etag");
      } finally {
        await s.close();
      }
    });
  });
});

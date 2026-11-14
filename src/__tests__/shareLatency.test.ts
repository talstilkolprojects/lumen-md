/**
 * Plan W6.23: scripts/share-latency.mjs, the owner's p95 measurement, run
 * here against local servers so the command the owner runs is known to work:
 *   - its room proof, commitment and proofs of work are the ones the
 *     servers check (sync-server/collab/roomToken.mjs, vault-relay.js);
 *   - the live-share measurement through sync-server/collab-server.mjs
 *     (E2EE only: its envelopes pass the room check);
 *   - the relay measurement through the Node relay and the Worker (with a
 *     proof of work for the new space, and one 2 MiB object).
 * The numbers here are loopback numbers; the acceptance number (p95 < 150 ms
 * from Israel) is the owner's run against the deployed servers.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
// @ts-expect-error -- plain ESM script, no types
import { committedRoomName, measureCollab, measureRelay, proofVerifier, relaySpace, roomProof, solveRelayPow, solveRoomPow } from "../../scripts/share-latency.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { commitmentOk, proofVerifier as serverVerifier, roomPowOk } from "../../sync-server/collab/roomToken.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";
// @ts-expect-error -- plain ESM Worker module, no types
import worker, { VaultRelay } from "../../edge-workers/vault-relay/worker.mjs";
import { roomProof as appRoomProof, committedRoomName as appCommitted } from "../collab/roomProof";
import { fakeState } from "./helpers/durableObject";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createVaultRelay, powOk } = require("../../sync-server/vault-relay.js") as {
  createVaultRelay: (o?: Record<string, unknown>) => { handle(req: IncomingMessage, res: ServerResponse): boolean; close(): void };
  powOk: (space: string, nonce: string, bits: number) => boolean;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http") as typeof import("node:http");

type Stats = { n: number; p50: number; p95: number; max: number; big?: number | null };
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
const quiet = () => undefined;

describe("share-latency.mjs speaks the servers' protocol", () => {
  it("the room proof and commitment are the app's; the proofs of work are the servers'", async () => {
    const proof = await (roomProof as (p: string, r: string) => Promise<string>)("pw", "room1");
    expect(proof).toBe(await appRoomProof("pw", "room1"));
    const v = (proofVerifier as (p: string) => string)(proof);
    expect(v).toBe((serverVerifier as (p: string) => string)(proof));
    expect((committedRoomName as (r: string, v: string) => string)("room1", v)).toBe(await appCommitted("room1", "pw"));
    expect((commitmentOk as (n: string, v: string) => boolean)((committedRoomName as (r: string, v: string) => string)("room1", v), v)).toBe(true);
    const nonce = (solveRoomPow as (r: string, v: string, b: number) => string)("room1", v, 10);
    expect((roomPowOk as (r: string, v: string, n: string, b: number) => boolean)("room1", v, nonce, 10)).toBe(true);
    const space = (relaySpace as (t: string) => string)("t".repeat(40));
    expect(powOk(space, (solveRelayPow as (s: string, b: number) => string)(space, 10), 10)).toBe(true);
  });
});

describe("share-latency.mjs against local servers", () => {
  it("live share: two clients through collab-server.mjs (E2EE only)", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "lumen-lat-"));
    cleanups.push(() => rmSync(dataDir, { recursive: true, force: true }));
    const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir, tokenSecret: "s".repeat(40), debounceMs: 20, maxDebounceMs: 50, backupIntervalMs: 0, e2eeOnly: true }) as {
      listen(): Promise<number>;
      close(): Promise<void>;
    };
    const port = await app.listen();
    cleanups.push(() => app.close());
    const s = (await (measureCollab as (u: string, n: number, c: string, l: (m: string) => void) => Promise<Stats>)(`ws://127.0.0.1:${port}/`, 40, "canary", quiet));
    expect(s.n).toBe(40);
    expect(s.p95).toBeLessThan(150);
  }, 60_000);

  it("vault relay: PUT + GET through the Node relay, with a proof of work and a 2 MiB object", async () => {
    const relay = createVaultRelay({ sweep: false, ratePerMinute: 100000, powBits: 8, maxObjectBytes: 4 * 1024 * 1024, clientAddress: () => "198.51.100.3" });
    const server: Server = http.createServer((req, res) => {
      if (!relay.handle(req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    cleanups.push(() => relay.close());
    const s = await (measureRelay as (o: string, n: number, opts: object) => Promise<Stats>)(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, 40, { big: true, log: quiet });
    expect(s.n).toBe(40);
    expect(s.big).toBe(201);
    expect(s.p95).toBeLessThan(150);
  }, 60_000);

  it("vault relay: the same through the Worker (simulated Durable Object); the 2 MiB PUT's time is printed", async () => {
    const state = fakeState();
    let obj: { fetch(r: Request): Promise<Response> } | null = null;
    const env: Record<string, unknown> = {
      VAULT_RELAY_POW_BITS: "8",
      RELAY: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async (r: Request) => {
            obj ??= new VaultRelay(state, env) as { fetch(r: Request): Promise<Response> };
            await state.ready;
            return obj.fetch(r);
          },
        }),
      },
    };
    const lines: string[] = [];
    const fetchFn = (u: string, init: RequestInit) => (worker as { fetch(r: Request, e: unknown): Promise<Response> }).fetch(new Request(u, { ...init, headers: { ...(init.headers as Record<string, string>), "cf-connecting-ip": "198.51.100.4" } }), env);
    const s = await (measureRelay as (o: string, n: number, opts: object) => Promise<Stats>)("https://relay.example.com", 40, { big: true, log: (m: string) => lines.push(m), fetchFn });
    console.log(lines.join("\n"));
    expect(s.big).toBe(201);
    // All deleted afterwards: nothing but counters and the day's key stays.
    expect([...state.storage.data.keys()].filter((k) => k.startsWith("m|") || k.startsWith("d|"))).toEqual([]);
  }, 60_000);
});

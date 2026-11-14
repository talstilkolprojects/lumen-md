/**
 * Plan W6.23 acceptance: "a scan: 0 plaintext note text in storage and logs".
 *
 * Real clients with the app's real encryption write notes with known texts
 * (canaries) through each share server; then scripts/share-scan.mjs looks
 * for those texts, as UTF-8, UTF-16, hex and base64, in everything the
 * server stored and everything it logged:
 *   - the live-share server, sync-server/collab-server.mjs (COLLAB_E2EE_ONLY,
 *     its SQLite files on disk), with the real HocuspocusProvider and
 *     src/collab/e2e.ts;
 *   - the vault relay on Workers (edge-workers/vault-relay/worker.mjs, its
 *     simulated Durable Object storage) and on Node (sync-server/vault-relay.js
 *     with its disk store), with the real encrypted sync (src/sync/e2ee).
 * Each scan has a control: the same scan finds the text where it is plain,
 * so 0 hits means none, not a scanner that can't see.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { wireE2E } from "../collab/e2e";
import { requestRoomToken } from "../collab/roomToken";
import { roomSocketUrl } from "../collab/persistentProvider";
import { PreconditionFailedError, type PutCondition, type StoredObject, type SyncProvider } from "../sync/e2ee/provider";
import { joinVault, newVault, snapshot } from "./helpers/e2ee";
import { FakeStorage, fakeState } from "./helpers/durableObject";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";
// @ts-expect-error -- plain ESM Worker module, no types
import worker, { VaultRelay } from "../../edge-workers/vault-relay/worker.mjs";
// @ts-expect-error -- plain ESM script, no types
import { scan, scanBuffers } from "../../scripts/share-scan.mjs";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createVaultRelay, diskStore } = require("../../sync-server/vault-relay.js") as {
  createVaultRelay: (o?: Record<string, unknown>) => { handle(req: IncomingMessage, res: ServerResponse): boolean; close(): void };
  diskStore: (dir: string) => unknown;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http") as typeof import("node:http");

type Hit = { file: string; text: string; form: string };
type Scan = (paths: string[], texts: string[]) => { hits: Hit[]; files: number; bytes: number };
type ScanBuffers = (named: Array<[string, Uint8Array]>, texts: string[]) => Hit[];
const scanFiles = scan as Scan;
const scanMem = scanBuffers as ScanBuffers;

/** Note texts: Hebrew and English, as a person writes them. */
const CANARIES = ["פגישה עם רונית ביום שלישי", "canary note: the launch code is 7431", "סוד: הסיסמה לאינטרנט"];

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lumen-scan-"));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

/** Everything the process logs while `fn` runs. */
async function capturingLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  const write = process.stdout.write.bind(process.stdout);
  const ewrite = process.stderr.write.bind(process.stderr);
  const keep = (...a: unknown[]) => lines.push(a.map((x) => (typeof x === "string" ? x : JSON.stringify(x, (_, v) => (v instanceof Uint8Array ? Buffer.from(v).toString("latin1") : v)))).join(" "));
  console.log = console.warn = console.error = console.info = console.debug = keep;
  process.stdout.write = ((c: string | Uint8Array) => (lines.push(String(c)), true)) as typeof process.stdout.write;
  process.stderr.write = ((c: string | Uint8Array) => (lines.push(String(c)), true)) as typeof process.stderr.write;
  try {
    return { value: await fn(), logs: lines.join("\n") };
  } finally {
    Object.assign(console, saved);
    process.stdout.write = write;
    process.stderr.write = ewrite;
  }
}

async function until(fn: () => boolean, ms = 8000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

interface App {
  listen(): Promise<number>;
  close(): Promise<void>;
}

describe("the live-share server keeps no note text (collab-server.mjs, SQLite on disk)", () => {
  async function editTogether(e2eeOnly: boolean, password: string | null) {
    const dataDir = tempDir();
    const { logs } = await capturingLogs(async () => {
      const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir, tokenSecret: "s".repeat(40), debounceMs: 20, maxDebounceMs: 50, backupIntervalMs: 0, e2eeOnly }) as App;
      const url = `ws://127.0.0.1:${await app.listen()}`;
      const room = `scan${Date.now().toString(36)}${password ? "e" : "p"}`;
      const docs = [0, 1].map(() => {
        const plain = new Y.Doc();
        const transport = password ? new Y.Doc() : plain;
        const channel = password ? wireE2E(plain, transport, { password, room }) : null;
        let synced = false;
        const provider = new HocuspocusProvider({ url: roomSocketUrl(url, room), name: room, document: transport, token: async () => (await requestRoomToken(url, room, null)).token });
        provider.on("synced", () => (synced = true));
        return { plain, provider, channel, synced: () => synced };
      });
      expect(await until(() => docs.every((d) => d.synced()))).toBe(true);
      docs[0].plain.getText("codemirror").insert(0, CANARIES.join("\n"));
      expect(await until(() => docs[1].plain.getText("codemirror").toString().includes(CANARIES[2]))).toBe(true);
      docs[1].plain.getText("codemirror").insert(0, `${CANARIES[1]} (B)\n`);
      expect(await until(() => docs[0].plain.getText("codemirror").toString().includes("(B)"))).toBe(true);
      // Past the server's debounce, so the room is on disk.
      await new Promise((r) => setTimeout(r, 300));
      for (const d of docs) {
        d.provider.destroy();
        d.channel?.destroy();
      }
      await app.close();
    });
    return { dataDir, logs };
  }

  it("two people edit an encrypted room: 0 hits in its storage and its logs", async () => {
    const { dataDir, logs } = await editTogether(true, "a room password");
    const r = scanFiles([dataDir], CANARIES);
    expect(r.files).toBeGreaterThan(0);
    expect(r.bytes).toBeGreaterThan(0);
    expect(r.hits).toEqual([]);
    expect(scanMem([["logs", Buffer.from(logs)]], CANARIES)).toEqual([]);
  }, 30_000);

  it("control: the same scan finds the text of a room without encryption on a server that allows it", async () => {
    const { dataDir } = await editTogether(false, null);
    expect(scanFiles([dataDir], CANARIES).hits.length).toBeGreaterThan(0);
  }, 30_000);
});

/** A SyncProvider for the relay's HTTP API (the shape of #483's src/sync/e2ee/providers/relay.ts). */
function relayClient(fetchFn: (url: string, init: RequestInit) => Promise<Response>, base: string, token: string): SyncProvider {
  const auth = { Authorization: `Bearer ${token}` };
  return {
    id: "relay",
    async get(name: string): Promise<StoredObject | null> {
      const r = await fetchFn(base + encodeURIComponent(name), { method: "GET", headers: auth });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error(`relay GET ${r.status}`);
      return { data: new Uint8Array(await r.arrayBuffer()), etag: r.headers.get("ETag") ?? "" };
    },
    async put(name: string, data: Uint8Array, cond?: PutCondition) {
      const pre: Record<string, string> = {};
      if (cond && "ifMatch" in cond) pre["If-Match"] = cond.ifMatch;
      if (cond && "ifNoneMatch" in cond) pre["If-None-Match"] = "*";
      const r = await fetchFn(base + encodeURIComponent(name), { method: "PUT", headers: { ...auth, ...pre }, body: data as BodyInit });
      if (r.status === 412) throw new PreconditionFailedError(name);
      if (!r.ok) throw new Error(`relay PUT ${r.status}`);
      return { etag: r.headers.get("ETag") ?? "" };
    },
    async delete(name: string) {
      const r = await fetchFn(base + encodeURIComponent(name), { method: "DELETE", headers: auth });
      if (!r.ok && r.status !== 404) throw new Error(`relay DELETE ${r.status}`);
    },
    async list() {
      const r = await fetchFn(base, { method: "GET", headers: auth });
      if (!r.ok) throw new Error(`relay list ${r.status}`);
      return ((await r.json()) as { names: string[] }).names;
    },
  };
}

/** Two devices sync notes with the canaries through `provider`. */
async function syncNotes(provider: SyncProvider) {
  const a = await newVault(provider);
  a.files.set("פגישות.md", `# ${CANARIES[0]}`);
  a.files.set("notes/launch.md", CANARIES[1]);
  await a.sync.sync();
  const b = await joinVault("B", provider);
  await b.sync.sync();
  expect(snapshot(b)).toEqual(snapshot(a));
  b.files.set("סודות.md", CANARIES[2]);
  await b.sync.sync();
  await a.sync.sync();
  expect(a.files.text("סודות.md")).toBe(CANARIES[2]);
}

const TOKEN = `scan-${"t".repeat(40)}`;

describe("the vault relay keeps no note text", () => {
  it("on Workers (simulated Durable Object): 0 hits in storage and logs", async () => {
    const storage = new FakeStorage();
    let obj: VaultRelayLike | null = null;
    type VaultRelayLike = { fetch(r: Request): Promise<Response> };
    const state = fakeState(storage);
    const env: Record<string, unknown> = {
      VAULT_RELAY_RATE: "100000",
      RELAY: {
        idFromName: (n: string) => n,
        get: () => ({
          fetch: async (r: Request) => {
            obj ??= new VaultRelay(state, env) as VaultRelayLike;
            await state.ready;
            return obj.fetch(r);
          },
        }),
      },
    };
    const call = (url: string, init: RequestInit) =>
      (worker as { fetch(r: Request, e: unknown): Promise<Response> }).fetch(new Request(url, { ...init, headers: { ...(init.headers as Record<string, string>), "cf-connecting-ip": "198.51.100.7" } }), env);
    const { logs } = await capturingLogs(() => syncNotes(relayClient(call, "https://relay.example.com/v1/vault/o/", TOKEN)));
    const dump = storage.dump();
    expect(dump.length).toBeGreaterThan(4);
    expect(scanMem(dump, CANARIES)).toEqual([]);
    expect(scanMem([["logs", Buffer.from(logs)]], CANARIES)).toEqual([]);
    // Control: a client that skips the encryption and puts the note as it is.
    await call(`https://relay.example.com/v1/vault/o/plain`, { method: "PUT", headers: { Authorization: `Bearer ${TOKEN}` }, body: Buffer.from(CANARIES[0]) as BodyInit });
    expect(scanMem(storage.dump(), CANARIES).length).toBeGreaterThan(0);
  }, 60_000);

  it("on Node with its disk store: 0 hits in the directory and the logs", async () => {
    const dir = tempDir();
    const { logs } = await capturingLogs(async () => {
      const relay = createVaultRelay({ sweep: false, ratePerMinute: 100000, store: diskStore(dir), clientAddress: () => "198.51.100.8" });
      const server: Server = http.createServer((req, res) => {
        if (!relay.handle(req, res)) res.writeHead(404).end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/vault/o/`;
      try {
        await syncNotes(relayClient((u, i) => fetch(u, i), base, TOKEN));
      } finally {
        relay.close();
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
    const r = scanFiles([dir], CANARIES);
    expect(r.files).toBeGreaterThan(4);
    expect(r.hits).toEqual([]);
    expect(scanMem([["logs", Buffer.from(logs)]], CANARIES)).toEqual([]);
    // Control.
    writeFileSync(join(dir, "control.bin"), Buffer.from(CANARIES[2], "utf16le"));
    expect(scanFiles([dir], CANARIES).hits.map((h) => h.form)).toEqual(["utf16le"]);
  }, 60_000);
});

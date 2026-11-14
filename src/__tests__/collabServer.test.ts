/**
 * Plan 3.6: the Hocuspocus collab server (sync-server/collab-server.mjs).
 * Runs it in-process on an ephemeral port with a temporary data directory
 * and talks to it with the real @hocuspocus/provider and room-token client.
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { requestRoomToken, RoomTokenError, roomTokenUrl } from "../collab/roomToken";
// @ts-expect-error -- plain ESM server module, no types
import { createCollabServer } from "../../sync-server/collab-server.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { importLegacyRooms } from "../../sync-server/collab/legacyImport.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { openStore } from "../../sync-server/collab/sqliteStore.mjs";
// @ts-expect-error -- plain ESM server module, no types
import { issueRoomToken, signingKey, verifyRoomToken } from "../../sync-server/collab/roomToken.mjs";

interface App {
  listen(): Promise<number>;
  close(): Promise<void>;
  backup(): string | null;
}

const ACCESS = "operator-access-key-for-tests";
const SECRET = "x".repeat(40);
const dirs: string[] = [];
const apps: App[] = [];
const providers: HocuspocusProvider[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "lumen-collab-"));
  dirs.push(d);
  return d;
}

async function start(dataDir: string, extra: Record<string, unknown> = {}): Promise<{ app: App; url: string }> {
  const app = createCollabServer({ port: 0, host: "127.0.0.1", dataDir, accessKey: ACCESS, tokenSecret: SECRET, debounceMs: 20, maxDebounceMs: 50, backupIntervalMs: 0, ...extra }) as App;
  apps.push(app);
  const port = await app.listen();
  return { app, url: `ws://127.0.0.1:${port}` };
}

/** Connect a provider for `room`; resolves once synced, rejects on auth failure. */
function join_(url: string, room: string, token: () => Promise<string>, doc = new Y.Doc()): Promise<{ doc: Y.Doc; provider: HocuspocusProvider }> {
  return new Promise((resolve, reject) => {
    const provider = new HocuspocusProvider({
      url,
      name: room,
      document: doc,
      token,
      onSynced: () => resolve({ doc, provider }),
      onAuthenticationFailed: ({ reason }) => reject(new Error(`auth failed: ${reason}`)),
    });
    providers.push(provider);
  });
}

afterEach(async () => {
  for (const p of providers.splice(0)) p.destroy();
  for (const a of apps.splice(0)) await a.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("room tokens (HMAC)", () => {
  const key = signingKey(SECRET);
  it("accepts its own token for its room, and nothing else", () => {
    const now = Date.UTC(2026, 9, 18);
    const { token, expiresAt } = issueRoomToken(key, "room-a", { ttlS: 60, nowMs: now });
    expect(expiresAt).toBe(now + 60_000);
    expect(verifyRoomToken(key, token, "room-a", { nowMs: now })).toBeNull();
    expect(verifyRoomToken(key, token, "room-b", { nowMs: now })).toBe("room");
    expect(verifyRoomToken(key, token, "room-a", { nowMs: now + 60_000 })).toBe("expired");
    expect(verifyRoomToken(signingKey("y".repeat(40)), token, "room-a", { nowMs: now })).toBe("signature");
    const [payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ r: "room-a", e: 9e9 })).toString("base64url");
    expect(verifyRoomToken(key, `${forged}.${sig}`, "room-a", { nowMs: now })).toBe("signature");
    expect(verifyRoomToken(key, payload, "room-a", { nowMs: now })).toBe("malformed");
    expect(verifyRoomToken(key, undefined, "room-a", { nowMs: now })).toBe("malformed");
  });

  it("refuses a short configured secret", () => {
    expect(() => signingKey("short")).toThrow(/32/);
  });

  it("puts the token endpoint under the server's path", () => {
    expect(roomTokenUrl("wss://collab.example.com")).toBe("wss://collab.example.com/token");
    expect(roomTokenUrl("wss://h.example/collab/?x=1")).toBe("wss://h.example/collab/token");
  });
});

describe("collab server", () => {
  it("answers /healthz", async () => {
    const { url } = await start(tempDir());
    const res = await fetch(url.replace("ws:", "http:") + "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, service: "lumen-collab", persistence: "sqlite" });
    // Behind a path prefix too, like the token endpoint (review: #237).
    expect((await fetch(url.replace("ws:", "http:") + "/collab/healthz")).status).toBe(200);
  });

  it("imports rooms left by the legacy LevelDB server once, never over a room it already has (review: #237)", async () => {
    const dataDir = tempDir();
    const legacy = new Map<string, Y.Doc>();
    for (const [name, text] of [["room-old", "from leveldb"], ["room-both", "stale leveldb copy"]] as const) {
      const d = new Y.Doc();
      d.getText("t").insert(0, text);
      legacy.set(name, d);
    }
    const source = { getAllDocNames: async () => [...legacy.keys()], getYDoc: async (n: string) => { const d = new Y.Doc(); Y.applyUpdate(d, Y.encodeStateAsUpdate(legacy.get(n)!)); return d; } };
    const store = openStore(dataDir);
    const current = new Y.Doc();
    current.getText("t").insert(0, "newer sqlite copy");
    store.save("room-both", Y.encodeStateAsUpdate(current));
    expect(await importLegacyRooms(store, source, { marker: "leveldb-import:x" })).toEqual({ imported: 1, skipped: 1, already: false });
    expect(await importLegacyRooms(store, source, { marker: "leveldb-import:x" })).toMatchObject({ already: true });
    store.close();

    // The imported room is served like any other.
    const { url } = await start(dataDir);
    const c = await join_(url, "room-old", async () => (await requestRoomToken(url, "room-old", ACCESS)).token);
    expect(c.doc.getText("t").toString()).toBe("from leveldb");
    const b = await join_(url, "room-both", async () => (await requestRoomToken(url, "room-both", ACCESS)).token);
    expect(b.doc.getText("t").toString()).toBe("newer sqlite copy");
  });

  it("issues a room token only with the access key", async () => {
    const { url } = await start(tempDir());
    await expect(requestRoomToken(url, "room-a", null)).rejects.toEqual(new RoomTokenError("unauthorized"));
    await expect(requestRoomToken(url, "room-a", "wrong")).rejects.toEqual(new RoomTokenError("unauthorized"));
    await expect(requestRoomToken(url, "../etc", ACCESS)).rejects.toEqual(new RoomTokenError("bad-room"));
    const { token, expiresAt } = await requestRoomToken(url, "room-a", ACCESS);
    expect(token).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
  });

  it("rejects a connection without a valid token for that room", async () => {
    const { url } = await start(tempDir());
    await expect(join_(url, "room-a", async () => "nope")).rejects.toThrow(/auth failed/);
    const other = (await requestRoomToken(url, "room-b", ACCESS)).token;
    await expect(join_(url, "room-a", async () => other)).rejects.toThrow(/auth failed/);
  });

  it("a room that every peer leaves keeps its content across a server restart, and is backed up", async () => {
    const dataDir = tempDir();
    let { app, url } = await start(dataDir);
    const tokenFor = (u: string) => async () => (await requestRoomToken(u, "room-p", ACCESS)).token;
    const a = await join_(url, "room-p", tokenFor(url));
    const b = await join_(url, "room-p", tokenFor(url));
    a.doc.getText("t").insert(0, "alpha ");
    await vi_waitFor(() => b.doc.getText("t").toString() === "alpha ");
    b.doc.getText("t").insert(6, "beta");
    await vi_waitFor(() => a.doc.getText("t").toString() === "alpha beta");
    // Both leave; the server stores and shuts down (as on a redeploy).
    for (const p of providers.splice(0)) p.destroy();
    await app.close();
    apps.splice(apps.indexOf(app), 1);
    expect(readdirSync(join(dataDir, "backups")).filter((f) => f.endsWith(".sqlite")).length).toBe(1);

    ({ app, url } = await start(dataDir));
    const c = await join_(url, "room-p", tokenFor(url));
    expect(c.doc.getText("t").toString()).toBe("alpha beta");
  });

  it("keeps only the newest backups", async () => {
    const { app } = await start(tempDir(), { keepBackups: 2 });
    const files = [app.backup(), app.backup(), app.backup()];
    expect(files.every(Boolean)).toBe(true);
    const dir = join(files[0]!, "..");
    expect(readdirSync(dir).sort()).toEqual([files[1], files[2]].map((f) => f!.split(/[\\/]/).pop()).sort());
  });
});

async function vi_waitFor(cond: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

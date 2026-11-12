// @vitest-environment node
/**
 * Plan W4.19, sync in two clicks: which place is suggested, the Hebrew key
 * words, the folder provider, and the encrypted relay — two devices syncing
 * through the real relay server (sync-server/vault-relay.js) and through a
 * shared folder, with the real crypto.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { isMobileDevice, setupChoices } from "../sync/e2ee/setup/recommend";
import { KEY_WORDS, newRecoveryWords, normalizeWord, parseRecoveryWords, relayToken, WORD_LIST } from "../sync/e2ee/setup/recoveryWords";
import { folderProvider, FOLDER_SYNC_DIR } from "../sync/e2ee/providers/folder";
import { relayOrigin, relayProvider, relaySpaceId, solveRelayPow } from "../sync/e2ee/providers/relay";
import { PreconditionFailedError, type SyncProvider } from "../sync/e2ee/provider";
import { createMemoryBackend } from "../storage/vault/memory";
import { createSession } from "../sync/e2ee/ui/session";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { keepBothResolver } from "../sync/e2ee/conflict";
import { __setProviderStore } from "../sync/e2ee/providers";
import { __resetSecretStore } from "../lib/secretStore";
import { TEST_ITERATIONS } from "./helpers/e2ee";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { createVaultRelay, memoryStore, powOk, addressKey, charge } = require("../../sync-server/vault-relay.js") as {
  createVaultRelay: (o?: Record<string, unknown>) => { handle(req: unknown, res: unknown): boolean; close(): void; sweep(): Promise<number> };
  memoryStore: () => unknown;
  powOk: (space: string, nonce: string, bits: number) => boolean;
  addressKey: (address: string) => string;
  charge: (bytes: number) => number;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const http = require("node:http") as typeof import("node:http");

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("setupChoices", () => {
  const base = { folderAccess: false, mobile: false, relayUrl: null, dropboxOAuth: false, gdriveOAuth: false };
  it("a computer with folder access gets the desktop sync folder first", () => {
    expect(setupChoices({ ...base, folderAccess: true, relayUrl: "https://r.example" })).toEqual({ recommended: "folder", available: ["folder", "relay", "webdav"] });
  });
  it("a phone gets the relay, even if it could open a folder", () => {
    expect(setupChoices({ ...base, folderAccess: true, mobile: true, relayUrl: "https://r.example" }).recommended).toBe("relay");
  });
  it("no folder access and no relay: WebDAV; OAuth providers only once registered", () => {
    expect(setupChoices(base)).toEqual({ recommended: "webdav", available: ["webdav"] });
    expect(setupChoices({ ...base, gdriveOAuth: true, dropboxOAuth: true }).available).toEqual(["gdrive", "dropbox", "webdav"]);
  });
  it("tells phones and iPads from computers", () => {
    expect(isMobileDevice({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)" }, false)).toBe(true);
    expect(isMobileDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 5 }, false)).toBe(true);
    expect(isMobileDevice({ userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)", maxTouchPoints: 0 }, false)).toBe(false);
    expect(isMobileDevice({ userAgent: "Mozilla/5.0 (Linux; Android 15; Pixel 7)" }, false)).toBe(true);
  });
  it("the relay origin follows the live-share server, https only (http only on this machine)", () => {
    expect(relayOrigin("wss://collab.example.workers.dev/")).toBe("https://collab.example.workers.dev");
    expect(relayOrigin("ws://evil.example/")).toBeNull();
    expect(relayOrigin("ws://localhost:4444")).toBe("http://localhost:4444");
    expect(relayOrigin(undefined)).toBeNull();
  });
});

describe("recovery words", () => {
  it("256 different everyday Hebrew words, even with final letters folded", () => {
    expect(WORD_LIST).toHaveLength(256);
    const fold = (w: string) => w.replace(/[ךםןףץ]/g, (c) => ({ ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" })[c] as string);
    expect(new Set(WORD_LIST.map(fold)).size).toBe(256);
    for (const w of WORD_LIST) expect(w).toMatch(/^[א-ת]{2,6}$/);
  });

  it("13 words that parse back to the same passphrase, typed loosely", async () => {
    const words = await newRecoveryWords();
    expect(words).toHaveLength(KEY_WORDS + 1);
    const typed = `  ${words.map((w, i) => (i === 2 ? w.replace(/[ךםןףץ]/g, (c) => ({ ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" })[c] as string) : w)).join(",  ")}\n`;
    const parsed = await parseRecoveryWords(typed);
    expect(parsed).toEqual({ ok: true, words, passphrase: words.join(" ") });
    expect(normalizeWord("שָׁלוֹם")).toBeNull();
    expect(normalizeWord(`${WORD_LIST[0]}.`)).toBe(WORD_LIST[0]);
  });

  it("a wrong word is caught: unknown words by position, swapped list words by the check word", async () => {
    let caught = 0;
    const rounds = 500;
    for (let i = 0; i < rounds; i++) {
      const words = await newRecoveryWords();
      const at = i % KEY_WORDS;
      const other = WORD_LIST[(WORD_LIST.indexOf(words[at]) + 1 + (i % 255)) % 256];
      const bad = words.map((w, j) => (j === at ? other : w));
      const r = await parseRecoveryWords(bad.join(" "));
      if (!r.ok && r.reason === "check") caught++;
    }
    // One byte of check: a random substitution slips through with p = 1/256.
    expect(caught).toBeGreaterThanOrEqual(rounds - 10);
    expect(await parseRecoveryWords("אבן אגם")).toEqual({ ok: false, reason: "count" });
    const w = await newRecoveryWords();
    expect(await parseRecoveryWords([...w.slice(0, 4), "xyz", ...w.slice(5)].join(" "))).toEqual({ ok: false, reason: "unknown", at: 4 });
  });

  it("the relay token is fixed by the words and fits the relay's token format", async () => {
    const t1 = await relayToken("אבן אגם");
    expect(t1).toBe(await relayToken("אבן אגם"));
    expect(t1).not.toBe(await relayToken("אבן אגס"));
    expect(t1).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

/** The provider contract the engine relies on. */
async function contract(p: SyncProvider): Promise<void> {
  expect(await p.list()).toEqual([]);
  expect(await p.get("a")).toBeNull();
  const { etag } = await p.put("a", enc("one"), { ifNoneMatch: "*" });
  await expect(p.put("a", enc("x"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailedError);
  const got = await p.get("a");
  expect(dec(got!.data)).toBe("one");
  expect(got!.etag).toBe(etag);
  const second = await p.put("a", enc("two"), { ifMatch: etag });
  await expect(p.put("a", enc("three"), { ifMatch: etag })).rejects.toBeInstanceOf(PreconditionFailedError);
  expect(dec((await p.get("a"))!.data)).toBe("two");
  await p.put("b", enc("bee"));
  expect((await p.list()).sort()).toEqual(["a", "b"]);
  await p.delete("b");
  await p.delete("b");
  expect(await p.list()).toEqual(["a"]);
  expect(second.etag).not.toBe(etag);
}

describe("folder provider", () => {
  it("keeps the contract on a folder backend, inside “Lumen sync”", async () => {
    const fs = createMemoryBackend();
    await contract(folderProvider(fs));
    expect((await fs.list(FOLDER_SYNC_DIR)).map((e) => e.name)).toEqual(["a"]);
  });

  it("ignores the copies desktop sync apps make on a clash", async () => {
    const fs = createMemoryBackend();
    const p = folderProvider(fs);
    await p.put("manifest", enc("m"));
    await fs.write(`${FOLDER_SYNC_DIR}/manifest (conflicted copy 2026-11-12).bin`, enc("x"));
    await fs.write(`${FOLDER_SYNC_DIR}/.DS_Store`, enc("x"));
    expect(await p.list()).toEqual(["manifest"]);
  });
});

describe("relay", () => {
  let server: Server;
  let origin = "";
  let relay: { close(): void };
  beforeAll(async () => {
    // The daily bytes of the one test address are not under test here (they cover every object, in 4 KiB blocks).
    relay = createVaultRelay({ sweep: false, maxSpaceBytes: 64 * 1024, addressBytesPerDay: 1024 * 1024, ratePerMinute: 100000 });
    server = http.createServer((req, res) => {
      if (!(relay as ReturnType<typeof createVaultRelay>).handle(req, res)) {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    relay.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("keeps the contract; one space per token; a bad token is refused", async () => {
    const token = await relayToken("first device words");
    await contract(relayProvider({ url: origin, token }));
    const other = relayProvider({ url: origin, token: await relayToken("someone else") });
    expect(await other.list()).toEqual([]);
    const res = await fetch(`${origin}/v1/vault/o/`, { headers: { Authorization: "Bearer short" } });
    expect(res.status).toBe(401);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("refuses a space past its quota", async () => {
    const p = relayProvider({ url: origin, token: await relayToken("quota") });
    await p.put("big", new Uint8Array(60 * 1024));
    await expect(p.put("more", new Uint8Array(8 * 1024))).rejects.toThrow(/507/);
  });
});

describe("two devices, two clicks each", () => {
  const kv = new Map<string, unknown>();
  beforeEach(() => {
    kv.clear();
    __setProviderStore({ get: async <T,>(k: string) => kv.get(k) as T | undefined, set: async (k, v) => void kv.set(k, v), del: async (k) => void kv.delete(k) });
  });
  afterEach(() => {
    __setProviderStore(null);
    __resetSecretStore();
  });

  const device = () => {
    const files = memoryFiles();
    const session = createSession({
      local: () => files,
      store: async () => memoryStateStore(),
      resolver: keepBothResolver,
      pbkdf2Iterations: TEST_ITERATIONS,
      kdfPolicy: { minPbkdf2Iterations: TEST_ITERATIONS },
      intervalMinutes: 0,
      treeBadges: false,
      background: false,
      watch: () => () => undefined,
    });
    return { files, session };
  };

  it("through the relay: the second device needs only the 13 words; the relay holds no note text", async () => {
    const relay = createVaultRelay({ sweep: false });
    const seen: Uint8Array[] = [];
    const server = http.createServer((req, res) => {
      if (req.method === "PUT") req.on("data", (c: Uint8Array) => seen.push(new Uint8Array(c)));
      relay.handle(req, res);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const words = await newRecoveryWords();
      const pass = words.join(" ");
      const a = device();
      await a.files.write("מקורות/פגישה.md", enc("# פגישה עם המקור\nסוד גדול"), null);
      await a.session.connect({ kind: "relay", url }, await relayToken(pass));
      expect(a.session.get().vaultExists).toBe(false);
      const first = await a.session.open(pass);
      expect(first.uploaded).toBe(1);

      const b = device();
      const parsed = await parseRecoveryWords(words.join("  "));
      if (!parsed.ok) throw new Error("words");
      await b.session.connect({ kind: "relay", url }, await relayToken(parsed.passphrase));
      expect(b.session.get().vaultExists).toBe(true);
      const second = await b.session.open(parsed.passphrase);
      expect(second.downloaded).toBe(1);
      expect(dec((await b.files.read("מקורות/פגישה.md"))!)).toBe("# פגישה עם המקור\nסוד גדול");
      expect([...b.session.get().files!.values()].every((f) => f.state === "synced")).toBe(true);

      const wire = seen.map((c) => Buffer.from(c).toString("utf8")).join("");
      expect(wire).not.toContain("סוד");
      expect(wire).not.toContain("פגישה");
    } finally {
      relay.close();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("through a desktop sync folder: what one device writes, the other reads", async () => {
    // Two folder providers on one backend stand for two computers whose sync app shares the folder.
    const shared = createMemoryBackend();
    const words = (await newRecoveryWords()).join(" ");
    const a = device();
    await a.files.write("note.md", enc("שלום"), null);
    // The session builds folder providers from the stored handle; drive the engine-level provider directly.
    const { createVault, unlockVault, E2eeSync } = await import("../sync/e2ee/engine");
    const pa = folderProvider(shared);
    const { keys: ka } = await createVault(pa, words, { pbkdf2Iterations: TEST_ITERATIONS });
    const ea = new E2eeSync({ provider: pa, keys: ka, local: a.files, store: memoryStateStore(), resolver: keepBothResolver });
    expect((await ea.sync()).uploaded).toBe(1);
    const b = device();
    const pb = folderProvider(shared);
    const { keys: kb } = await unlockVault(pb, words, { minPbkdf2Iterations: TEST_ITERATIONS });
    const eb = new E2eeSync({ provider: pb, keys: kb, local: b.files, store: memoryStateStore(), resolver: keepBothResolver });
    expect((await eb.sync()).downloaded).toBe(1);
    expect(dec((await b.files.read("note.md"))!)).toBe("שלום");
  });
});

describe("relay limits (review 12.11)", () => {
  /** A relay on a real socket, for one test. */
  async function serve(opts: Record<string, unknown>) {
    const relay = createVaultRelay({ sweep: false, ratePerMinute: 100000, ...opts });
    const server = http.createServer((req, res) => void relay.handle(req, res));
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { relay, origin, close: () => (relay.close(), new Promise<void>((r) => server.close(() => r()))) };
  }
  const tok = (i: number) => `t${String(i).padStart(40, "0")}`;

  it("a new token is not free: new spaces per address per day, bytes per address per day, and all spaces together are capped", async () => {
    // Every object is charged in whole 4 KiB blocks (review 2): 10,000 bytes cost 12,288.
    const r = await serve({ newSpacesPerDay: 2, maxSpaceBytes: 20_000, addressBytesPerDay: 100_000, maxTotalBytes: 30_000 });
    try {
      await relayProvider({ url: r.origin, token: tok(1) }).put("a", new Uint8Array(10_000));
      await relayProvider({ url: r.origin, token: tok(2) }).put("a", new Uint8Array(10_000));
      // A third space from the same address today: refused before anything is stored.
      await expect(relayProvider({ url: r.origin, token: tok(3) }).put("a", new Uint8Array(1))).rejects.toThrow(/429/);
      // The existing spaces still work, until the relay as a whole is full (each is under its own quota).
      await relayProvider({ url: r.origin, token: tok(1) }).put("b", new Uint8Array(4_000));
      await expect(relayProvider({ url: r.origin, token: tok(2) }).put("b", new Uint8Array(2_000))).rejects.toThrow(/507/);
      // Deleting frees room in the total.
      await relayProvider({ url: r.origin, token: tok(1) }).delete("b");
      await relayProvider({ url: r.origin, token: tok(2) }).put("b", new Uint8Array(2_000));
    } finally {
      await r.close();
    }
    const b = await serve({ maxSpaceBytes: 12_288, addressBytesPerDay: 15_000 });
    try {
      await relayProvider({ url: b.origin, token: tok(1) }).put("a", new Uint8Array(10_000));
      await expect(relayProvider({ url: b.origin, token: tok(2) }).put("a", new Uint8Array(10_000))).rejects.toThrow(/429/);
    } finally {
      await b.close();
    }
  });

  it("an invite, when the operator sets one, is needed to open a space (not to use one)", async () => {
    const r = await serve({ invite: "club-secret-1234" });
    try {
      await expect(relayProvider({ url: r.origin, token: tok(1) }).put("a", enc("x"))).rejects.toThrow(/403/);
      const p = relayProvider({ url: r.origin, token: tok(1), invite: "club-secret-1234" });
      await p.put("a", enc("x"));
      expect(await p.list()).toEqual(["a"]);
      expect(await relayProvider({ url: r.origin, token: tok(1) }).list()).toEqual(["a"]);
    } finally {
      await r.close();
    }
  });

  it("a proof of work, when the operator asks for one: the app solves it once, bound to its own space", async () => {
    const r = await serve({ powBits: 10 });
    try {
      const raw = await fetch(`${r.origin}/v1/vault/o/a`, { method: "PUT", headers: { Authorization: `Bearer ${tok(1)}` }, body: "x" });
      expect(raw.status).toBe(428);
      expect(await raw.json()).toEqual({ error: "pow", bits: 10 });
      const p = relayProvider({ url: r.origin, token: tok(1) });
      await p.put("a", enc("x"));
      await p.put("b", enc("y")); // the space exists now: no more work
      expect((await p.list()).sort()).toEqual(["a", "b"]);
      // A nonce solved for one space proves nothing for another.
      const nonce = await solveRelayPow(await relaySpaceId(tok(1)), 10);
      expect(powOk(await relaySpaceId(tok(1)), nonce, 10)).toBe(true);
      const other = await fetch(`${r.origin}/v1/vault/o/a`, { method: "PUT", headers: { Authorization: `Bearer ${tok(2)}`, "X-Lumen-Pow": nonce }, body: "x" });
      expect(other.status).toBe(428);
    } finally {
      await r.close();
    }
  });

  it("retention counts reads: a space read every day is kept; one nobody reads or writes goes", async () => {
    const real = Date.now;
    let now = Date.UTC(2026, 0, 1);
    Date.now = () => now;
    try {
      const r = await serve({ store: memoryStore(), retentionDays: 180 });
      try {
        const read = relayProvider({ url: r.origin, token: tok(1) });
        const idle = relayProvider({ url: r.origin, token: tok(2) });
        await read.put("m", enc("sealed"));
        await idle.put("m", enc("sealed"));
        for (let d = 0; d < 200; d++) {
          now += 86_400_000;
          expect(await read.get("m")).not.toBeNull();
        }
        expect(await r.relay.sweep()).toBe(1);
        expect(await read.get("m")).not.toBeNull();
        expect(await idle.get("m")).toBeNull();
      } finally {
        await r.close();
      }
    } finally {
      Date.now = real;
    }
  });

  it("review 2: an IPv6 /64 is one address; objects cost whole blocks; a concurrent burst is counted in full", async () => {
    expect(addressKey("2001:db8:1:2::5")).toBe(addressKey("2001:db8:1:2:ffff:1:2:3"));
    expect(addressKey("2001:db8:1:3::5")).not.toBe(addressKey("2001:db8:1:2::5"));
    expect(addressKey("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect([charge(0), charge(1), charge(4096), charge(4097)]).toEqual([4096, 4096, 4096, 8192]);
    const r = await serve({ newSpacesPerDay: 3 });
    try {
      const out = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => relayProvider({ url: r.origin, token: tok(100 + i) }).put("a", enc("x"))));
      expect(out.filter((o) => o.status === "fulfilled")).toHaveLength(3);
    } finally {
      await r.close();
    }
  });
});

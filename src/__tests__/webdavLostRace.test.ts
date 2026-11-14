/**
 * Plan W8.3: WebDAV servers that answer a racing write with 423 Locked
 * (Go's x/net/webdav, Nextcloud's file locking) or 409 Conflict instead of
 * 412. The provider retries a bounded number of times; a conditional write
 * that stays locked is a lost race (PreconditionFailedError, which the
 * engine re-reads and merges), never a plain error. A 409 because the folder
 * is gone is still an error.
 */
import { describe, expect, it } from "vitest";
import { PreconditionFailedError, ProviderUnavailableError } from "../sync/e2ee/provider";
import { DEFAULT_LOCK_RETRY, isRaceStatus, webdavProvider } from "../sync/e2ee/providers/webdav";
import { fakeFetch, text, utf8, type FakeRequest, type FakeResponse } from "./helpers/fakeServers/http";
import { fakeWebdav } from "./helpers/fakeServers/webdav";

const URL_ = "https://dav.example/d/";

/** A fake WebDAV server with a hook in front of it, and a provider whose waits are recorded, not slept. */
function lab(front?: (req: FakeRequest, next: () => FakeResponse | Promise<FakeResponse>) => FakeResponse | Promise<FakeResponse>, retries = DEFAULT_LOCK_RETRY.retries, wait?: () => Promise<void>) {
  const server = fakeWebdav({ baseUrl: URL_, preCreated: true });
  const waits: number[] = [];
  let putCount = 0;
  const handler = (req: FakeRequest) => {
    if (req.method === "PUT") putCount++;
    return front ? front(req, () => server.handle(req)) : server.handle(req);
  };
  const provider = webdavProvider({ url: URL_ }, { fetch: fakeFetch(handler), lockRetry: { retries, baseDelayMs: 100 }, sleep: async (ms) => {
      waits.push(ms);
      await wait?.();
    },
  });
  /** PUTs that reached the server, answered by the hook or not. */
  const puts = () => putCount;
  return { server, provider, waits, puts };
}

/** Answer the first `n` PUTs with `status`, then let the server answer. */
const firstPuts = (n: number, status: number) => {
  let left = n;
  return (req: FakeRequest, next: () => FakeResponse | Promise<FakeResponse>) => {
    if (req.method === "PUT" && left > 0) {
      left--;
      return { status, body: status === 423 ? "locked" : "conflict" };
    }
    return next();
  };
};

describe("WebDAV 423 Locked and 409 Conflict (W8.3)", () => {
  it("423 and 409 are the race statuses; 412 stays the precondition", () => {
    expect([423, 409, 412, 500].map(isRaceStatus)).toEqual([true, true, false, false]);
  });

  it("a 423 leads to a retry, not an error: the conditional write lands on the second attempt", async () => {
    const L = lab(firstPuts(1, 423));
    const a = await L.provider.put("obj", text("one"), { ifNoneMatch: "*" });
    expect(a.etag).toBeTruthy();
    expect(L.waits).toHaveLength(1);
    expect(utf8((await L.provider.get("obj"))!.data)).toBe("one");
  });

  it("a 409 while the folder exists is retried the same way", async () => {
    const L = lab();
    const first = await L.provider.put("obj", text("one"));
    const conflicted = lab(firstPuts(2, 409));
    conflicted.server.files.set("obj", L.server.files.get("obj")!);
    const b = await conflicted.provider.put("obj", text("two"), { ifMatch: first.etag });
    expect(b.etag).toBeTruthy();
    expect(conflicted.waits).toHaveLength(2);
  });

  it("a conditional write that stays locked is a lost race after a bounded number of attempts", async () => {
    const L = lab(firstPuts(100, 423));
    await expect(L.provider.put("obj", text("x"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailedError);
    // 1 + 3 retries, and the waits double: 100·2^n plus up to the same again.
    expect(L.puts()).toBe(4);
    expect(L.waits).toHaveLength(3);
    L.waits.forEach((w, i) => {
      expect(w).toBeGreaterThanOrEqual(100 * 2 ** i);
      expect(w).toBeLessThanOrEqual(2 * 100 * 2 ** i);
    });
  });

  it("an unconditional write that stays locked is 'unavailable, retry later', not a lost race", async () => {
    const L = lab(firstPuts(100, 423), 1);
    const e = await L.provider.put("obj", text("x")).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderUnavailableError);
    expect(String((e as Error).message)).toContain("locked (423) after 2 attempts");
  });

  it("a 409 because the folder is gone is an error at once: no retry, not a race", async () => {
    const L = lab();
    L.server.collection = false;
    const e = await L.provider.put("obj", text("x"), { ifNoneMatch: "*" }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(PreconditionFailedError);
    expect(String((e as Error).message)).toContain("409");
    expect(L.puts()).toBe(1);
    expect(L.waits).toEqual([]);
  });

  it("two devices, the server locks the file while one writes: exactly one wins, the other loses the race", async () => {
    // The server holds a lock for the length of a PUT; a PUT that arrives meanwhile gets 423.
    let locked = false;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let firstWriter = true;
    // B's wait between attempts lasts until A's write is done, as a real backoff would.
    const L = lab(async (req, next) => {
      if (req.method !== "PUT") return next();
      if (locked) return { status: 423, body: "locked" };
      locked = true;
      try {
        if (firstWriter) {
          firstWriter = false;
          await held; // the first writer is slow
        }
        return await next();
      } finally {
        locked = false;
      }
    }, DEFAULT_LOCK_RETRY.retries, () => held);
    const base = await L.provider.get("obj");
    expect(base).toBeNull();
    // Device A's create starts and holds the lock; device B's create meets 423, waits, retries.
    const a = L.provider.put("obj", text("from A"), { ifNoneMatch: "*" });
    await new Promise((r) => setTimeout(r, 0));
    const b = L.provider.put("obj", text("from B"), { ifNoneMatch: "*" });
    const settled = Promise.allSettled([a, b]);
    await new Promise((r) => setTimeout(r, 0));
    expect(L.waits).toHaveLength(1); // B met the lock and is waiting
    release();
    const results = await settled;
    const won = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(lost[0].reason).toBeInstanceOf(PreconditionFailedError);
    expect(utf8((await L.provider.get("obj"))!.data)).toBe("from A");
    // B's retry after the lock was released was refused by the precondition (412), not by the retry limit.
    expect(L.puts()).toBe(3);
  });

  it("delete retries a 423, then succeeds", async () => {
    const L = lab();
    await L.provider.put("obj", text("x"));
    const locking = lab(async (req, next) => (req.method === "DELETE" && locking.waits.length === 0 ? { status: 423, body: "locked" } : next()));
    locking.server.files.set("obj", L.server.files.get("obj")!);
    await locking.provider.delete("obj");
    expect(locking.waits).toHaveLength(1);
    expect(locking.server.files.has("obj")).toBe(false);
  });

  it("probe passes on a server that locks now and then", async () => {
    let n = 0;
    const L = lab((req, next) => (req.method === "PUT" && ++n % 3 === 0 ? { status: 423, body: "locked" } : next()));
    await expect(L.provider.probe()).resolves.toBeUndefined();
    expect(L.waits.length).toBeGreaterThan(0);
  });
});

/**
 * The storage providers of the encrypted sync (plan 3.5) against mock
 * servers that implement each service's conditional write: WebDAV
 * `If-Match` / `If-None-Match`, S3 `If-Match` / `If-None-Match` (signed
 * SigV4 requests, verified by the mock), Dropbox `mode: update` with a rev
 * and `mode: add`, Google Drive `If-Match` on the metadata ETag. The 3.4
 * two-writer race runs on all four. Dropbox and Drive are mocks only until
 * Tal's client ids (plan 15.5).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PreconditionFailedError, ProviderUnavailableError, type SyncProvider } from "../sync/e2ee/provider";
import { ProviderAuthError, ProviderUnsupportedError } from "../sync/e2ee/providers/http";
import { webdavProvider } from "../sync/e2ee/providers/webdav";
import { s3Provider } from "../sync/e2ee/providers/s3";
import { dropboxSyncProvider } from "../sync/e2ee/providers/dropbox";
import { gdriveSyncProvider } from "../sync/e2ee/providers/gdrive";
import { HEADER_NAME } from "../sync/e2ee/header";
import { manifestName, openManifest } from "../sync/e2ee/manifest";
import { setSecret, __resetSecretStore } from "../lib/secretStore";
import { fakeFetch, text, utf8 } from "./helpers/fakeServers/http";
import { fakeWebdav } from "./helpers/fakeServers/webdav";
import { fakeS3 } from "./helpers/fakeServers/s3";
import { fakeDropbox } from "./helpers/fakeServers/dropbox";
import { fakeGdrive } from "./helpers/fakeServers/gdrive";
import { gatedProvider } from "./helpers/gatedProvider";
import { joinVault, newVault, snapshot } from "./helpers/e2ee";

interface Lab {
  provider: SyncProvider;
  /** Every object the server holds, by name → bytes. */
  stored(): Map<string, Uint8Array>;
  outage(status: number | null): void;
  /** The same server, wrong credentials. */
  wrongCredentials(): SyncProvider;
  /** A fresh provider on the same server (another device). */
  again(): SyncProvider;
  log: string[];
}

const token = (name: string, access: string) => setSecret(name, JSON.stringify({ access, expiresAt: Date.now() + 3_600_000 }));

const labs: Array<[string, () => Promise<Lab>]> = [
  [
    "webdav",
    async () => {
      const server = fakeWebdav({ baseUrl: "https://dav.example/remote.php/dav/files/tal/Lumen/", username: "tal", password: "pw" });
      const make = (password: string) => webdavProvider({ url: "https://dav.example/remote.php/dav/files/tal/Lumen/", username: "tal", password }, { fetch: fakeFetch(server.handle) });
      const provider = make("pw");
      await provider.probe();
      return {
        provider,
        stored: () => new Map([...server.files].map(([k, v]) => [k, v.data])),
        outage: (s) => (server.outage = s),
        wrongCredentials: () => make("nope"),
        again: () => make("pw"),
        log: server.log,
      };
    },
  ],
  [
    "s3",
    async () => {
      const cfg = { endpoint: "https://s3.eu-central-1.example", bucket: "notes", accessKeyId: "AKIATEST", secretAccessKey: "secret/key+1", region: "eu-central-1" };
      const server = fakeS3(cfg);
      const make = (secretAccessKey: string) => s3Provider({ ...cfg, secretAccessKey, prefix: "lumen/vault" }, { fetch: fakeFetch(server.handle) });
      const provider = make(cfg.secretAccessKey);
      await provider.probe();
      return {
        provider,
        stored: () => new Map([...server.objects].map(([k, v]) => [k.replace(/^lumen\/vault\//, ""), v.data])),
        outage: (s) => (server.outage = s),
        wrongCredentials: () => make("wrong"),
        again: () => make(cfg.secretAccessKey),
        log: server.log,
      };
    },
  ],
  [
    "dropbox",
    async () => {
      const server = fakeDropbox({ token: "dbx-test-token" });
      await token("lumen.cloud.dropbox.token", "dbx-test-token");
      const make = () => dropboxSyncProvider({ folder: "/Apps/Lumen/vault" }, { fetch: fakeFetch(server.handle) });
      return {
        provider: make(),
        stored: () => new Map([...server.files.values()].filter((f) => f.display.startsWith("/Apps/Lumen/vault/")).map((f) => [f.display.slice("/Apps/Lumen/vault/".length), f.data])),
        outage: (s) => (server.outage = s),
        wrongCredentials: () => {
          server.token = "rotated";
          return make();
        },
        again: make,
        log: server.log,
      };
    },
  ],
  [
    "gdrive",
    async () => {
      const server = fakeGdrive({ token: "gd-test-token" });
      await token("lumen.cloud.gdrive.token", "gd-test-token");
      const make = () => gdriveSyncProvider({}, { fetch: fakeFetch(server.handle) });
      return {
        provider: make(),
        stored: () => {
          const folder = [...server.files.values()].find((f) => f.appProperties?.lumenVault === "true");
          return new Map([...server.files.values()].filter((f) => folder && f.parents.includes(folder.id)).map((f) => [f.name, f.data]));
        },
        outage: (s) => (server.outage = s),
        wrongCredentials: () => {
          server.token = "rotated";
          return make();
        },
        again: make,
        log: server.log,
      };
    },
  ],
];

describe.each(labs)("sync provider: %s", (_name, makeLab) => {
  let lab: Lab;
  beforeEach(async () => {
    __resetSecretStore();
    lab = await makeLab();
  });
  afterEach(() => __resetSecretStore());

  it("get / put / delete / list, with the service's own conditional writes", async () => {
    const p = lab.provider;
    expect(await p.get("missing")).toBeNull();
    const { etag } = await p.put("a", text("one"), { ifNoneMatch: "*" });
    expect(etag).toBeTruthy();
    const got = await p.get("a");
    expect(utf8(got!.data)).toBe("one");
    expect(got!.etag).toBe(etag);
    // Create-only on an existing object: a lost race.
    await expect(p.put("a", text("x"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailedError);
    // Replace exactly the version that was read: once, then the etag is stale.
    const { etag: etag2 } = await p.put("a", text("two"), { ifMatch: etag });
    expect(etag2).not.toBe(etag);
    await expect(p.put("a", text("three"), { ifMatch: etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(utf8((await p.get("a"))!.data)).toBe("two");
    // Unconditional write and binary bytes.
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    await p.put("b", bytes);
    expect([...(await p.get("b"))!.data]).toEqual([...bytes]);
    expect((await p.list()).sort()).toEqual(["a", "b"]);
    await p.delete("a");
    await p.delete("a"); // idempotent
    expect(await p.get("a")).toBeNull();
    expect(await p.list()).toEqual(["b"]);
  });

  it("maps outages to ProviderUnavailableError and refused credentials to ProviderAuthError", async () => {
    lab.outage(503);
    await expect(lab.provider.get("a")).rejects.toBeInstanceOf(ProviderUnavailableError);
    lab.outage(null);
    await expect(lab.wrongCredentials().put("a", text("x"))).rejects.toBeInstanceOf(ProviderAuthError);
  });

  it("the 3.4 race: two devices writing in parallel from the same version N — both changes are kept", async () => {
    const provider = gatedProvider(lab.provider, 2);
    const a = await newVault(provider);
    a.files.set("shared.md", "base");
    await a.sync.sync();
    const b = await joinVault("B", provider);
    await b.sync.sync();
    const mname = await manifestName(a.keys);
    provider.manifest = mname;
    const n = (await openManifest(a.keys, (await lab.provider.get(mname))!.data)).manifest.counter;

    a.files.set("from-a.md", "A's note");
    b.files.set("from-b.md", "B's note — שלום");
    const [ra, rb] = await Promise.all([a.sync.sync(), b.sync.sync()]);
    expect(ra.retries + rb.retries).toBe(1); // exactly one lost the service's conditional write, pulled, merged and retried
    expect(Math.max(ra.counter, rb.counter)).toBe(n + 2);
    await a.sync.sync();
    await b.sync.sync();
    for (const d of [a, b]) {
      expect(snapshot(d)).toEqual([
        ["from-a.md", "A's note"],
        ["from-b.md", "B's note — שלום"],
        ["shared.md", "base"],
      ]);
    }
  }, 30_000);

  it("the service sees only the header, opaque names and ciphertext", async () => {
    const a = await newVault(lab.provider);
    a.files.set("פרויקטים/סיכום.md", "# סודי מאוד\n\nthe secret plan");
    await a.sync.sync();
    const stored = lab.stored();
    expect(stored.has(HEADER_NAME)).toBe(true);
    for (const [name, data] of stored) {
      if (name !== HEADER_NAME) expect(name).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const asText = utf8(data);
      expect(asText).not.toContain("secret plan");
      expect(asText).not.toContain("סיכום");
    }
    // Another device with the passphrase reads it all back.
    const b = await joinVault("B", lab.again());
    await b.sync.sync();
    expect(b.files.text("פרויקטים/סיכום.md")).toBe("# סודי מאוד\n\nthe secret plan");
  }, 30_000);
});

describe("provider specifics", () => {
  it("webdav: a server without ETags is refused rather than synced unsafely", async () => {
    const server = fakeWebdav({ baseUrl: "https://dav.example/d/", preCreated: true });
    server.noEtags = true;
    const p = webdavProvider({ url: "https://dav.example/d/" }, { fetch: fakeFetch(server.handle) });
    await expect(p.probe()).rejects.toBeInstanceOf(ProviderUnsupportedError);
  });

  it("webdav: lists only the collection's files, names decoded", async () => {
    const server = fakeWebdav({ baseUrl: "https://dav.example/d/", preCreated: true });
    const p = webdavProvider({ url: "https://dav.example/d/" }, { fetch: fakeFetch(server.handle) });
    await p.put("abc_DEF-123", text("x"));
    await p.put(HEADER_NAME, text("h"));
    expect((await p.list()).sort()).toEqual(["abc_DEF-123", HEADER_NAME].sort());
    expect(server.log.some((l) => l.startsWith("PROPFIND /d/"))).toBe(true);
  });

  it("s3: paginated listing under the prefix, signed requests", async () => {
    const cfg = { endpoint: "https://s3.example", bucket: "b", accessKeyId: "AK", secretAccessKey: "SK", region: "us-east-1" };
    const server = fakeS3(cfg);
    server.pageSize = 2;
    const p = s3Provider({ ...cfg, prefix: "v" }, { fetch: fakeFetch(server.handle) });
    for (const n of ["n1", "n2", "n3", "n4", "n5"]) await p.put(n, text(n));
    server.objects.set("other/x", { data: text("x"), etag: '"o"' }); // outside the prefix
    expect((await p.list()).sort()).toEqual(["n1", "n2", "n3", "n4", "n5"]);
    expect(server.log.filter((l) => l.includes("list-type=2")).length).toBe(3);
  });

  it("dropbox: a stale rev is a conflict, never a 'conflicted copy'", async () => {
    const server = fakeDropbox({ token: "t" });
    await token("lumen.cloud.dropbox.token", "t");
    const p = dropboxSyncProvider({ folder: "/Apps/Lumen/vault" }, { fetch: fakeFetch(server.handle) });
    const { etag } = await p.put("m", text("1"));
    await p.put("m", text("2"), { ifMatch: etag });
    await expect(p.put("m", text("3"), { ifMatch: etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect([...server.files.keys()]).toEqual(["/apps/lumen/vault/m"]);
    server.pageSize = 1;
    await p.put("n", text("n"));
    expect((await p.list()).sort()).toEqual(["m", "n"]);
    __resetSecretStore();
  });

  it("gdrive: two devices creating the same object at once — exactly one wins", async () => {
    const server = fakeGdrive({ token: "t" });
    await token("lumen.cloud.gdrive.token", "t");
    await gdriveSyncProvider({}, { fetch: fakeFetch(server.handle) }).list(); // the vault folder exists
    // Hold both uploads until both devices have looked and found nothing.
    let waiting: Array<() => void> = [];
    const gated: typeof server.handle = async (req) => {
      if (req.method === "POST" && req.url.pathname === "/upload/drive/v3/files") {
        await new Promise<void>((go) => {
          waiting.push(go);
          if (waiting.length === 2) (waiting.forEach((w) => w()), (waiting = []));
        });
      }
      return server.handle(req);
    };
    const a = gdriveSyncProvider({}, { fetch: fakeFetch(gated) });
    const b = gdriveSyncProvider({}, { fetch: fakeFetch(gated) });
    const results = await Promise.allSettled([a.put("m", text("from a"), { ifNoneMatch: "*" }), b.put("m", text("from b"), { ifNoneMatch: "*" })]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(PreconditionFailedError);
    expect([...server.files.values()].filter((f) => f.name === "m")).toHaveLength(1);
    const winner = results.findIndex((r) => r.status === "fulfilled") === 0 ? "from a" : "from b";
    expect(utf8((await b.get("m"))!.data)).toBe(winner);
    __resetSecretStore();
  });

  it("gdrive: the vault folder is created once, and a stale metadata ETag is a 412", async () => {
    const server = fakeGdrive({ token: "t" });
    await token("lumen.cloud.gdrive.token", "t");
    const p = gdriveSyncProvider({}, { fetch: fakeFetch(server.handle) });
    const { etag } = await p.put("m", text("1"));
    await gdriveSyncProvider({}, { fetch: fakeFetch(server.handle) }).put("n", text("1"));
    expect([...server.files.values()].filter((f) => f.appProperties?.lumenVault === "true")).toHaveLength(1);
    await p.put("m", text("2"), { ifMatch: etag });
    await expect(p.put("m", text("3"), { ifMatch: etag })).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(utf8((await p.get("m"))!.data)).toBe("2");
    __resetSecretStore();
  });
});

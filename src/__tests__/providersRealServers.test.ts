/**
 * The storage providers against real servers (plan W6.27; E31, RR-7, RR-8).
 *
 * syncProviders.test.ts runs the providers against fake servers written for
 * the tests. This file runs the same providers against real WebDAV and S3
 * servers, and against Dropbox and Google Drive with a real token, and
 * records what each one does with conditional writes:
 *
 *   C1 create-only on a new name succeeds
 *   C2 create-only on an existing name is refused (412)
 *   C3 If-Match with the current ETag succeeds and gives a new ETag
 *   C4 If-Match with a stale ETag is refused and leaves the object as it was
 *   C5 racing create-only writes on one name: exactly one wins, and the object is the winner's
 *   C6 racing If-Match writes from one ETag: exactly one wins, and the object is the winner's
 *   C7 read-back: the bytes and the ETag `get` returns are the ones `put` wrote and returned
 *   C8 list and delete
 *   P1 the provider's connect-time probe (`probe()`)
 *   P2 the engine's probe before a key change (`proveCas`)
 *   T8 the RR-8 race: A revokes the phone while B re-keys from the same keyring
 *
 * The assertion is that the probes agree with the server: a server the
 * probes accept must pass every C case and T8 (B's stale keyring write is
 * refused, the revoked phone gets no new secret); a server the probes refuse
 * must fail at least one C case (the refusal is not spurious), and a key
 * change on it must be refused with `CasUnsupportedError`.
 *
 * It runs only when LUMEN_REAL_SERVERS names a JSON file of servers (see
 * docs/.../sync-real-servers.md and scripts/real-servers/). Without it the
 * suite is skipped: there is no server to talk to. With
 * LUMEN_REAL_SERVERS_OUT it also writes the result table as JSON.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";
import { CasUnsupportedError, PreconditionFailedError, proveCas, type PutCondition, type StoredObject, type SyncProvider } from "../sync/e2ee/provider";
import { ProviderUnsupportedError } from "../sync/e2ee/providers/http";
import { webdavProvider } from "../sync/e2ee/providers/webdav";
import { s3Provider } from "../sync/e2ee/providers/s3";
import { dropboxSyncProvider } from "../sync/e2ee/providers/dropbox";
import { gdriveSyncProvider } from "../sync/e2ee/providers/gdrive";
import { KEYRING_NAME } from "../sync/e2ee/keyring";
import { ageDecrypt, generateIdentity } from "../sync/e2ee/age";
import { fromB64u, fromUtf8, randomBytes, toB64u } from "../sync/e2ee/bytes";
import { unlockVault, unlockWithDevice, E2eeSync } from "../sync/e2ee/engine";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { setSecret } from "../lib/secretStore";
import { device, newVault, pairConfirmed, PASSPHRASE, TEST_POLICY } from "./helpers/e2ee";

type ServerConfig =
  | { name: string; kind: "webdav"; url: string; username?: string; password?: string }
  | { name: string; kind: "s3"; endpoint: string; region: string; bucket: string; prefix?: string; accessKeyId: string; secretAccessKey: string; pathStyle?: boolean }
  | { name: string; kind: "dropbox"; folder?: string; tokenEnv: string }
  | { name: string; kind: "gdrive"; folderName?: string; tokenEnv: string };

const configPath = process.env.LUMEN_REAL_SERVERS;
const outPath = process.env.LUMEN_REAL_SERVERS_OUT;
const servers: ServerConfig[] = configPath ? (JSON.parse(readFileSync(configPath, "utf8")) as { servers: ServerConfig[] }).servers : [];
/** Rounds of each race (C5, C6) and writers per round. */
const ROUNDS = Number(process.env.LUMEN_REAL_SERVERS_ROUNDS ?? 10);
const WRITERS = 4;
/** How often the connect-time probe runs on each server (it is timing-dependent on some). */
const PROBES = Number(process.env.LUMEN_REAL_SERVERS_PROBES ?? 20);

type Outcome = { ok: boolean; detail: string };
const table: Record<string, Record<string, Outcome>> = {};

const run = toB64u(randomBytes(6)).replace(/[^A-Za-z0-9]/g, "x");

/** A new provider object on a fresh folder or prefix of `cfg` (another device when called again with the same `slot`). */
async function connect(cfg: ServerConfig, slot: string): Promise<SyncProvider & { probe(): Promise<void> }> {
  switch (cfg.kind) {
    case "webdav": {
      const url = `${cfg.url.replace(/\/+$/, "")}/lumen-real-${run}-${slot}/`;
      return webdavProvider({ url, username: cfg.username, password: cfg.password });
    }
    case "s3":
      return s3Provider({ ...cfg, prefix: `${(cfg.prefix ?? "").replace(/\/+$/, "")}${cfg.prefix ? "/" : ""}lumen-real-${run}-${slot}` });
    case "dropbox": {
      await setSecret("lumen.cloud.dropbox.token", JSON.stringify({ access: process.env[cfg.tokenEnv] ?? "", expiresAt: Date.now() + 3_600_000 }));
      return dropboxSyncProvider({ folder: `${(cfg.folder ?? "/Apps/Lumen").replace(/\/+$/, "")}/lumen-real-${run}-${slot}` });
    }
    case "gdrive": {
      await setSecret("lumen.cloud.gdrive.token", JSON.stringify({ access: process.env[cfg.tokenEnv] ?? "", expiresAt: Date.now() + 3_600_000 }));
      return gdriveSyncProvider({ folderName: `${cfg.folderName ?? "Lumen Vault"} real ${run} ${slot}` });
    }
  }
}

const bytes = (tag: string): Uint8Array => {
  const r = randomBytes(285);
  r[0] = 1;
  const t = new TextEncoder().encode(tag);
  r.set(t.slice(0, 32), 1);
  return r;
};
const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const objName = () => toB64u(randomBytes(32));

async function refused(p: SyncProvider, name: string, data: Uint8Array, cond: PutCondition): Promise<boolean> {
  try {
    await p.put(name, data, cond);
    return false;
  } catch (e) {
    if (e instanceof PreconditionFailedError) return true;
    throw e;
  }
}

/** Run `n` conditional writes on `name` at once; the indexes that won. */
async function raceWrites(p: SyncProvider, name: string, datas: Uint8Array[], cond: PutCondition): Promise<number[]> {
  const res = await Promise.all(datas.map((d) => p.put(name, d, cond).then(() => true, (e) => (e instanceof PreconditionFailedError ? false : Promise.reject(e)))));
  return res.flatMap((won, i) => (won ? [i] : []));
}

/** The conformance cases on the raw provider. Each outcome is recorded; none throws. */
async function conformance(p: SyncProvider): Promise<Record<string, Outcome>> {
  const out: Record<string, Outcome> = {};
  const step = async (id: string, f: () => Promise<string | null>) => {
    try {
      const bad = await f();
      out[id] = bad ? { ok: false, detail: bad } : { ok: true, detail: "" };
    } catch (e) {
      out[id] = { ok: false, detail: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 200) };
    }
  };
  const name = objName();
  let first: { etag: string } | null = null;
  let second: { etag: string } | null = null;
  const v2 = bytes("v2");
  try {
    await step("C1", async () => {
      first = await p.put(name, bytes("v1"), { ifNoneMatch: "*" });
      return first.etag ? null : "no ETag returned";
    });
    await step("C2", async () => ((await refused(p, name, bytes("again"), { ifNoneMatch: "*" })) ? null : "a second create-only write was accepted"));
    await step("C3", async () => {
      if (!first) return "skipped: C1 failed";
      try {
        second = await p.put(name, v2, { ifMatch: first.etag });
      } catch (e) {
        if (e instanceof PreconditionFailedError) return "If-Match with the current ETag was refused";
        throw e;
      }
      return second.etag !== first.etag ? null : "the ETag did not change";
    });
    await step("C4", async () => {
      if (!first || !second) return "skipped: C3 failed";
      const wasRefused = await refused(p, name, bytes("stale"), { ifMatch: first.etag });
      const now = await p.get(name);
      const unchanged = !!now && same(now.data, v2);
      if (!wasRefused) return `If-Match with a stale ETag was accepted${unchanged ? "" : " and overwrote the object"}`;
      return unchanged ? null : "refused, but the object changed";
    });
    await step("C5", async () => {
      const bad: string[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const n = objName();
        const datas = Array.from({ length: WRITERS }, (_, i) => bytes(`c5-${r}-${i}`));
        const wins = await raceWrites(p, n, datas, { ifNoneMatch: "*" });
        const now = await p.get(n);
        if (wins.length !== 1) bad.push(`round ${r + 1}: ${wins.length} of ${WRITERS} won`);
        else if (!now || !same(now.data, datas[wins[0]])) bad.push(`round ${r + 1}: the object is not the winner's`);
        await p.delete(n).catch(() => undefined);
      }
      return bad.length ? `${bad.length}/${ROUNDS} rounds wrong (${bad.slice(0, 2).join("; ")})` : null;
    });
    await step("C6", async () => {
      const bad: string[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        const base = await p.get(name);
        if (!base) return "the object is gone";
        const datas = Array.from({ length: WRITERS }, (_, i) => bytes(`c6-${r}-${i}`));
        const wins = await raceWrites(p, name, datas, { ifMatch: base.etag });
        const now = await p.get(name);
        if (wins.length !== 1) bad.push(`round ${r + 1}: ${wins.length} of ${WRITERS} won`);
        else if (!now || !same(now.data, datas[wins[0]])) bad.push(`round ${r + 1}: the object is not the winner's`);
      }
      return bad.length ? `${bad.length}/${ROUNDS} rounds wrong (${bad.slice(0, 2).join("; ")})` : null;
    });
    await step("C7", async () => {
      const d = bytes("c7");
      const cur = await p.get(name);
      const w = await p.put(name, d, cur ? { ifMatch: cur.etag } : { ifNoneMatch: "*" });
      const back = await p.get(name);
      if (!back) return "nothing read back";
      if (!same(back.data, d)) return "the bytes read back differ";
      return back.etag === w.etag ? null : `the ETag read back (${back.etag}) is not the one put returned (${w.etag})`;
    });
    await step("C8", async () => {
      const listed = await p.list();
      if (!listed.includes(name)) return "list() misses the object";
      await p.delete(name);
      await p.delete(name);
      if (await p.get(name)) return "the object is still there after delete";
      return (await p.list()).includes(name) ? "list() still shows the deleted object" : null;
    });
  } finally {
    await p.delete(name).catch(() => undefined);
  }
  return out;
}

/**
 * WebDAV only: what the server itself answers, without the provider in
 * between: a second `If-None-Match: *` PUT and a PUT with an `If-Match` that
 * names no version. 412 for both is right.
 */
async function rawWebdav(cfg: ServerConfig): Promise<Outcome | null> {
  if (cfg.kind !== "webdav") return null;
  const url = `${cfg.url.replace(/\/+$/, "")}/lumen-real-${run}-c/${objName()}`;
  const auth: Record<string, string> = cfg.username ? { Authorization: `Basic ${btoa(`${cfg.username}:${cfg.password ?? ""}`)}` } : {};
  const put = async (h: Record<string, string>) => (await fetch(url, { method: "PUT", headers: { ...auth, ...h }, body: bytes("raw") as BodyInit })).status;
  const created = await put({});
  const again = await put({ "If-None-Match": "*" });
  const stale = await put({ "If-Match": '"lumen-no-such-version"' });
  const etag = (await fetch(url, { method: "HEAD", headers: auth })).headers.get("ETag");
  await fetch(url, { method: "DELETE", headers: auth }).catch(() => undefined);
  const detail = `PUT ${created}; If-None-Match:* on it ${again}; If-Match:<unknown> ${stale}; ETag on HEAD ${etag ? "yes" : "no"}`;
  return { ok: again === 412 && stale === 412, detail };
}

/** A provider with hooks around `put` (the t8 harness's gates). */
function hooked(base: SyncProvider, before: (name: string) => Promise<void> | void, after: (name: string) => Promise<void> | void = () => undefined): SyncProvider {
  return {
    id: base.id,
    atomicCreate: base.atomicCreate,
    get: (n) => base.get(n),
    delete: (n) => base.delete(n),
    list: () => base.list(),
    async put(n, d, c) {
      await before(n);
      const r = await base.put(n, d, c);
      await after(n);
      return r;
    },
  };
}

function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { open, wait: () => p };
}

async function wrapFor(p: SyncProvider, id: string, identity: string): Promise<Uint8Array | null> {
  const o: StoredObject | null = await p.get(KEYRING_NAME);
  if (!o) return null;
  const ring = JSON.parse(fromUtf8(o.data)) as { devices: Record<string, { wrap: string }> };
  if (!ring.devices[id]) return null;
  return ageDecrypt(fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

const ringEpoch = async (p: SyncProvider) => {
  const o = await p.get(KEYRING_NAME);
  return o ? (JSON.parse(fromUtf8(o.data)) as { epoch: number }).epoch : null;
};

/**
 * T8 (RR-8) on a real server: B is held just before its keyring write until
 * A's revocation of the phone has landed; B's write then carries a stale
 * If-Match. On a server that keeps CAS, B is refused and the phone gets no
 * wrap of the new epoch. On one the probe refuses, both re-keys are refused.
 */
async function t8(cfg: ServerConfig, supported: boolean): Promise<Outcome> {
  const fail = (detail: string): Outcome => ({ ok: false, detail });
  const p = await connect(cfg, "t8");
  // The probe creates the folder (WebDAV MKCOL). On a refused server it throws
  // after that; the engine is then tested on its own (proveCas below).
  await p.probe().catch(() => undefined);
  const phone = await generateIdentity();
  const laptop = await generateIdentity();
  if (!supported) {
    let a: Awaited<ReturnType<typeof newVault>>;
    try {
      a = await newVault(p);
      a.files.set("a.md", "hello");
      await a.sync.sync();
    } catch (e) {
      // A server without ETags can't even hold a vault: no key change either.
      if (e instanceof ProviderUnsupportedError) return { ok: true, detail: `${REFUSED}: no vault at all (${e.message.slice(0, 80)})` };
      throw e;
    }
    const r = await a.sync.rekey({ enroll: { phone: phone.recipient } }).then(() => null, (e: unknown) => e);
    if (!(r instanceof CasUnsupportedError)) return fail(`a key change was not refused: ${r ? (r as Error).name : "it succeeded"}`);
    const epoch = await ringEpoch(p);
    return epoch === null || epoch === 0 ? { ok: true, detail: `${REFUSED} (CasUnsupportedError)` } : fail(`the keyring moved to epoch ${epoch}`);
  }
  const a = await newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  const { keys: phoneKeys } = await unlockWithDevice(await connect(cfg, "t8"), "phone", phone.identity);
  const phoneFiles = memoryFiles();
  await new E2eeSync({ provider: await connect(cfg, "t8"), keys: phoneKeys, local: phoneFiles, store: memoryStateStore(), access: { device: "phone", identity: phone.identity } }).sync();
  await a.sync.sync();

  const bReached = gate();
  const aDone = gate();
  const pb = hooked(await connect(cfg, "t8"), async (n) => {
    if (n === KEYRING_NAME) {
      bReached.open();
      await aDone.wait();
    }
  });
  const { keys: bKeys } = await unlockVault(pb, PASSPHRASE, TEST_POLICY);
  const b = device("B", pb, bKeys);
  await b.sync.sync();
  await pairConfirmed(b, a, await a.sync.pairingCode()); // W8.5
  const bRun: { p: Promise<unknown> | null } = { p: null };
  let fired = false;
  const pa = hooked(
    await connect(cfg, "t8"),
    async (n) => {
      if (!fired && n === KEYRING_NAME) {
        fired = true;
        // B may be refused before its keyring write (it sees A's freeze, review 5 Q2):
        // that ends the race too.
        bRun.p = b.sync.rekey({ enroll: { laptop: laptop.recipient } }).then((r) => r, (e: unknown) => e).finally(() => bReached.open());
        await bReached.wait();
      }
    },
    (n) => {
      if (n === KEYRING_NAME) aDone.open();
    },
  );
  const a2 = device("A2", pa, a.sync.keys());
  await a2.sync.sync();
  await pairConfirmed(a2, a, await a.sync.pairingCode()); // W8.5
  const ra = await a2.sync.rekey({ revoke: ["phone"] }).then((r) => r, (e: unknown) => e);
  if (!fired) aDone.open();
  const rb: unknown = bRun.p ? await bRun.p : null;
  const problems: string[] = [];
  if (ra instanceof Error) problems.push(`A's revocation failed: ${ra.name}`);
  if (!fired) problems.push("the race never happened");
  if (!(rb instanceof Error)) problems.push("B's stale re-key was accepted");
  if (await wrapFor(p, "phone", phone.identity)) problems.push("the revoked phone opens the new epoch");
  a2.files.set("after.md", "after revoking the phone");
  const next = await a2.sync.sync().then(() => null, (e: unknown) => e);
  if (next) problems.push(`A's next round failed: ${(next as Error).name}`);
  if (await wrapFor(p, "phone", phone.identity)) problems.push("the phone has a wrap after A's next round");
  return problems.length ? fail(problems.join("; ")) : { ok: true, detail: ACCEPTED };
}

const ACCEPTED = "B refused, the phone gets nothing";
const REFUSED = "key change refused";

const suite = servers.length ? describe : describe.skip;

// Skipped without LUMEN_REAL_SERVERS: these need running servers (scripts/real-servers/), W6.27.
suite("sync providers against real servers (W6.27)", () => {
  afterAll(() => {
    if (outPath) writeFileSync(outPath, JSON.stringify({ run, rounds: ROUNDS, writers: WRITERS, at: new Date().toISOString(), table }, null, 2));
  });

  for (const cfg of servers) {
    it(`${cfg.name} (${cfg.kind}): the probes agree with what the server does`, async () => {
      const row: Record<string, Outcome> = (table[cfg.name] = {});
      const raw = await connect(cfg, "c");
      // The folder / bucket prefix exists before the raw cases (MKCOL for WebDAV).
      const probe = await raw.probe().then(
        () => ({ ok: true, detail: "" }),
        (e: unknown) => ({ ok: false, detail: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 240) }),
      );
      row.P1 = probe;
      Object.assign(row, await conformance(await connect(cfg, "c")));
      const raw412 = await rawWebdav(cfg);
      if (raw412) row.R = raw412;
      // The probe again, PROBES times: on a server whose ETag is the file's
      // mtime in seconds, it passes whenever its writes straddle a second.
      let accepted = 0;
      let proved = 0;
      const why = new Map<string, number>();
      const note = (e: unknown) => {
        const k = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 120);
        why.set(k, (why.get(k) ?? 0) + 1);
        return false;
      };
      for (let i = 0; i < PROBES; i++) {
        if (await (await connect(cfg, "c")).probe().then(() => true, note)) accepted++;
        if (await proveCas(await connect(cfg, "c")).then(() => true, note)) proved++;
      }
      const steady = (n: number) => n === 0 || n === PROBES;
      const reasons = [...why].map(([k, n]) => `${n}× ${k}`).join("; ");
      row.PN = { ok: steady(accepted) && steady(proved), detail: `probe accepted ${accepted}/${PROBES}, proveCas ${proved}/${PROBES}${steady(accepted) && steady(proved) ? "" : ` (${reasons})`}` };
      row.P2 = await proveCas(await connect(cfg, "c")).then(
        () => ({ ok: true, detail: "" }),
        (e: unknown) => ({ ok: false, detail: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 240) }),
      );
      const supported = row.P1.ok && row.P2.ok;
      row.T8 = await t8(cfg, supported).catch((e: unknown) => ({ ok: false, detail: `${(e as Error).name}: ${(e as Error).message}`.slice(0, 240) }));

      const cases = ["C1", "C2", "C3", "C4", "C5", "C6", "C7"];
      const failing = cases.filter((c) => !row[c].ok);
      expect(row.PN.ok, `${cfg.name}: the probe's answer depends on timing (${row.PN.detail})`).toBe(true);
      if (supported) {
        expect(failing, `${cfg.name}: the probes accept it, but these cases fail`).toEqual([]);
      } else {
        expect(failing.length, `${cfg.name}: the probes refuse it, but every case passes (a spurious refusal)`).toBeGreaterThan(0);
      }
      expect(row.T8.ok, row.T8.detail).toBe(true);
      expect(row.T8.detail.startsWith(supported ? ACCEPTED : REFUSED), row.T8.detail).toBe(true);
    }, 600_000);
  }
});

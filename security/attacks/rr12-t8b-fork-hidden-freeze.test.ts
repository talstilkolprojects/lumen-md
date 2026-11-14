/**
 * W10.D8 (plan W6.3, W1.7): t8's forking variant — a storage that does not
 * keep conditional writes (Google Drive, whose If-Match the engine relies on
 * for the manifest, or a malicious one) and also hides one device's writes
 * from another.
 *
 * t8 (rr12-t8-cas-fork.test.ts) is a provider that passes the CAS probe and
 * then ignores If-Match on the keyring. Since review 16 its "lie" case no
 * longer forks: B's re-key re-reads the manifest, sees A's freeze and is
 * refused. This file is what t8 left open: the storage serves B the objects
 * as they were before A wrote them, and accepts B's writes over A's.
 *
 *   1. The vault itself (a Drive-like storage: no atomic create, and an
 *      If-Match it does not keep). A writes x.md; B is shown the manifest
 *      from before and writes y.md over A's. The two manifests have the same
 *      counter and different digests: A's next rounds must see the fork by
 *      the counter and the hash chain, stop, and write nothing at all, with
 *      the user told in Hebrew (and English). The same for an older manifest
 *      served back to A (a rollback).
 *   2. The keyring. A revokes the phone; B, shown the manifest without A's
 *      freeze, re-keys at the same time, and its keyring (which still wraps
 *      the phone) is the one left. A's next round must be a loud
 *      KeyringForkError, revoke the phone again on top (fifth review F2: the
 *      one write that takes the phone's access away), and write no content
 *      in that round.
 *
 * Every assertion is the secure outcome: a failure means the attack worked.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { P, K, E, M, AGE, H, B, hooked, gate, wrapFor, pairVia, enrolled } from "./common";
import { e2eeErrorText } from "../../src/sync/e2ee/ui/errorText";
import { t } from "../../src/i18n";

type Obj = { data: Uint8Array; etag: string };
type Provider = { put: (...a: any[]) => Promise<any>; delete: (...a: any[]) => Promise<any> };

/** Count every write (put or delete) `x` makes from now on. */
function countWrites(x: Provider) {
  const log: string[] = [];
  const put = x.put.bind(x);
  const del = x.delete.bind(x);
  x.put = async (...args: unknown[]) => {
    log.push(`put ${String(args[0])}`);
    return put(...args);
  };
  x.delete = async (...args: unknown[]) => {
    log.push(`delete ${String(args[0])}`);
    return del(...args);
  };
  return log;
}

const he = JSON.parse(readFileSync(join(__dirname, "..", "..", "src/i18n/locales/he/common.json"), "utf8")) as Record<string, string>;
const HEBREW = /[֐-׿]/;

/**
 * A view of `p` that, while `hide()` is on, shows each object as it was when
 * `freeze()` was called, until this view writes it, and drops the condition
 * on its writes to those objects. Every other object keeps its conditions,
 * so the CAS probe (random names) still passes.
 */
function staleView(p: ReturnType<typeof P.memoryProvider>, opts: { atomicCreate?: boolean; before?: (op: string, name: string) => Promise<void> | void } = {}) {
  const shown = new Map<string, Obj>();
  const wrote = new Set<string>();
  let on = false;
  const base = hooked(p, { before: opts.before });
  const view = {
    ...base,
    ...(opts.atomicCreate === false ? { atomicCreate: false } : {}),
    async get(name: string) {
      const s = on && !wrote.has(name) ? shown.get(name) : undefined;
      return s ? { data: s.data.slice(), etag: s.etag } : base.get(name);
    },
    async put(name: string, data: Uint8Array, cond?: unknown) {
      const drop = on && (shown.has(name) || name === K.KEYRING_NAME);
      if (on) wrote.add(name);
      return base.put(name, data, drop ? undefined : (cond as never));
    },
  };
  return {
    view,
    freeze() {
      shown.clear();
      for (const [k, v] of p.objects) shown.set(k, { data: v.data.slice(), etag: v.etag });
    },
    hide(v: boolean) {
      on = v;
      if (!v) wrote.clear();
    },
  };
}

async function manifestFork(kind: "fork" | "fork-ahead" | "older") {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const sb = staleView(p, { atomicCreate: false });
  const b = H.device("B", sb.view as never, a.sync.keys());
  await b.sync.sync();
  await pairVia(b, a, p);
  await a.sync.sync();
  await b.sync.sync();
  sb.freeze();

  a.files.set("x.md", "A's write");
  await a.sync.sync();
  if (kind !== "older") {
    // B is shown the manifest from before A's write, and its write replaces A's.
    sb.hide(true);
    b.files.set("y.md", "B's write");
    await b.sync.sync();
    if (kind === "fork-ahead") {
      // …and B writes again on top of its own: the counter is now ahead of A's.
      b.files.set("z.md", "B again");
      await b.sync.sync();
    }
    sb.hide(false);
  } else {
    // The storage serves A's own manifest from before its last write: a rollback.
    const name = await M.manifestName(a.sync.keys());
    sb.hide(true); // the snapshot, taken before A's write, is what is replayed
    const old = (await sb.view.get(name))!;
    sb.hide(false);
    p.objects.set(name, { data: old.data.slice(), etag: "replayed" });
  }
  const remoteName = await M.manifestName(a.sync.keys());
  const remoteBefore = p.objects.get(remoteName)!.data.slice();

  // A keeps working: a new note, then three rounds.
  const writes = countWrites(p as unknown as Provider);
  a.files.set("after.md", "A's change after the fork");
  const errors: unknown[] = [];
  for (let i = 0; i < 3; i++) errors.push(await a.sync.sync().then(() => null, (e) => e));
  const remoteAfter = p.objects.get(remoteName)!.data;
  return { errors, writes, remoteUnchanged: B.toB64u(remoteBefore) === B.toB64u(remoteAfter), localX: await a.files.read("x.md").catch(() => null) };
}

async function keyringForkWithHiddenFreeze() {
  const p = P.memoryProvider();
  const a = await H.newVault(p);
  a.files.set("a.md", "hello");
  await a.sync.sync();
  const phone = await AGE.generateIdentity();
  const laptop = await AGE.generateIdentity();
  await a.sync.rekey({ enroll: { phone: phone.recipient } });
  const lost = await enrolled(p, "phone", phone.identity);
  await lost.sync.sync();
  await a.sync.sync();

  let armed = false;
  const bReached = gate();
  const aDone = gate();
  let bPromise: Promise<unknown> | null = null;
  const sb = staleView(p, {
    async before(op, name) {
      if (armed && op === "put" && name === K.KEYRING_NAME) {
        bReached.open();
        await aDone.wait();
      }
    },
  });
  const { keys: bKeys } = await E.unlockVault(p, H.PASSPHRASE, H.TEST_POLICY);
  const bDev = H.device("B", sb.view as never, bKeys);
  await bDev.sync.sync();
  await pairVia(bDev, a, p);

  // A's view is the real store; only its keyring write loses its condition.
  let fired = false;
  const paBase = hooked(p, {
    async before(op, name) {
      if (armed && !fired && op === "put" && name === K.KEYRING_NAME) {
        fired = true;
        // A has written its freeze; B is shown the store from before it.
        sb.hide(true);
        bPromise = bDev.sync.rekey({ enroll: { laptop: laptop.recipient } }).then((r) => r, (e) => e);
        await Promise.race([bReached.wait(), bPromise]);
      }
    },
    async after(op, name) {
      if (armed && op === "put" && name === K.KEYRING_NAME) aDone.open();
    },
  });
  const pa = { ...paBase, put: (name: string, data: Uint8Array, cond?: unknown) => paBase.put(name, data, armed && name === K.KEYRING_NAME ? undefined : (cond as never)) };
  const aDev = H.device("A2", pa as never, a.sync.keys());
  await aDev.sync.sync();
  await pairVia(aDev, a, p);
  sb.freeze();
  armed = true;
  const ra = await aDev.sync.rekey({ revoke: ["phone"] }).then((r) => r, (e) => e);
  if (!fired) aDone.open();
  const rb = bPromise ? await bPromise : null;
  armed = false;
  sb.hide(false);
  const phoneAfterRace = await wrapFor(p, "phone", phone.identity);

  const writes = countWrites(pa as unknown as Provider);
  aDev.files.set("after.md", "after revoking the phone");
  const err = await aDev.sync.sync().then(() => null, (e) => e);
  const detectRound = [...writes];
  const keysNow = aDev.sync.keys();
  const name = await M.manifestName(keysNow);
  const { manifest } = await M.openManifest(keysNow, p.objects.get(name)!.data, name);
  return { ra, rb, phoneAfterRace, err, detectRound, filesAfterDetect: Object.keys(manifest.files), phoneAtEnd: await wrapFor(p, "phone", phone.identity), ring: JSON.parse(B.fromUtf8(p.objects.get(K.KEYRING_NAME)!.data)) };
}

describe("W10.D8: t8 with one device's writes hidden from the other (no kept If-Match)", () => {
  it("the vault forks (same counter, other digest): A stops on every round, writes nothing, keeps its notes, and says so in Hebrew", async () => {
    const r = await manifestFork("fork");
    console.log("  manifest fork: A rounds", r.errors.map((e) => (e ? `${(e as Error).name}(${(e as { kind?: string }).kind})` : "ok")).join(", "), "| writes", r.writes.length);
    expect(r.errors).toHaveLength(3);
    for (const e of r.errors) {
      expect((e as Error)?.name).toBe("RollbackError");
      expect((e as { kind?: string }).kind).toBe("fork");
    }
    expect(r.writes).toEqual([]);
    expect(r.remoteUnchanged).toBe(true);
    expect(r.localX).not.toBeNull();
    // What the user reads: the fork in words, not a generic error.
    expect(e2eeErrorText(r.errors[0])).toBe(t("e2ee.rollback.fork"));
    expect(he["e2ee.rollback.fork"]).toMatch(HEBREW);
    expect(he["e2ee.rollback.fork"]).toContain("לא כתב דבר");
  });

  it("the fork is ahead of A (B wrote twice): the hash chain doesn't hold A's manifest, so A stops the same way", async () => {
    const r = await manifestFork("fork-ahead");
    console.log("  manifest fork ahead: A rounds", r.errors.map((e) => (e ? `${(e as Error).name}(${(e as { kind?: string }).kind})` : "ok")).join(", "), "| writes", r.writes.length);
    for (const e of r.errors) expect((e as Error)?.name).toBe("RollbackError");
    expect(r.writes).toEqual([]);
    expect(r.remoteUnchanged).toBe(true);
  });

  it("an older manifest served back (a rollback): A stops on every round and writes nothing", async () => {
    const r = await manifestFork("older");
    console.log("  manifest rollback: A rounds", r.errors.map((e) => (e ? `${(e as Error).name}(${(e as { kind?: string }).kind})` : "ok")).join(", "), "| writes", r.writes.length);
    for (const e of r.errors) expect((e as { kind?: string }).kind).toBe("older");
    expect(r.writes).toEqual([]);
    expect(e2eeErrorText(r.errors[0])).toBe(t("e2ee.rollback.older"));
    expect(he["e2ee.rollback.older"]).toMatch(HEBREW);
    expect(e2eeErrorText(new K.KeyringRollbackError(3, 2))).toBe(t("e2ee.rollback.keyring"));
    expect(he["e2ee.rollback.keyring"]).toMatch(HEBREW);
  });

  it("the keyring forks with the freeze hidden: both re-keys commit and the phone is back — A's next round is a loud fork that revokes it again, and writes no content", async () => {
    const r = await keyringForkWithHiddenFreeze();
    console.log("  keyring fork: A", (r.ra as any)?.devices ?? (r.ra as Error)?.name, "confirmed", (r.ra as any)?.confirmed, "| B", (r.rb as any)?.devices ?? (r.rb as Error)?.name, "| A next:", (r.err as Error)?.name, (r.err as any)?.revocationReapplied, "| detect-round writes", r.detectRound.length, "| ring", r.ring.epoch, Object.keys(r.ring.devices));
    // The setup really forks: both commit, and the keyring left wraps the revoked phone.
    expect(r.ra).not.toBeInstanceOf(Error);
    expect((r.ra as { confirmed?: boolean }).confirmed).toBe(false);
    expect(r.rb).not.toBeInstanceOf(Error);
    expect(r.phoneAfterRace).not.toBeNull();
    // Detected, loud, and the phone is out again.
    expect(r.err).toBeInstanceOf(K.KeyringForkError);
    expect((r.err as InstanceType<typeof K.KeyringForkError>).revocationReapplied).toEqual(["phone"]);
    expect(r.phoneAtEnd).toBeNull();
    expect(Object.keys(r.ring.devices)).not.toContain("phone");
    // The detecting round writes only the re-key (keyring and manifests), no content.
    expect(r.filesAfterDetect).not.toContain("after.md");
    expect(r.detectRound.filter((w) => w.startsWith("delete"))).toEqual([]);
    expect(e2eeErrorText(r.err)).toBe(t("e2ee.fork.reapplied"));
    expect(he["e2ee.fork.reapplied"]).toMatch(HEBREW);
  });
});

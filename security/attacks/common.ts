/**
 * Attack tests (plan W6.3/W6.4, W10.D6): shared helpers.
 *
 * Moved into the repo from the crypto re-reviews of 12.11 (rr7: the seventh
 * review's suites; rr12: the re-review's t1-t8), where they imported the
 * worktree under review by absolute path. Here they import the code of this
 * checkout. Every test asserts the secure outcome: a FAIL means the attack
 * worked.
 */
import * as P from "../../src/sync/e2ee/provider";
import * as E from "../../src/sync/e2ee/engine";
import * as K from "../../src/sync/e2ee/keyring";
import * as M from "../../src/sync/e2ee/manifest";
import * as B from "../../src/sync/e2ee/bytes";
import * as AGE from "../../src/sync/e2ee/age";
import * as H from "../../src/__tests__/helpers/e2ee";
import * as LF from "../../src/sync/e2ee/localFiles";
import * as ST from "../../src/sync/e2ee/state";
import * as HDR from "../../src/sync/e2ee/header";
import * as PR from "../../src/sync/e2ee/pairing";
import * as KEYS from "../../src/sync/e2ee/keys";

export { P, E, K, M, B, AGE, H, LF, ST, HDR, PR, KEYS };


/** The plaintext keyring JSON as the provider sees it. */
export function ringJson(p: { objects: Map<string, { data: Uint8Array; etag: string }> }) {
  return JSON.parse(B.fromUtf8(p.objects.get(K.KEYRING_NAME)!.data));
}

/** Snapshot / restore every object (a provider replaying an earlier state). */
export function snap(p: { objects: Map<string, { data: Uint8Array; etag: string }> }) {
  return new Map([...p.objects].map(([k, v]) => [k, { data: v.data.slice(), etag: v.etag }]));
}
export function restore(p: { objects: Map<string, { data: Uint8Array; etag: string }> }, s: Map<string, { data: Uint8Array; etag: string }>, names?: string[]) {
  if (!names) {
    p.objects.clear();
    for (const [k, v] of s) p.objects.set(k, { data: v.data.slice(), etag: v.etag });
    return;
  }
  for (const n of names) {
    const v = s.get(n);
    if (v) p.objects.set(n, { data: v.data.slice(), etag: v.etag });
    else p.objects.delete(n);
  }
}

/** Can `identity` open `id`'s wrap in the provider's current keyring? Returns the secret or null. */
export async function wrapFor(p: { objects: Map<string, { data: Uint8Array; etag: string }> }, id: string, identity: string): Promise<Uint8Array | null> {
  const ring = ringJson(p);
  if (!ring.devices[id]) return null;
  return AGE.ageDecrypt(B.fromB64u(ring.devices[id].wrap), [{ identity }]).catch(() => null);
}

/** With a stolen epoch secret, open the current manifest and return its file list. */
export async function readWithSecret(p: { objects: Map<string, { data: Uint8Array; etag: string }> }, secret: Uint8Array) {
  const ring = ringJson(p);
  const keys = await K.keysFromKeyring(ring, secret, { header: null as never, wrap: null });
  const name = await M.manifestName(keys);
  const { manifest } = await M.openManifest(keys, p.objects.get(name)!.data, name);
  return Object.keys(manifest.files);
}


/**
 * A provider wrapper over a shared object map, with async hooks around
 * every operation (the malicious / slow provider of the tests). `ignoreCas`
 * makes it accept every conditional write (a server that ignores If-Match).
 */
export function hooked(base: ReturnType<typeof P.memoryProvider>, opts: { ignoreCas?: boolean; before?: (op: string, name: string) => Promise<void> | void; after?: (op: string, name: string) => Promise<void> | void } = {}) {
  return {
    id: "hooked",
    objects: base.objects,
    async get(name: string) {
      await opts.before?.("get", name);
      const r = await base.get(name);
      await opts.after?.("get", name);
      return r;
    },
    async put(name: string, data: Uint8Array, cond?: unknown) {
      await opts.before?.("put", name);
      const r = await base.put(name, data, opts.ignoreCas ? undefined : (cond as never));
      await opts.after?.("put", name);
      return r;
    },
    async delete(name: string) {
      await opts.before?.("delete", name);
      await base.delete(name);
      await opts.after?.("delete", name);
    },
    list: () => base.list(),
  };
}

/** A promise you resolve from outside. */
export function gate() {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { wait: () => p, open };
}




/** A device that opens with its own age key (optionally with a saved state store). */
export async function enrolled(provider: unknown, name: string, identity: string, store = ST.memoryStateStore(), now?: () => number) {
  const { keys } = await E.unlockWithDevice(provider, name, identity, store.state);
  const files = LF.memoryFiles();
  return { files, store, keys, sync: new E.E2eeSync({ provider, keys, local: files, store, access: { device: name, identity }, ...(now ? { now } : {}) }) };
}

/** A vault whose creator device runs on `now`. */
export async function newVaultAt(p: unknown, now: () => number) {
  const { keys, anchor } = await E.createVault(p, H.PASSPHRASE, { pbkdf2Iterations: H.TEST_ITERATIONS });
  const d = H.device("A", p, keys, undefined, now);
  await d.sync.markCreated(anchor);
  return d;
}

/**
 * A holder of the current epoch's secret (the device about to be revoked)
 * writes a frozen successor of the live manifest, without the engine: what a
 * re-key's step 1 writes, by "by". Returns the new manifest's digest.
 */
export async function freezeAs(p: { get: (n: string) => Promise<{ data: Uint8Array; etag: string } | null>; put: (n: string, d: Uint8Array, c?: unknown) => Promise<unknown> }, keys: any, by: string, at: number) {
  const name = await M.manifestName(keys);
  const obj = (await p.get(name))!;
  const { manifest: m, digest } = await M.openManifest(keys, obj.data, name);
  const rest = { ...m };
  delete (rest as { frozen?: unknown }).frozen;
  const next = {
    ...rest,
    protocol: M.FROZEN_PROTOCOL,
    counter: m.counter + 1,
    files: M.pathRecord(m.files),
    history: [...m.history, [m.counter, digest]].slice(-M.HISTORY_LENGTH),
    frozen: { epoch: keys.epoch + 1, at, by },
  };
  const sealed = await M.sealManifest(keys, next, name);
  await p.put(name, sealed.bytes, { ifMatch: obj.etag });
  return sealed.digest;
}

export const errName = (e: unknown) => (e as Error)?.name ?? String(e);

/**
 * Pair `joiner` through `issuer` the way the app does since W8.5: the code,
 * then the five-symbol comparison confirmed on both devices
 * (`H.pairConfirmed`). A copy of the issuer (same keys, a copy of its state)
 * issues the code, so the issuer itself stays free to change keys: a device
 * that confirmed a comparison holds key changes for the new device's window
 * (review 13, S13-1), the same pattern as e2eeNinthReview.test.ts.
 */
export async function pairVia(joiner: { sync: any }, issuer: { name: string; sync: any; store: any }, provider: unknown) {
  const copy = H.device(`${issuer.name}-issuer`, provider as never, issuer.sync.keys());
  copy.store.state = JSON.parse(JSON.stringify(issuer.store.state));
  await H.pairConfirmed(joiner as never, copy, await copy.sync.pairingCode());
}

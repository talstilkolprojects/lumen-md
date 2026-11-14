/**
 * Plan W2.19: sync on the local network, no cloud. Two devices: the host
 * keeps the vault's bucket, the peer reaches it over a direct link (here an
 * in-memory channel with LAN-like latency; the WebRTC link is the e2e test)
 * and both run the real encrypted sync engine (plan 3.4).
 * @vitest-environment node
 */
import { afterEach, describe, expect, it } from "vitest";
import { createVault, unlockVault, E2eeSync } from "../sync/e2ee/engine";
import { memoryProvider, PreconditionFailedError } from "../sync/e2ee/provider";
import { memoryFiles } from "../sync/e2ee/localFiles";
import { memoryStateStore } from "../sync/e2ee/state";
import { keepBothResolver } from "../sync/e2ee/conflict";
import { HEADER_NAME } from "../sync/e2ee/header";
import { KEYRING_NAME } from "../sync/e2ee/keyring";
import { utf8 } from "../sync/e2ee/bytes";
import { chunk, decodeMessage, encodeMessage, memoryChannelPair, reassembler, CHUNK } from "../sync/e2ee/lan/channel";
import { lanHost, liveSync, remoteLanProvider, LanAuthError } from "../sync/e2ee/lan/rpc";
import { candidateIsLan, isLanHost, lanOnlySdp } from "../sync/e2ee/lan/address";
import { mulberry32, pairConfirmed, PASSPHRASE, TEST_ITERATIONS, TEST_POLICY } from "./helpers/e2ee";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Every fetch from here on fails the test: the LAN sync must make none. */
function forbidFetch(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(String(input));
    return Promise.reject(new Error("no network in a LAN sync"));
  }) as typeof fetch;
  return calls;
}

async function pair(opts: { latencyMs?: () => number } = {}) {
  const bucket = memoryProvider();
  const { keys, anchor } = await createVault(bucket, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
  let hostKeys: typeof keys | null = keys;
  const host = lanHost({ bucket, keys: () => hostKeys });
  const frames: Uint8Array[] = [];
  const [hostEnd, peerEnd] = memoryChannelPair({ latencyMs: opts.latencyMs ?? (() => 1), onFrame: (_f, d) => frames.push(d) });
  host.attach(hostEnd, { address: "192.168.1.20" });
  const remote = remoteLanProvider(peerEnd);
  const peerKeys = (await unlockVault(remote, PASSPHRASE, TEST_POLICY)).keys;
  await remote.authenticate(peerKeys);
  const hostFiles = memoryFiles();
  const peerFiles = memoryFiles();
  const hostSync = new E2eeSync({ provider: host.provider, keys, local: hostFiles, store: memoryStateStore(), resolver: keepBothResolver });
  await hostSync.markCreated(anchor);
  const peerSync = new E2eeSync({ provider: remote, keys: peerKeys, local: peerFiles, store: memoryStateStore(), resolver: keepBothResolver });
  // The peer is paired with the host (third review N6: an unverified device doesn't upload).
  await peerSync.sync();
  // W8.5: through the comparison, the user confirming on both devices.
  await pairConfirmed({ sync: peerSync }, { sync: hostSync }, await hostSync.pairingCode());
  return { bucket, host, remote, hostFiles, peerFiles, hostSync, peerSync, frames, lockHost: () => (hostKeys = null) };
}

const snapshot = (f: ReturnType<typeof memoryFiles>) => [...f.files.keys()].sort().map((p) => [p, f.text(p)]);

/* ─── Acceptance 1: two devices, no internet, 0 lost in 1,000 rounds ───── */

describe("LAN sync between two devices", () => {
  it("1,000 rounds of random edits on both devices: 0 lost, and not one request off the device", async () => {
    const fetches = forbidFetch();
    const rand = mulberry32(0x1a2b);
    const d = await pair({ latencyMs: () => Math.floor(rand() * 3) });
    // What each device last wrote to its own files (null: deleted).
    const truth = { host: new Map<string, string | null>(), peer: new Map<string, string | null>() };
    const shared: string[] = [];
    for (let round = 0; round < 1000; round++) {
      for (const [who, files] of [["host", d.hostFiles], ["peer", d.peerFiles]] as const) {
        if (rand() < 0.6) {
          const path = `${who}/note-${Math.floor(rand() * 12)}.md`;
          if (rand() < 0.15 && files.files.has(path)) {
            files.delete(path);
            truth[who].set(path, null);
          } else {
            const text = `# ${who} ${round}\nשלום ${Math.floor(rand() * 1e6)}`;
            files.set(path, text);
            truth[who].set(path, text);
          }
        }
      }
      // Now and then both write the same new note between rounds: both versions
      // are kept (one in a conflict copy), and nobody overwrites them later.
      if (round % 97 === 13) {
        const a = `shared from host ${round}`;
        const b = `shared from peer ${round}`;
        d.hostFiles.set(`shared-${round}.md`, a);
        d.peerFiles.set(`shared-${round}.md`, b);
        shared.push(a, b);
      }
      // Sometimes in turn, sometimes at the same time.
      if (rand() < 0.5) await Promise.all([d.hostSync.sync(), d.peerSync.sync()]);
      else {
        await d.peerSync.sync();
        await d.hostSync.sync();
      }
    }
    // Settle: a couple of plain rounds.
    for (let i = 0; i < 3; i++) {
      await d.hostSync.sync();
      await d.peerSync.sync();
    }
    expect(snapshot(d.peerFiles)).toEqual(snapshot(d.hostFiles));
    for (const who of ["host", "peer"] as const) {
      for (const [path, text] of truth[who]) {
        if (text === null) expect(d.hostFiles.files.has(path)).toBe(false);
        else expect(d.hostFiles.text(path)).toBe(text);
      }
    }
    // Every concurrent write to a shared note survives, in it or in its conflict copy.
    const all = [...d.hostFiles.files.keys()].map((p) => d.hostFiles.text(p) ?? "").join("\n");
    for (const s of shared) expect(all).toContain(s);
    expect(fetches).toEqual([]);
    // The link carried sealed objects only: no note text on the wire.
    const wire = Buffer.concat(d.frames.map((f) => Buffer.from(f)));
    expect(wire.includes(Buffer.from("שלום", "utf8"))).toBe(false);
    expect(wire.includes(Buffer.from("# host", "utf8"))).toBe(false);
  }, 180_000);

  it("a change reaches the other device in < 2 s, both ways (live sync)", async () => {
    const d = await pair();
    const hostLive = liveSync(() => d.hostSync.sync(), { debounceMs: 50 });
    const peerLive = liveSync(() => d.peerSync.sync(), { debounceMs: 50 });
    d.host.onPeerWrite(hostLive.kick);
    d.remote.onChanged(peerLive.kick);
    const arrives = (files: ReturnType<typeof memoryFiles>, path: string, text: string) =>
      new Promise<number>((resolve, reject) => {
        const t0 = Date.now();
        const poll = () => {
          if (files.text(path) === text) return resolve(Date.now() - t0);
          if (Date.now() - t0 > 5000) return reject(new Error(`${path} did not arrive`));
          setTimeout(poll, 5);
        };
        poll();
      });
    const times: number[] = [];
    for (let i = 0; i < 10; i++) {
      d.hostFiles.set(`from-host-${i}.md`, `host ${i}`);
      hostLive.kick(); // what watchVault does on a local edit
      times.push(await arrives(d.peerFiles, `from-host-${i}.md`, `host ${i}`));
      d.peerFiles.set(`from-peer-${i}.md`, `peer ${i}`);
      peerLive.kick();
      times.push(await arrives(d.hostFiles, `from-peer-${i}.md`, `peer ${i}`));
    }
    hostLive.stop();
    peerLive.stop();
    expect(Math.max(...times)).toBeLessThan(2000);
  });
});

/* ─── Who may use the host ─────────────────────────────────────────────── */

describe("the host", () => {
  it("serves only what unlocking needs (header, keyring) before a device proves it knows the passphrase", async () => {
    const bucket = memoryProvider();
    const { keys } = await createVault(bucket, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const host = lanHost({ bucket, keys: () => keys });
    const [h, p] = memoryChannelPair();
    host.attach(h);
    const remote = remoteLanProvider(p);
    expect(await remote.get(HEADER_NAME)).not.toBeNull();
    // The keyring may be read (a new device unlocks with it); any other object may not.
    await remote.get(KEYRING_NAME);
    const other = (await bucket.list()).find((n) => n !== HEADER_NAME && n !== KEYRING_NAME);
    expect(other).toBeDefined();
    await expect(remote.get(other!)).rejects.toBeInstanceOf(LanAuthError);
    await expect(remote.list()).rejects.toBeInstanceOf(LanAuthError);
    await expect(remote.put("x", utf8("garbage"))).rejects.toBeInstanceOf(LanAuthError);
    await expect(remote.delete(HEADER_NAME)).rejects.toBeInstanceOf(LanAuthError);
    expect(await bucket.get(HEADER_NAME)).not.toBeNull();
  });

  it("refuses a device with another passphrase, and a peer refuses a host from another vault", async () => {
    const bucket = memoryProvider();
    const { keys } = await createVault(bucket, PASSPHRASE, { pbkdf2Iterations: TEST_ITERATIONS });
    const other = await createVault(memoryProvider(), "another passphrase entirely", { pbkdf2Iterations: TEST_ITERATIONS });
    const host = lanHost({ bucket, keys: () => keys });
    const [h, p] = memoryChannelPair();
    host.attach(h);
    const remote = remoteLanProvider(p);
    await expect(remote.authenticate(other.keys)).rejects.toBeInstanceOf(LanAuthError);
    for (let i = 0; i < 100 && !remote.closed; i++) await new Promise((r) => setTimeout(r, 10));
    expect(remote.closed).toBe(true); // the host drops the link

    const fakeHost = lanHost({ bucket: memoryProvider(), keys: () => other.keys });
    const [h2, p2] = memoryChannelPair();
    fakeHost.attach(h2);
    await expect(remoteLanProvider(p2).authenticate(keys)).rejects.toBeInstanceOf(LanAuthError);
  });

  it("conditional writes hold over the link, and a locked host says so", async () => {
    const d = await pair();
    const { etag } = await d.remote.put("obj", utf8("one"), { ifNoneMatch: "*" });
    await expect(d.remote.put("obj", utf8("two"), { ifNoneMatch: "*" })).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(d.remote.put("obj", utf8("two"), { ifMatch: "stale" })).rejects.toBeInstanceOf(PreconditionFailedError);
    await d.remote.put("obj", utf8("two"), { ifMatch: etag });
    expect(new TextDecoder().decode((await d.bucket.get("obj"))!.data)).toBe("two");
    // A large object crosses in chunks.
    const big = new Uint8Array(CHUNK * 5 + 123).map((_, i) => i % 251);
    await d.remote.put("big", big);
    expect((await d.remote.get("big"))!.data).toEqual(big);
    d.lockHost();
    const [h, p] = memoryChannelPair();
    d.host.attach(h);
    const late = remoteLanProvider(p);
    await expect(late.authenticate((await unlockVault(late, PASSPHRASE, TEST_POLICY)).keys)).rejects.toThrow(/locked/);
  });
});

/* ─── Acceptance 2: no address off the local network ───────────────────── */

describe("local network only", () => {
  it("accepts private, link-local, loopback and mDNS addresses only", () => {
    for (const h of ["192.168.1.20", "10.0.0.7", "172.16.4.1", "172.31.255.255", "169.254.10.2", "127.0.0.1", "::1", "fe80::1c2d:3eff:fe4f:5a6b", "fd12:3456:789a::1", "[fe80::1%en0]", "::ffff:192.168.0.3", "0b6c1d2e-3f40-4a5b-9c6d-7e8f90a1b2c3.local", "my-mac.local"]) {
      expect(isLanHost(h), h).toBe(true);
    }
    for (const h of ["8.8.8.8", "172.32.0.1", "100.64.0.1", "192.169.0.1", "2001:4860:4860::8888", "::ffff:8.8.8.8", "example.com", "local", "evil.local.example.com", ""]) {
      expect(isLanHost(h), h).toBe(false);
    }
  });

  it("keeps host candidates on the LAN, drops public, reflexive and relay ones", () => {
    expect(candidateIsLan("candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host generation 0")).toBe(true);
    expect(candidateIsLan("a=candidate:2 1 udp 2122260223 4e2f.local 54321 typ host")).toBe(true);
    expect(candidateIsLan("candidate:3 1 udp 1686052607 203.0.113.9 54321 typ srflx raddr 192.168.1.20 rport 54321")).toBe(false);
    expect(candidateIsLan("candidate:4 1 udp 41885439 192.168.1.20 3478 typ relay")).toBe(false);
    expect(candidateIsLan("candidate:5 1 udp 2122260223 203.0.113.9 54321 typ host")).toBe(false);
    const sdp = ["v=0", "a=candidate:1 1 udp 2122260223 192.168.1.20 54321 typ host", "a=candidate:2 1 udp 1686052607 203.0.113.9 54321 typ srflx raddr 0.0.0.0 rport 0", "a=end-of-candidates"].join("\r\n");
    const out = lanOnlySdp(sdp);
    expect(out.kept).toEqual(["192.168.1.20"]);
    expect(out.dropped).toEqual(["203.0.113.9"]);
    expect(out.sdp).not.toContain("203.0.113.9");
  });
});

/* ─── Framing ──────────────────────────────────────────────────────────── */

describe("framing", () => {
  it("chunks and reassembles; refuses frames out of order", () => {
    const msg = encodeMessage({ op: "put", name: "n" }, new Uint8Array(CHUNK * 2 + 5).fill(9));
    const frames = chunk(7, msg);
    expect(frames.length).toBe(3);
    const r = reassembler();
    expect(r.push(frames[0])).toBeNull();
    expect(r.push(frames[1])).toBeNull();
    const whole = r.push(frames[2]);
    expect(decodeMessage(whole!)!.header).toEqual({ op: "put", name: "n" });
    const r2 = reassembler();
    r2.push(frames[0]);
    expect(() => r2.push(frames[2])).toThrow();
  });
});

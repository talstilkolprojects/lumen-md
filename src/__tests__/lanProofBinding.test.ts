/**
 * Review 28, L1 (plan W2.19): the LAN link's passphrase proof is bound to the
 * channel, so once the pairing codes travel over the network (mDNS) a device
 * in the middle, holding two different DTLS connections, can't pass it. And
 * both screens show the same comparison code exactly when the fingerprints
 * agree. Property tests: random fingerprints, random one-character changes.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { deriveVaultKeys } from "../sync/e2ee/keys";
import { memoryProvider } from "../sync/e2ee/provider";
import { memoryChannelPair } from "../sync/e2ee/lan/channel";
import { channelBinding, comparisonCode, lanHost, LanAuthError, proofData, remoteLanProvider, type LinkFingerprints } from "../sync/e2ee/lan/rpc";
import { sdpFingerprint } from "../sync/e2ee/lan/link";

let seed = 2819;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
const HEX = "0123456789abcdef";
const fingerprint = () => `sha-256 ${Array.from({ length: 32 }, () => HEX[Math.floor(rnd() * 16)] + HEX[Math.floor(rnd() * 16)]).join(":")}`;
/** One character of `fp` changed (never a colon), as a different certificate would. */
const mutate = (fp: string) => {
  let i: number;
  do i = 8 + Math.floor(rnd() * (fp.length - 8));
  while (fp[i] === ":");
  const c = HEX[(HEX.indexOf(fp[i]) + 1 + Math.floor(rnd() * 15)) % 16];
  return fp.slice(0, i) + c + fp.slice(i + 1);
};

const keys = () => deriveVaultKeys(new Uint8Array(32).fill(3), "vault-r28");

/** A host and a peer over an in-memory channel, each told the fingerprints it sees. */
async function pair(hostSees: LinkFingerprints | null, peerSees: LinkFingerprints | null) {
  const k = await keys();
  const host = lanHost({ bucket: memoryProvider(), keys: () => k });
  const [a, b] = memoryChannelPair({ latencyMs: 0 });
  host.attach(a, { address: "192.168.1.20", fingerprints: hostSees });
  const peer = remoteLanProvider(b, { fingerprints: peerSees });
  let ok = true;
  try {
    await peer.authenticate(k);
  } catch (e) {
    expect(e).toBeInstanceOf(LanAuthError);
    ok = false;
  }
  // Let the host's code land in its peer info.
  for (let i = 0; i < 20 && host.peers()[0] && host.peers()[0].code === undefined; i++) await new Promise((r) => setTimeout(r, 5));
  return { ok, host, authedOnHost: host.peers().some((p) => p.authed) };
}

describe("W2.19 review 28: the proof is bound to the channel", () => {
  it("passes when both sides see the same two fingerprints, and both show the same code", async () => {
    for (let i = 0; i < 25; i++) {
      const [h, p] = [fingerprint(), fingerprint()];
      const r = await pair({ local: h, remote: p }, { local: p, remote: h });
      expect(r.ok).toBe(true);
      expect(r.authedOnHost).toBe(true);
      const peerCode = await comparisonCode(channelBinding("peer", { local: p, remote: h }));
      expect(peerCode).toMatch(/^\d{4} \d{4}$/);
      expect(r.host.peers()[0].code).toBe(peerCode);
    }
  });

  it("fails when any one fingerprint differs on either side (a device in the middle), and the codes differ", async () => {
    for (let i = 0; i < 40; i++) {
      const [h, p] = [fingerprint(), fingerprint()];
      const host = { local: h, remote: p };
      const peer = { local: p, remote: h };
      const which = Math.floor(rnd() * 4);
      const hs = which === 0 ? { ...host, local: mutate(h) } : which === 1 ? { ...host, remote: mutate(p) } : host;
      const ps = which === 2 ? { ...peer, local: mutate(p) } : which === 3 ? { ...peer, remote: mutate(h) } : peer;
      const r = await pair(hs, ps);
      expect(r.ok, `case ${which}`).toBe(false);
      expect(r.authedOnHost, `case ${which}`).toBe(false);
      expect(await comparisonCode(channelBinding("host", hs))).not.toBe(await comparisonCode(channelBinding("peer", ps)));
    }
  });

  it("fails when one side has fingerprints and the other none, or the two are swapped", async () => {
    const [h, p] = [fingerprint(), fingerprint()];
    expect((await pair({ local: h, remote: p }, null)).ok).toBe(false);
    expect((await pair(null, { local: p, remote: h })).ok).toBe(false);
    expect((await pair({ local: h, remote: p }, { local: h, remote: p })).ok).toBe(false);
    // In-memory channels with none on both sides still pair (tests, no WebRTC), and show no code.
    const none = await pair(null, null);
    expect(none.ok).toBe(true);
    expect(none.host.peers()[0].code).toBeNull();
  });

  it("keeps the role labels: a host's proof data never equals a peer's for the same values", () => {
    for (let i = 0; i < 50; i++) {
      const b = channelBinding("host", { local: fingerprint(), remote: fingerprint() });
      const [x, y] = [String(rnd()), String(rnd())];
      const td = new TextDecoder();
      expect(td.decode(proofData("host", x, y, b))).toMatch(/^lumen-lan:1\|host\|/);
      expect(td.decode(proofData("host", x, y, b))).not.toBe(td.decode(proofData("peer", x, y, b)));
    }
  });

  it("reads the DTLS fingerprint from an SDP", () => {
    const fp = fingerprint().split(" ")[1].toUpperCase();
    expect(sdpFingerprint(`v=0\r\na=group:BUNDLE 0\r\na=fingerprint:SHA-256 ${fp}\r\na=setup:actpass\r\n`)).toBe(`sha-256 ${fp.toLowerCase()}`);
    expect(sdpFingerprint("v=0\r\n")).toBeNull();
  });
});

/**
 * Plan W2.19 — finding the other device on the local network (mDNS in the
 * desktop app): the web side of it. The sockets are the desktop app's
 * (src-tauri/lan-mdns, tested with `cargo test`, two processes over real
 * multicast); here the app's commands are a fake that behaves like them, and
 * the checks are what the web side adds: only local addresses and Lumen
 * names come through, a pairing is announced until it is answered or given
 * up, and a half-made link is cancelled when its answer can't be delivered.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { announcePairing, DiscoveryError, findDevices, joinFound, NAME_RE, type Invoke } from "../sync/e2ee/lan/discovery";

const OFFER = "lumen-lan:1:zHostOffer_-1";
const ANSWER = "lumen-lan:1:zJoinAnswer_-2";
const TOKEN = "0123456789abcdef0123456789abcdef";

/** A fake of the desktop app's lan_discovery_* commands, with one rendezvous. */
function fakeApp(opts: { found?: unknown; offer?: { token: string; offer: string }; refuseAnswer?: string } = {}) {
  const calls: Array<{ cmd: string; args?: Record<string, unknown> }> = [];
  let hosted: string | null = null;
  let answer: string | null = null;
  const invoke: Invoke = async <T,>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    switch (cmd) {
      case "lan_discovery_host":
        hosted = String(args?.offer);
        return { name: "Lumen-K7Q2", port: 40123 } as T;
      case "lan_discovery_answer": {
        const a = answer;
        answer = null;
        return a as T;
      }
      case "lan_discovery_stop":
        hosted = null;
        return undefined as T;
      case "lan_discovery_browse":
        return (opts.found ?? []) as T;
      case "lan_discovery_fetch_offer":
        return (opts.offer ?? { token: TOKEN, offer: OFFER }) as T;
      case "lan_discovery_send_answer":
        if (opts.refuseAnswer) throw new Error(opts.refuseAnswer);
        answer = String(args?.answer);
        return undefined as T;
    }
    throw new Error(`unknown command ${cmd}`);
  };
  return { invoke, calls, hosted: () => hosted, deliver: (a: string) => (answer = a) };
}

describe("W2.19 discovery: the hosting device", () => {
  it("announces its offer, hands over the answer that comes, and stops announcing once given up", async () => {
    const app = fakeApp();
    const ctl = new AbortController();
    const { name, answer } = await announcePairing(OFFER, { signal: ctl.signal, invoke: app.invoke, pollMs: 5 });
    expect(name).toMatch(NAME_RE);
    expect(app.hosted()).toBe(OFFER);
    setTimeout(() => app.deliver(ANSWER), 20);
    expect(await answer).toBe(ANSWER);

    const ctl2 = new AbortController();
    const second = await announcePairing(OFFER, { signal: ctl2.signal, invoke: app.invoke, pollMs: 5 });
    ctl2.abort();
    expect(await second.answer).toBeNull();
    expect(app.calls.at(-1)?.cmd).toBe("lan_discovery_stop");
    expect(app.hosted()).toBeNull();
  });

  it("never announces something that is not a pairing code, and ignores an answer that isn't one", async () => {
    const app = fakeApp();
    await expect(announcePairing("hello", { signal: new AbortController().signal, invoke: app.invoke })).rejects.toBeInstanceOf(DiscoveryError);
    expect(app.calls).toEqual([]);
    const ctl = new AbortController();
    const { answer } = await announcePairing(OFFER, { signal: ctl.signal, invoke: app.invoke, pollMs: 5 });
    app.deliver("<script>");
    await new Promise((r) => setTimeout(r, 30));
    app.deliver(ANSWER);
    expect(await answer).toBe(ANSWER);
  });
});

describe("W2.19 discovery: the joining device", () => {
  it("lists only Lumen names on local-network addresses, once each", async () => {
    const app = fakeApp({
      found: [
        { name: "Lumen-K7Q2", host: "192.168.1.20", port: 40123 },
        { name: "Lumen-K7Q2", host: "192.168.1.21", port: 40124 },
        { name: "Lumen-AB12", host: "fe80::1", port: 5000 },
        { name: "Lumen-WAN1", host: "8.8.8.8", port: 40123 },
        { name: "Tal's MacBook", host: "192.168.1.30", port: 40123 },
        { name: "Lumen-PORT", host: "10.0.0.2", port: 0 },
        { name: "Lumen-TYPE", host: "10.0.0.2", port: "80" },
        null,
      ],
    });
    expect(await findDevices({ invoke: app.invoke })).toEqual([
      { name: "Lumen-K7Q2", host: "192.168.1.20", port: 40123 },
      { name: "Lumen-AB12", host: "fe80::1", port: 5000 },
    ]);
    expect(app.calls[0]).toEqual({ cmd: "lan_discovery_browse", args: { ms: 2500 } });
    expect(await findDevices({ invoke: fakeApp({ found: "nonsense" }).invoke })).toEqual([]);
  });

  it("fetches the offer, makes the answer from it and sends it back to the same device", async () => {
    const app = fakeApp();
    const device = { name: "Lumen-K7Q2", host: "192.168.1.20", port: 40123 };
    const seen: string[] = [];
    const j = await joinFound(device, async (offer) => {
      seen.push(offer);
      return { code: ANSWER };
    }, { invoke: app.invoke });
    expect(seen).toEqual([OFFER]);
    expect(j.code).toBe(ANSWER);
    expect(app.calls.map((c) => c.cmd)).toEqual(["lan_discovery_fetch_offer", "lan_discovery_send_answer"]);
    expect(app.calls[1].args).toEqual({ host: "192.168.1.20", port: 40123, token: TOKEN, answer: ANSWER });
  });

  it("refuses a device off the local network, a malformed offer, and cancels its half of the link when the answer can't be delivered", async () => {
    const ok = fakeApp();
    await expect(joinFound({ name: "Lumen-WAN1", host: "1.1.1.1", port: 1 }, async () => ({ code: ANSWER }), { invoke: ok.invoke })).rejects.toMatchObject({ reason: "not-lan" });
    expect(ok.calls).toEqual([]);
    const lan = { name: "Lumen-K7Q2", host: "10.0.0.5", port: 40123 };
    let made = 0;
    const make = async () => {
      made++;
      return { code: ANSWER };
    };
    const bad = fakeApp({ offer: { token: "short", offer: OFFER } });
    await expect(joinFound(lan, make, { invoke: bad.invoke })).rejects.toMatchObject({ reason: "failed" });
    const notCode = fakeApp({ offer: { token: TOKEN, offer: "javascript:alert(1)" } });
    await expect(joinFound(lan, make, { invoke: notCode.invoke })).rejects.toMatchObject({ reason: "failed" });
    expect(made).toBe(0);
    // Another device answered first: the host says "used".
    let cancelled = 0;
    const used = fakeApp({ refuseAnswer: "used" });
    await expect(joinFound(lan, async () => ({ code: ANSWER, cancel: () => cancelled++ }), { invoke: used.invoke })).rejects.toMatchObject({ reason: "used" });
    expect(cancelled).toBe(1);
  });

  it("outside the desktop app there is nothing to find with, and no request is made", async () => {
    await expect(findDevices()).rejects.toMatchObject({ reason: "unavailable" });
  });
});

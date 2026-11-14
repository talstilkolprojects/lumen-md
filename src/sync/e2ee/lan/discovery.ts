/**
 * Finding the other device on the local network (plan W2.19), so pairing
 * needs no code typed or scanned: in the desktop app, the device that keeps
 * the vault announces its pairing over multicast DNS (`_lumen-lan._tcp`)
 * while its dialog is open, and serves its offer code on a small local port;
 * the joining device lists what it finds, fetches the code and sends its
 * answer back the same way. The WebRTC link, its local-addresses-only rule
 * and the passphrase proof are the same as with a QR code (./link.ts,
 * ./rpc.ts): the codes carry no key, and a device that takes one without the
 * passphrase fails the proof.
 *
 * The sockets live in the desktop app (src-tauri/lan-mdns, std-only Rust): a
 * web page can't send UDP or listen on a port. In a browser or on a phone
 * `discoveryAvailable()` is false and the dialog shows the codes as before.
 *
 * Every address the app returns is checked again here (./address.ts), and a
 * name is only ever "Lumen-" and four letters or digits, so nothing about the
 * user or the vault is announced.
 */

import { isLanHost } from "./address";
import { CODE_PREFIX } from "./link";

export type Invoke = <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

export interface FoundDevice {
  /** "Lumen-K7Q2": the name the hosting device shows while it is visible. */
  name: string;
  host: string;
  port: number;
}

export interface DiscoveryDeps {
  invoke?: Invoke;
  /** How often to ask whether an answer came (default 400 ms). */
  pollMs?: number;
}

export const NAME_RE = /^Lumen-[A-Z0-9]{4}$/;
export const BROWSE_MS = 2500;

export class DiscoveryError extends Error {
  constructor(public readonly reason: "unavailable" | "not-lan" | "used" | "token" | "failed") {
    super(`LAN discovery: ${reason}`);
    this.name = "DiscoveryError";
  }
}

/** True in the desktop app, which has the sockets for it. */
export function discoveryAvailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function invokeOf(deps: DiscoveryDeps): Promise<Invoke> {
  if (deps.invoke) return deps.invoke;
  if (!discoveryAvailable()) throw new DiscoveryError("unavailable");
  const core = await import("@tauri-apps/api/core");
  return core.invoke as Invoke;
}

const isCode = (s: unknown): s is string => typeof s === "string" && s.startsWith(CODE_PREFIX) && s.length < 60_000 && /^[A-Za-z0-9_-]+$/.test(s.slice(CODE_PREFIX.length));

/** The app's error text → a reason (it says "used" or "token" for a pairing that is gone or another one's). */
function reasonOf(e: unknown): DiscoveryError {
  if (e instanceof DiscoveryError) return e;
  const m = String((e as Error)?.message ?? e);
  if (/\bused\b/.test(m)) return new DiscoveryError("used");
  if (/\btoken\b/.test(m)) return new DiscoveryError("token");
  if (/not-lan/.test(m)) return new DiscoveryError("not-lan");
  return new DiscoveryError("failed");
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), resolve()), { once: true });
  });

/**
 * Make this device visible on the network with `offer` (a host's pairing
 * code) until an answer comes or `signal` aborts. `answer` resolves with the
 * joining device's answer code, or null once aborted; either way this device
 * stops announcing.
 */
export async function announcePairing(offer: string, opts: { signal: AbortSignal } & DiscoveryDeps): Promise<{ name: string; answer: Promise<string | null> }> {
  if (!isCode(offer)) throw new DiscoveryError("failed");
  const invoke = await invokeOf(opts);
  let hosting: { name?: unknown };
  try {
    hosting = await invoke<{ name?: unknown }>("lan_discovery_host", { offer });
  } catch (e) {
    throw reasonOf(e);
  }
  const name = typeof hosting.name === "string" && NAME_RE.test(hosting.name) ? hosting.name : "Lumen";
  const stop = () => invoke("lan_discovery_stop").catch(() => undefined);
  const answer = (async () => {
    while (!opts.signal.aborted) {
      const a = await invoke<unknown>("lan_discovery_answer").catch(() => null);
      if (isCode(a)) return a;
      await sleep(opts.pollMs ?? 400, opts.signal);
    }
    await stop();
    return null;
  })();
  return { name, answer };
}

/** The devices announcing a pairing on this network: local addresses and Lumen names only. */
export async function findDevices(deps: DiscoveryDeps & { ms?: number } = {}): Promise<FoundDevice[]> {
  const invoke = await invokeOf(deps);
  let raw: unknown;
  try {
    raw = await invoke<unknown>("lan_discovery_browse", { ms: deps.ms ?? BROWSE_MS });
  } catch (e) {
    throw reasonOf(e);
  }
  if (!Array.isArray(raw)) return [];
  const out: FoundDevice[] = [];
  for (const d of raw as Array<Partial<FoundDevice>>) {
    if (!d || typeof d.name !== "string" || !NAME_RE.test(d.name)) continue;
    if (typeof d.host !== "string" || !isLanHost(d.host)) continue;
    if (typeof d.port !== "number" || !Number.isInteger(d.port) || d.port < 1 || d.port > 65535) continue;
    if (out.some((x) => x.name === d.name)) continue;
    out.push({ name: d.name, host: d.host, port: d.port });
  }
  return out;
}

/**
 * Pair with a found device: fetch its offer code, make the answer with
 * `answerFor` (./link.ts joinOffer), and send it back. Returns what
 * `answerFor` returned, so the caller can wait for the link; if the answer
 * can't be delivered, its `cancel` is called.
 */
export async function joinFound<J extends { code: string; cancel?(): void }>(device: FoundDevice, answerFor: (offer: string) => Promise<J>, deps: DiscoveryDeps = {}): Promise<J> {
  if (!isLanHost(device.host)) throw new DiscoveryError("not-lan");
  const invoke = await invokeOf(deps);
  let got: { token?: unknown; offer?: unknown };
  try {
    got = await invoke<{ token?: unknown; offer?: unknown }>("lan_discovery_fetch_offer", { host: device.host, port: device.port });
  } catch (e) {
    throw reasonOf(e);
  }
  if (typeof got.token !== "string" || !/^[0-9a-f]{32}$/.test(got.token) || !isCode(got.offer)) throw new DiscoveryError("failed");
  const joined = await answerFor(got.offer);
  try {
    await invoke("lan_discovery_send_answer", { host: device.host, port: device.port, token: got.token, answer: joined.code });
  } catch (e) {
    // The host never got the answer: this side's half-made link goes too.
    joined.cancel?.();
    throw reasonOf(e);
  }
  return joined;
}

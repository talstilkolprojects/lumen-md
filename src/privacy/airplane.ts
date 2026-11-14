/**
 * Provable airplane mode (plan W5.9): one switch that stops every network
 * request the app can make, and a live list of every attempt — allowed or
 * blocked — with the place in the code it came from.
 *
 * Loaded right after start-up (src/main.tsx, off the startup bundle) and
 * installed outside the privacy ledger (src/ai/privacyLedger.ts), so it sees
 * every request first. When the switch was already on, the browser-enforced
 * half (src/privacy/airplaneBoot.ts) has been in place since the first line:
 *
 *   fetch            other origins: blocked. The app's own origin: GET only,
 *                    and only from a cache (`cache: "only-if-cached"`, which
 *                    the service worker passes on) — never the network.
 *   XMLHttpRequest, WebSocket, EventSource, sendBeacon, RTCPeerConnection
 *                    blocked (the live-collab sockets and peers open before
 *                    the switch are closed).
 *   workers          their fetch asks the window (BroadcastChannel, see
 *                    src/ai/workerLedger.ts) and is blocked the same way.
 *   everything else  a Content-Security-Policy <meta> added to the page while
 *                    the switch is on: the browser itself refuses images,
 *                    fonts, media, frames and connections to other sites
 *                    (remote images also stay behind their placeholder).
 *
 * Loopback (localhost, 127.0.0.1, [::1]) stays allowed: a local model on
 * this machine is not the network. blob: and data: URLs never leave.
 *
 * A browser cannot drop a CSP it has applied, so turning the switch off
 * reloads the page. While it is on, the monitor's certificate (src/privacy/
 * airplaneCertificate.ts) states the window and counts the attempts that
 * reached the network (attempts, not bytes). Requests still waiting for an
 * answer when the switch goes on are counted in that number and aborted;
 * response bodies still downloading are cut off.
 *
 * Frames: a URL-loaded frame (the playground and live-js runners) has its own
 * header policy, so the <meta> allows frames from blob: only and those
 * blocks don't run while the switch is on (review 12.11).
 *
 * Not covered, said plainly: the app's own script chunks that the service
 * worker does not have cached load from the app's server like any page
 * resource (they are not fetch requests). The certificate counts such loads
 * from Resource Timing, so a non-zero transfer shows up.
 */

import { __setAirplaneFlag, addAirplaneCsp, AIRPLANE_KEY, airplaneSinceStored } from "./airplaneBoot";
import { AIRPLANE_CHANNEL, type AirplaneMessage } from "../ai/workerLedger";

export type EgressKind = "fetch" | "xhr" | "websocket" | "eventsource" | "beacon" | "webrtc" | "worker" | "resource" | "csp";
/** "in-flight": a request still waiting for its answer when the switch went on (counted, then aborted). */
export type EgressDecision = "allowed" | "blocked" | "cache-only" | "local" | "in-flight";

export interface EgressAttempt {
  id: number;
  ts: number;
  kind: EgressKind;
  /** Origin and path; never the query or the fragment (they may carry data). */
  target: string;
  method: string;
  decision: EgressDecision;
  /** Where in the code it came from: the first stack frame outside this module. */
  origin: string;
  /**
   * Bytes transferred over the network (Resource Timing), for the app's own
   * origin only. A load from another origin reports 0 without
   * Timing-Allow-Origin, so it carries no size and always counts as an
   * attempt that reached the network.
   */
  transferSize?: number;
}

/** Thrown (or the rejection) for a request airplane mode stopped. */
export class AirplaneBlockedError extends Error {
  constructor(target: string) {
    super(`Blocked: airplane mode is on (${target})`);
    this.name = "AirplaneBlockedError";
  }
}

const MAX = 500;
let attempts: EgressAttempt[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
let on = false;
let since: number | null = null;
let installed = false;

export function airplaneModeOn(): boolean {
  return on;
}

/** When the switch went on (ms), or null. */
export function airplaneSince(): number | null {
  return since;
}

export function egressAttempts(): readonly EgressAttempt[] {
  return attempts;
}

export function subscribeEgress(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * The place in the code a request came from. `skip` is the number of this
 * module's own frames on top (the recording helper and the wrapper: 2), so
 * the answer does not depend on how the build names or merges chunks; any
 * later frame still in this module is skipped by name as well.
 */
export function codeOrigin(stack: string | undefined, skip = 0): string {
  const frames = (stack ?? "").split("\n").map((l) => l.trim()).filter((l) => /:\d+:\d+\)?$/.test(l));
  const rest = frames.slice(skip);
  const outside = rest.find((l) => !/privacy\/airplane|airplane[-.][\w-]*\.js/.test(l)) ?? rest[0] ?? frames[0] ?? "";
  // "at fn (https://host/assets/x-abc.js:1:234)" / "fn@https://host/assets/x.js:1:234" → "fn x-abc.js:1:234"
  const m = /^(?:at\s+)?(?:(.*?)\s*\(|(.*?)@)?(?:[a-z-]+:\/\/[^/]+)?\/?([^()]*?:\d+:\d+)\)?$/.exec(outside);
  if (!m) return outside.slice(0, 160);
  const fn = (m[1] ?? m[2] ?? "").replace(/^async\s+/, "").trim();
  const file = m[3].split("/").pop() ?? m[3];
  return `${fn ? `${fn} ` : ""}${file}`.slice(0, 160);
}

/** Origin + path only. */
export function egressTarget(url: string, base: string = typeof location !== "undefined" ? location.href : "http://localhost/"): string {
  try {
    const u = new URL(url, base);
    if (u.protocol === "blob:" || u.protocol === "data:") return `${u.protocol}…`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0].slice(0, 200);
  }
}

export function record(a: Omit<EgressAttempt, "id" | "ts"> & { ts?: number }): EgressAttempt {
  const entry: EgressAttempt = { ...a, id: nextId++, ts: a.ts ?? Date.now() };
  attempts = [...attempts, entry].slice(-MAX);
  for (const fn of [...listeners]) fn();
  return entry;
}

type Verdict = "network" | "local" | "self" | "blocked";

/** How airplane mode treats a URL (when the switch is on). Exported for tests. */
export function verdict(url: string, base: string = typeof location !== "undefined" ? location.href : "http://localhost/"): Verdict {
  let u: URL;
  try {
    u = new URL(url, base);
  } catch {
    return "blocked";
  }
  if (u.protocol === "blob:" || u.protocol === "data:") return "local";
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost")) return "local";
  let self = false;
  try {
    self = u.origin === new URL(base).origin;
  } catch {
    /* why: an unusable base: nothing is the page's own origin */
  }
  if (!on) return "network";
  return self ? "self" : "blocked";
}

function sameOrigin(url: string, base: string | undefined): boolean {
  try {
    return !!base && new URL(url, base).origin === new URL(base).origin;
  } catch {
    return false;
  }
}

const isBlocked = (v: Verdict) => v === "blocked" || (v === "self" && on);

/* ─── the switch ─── */

/** Sockets and peers open now, with what they connect to (closed and counted when the switch goes on). */
const openSockets = new Map<{ close: () => void }, { kind: EgressKind; url: string; origin: string }>();

/** Requests that reached the network and have no answer yet. */
interface Flight {
  kind: EgressKind;
  url: string;
  method: string;
  origin: string;
  abort: () => void;
}
const inFlight = new Set<Flight>();
/** Answered fetches whose body may still be downloading (aborting a finished one does nothing). */
let bodies: AbortController[] = [];
const MAX_BODIES = 200;
let channel: BroadcastChannel | null = null;

function broadcast(): void {
  try {
    channel?.postMessage({ kind: "state", on } satisfies AirplaneMessage);
  } catch {
    /* why: a closed channel: workers then wait for their timeout (see workerLedger.ts) */
  }
}

/** Turn the switch on now: everything is stopped from this moment. */
export function enableAirplaneMode(): void {
  if (on) return;
  on = true;
  const at = Date.now();
  since = at;
  try {
    localStorage.setItem(AIRPLANE_KEY, JSON.stringify({ since }));
  } catch {
    /* why: storage denied: on for this page only */
  }
  if (typeof document !== "undefined") addAirplaneCsp(document);
  // What was already on the network: counted at this moment, then stopped.
  for (const f of [...inFlight]) {
    record({ kind: f.kind, target: egressTarget(f.url), method: f.method, decision: "in-flight", origin: f.origin, ts: at });
    try {
      f.abort();
    } catch {
      /* why: already settled */
    }
  }
  inFlight.clear();
  for (const c of bodies.splice(0)) {
    try {
      c.abort(new AirplaneBlockedError("response body"));
    } catch {
      /* why: already done */
    }
  }
  for (const [s, info] of [...openSockets]) {
    record({ kind: info.kind, target: egressTarget(info.url), method: info.kind === "webrtc" ? "PEER" : "GET", decision: "in-flight", origin: info.origin, ts: at });
    try {
      s.close();
    } catch {
      /* why: already closed */
    }
  }
  openSockets.clear();
  broadcast();
  // A new snapshot, so subscribers (the monitor) re-render with the new state.
  attempts = [...attempts];
  for (const fn of [...listeners]) fn();
}

/** Turn it off: the page reloads (a CSP cannot be lifted from a loaded page). */
export function disableAirplaneMode(reload: () => void = () => location.reload()): void {
  try {
    localStorage.removeItem(AIRPLANE_KEY);
  } catch {
    /* why: storage denied: nothing was kept */
  }
  reload();
}

/* ─── the wrappers ─── */

function blockedAttempt(kind: EgressKind, url: string, method: string): AirplaneBlockedError {
  record({ kind, target: egressTarget(url), method, decision: "blocked", origin: codeOrigin(new Error().stack, 2) });
  return new AirplaneBlockedError(egressTarget(url));
}

/** Record an attempt that goes ahead; returns where in the code it came from. */
function note(kind: EgressKind, url: string, method: string, v: Verdict): string {
  return record({ kind, target: egressTarget(url), method, decision: v === "local" ? "local" : v === "self" ? "cache-only" : "allowed", origin: codeOrigin(new Error().stack, 2) }).origin;
}

type W = Window & typeof globalThis;

/** Exported for tests: wrap one window (or a fake of it). */
export function installAirplaneMode(win: W = window as W): void {
  if (installed) return;
  installed = true;
  since = airplaneSinceStored();
  on = since !== null;
  if (on && win.document) addAirplaneCsp(win.document);

  const innerFetch = win.fetch.bind(win);
  win.fetch = function airplaneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (typeof Request !== "undefined" && input instanceof Request ? input.method : "GET")).toUpperCase();
    const v = verdict(url, win.location?.href);
    if (v === "blocked" || (v === "self" && method !== "GET")) return Promise.reject(blockedAttempt("fetch", url, method));
    const origin = note("fetch", url, method, v);
    // The app's own files, from a cache only: the service worker passes the mode on.
    if (v === "self") return innerFetch(input, { ...init, cache: "only-if-cached", mode: "same-origin" });
    if (v !== "network" || typeof AbortController === "undefined") return innerFetch(input, init);
    // On the network: kept in reach, so turning the switch on counts it and aborts it.
    const ctrl = new AbortController();
    const outer = init?.signal ?? (typeof Request !== "undefined" && input instanceof Request ? input.signal : undefined);
    if (outer) {
      if (outer.aborted) ctrl.abort(outer.reason);
      else outer.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
    }
    const flight: Flight = { kind: "fetch", url, method, origin, abort: () => ctrl.abort(new AirplaneBlockedError(egressTarget(url))) };
    inFlight.add(flight);
    return innerFetch(input, { ...init, signal: ctrl.signal }).then(
      (res) => {
        inFlight.delete(flight);
        bodies = [...bodies, ctrl].slice(-MAX_BODIES);
        return res;
      },
      (err: unknown) => {
        inFlight.delete(flight);
        throw err;
      },
    );
  } as typeof fetch;

  const XHR = win.XMLHttpRequest;
  if (XHR) {
    const open = XHR.prototype.open;
    const send = XHR.prototype.send;
    const urls = new WeakMap<XMLHttpRequest, [string, string]>();
    XHR.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      urls.set(this, [String(method).toUpperCase(), String(url)]);
      return (open as (...a: unknown[]) => void).call(this, method, url, ...rest);
    } as typeof XHR.prototype.open;
    XHR.prototype.send = function (this: XMLHttpRequest, body?: Parameters<XMLHttpRequest["send"]>[0]) {
      const [method, url] = urls.get(this) ?? ["GET", ""];
      const v = verdict(url, win.location?.href);
      if (isBlocked(v)) throw blockedAttempt("xhr", url, method);
      const origin = note("xhr", url, method, v);
      if (v === "network") {
        const flight: Flight = { kind: "xhr", url, method, origin, abort: () => this.abort() };
        inFlight.add(flight);
        this.addEventListener?.("loadend", () => inFlight.delete(flight));
      }
      return send.call(this, body);
    };
  }

  const wrapCtor = (name: "WebSocket" | "EventSource" | "RTCPeerConnection", kind: EgressKind, urlOf: (args: unknown[]) => string, track: boolean): void => {
    const Inner = (win as unknown as Record<string, (new (...a: unknown[]) => object) | undefined>)[name];
    if (!Inner) return;
    const Wrapped = function (this: unknown, ...args: unknown[]) {
      const url = urlOf(args);
      const v = kind === "webrtc" ? (on ? "blocked" : "network") : verdict(url, win.location?.href);
      if (isBlocked(v)) throw blockedAttempt(kind, url, kind === "webrtc" ? "PEER" : "GET");
      const origin = note(kind, url, kind === "webrtc" ? "PEER" : "GET", v);
      const inst = Reflect.construct(Inner, args, new.target ?? Inner) as { close?: () => void; addEventListener?: (t: string, f: () => void) => void };
      if (track && typeof inst.close === "function") {
        const s = inst as { close: () => void };
        openSockets.set(s, { kind, url, origin });
        inst.addEventListener?.("close", () => openSockets.delete(s));
      }
      return inst;
    };
    Object.setPrototypeOf(Wrapped, Inner);
    Wrapped.prototype = Inner.prototype;
    (win as unknown as Record<string, unknown>)[name] = Wrapped;
  };
  wrapCtor("WebSocket", "websocket", (a) => String(a[0]), true);
  wrapCtor("EventSource", "eventsource", (a) => String(a[0]), true);
  wrapCtor("RTCPeerConnection", "webrtc", () => "webrtc:peer", true);

  const nav = win.navigator as Navigator | undefined;
  if (nav && typeof nav.sendBeacon === "function") {
    const beacon = nav.sendBeacon.bind(nav);
    nav.sendBeacon = (url: string | URL, data?: BodyInit | null) => {
      const v = verdict(String(url), win.location?.href);
      if (isBlocked(v)) {
        blockedAttempt("beacon", String(url), "POST");
        return false;
      }
      note("beacon", String(url), "POST", v);
      return beacon(url, data);
    };
  }

  // What the browser refused by the CSP (the <meta> above, or the app's own policy).
  win.document?.addEventListener?.("securitypolicyviolation", (e: SecurityPolicyViolationEvent) => {
    if (!/^(https?|wss?):/.test(e.blockedURI)) return;
    record({ kind: "csp", target: egressTarget(e.blockedURI), method: e.effectiveDirective || e.violatedDirective, decision: "blocked", origin: `${(e.sourceFile || "").split("/").pop() || "page"}:${e.lineNumber}:${e.columnNumber}` });
  });

  // Loads that are not fetch (images, fonts, stylesheets, script chunks): seen after the fact.
  try {
    new PerformanceObserver((list) => {
      for (const r of list.getEntries() as PerformanceResourceTiming[]) {
        if (r.initiatorType === "fetch" || r.initiatorType === "xmlhttprequest" || r.initiatorType === "beacon") continue;
        const rv = verdict(r.name, win.location?.href);
        if (rv === "local" || (!on && sameOrigin(r.name, win.location?.href))) continue;
        // Another origin's transferSize is 0 without Timing-Allow-Origin: no size, so it counts as an attempt.
        const own = sameOrigin(r.name, win.location?.href);
        record({ kind: "resource", target: egressTarget(r.name), method: r.initiatorType, decision: "allowed", origin: r.initiatorType, ...(own ? { transferSize: r.transferSize } : {}), ts: Math.round(performance.timeOrigin + r.startTime) });
      }
    }).observe({ type: "resource", buffered: false });
  } catch {
    /* why: no Resource Timing in this engine: fetch-level attempts are still listed */
  }

  // Workers: their fetch asks here (src/ai/workerLedger.ts); attempts are reported on the ledger channel.
  if (typeof BroadcastChannel !== "undefined") {
    channel = new BroadcastChannel(AIRPLANE_CHANNEL);
    channel.addEventListener("message", (e: MessageEvent<AirplaneMessage>) => {
      const m = e.data;
      if (m?.kind === "hello") broadcast();
      if (m?.kind === "attempt" && typeof m.url === "string") {
        const v = verdict(m.url, win.location?.href);
        record({ kind: "worker", target: egressTarget(m.url), method: m.method || "GET", decision: m.blocked ? "blocked" : v === "local" ? "local" : "allowed", origin: `worker ${m.worker || ""}`.trim() });
      }
    });
    broadcast();
  }
  for (const fn of [...listeners]) fn();
}

/** Tests only. */
export function __resetAirplane(): void {
  __setAirplaneFlag(false);
  attempts = [];
  nextId = 1;
  listeners.clear();
  on = false;
  since = null;
  installed = false;
  openSockets.clear();
  inFlight.clear();
  bodies = [];
  channel?.close();
  channel = null;
}

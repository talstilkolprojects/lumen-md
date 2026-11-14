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
 * blocks don't run while the switch is on (review 12.11). Every frame
 * already open with something in it, whatever its sandbox (CSS alone makes
 * requests), in the page or in a shadow root, and every <object> and
 * <embed>, is torn down when the switch goes on (its page replaced by
 * about:blank, which stops its scripts, animations and any worker inside it)
 * and recorded as "in-flight" (reviews 2, 4 and 6).
 *
 * What a frame could start outside itself (review 6, RR6-451-2):
 *   windows   the app's own window.open (and that of every same-origin
 *             frame) is tracked, and those windows are closed at the switch.
 *             While the switch is on, no frame gets allow-popups
 *             (`guardFrames`, however the frame is made). Before it, a frame
 *             may (an embed's "Watch on YouTube" link): at the switch, each
 *             frame that could have opened a window this page can't reach is
 *             counted as a possible POPUP (review 8, RR8-451-1, -2).
 *   service workers   a frame from another site keeps allow-same-origin
 *             only for the known embed providers (EMBED_ORIGINS), so another
 *             site's page can't register one. At the switch, every service
 *             worker registration of the app's origin other than the app's
 *             own is unregistered. One a known provider registered is out of
 *             this page's reach, and the certificate says so.
 *
 * Other tabs: the workers' channel is shared by every tab, so each window
 * answers only its own workers (AIRPLANE_TAB), and a tab that sees the
 * switch go on in another tab (the storage event, listened to in the startup
 * bundle, airplaneBoot.ts) turns it on too.
 *
 * Not covered, said plainly: the app's own script chunks that the service
 * worker does not have cached load from the app's server like any page
 * resource (they are not fetch requests). The certificate counts such loads
 * from Resource Timing, so a non-zero transfer shows up.
 */

import { isPopup, reachedNetwork, type EgressTally } from "./airplaneCertificate";
import { __setAirplaneFlag, addAirplaneCsp, AIRPLANE_KEY, AIRPLANE_TAB, airplaneSinceStored, blankFrames, onSwitchedElsewhere, rootsOf, shadowRoots } from "./airplaneBoot";
import { AIRPLANE_CHANNEL, type AirplaneMessage } from "../ai/workerLedger";
import { wrapLedgerTransport } from "../ai/privacyLedger";

export type EgressKind = "fetch" | "xhr" | "websocket" | "eventsource" | "beacon" | "webrtc" | "worker" | "resource" | "csp" | "frame";
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

/** The list keeps every attempt that reached the network, and this many others (the newest). */
const MAX = 500;
let attempts: EgressAttempt[] = [];
/** Listed attempts that did not reach the network (the ones the list may drop). */
let unpinned = 0;
const freshTally = (from: number): EgressTally => ({ from, attempts: 0, blocked: 0, local: 0, cacheOnly: 0, inFlight: 0, left: 0, popups: 0 });
/** Every attempt counted, by decision, since the switch (or the page's start): kept apart from the bounded list (review 14). */
let tally: EgressTally = freshTally(Date.now());
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

/** The running count behind the certificate's summary (`buildCertificate(…, egressTally())`). */
export function egressTally(): Readonly<EgressTally> {
  return { ...tally };
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
  tally.attempts++;
  if (entry.decision === "blocked") tally.blocked++;
  else if (entry.decision === "local") tally.local++;
  else if (entry.decision === "cache-only") tally.cacheOnly++;
  else if (entry.decision === "in-flight") tally.inFlight++;
  const leak = reachedNetwork(entry);
  if (leak) tally.left++;
  if (leak && isPopup(entry)) tally.popups++;
  // A real leak is never dropped from the list (review 14): only the oldest of the others go, past MAX.
  const next = [...attempts, entry];
  if (!leak) unpinned++;
  if (unpinned > MAX) {
    const i = next.findIndex((a) => !reachedNetwork(a));
    if (i >= 0) next.splice(i, 1);
    unpinned--;
  }
  attempts = next;
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
let followingOtherTabs = false;

/** Tell this window's workers the state (a reply to a hello says the hello's own tab, if any). */
function broadcast(tab: string | null = AIRPLANE_TAB): void {
  try {
    channel?.postMessage((tab !== null ? { kind: "state", on, tab } : { kind: "state", on }) satisfies AirplaneMessage);
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
  tally = freshTally(at);
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
  if (typeof document !== "undefined") stopFrames(document, at);
  if (typeof navigator !== "undefined") void stopForeignWorkers(navigator, at);
  broadcast();
  // A new snapshot, so subscribers (the monitor) re-render with the new state.
  attempts = [...attempts];
  for (const fn of [...listeners]) fn();
}

/**
 * Stop every frame with something in it when the switch goes on (reviews 4
 * and 6, `blankFrames`), and close the windows the app opened. Each is
 * recorded as in-flight. The blocks cannot
 * load a new page while the switch is on (frame-src blob:), and a frame made
 * after the switch inherits the <meta>.
 */
export function stopFrames(doc: Pick<Document, "querySelectorAll">, at: number = Date.now()): number {
  // Before they are emptied: frames that could have opened a window out of this page's reach (RR8-451-1, -2),
  // and those seen able to since they were made, gone or changed since (RR11-451-1).
  const seen = new Set<HTMLIFrameElement>();
  const counted = popupFrames(doc, 0, seen);
  for (const l of latched.splice(0)) {
    const f = l.frame?.deref();
    if (!f || !seen.has(f)) counted.push(l.target);
  }
  for (const src of counted) {
    record({ kind: "frame", target: src.startsWith("about:") ? src : egressTarget(src), method: "POPUP", decision: "in-flight", origin: "frame (allow-popups)", ts: at });
  }
  // More frames than the list keeps: those dropped from it may have opened windows too (review 14, RR14-451-1).
  if (droppedLatches > 0) {
    record({ kind: "frame", target: "about:frames", method: "POPUP", decision: "in-flight", origin: `${droppedLatches} earlier frames (allow-popups)`, ts: at });
    droppedLatches = 0;
  }
  const stopped = blankFrames(doc);
  for (const f of stopped) {
    record({ kind: "frame", target: f.src.startsWith("about:") ? f.src : egressTarget(f.src), method: "FRAME", decision: "in-flight", origin: f.title || "frame", ts: at });
  }
  // Windows the app (or a same-origin frame) opened: closed, and counted.
  for (const [w, url] of [...popups]) {
    popups.delete(w);
    try {
      if (w.closed) continue;
      w.close();
    } catch {
      /* why: already gone */
    }
    record({ kind: "frame", target: egressTarget(url || "about:blank"), method: "POPUP", decision: "in-flight", origin: "window.open", ts: at });
  }
  return stopped.length;
}

/** Windows opened through a tracked window.open, with the URL asked for. */
const popups = new Map<Window, string>();

/**
 * Every frame seen able to open windows while the switch was off (review 11,
 * RR11-451-1), from when the guard first decided it: a window it opened stays
 * open after the frame is gone or loses allow-popups, so the switch counts it
 * even then. Its target, and the frame while it is alive (to not count it twice).
 */
const latched: Array<{ target: string; frame: WeakRef<HTMLIFrameElement> | null }> = [];
const latchedFrames = new WeakSet<HTMLIFrameElement>();
const MAX_LATCHED = 500;
/** Latches dropped to keep the list at MAX_LATCHED: recorded at the switch as one POPUP (review 14, RR14-451-1). */
let droppedLatches = 0;

/** Remember a frame that can open windows now (its sandbox allows popups, or it has none and holds another site's page). */
function latchPopups(f: HTMLIFrameElement, base: string): void {
  if (on || latchedFrames.has(f)) return;
  const sb = f.getAttribute("sandbox");
  const srcdoc = f.getAttribute("srcdoc");
  const src = f.getAttribute("src") ?? "";
  if (srcdoc === null && (!src || src === "about:blank")) return; // why: nothing loaded in it yet
  let may = false;
  if (sb !== null) may = sb.split(/[\t\n\f\r ]+/).some((t) => t.toLowerCase() === "allow-popups");
  else {
    try {
      const u = new URL(src, base);
      may = /^https?:$/.test(u.protocol) && u.origin !== new URL(base).origin;
    } catch {
      may = true; // why: a URL that doesn't parse: count it
    }
  }
  if (!may) return;
  latchedFrames.add(f);
  latched.push({ target: srcdoc !== null ? "about:srcdoc" : src, frame: typeof WeakRef === "undefined" ? null : new WeakRef(f) });
  if (latched.length > MAX_LATCHED) {
    latched.shift();
    droppedLatches++;
  }
}

/**
 * Frames that may have opened a window this page can't close (review 8,
 * RR8-451-1, -2): a frame whose sandbox allows popups, or that has none,
 * unless its window is one whose window.open is tracked (`trackOpen`); and
 * the same in same-origin frames' documents.
 */
function popupFrames(doc: Pick<Document, "querySelectorAll">, depth = 0, seen?: Set<HTMLIFrameElement>): string[] {
  const out: string[] = [];
  for (const root of rootsOf(doc)) {
    let frames: HTMLIFrameElement[] = [];
    try {
      frames = Array.from(root.querySelectorAll("iframe"));
    } catch {
      /* why: a fake document */
    }
    for (const f of frames) {
      let inner: Document | null = null;
      let tracked = false;
      try {
        inner = f.contentDocument;
        tracked = Boolean((f.contentWindow as (Window & { __lumenOpen?: boolean }) | null)?.__lumenOpen);
      } catch {
        /* why: another origin's page: its window.open is out of reach */
      }
      const sb = f.getAttribute("sandbox");
      const may = sb === null || sb.split(/[\t\n\f\r ]+/).some((t) => t.toLowerCase() === "allow-popups");
      if (may && !tracked) {
        out.push(f.getAttribute("srcdoc") !== null ? "about:srcdoc" : f.getAttribute("src") || "about:blank");
        seen?.add(f);
      }
      if (inner && depth < 8) out.push(...popupFrames(inner, depth + 1, seen));
    }
  }
  return out;
}

/** Wrap one window's `open` so the window it returns can be closed at the switch (RR6-451-2). */
export function trackOpen(w: Window | null | undefined): void {
  const target = w as (Window & { __lumenOpen?: boolean }) | null | undefined;
  try {
    if (!target || typeof target.open !== "function" || target.__lumenOpen) return;
    const inner = target.open.bind(target);
    target.open = ((url?: string | URL, name?: string, features?: string) => {
      const opened = inner(url, name, features);
      if (opened) popups.set(opened, String(url ?? ""));
      return opened;
    }) as typeof window.open;
    Object.defineProperty(target, "__lumenOpen", { value: true });
  } catch {
    /* why: another origin's window: out of reach (and `guardFrames` gives it no allow-popups) */
  }
}

/**
 * The sites whose embeds keep `allow-same-origin`: the https origins of
 * public/_headers' frame-src, which are the providers of
 * src/plugins/EmbedBlock.tsx and the embed codes they hand out (review 8,
 * RR8-451-2: one list; a test keeps them equal). A frame from any other site
 * loses it, so it has no storage and no service worker of its own (review 6,
 * RR6-451-2).
 */
export const EMBED_ORIGINS: ReadonlySet<string> = new Set([
  "https://codepen.io",
  "https://codesandbox.io",
  "https://gist.github.com",
  "https://maps.google.com",
  "https://open.spotify.com",
  "https://platform.twitter.com",
  "https://player.vimeo.com",
  "https://w.soundcloud.com",
  "https://www.facebook.com",
  "https://www.figma.com",
  "https://www.google.com",
  "https://www.instagram.com",
  "https://www.linkedin.com",
  "https://www.loom.com",
  "https://www.openstreetmap.org",
  "https://www.reddit.com",
  "https://www.redditmedia.com",
  "https://www.tiktok.com",
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
]);

const NO_POPUPS = new Set(["allow-popups", "allow-popups-to-escape-sandbox"]);

/**
 * A frame's sandbox as `guardFrames` leaves it: no popups while the switch is
 * on (`stripPopups`, review 8, RR8-451-2: before it, an embed's links still
 * open their page); same-origin powers only for the app and the known embeds.
 */
export function guardedSandbox(sandbox: string, src: string | null, base: string, stripPopups: boolean = on): string {
  let foreign = false;
  if (src) {
    try {
      const u = new URL(src, base);
      foreign = /^https?:$/.test(u.protocol) && u.origin !== new URL(base).origin && !EMBED_ORIGINS.has(u.origin);
    } catch {
      foreign = true; // why: a URL that doesn't parse gets no powers
    }
  }
  return sandbox
    .split(/[\t\n\f\r ]+/)
    .filter((t) => t && !(stripPopups && NO_POPUPS.has(t.toLowerCase())) && !(foreign && t.toLowerCase() === "allow-same-origin"))
    .join(" ");
}

/**
 * Every sandboxed iframe this page makes through the DOM (React included)
 * gets `guardedSandbox`, decided before it loads: when its sandbox or its
 * src is set, through setAttribute, setAttributeNS or the properties. Frames
 * the HTML parser makes (innerHTML, document.write) or whose sandbox comes
 * through an Attr are decided by a MutationObserver before their first page
 * can run (the same microtask checkpoint), and loaded again when that changes
 * their sandbox; the same holds in shadow roots and in same-origin frames'
 * documents (review 8, RR8-451-1). A frame with no sandbox attribute is left
 * as it is (the app sandboxes every frame it loads from another site).
 */
export function guardFrames(win: W): void {
  const proto = win.HTMLIFrameElement?.prototype as (HTMLIFrameElement & { __lumenGuard?: boolean }) | undefined;
  if (!proto || proto.__lumenGuard) return;
  Object.defineProperty(proto, "__lumenGuard", { value: true });
  const base = () => win.location?.href ?? "http://localhost/";
  const native = win.Element.prototype.setAttribute;
  const apply = (f: HTMLIFrameElement, src: string | null) => {
    const sb = f.getAttribute("sandbox");
    if (sb === null) return;
    const next = guardedSandbox(sb, src, base());
    if (next !== sb) native.call(f, "sandbox", next);
  };
  proto.setAttribute = function (this: HTMLIFrameElement, name: string, value: string) {
    const n = String(name).toLowerCase();
    if (n === "sandbox") native.call(this, name, guardedSandbox(String(value), this.getAttribute("src"), base()));
    else {
      if (n === "src") apply(this, String(value));
      native.call(this, name, value);
    }
  };
  const nativeNS = win.Element.prototype.setAttributeNS;
  proto.setAttributeNS = function (this: HTMLIFrameElement, ns: string | null, name: string, value: string) {
    const n = String(name).toLowerCase();
    if (!ns && (n === "sandbox" || n === "src")) this.setAttribute(n, value);
    else nativeNS.call(this, ns, name, value);
  };
  observeFrames(win, win.document, native);
  const srcDesc = Object.getOwnPropertyDescriptor(proto, "src");
  if (srcDesc?.set) {
    Object.defineProperty(proto, "src", {
      ...srcDesc,
      set(this: HTMLIFrameElement, v: string) {
        apply(this, String(v));
        srcDesc.set!.call(this, v);
      },
    });
  }
  const sbDesc = Object.getOwnPropertyDescriptor(proto, "sandbox");
  if (sbDesc?.get) {
    Object.defineProperty(proto, "sandbox", {
      ...sbDesc,
      get(this: HTMLIFrameElement) {
        const list = sbDesc.get!.call(this) as DOMTokenList;
        owners.set(list, this);
        return list;
      },
      set(this: HTMLIFrameElement, v: string) {
        native.call(this, "sandbox", guardedSandbox(String(v), this.getAttribute("src"), base()));
      },
    });
  }
  // `frame.sandbox.add("allow-popups")` and the like: put the guard back after the change.
  const TL = win.DOMTokenList?.prototype;
  if (TL) {
    for (const m of ["add", "toggle", "replace"] as const) {
      const inner = TL[m] as (...a: unknown[]) => unknown;
      (TL as unknown as Record<string, unknown>)[m] = function (this: DOMTokenList, ...a: unknown[]) {
        const r = inner.apply(this, a);
        const f = owners.get(this);
        if (f) apply(f, f.getAttribute("src"));
        return r;
      };
    }
    const value = Object.getOwnPropertyDescriptor(TL, "value");
    if (value?.set) {
      Object.defineProperty(TL, "value", {
        ...value,
        set(this: DOMTokenList, v: string) {
          value.set!.call(this, v);
          const f = owners.get(this);
          if (f) apply(f, f.getAttribute("src"));
        },
      });
    }
  }
}
const owners = new WeakMap<DOMTokenList, HTMLIFrameElement>();

/** The nodes `observeFrames` already watches (a document or a shadow root). */
const observed = new WeakSet<Node>();
let observeShadow: ((root: ShadowRoot) => void) | null = null;

/**
 * Decide frames that no setter saw (RR8-451-1): each iframe added to `root`
 * (or whose sandbox, src or srcdoc changes) gets `guardedSandbox`; one whose
 * sandbox that changes is loaded again, so its page runs with the new flags.
 * A same-origin frame's own window is guarded too, as soon as it is seen.
 */
function observeFrames(win: W, root: Node | null | undefined, native: (this: Element, name: string, value: string) => void): void {
  const MO = win.MutationObserver;
  if (!root || !MO || observed.has(root)) return;
  observed.add(root);
  const base = () => win.location?.href ?? "http://localhost/";
  const decide = (f: HTMLIFrameElement) => {
    latchPopups(f, base());
    const sb = f.getAttribute("sandbox");
    if (sb !== null) {
      const next = guardedSandbox(sb, f.getAttribute("src"), base());
      if (next !== sb) {
        native.call(f, "sandbox", next);
        // The page it started (if any) has the old flags: start it again with the new ones.
        const doc = f.getAttribute("srcdoc");
        if (doc !== null) native.call(f, "srcdoc", doc);
        else native.call(f, "src", f.getAttribute("src") ?? "about:blank");
      }
    }
    try {
      const w = f.contentWindow as W | null;
      if (w && w.document && w.HTMLIFrameElement) {
        guardFrames(w);
        trackOpen(w);
      }
    } catch {
      /* why: another origin's page: its frames are its own (and inherit this one's sandbox) */
    }
  };
  // Every insertion in the app passes here (the editor's too): only a cheap look for frames.
  const scan = (n: Node) => {
    if (n.nodeType !== 1) return;
    const el = n as Element;
    if (el.tagName === "IFRAME") decide(el as HTMLIFrameElement);
    else if (el.childElementCount) for (const f of Array.from(el.getElementsByTagName("iframe"))) decide(f);
  };
  try {
    new MO((list) => {
      for (const m of list) {
        if (m.type === "attributes") {
          if ((m.target as Element).tagName === "IFRAME") decide(m.target as HTMLIFrameElement);
        } else for (const n of Array.from(m.addedNodes)) scan(n);
      }
    }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ["sandbox", "src", "srcdoc"] });
  } catch {
    return; // why: not a node it can watch (a fake document)
  }
  for (const n of Array.from((root as ParentNode).children ?? [])) scan(n);
  observeShadow ??= (sr) => observeFrames(win, sr, native);
}

/** Wrap `attachShadow`, so `blankFrames` finds frames in shadow roots, closed ones too (RR6-451-3). */
export function trackShadowRoots(win: W): void {
  const proto = win.Element?.prototype as (Element & { __lumenShadow?: boolean }) | undefined;
  if (!proto || typeof proto.attachShadow !== "function" || proto.__lumenShadow || typeof WeakRef === "undefined") return;
  const inner = proto.attachShadow;
  proto.attachShadow = function (this: Element, init: ShadowRootInit): ShadowRoot {
    const root = inner.call(this, init);
    shadowRoots.add(new WeakRef(root));
    observeShadow?.(root);
    return root;
  };
  Object.defineProperty(proto, "__lumenShadow", { value: true });
}

/**
 * Service workers of the app's origin that are not the app's own (one a
 * same-origin frame registered): unregistered at the switch, and counted.
 * Another site's are out of reach (see EMBED_ORIGINS).
 */
async function stopForeignWorkers(nav: Navigator | undefined, at: number): Promise<void> {
  const sw = nav?.serviceWorker;
  if (!sw || typeof sw.getRegistrations !== "function") return;
  try {
    const own = sw.controller?.scriptURL ?? null;
    for (const reg of await sw.getRegistrations()) {
      const script = (reg.active ?? reg.waiting ?? reg.installing)?.scriptURL ?? "";
      if (own !== null ? script === own : /\/(sw|service-worker)\.js$/.test(new URL(script || reg.scope).pathname)) continue;
      await reg.unregister().catch(() => false);
      record({ kind: "worker", target: egressTarget(script || reg.scope), method: "SERVICE-WORKER", decision: "in-flight", origin: "service worker", ts: at });
    }
  } catch {
    /* why: no registrations to reach here */
  }
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
  // Woken with the switch on: everything this page counts is since the switch (nothing earlier is in memory).
  if (since !== null) tally = freshTally(since);
  if (on && win.document) addAirplaneCsp(win.document);

  // What a frame could start outside itself, and frames in shadow roots (review 6).
  guardFrames(win);
  trackShadowRoots(win);
  trackOpen(win);
  try {
    // A same-origin frame's window.open, as each frame loads.
    win.document?.addEventListener?.(
      "load",
      (e: Event) => {
        const t = e.target as HTMLIFrameElement | null;
        if (t && t.tagName === "IFRAME") {
          trackOpen(t.contentWindow);
          try {
            const w = t.contentWindow as W | null;
            if (w?.HTMLIFrameElement) guardFrames(w); // why: a same-origin page's own frames (RR8-451-1)
          } catch {
            /* why: another origin's page */
          }
        }
      },
      true,
    );
  } catch {
    /* why: no document here */
  }

  const guard = (innerFetch: typeof fetch): typeof fetch =>
  function airplaneFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
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
  win.fetch = guard(win.fetch.bind(win));
  // The ledger's own transport too (RR20-1): consented requests (open sources, Sefaria, the clipper) go
  // through the captured fetch, which would otherwise bypass this guard. Only for the real window.
  if (typeof window !== "undefined" && (win as unknown) === window) wrapLedgerTransport(guard);

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
      // Only this window's workers (or one that names no window): another tab answers its own.
      if (m?.kind === "hello" && (typeof m.tab !== "string" || m.tab === AIRPLANE_TAB)) broadcast(typeof m.tab === "string" ? m.tab : null);
      if (m?.kind === "attempt" && typeof m.url === "string") {
        const v = verdict(m.url, win.location?.href);
        record({ kind: "worker", target: egressTarget(m.url), method: m.method || "GET", decision: m.blocked ? "blocked" : v === "local" ? "local" : "allowed", origin: `worker ${m.worker || ""}`.trim() });
      }
    });
    broadcast();
  }
  // Switched on in another tab of the app: the startup bundle's storage listener (airplaneBoot)
  // runs the full switch here, with the certificate, once this chunk is loaded (review 4).
  if (!followingOtherTabs) {
    followingOtherTabs = true;
    onSwitchedElsewhere(() => {
      if (!on) enableAirplaneMode();
    });
  }
  for (const fn of [...listeners]) fn();
}

/** Tests only. */
export function __resetAirplane(): void {
  __setAirplaneFlag(false);
  attempts = [];
  unpinned = 0;
  tally = freshTally(Date.now());
  nextId = 1;
  listeners.clear();
  on = false;
  since = null;
  installed = false;
  openSockets.clear();
  inFlight.clear();
  popups.clear();
  bodies = [];
  channel?.close();
  channel = null;
}

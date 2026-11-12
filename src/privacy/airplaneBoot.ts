/**
 * Airplane mode at start-up (plan W5.9) — the small part that must run
 * before anything else (src/main.tsx imports it second, after Trusted Types).
 *
 * When the switch is on, a Content-Security-Policy <meta> goes into the page
 * at once: from then on the browser itself refuses every image, font, media
 * file, frame and connection to another site. The wrappers and the live list
 * of attempts (src/privacy/airplane.ts) load right after, off the startup
 * bundle.
 *
 * Frames: a URL-loaded frame (the playground and live-js runners) runs under
 * its own header policy, not this <meta>, so `frame-src` allows only blob:
 * while the switch is on: the browser refuses to load those pages at all
 * (review 12.11). srcdoc and blob: frames inherit this policy.
 *
 * Workers: this module also answers their "is airplane mode on?" question
 * (src/ai/workerLedger.ts) from the startup bundle, so the answer never
 * depends on a lazy chunk loading. A worker that hears nothing blocks. Each
 * window answers only its own workers (AIRPLANE_TAB, review 2).
 */

export const AIRPLANE_KEY = "lumen.airplane";
const META_ID = "lumen-airplane-csp";

/** What the page may still load while the switch is on: itself, blob:, data:, loopback. */
export const AIRPLANE_CSP =
  "default-src 'self' blob: data:; script-src 'self' 'wasm-unsafe-eval' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; media-src 'self' blob: data:; font-src 'self' data:; frame-src blob:; worker-src 'self' blob:; connect-src 'self' blob: data: http://localhost:* http://127.0.0.1:* ws://localhost:* ws://127.0.0.1:*";

/** When the switch went on (ms since the epoch), or null when it is off. */
export function airplaneSinceStored(): number | null {
  try {
    const v = JSON.parse(localStorage.getItem(AIRPLANE_KEY) ?? "null") as { since?: unknown } | null;
    return v && typeof v.since === "number" ? v.since : null;
  } catch {
    return null;
  }
}

let on = airplaneSinceStored() !== null;

/** Is airplane mode on in this page? */
export function airplaneFlagOn(): boolean {
  return on;
}

/** The browser-enforced half: once added, the page cannot loosen it (turning off reloads). */
export function addAirplaneCsp(doc: Document = document): void {
  on = true;
  if (!doc?.head || typeof doc.getElementById !== "function" || doc.getElementById(META_ID)) return;
  const meta = doc.createElement("meta");
  meta.id = META_ID;
  meta.httpEquiv = "Content-Security-Policy";
  meta.content = AIRPLANE_CSP;
  doc.head.appendChild(meta);
}

if (on && typeof document !== "undefined" && document.head) addAirplaneCsp(document);

/** The workers' channel (the same name as AIRPLANE_CHANNEL in src/ai/workerLedger.ts). */
const WORKER_CHANNEL = "lumen-airplane";

/**
 * This window's id on the workers' channel (review 2, 12.11). The channel is
 * shared by every tab of the app, so a worker is told its window's id in its
 * name (`airplaneWorkerName`), says it in its "hello", and takes an answer
 * only from that window: another tab, still off, cannot switch it off.
 */
export const AIRPLANE_TAB: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
})();

/** A worker's name that carries this window's id (read back by src/ai/workerLedger.ts). */
export function airplaneWorkerName(label: string): string {
  return `${label}#lumen-tab=${AIRPLANE_TAB}`;
}

/**
 * Answer a worker's "hello" with the switch's state, at once. Exported for
 * tests; runs on load in a window. Returns the channel, or null.
 */
export function answerWorkers(make: () => Pick<BroadcastChannel, "postMessage" | "addEventListener"> = () => new BroadcastChannel(WORKER_CHANNEL)): Pick<BroadcastChannel, "postMessage" | "addEventListener"> | null {
  try {
    const ch = make();
    ch.addEventListener("message", ((e: MessageEvent<{ kind?: unknown } | null>) => {
      const m = e.data as { kind?: unknown; tab?: unknown } | null;
      if (m?.kind !== "hello") return;
      // A worker of another window: that window answers it.
      if (typeof m.tab === "string" && m.tab !== AIRPLANE_TAB) return;
      ch.postMessage(typeof m.tab === "string" ? { kind: "state", on, tab: m.tab } : { kind: "state", on });
    }) as EventListener);
    (ch as { unref?: () => void }).unref?.();
    return ch;
  } catch {
    // why: no BroadcastChannel here: workers then hear nothing and block (fail closed)
    return null;
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined" && typeof BroadcastChannel !== "undefined") answerWorkers();

/** Tests only: the flag as if the page had just loaded with it. */
export function __setAirplaneFlag(value: boolean): void {
  on = value;
}

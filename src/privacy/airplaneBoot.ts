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
 *
 * Other tabs (review 4, RR4-451-2): the storage listener is here too, so a
 * tab follows the switch even when the lazy chunk didn't load. It adds the
 * <meta>, blanks every frame with something in it (`blankFrames`)
 * and tells this window's workers "on". When airplane.ts is loaded, it does
 * the full switch instead (`onSwitchedElsewhere`), with the certificate.
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

const workerChannel = typeof window !== "undefined" && typeof document !== "undefined" && typeof BroadcastChannel !== "undefined" ? answerWorkers() : null;

/** A frame `blankFrames` stopped: its URL ("about:srcdoc" for an inline document) and title. */
export interface BlankedFrame {
  src: string;
  title: string;
}

/**
 * Shadow roots, open and closed (review 6, RR6-451-3): airplane.ts wraps
 * `attachShadow` and adds each root here, so a frame inside one can still be
 * found. A closed root made before that is out of reach.
 */
export const shadowRoots = new Set<WeakRef<ShadowRoot>>();

type Root = Pick<Document, "querySelectorAll">;

/** The document and every shadow root in it: the tracked ones, and open ones found on the way. */
export function rootsOf(doc: Root): Root[] {
  const out: Root[] = [doc];
  const seen = new Set<unknown>([doc]);
  for (const ref of [...shadowRoots]) {
    const r = ref.deref();
    if (!r) shadowRoots.delete(ref);
    else if (!seen.has(r)) {
      seen.add(r);
      out.push(r);
    }
  }
  for (let i = 0; i < out.length; i++) {
    let all: ArrayLike<Element> = [];
    try {
      all = out[i].querySelectorAll("*");
    } catch {
      /* why: a fake document */
    }
    for (const el of Array.from(all)) {
      const r = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (r && !seen.has(r)) {
        seen.add(r);
        out.push(r);
      }
    }
  }
  return out;
}

/** What a frame holds: its URL, "about:srcdoc", or null when it is empty (nothing loaded or written). */
function frameContent(f: HTMLIFrameElement): string | null {
  if (f.getAttribute("srcdoc") !== null) return "about:srcdoc";
  const src = f.getAttribute("src") ?? "";
  let here = "";
  try {
    here = f.contentWindow?.location?.href ?? "";
  } catch {
    // why: another origin's page is in it (a src, or a page script navigated it to)
    return src && src !== "about:blank" ? src : "about:navigated";
  }
  if (src && src !== "about:blank") return src;
  if (here && here !== "about:blank" && here !== "about:srcdoc") return here;
  try {
    const d = f.contentDocument;
    if (d && ((d.head?.childNodes.length ?? 0) > 0 || (d.body?.childNodes.length ?? 0) > 0)) return "about:blank";
  } catch {
    /* why: not readable: nothing written by this page */
  }
  return null;
}

/**
 * Stop every frame that has something in it (reviews 4 and 6): whatever
 * its sandbox, because CSS alone (an animation over background images, a
 * :hover image) makes requests without a script. A frame keeps the policy
 * it was created with (a srcdoc copies the page's policy then, and a
 * URL-loaded page has its own), so the <meta> added later doesn't reach it.
 * Its document is replaced by about:blank, which ends its scripts, timers,
 * animations and workers. Frames in shadow roots and frames a script
 * navigated count too (RR6-451-3), and so do <object> and <embed>.
 */
export function blankFrames(doc: Root): BlankedFrame[] {
  const out: BlankedFrame[] = [];
  for (const root of rootsOf(doc)) {
    try {
      for (const f of Array.from(root.querySelectorAll("iframe"))) {
        const src = frameContent(f);
        if (src === null) continue;
        f.removeAttribute("srcdoc");
        f.setAttribute("src", "about:blank");
        out.push({ src, title: f.title });
      }
      for (const o of Array.from(root.querySelectorAll("object, embed"))) {
        const attr = o.tagName.toLowerCase() === "object" ? "data" : "src";
        const src = o.getAttribute(attr);
        if (!src || src === "about:blank") continue;
        if (attr === "data") o.setAttribute("data", "about:blank");
        else o.removeAttribute("src");
        out.push({ src, title: o.getAttribute("title") ?? "" });
      }
    } catch {
      /* why: no frames to reach here */
    }
  }
  return out;
}

const elsewhere: Array<() => void> = [];

/** airplane.ts: run the full switch when another tab turns it on (instead of the minimal one here). */
export function onSwitchedElsewhere(fn: () => void): void {
  elsewhere.push(fn);
}

/** Another tab turned the switch on: on here too (turning it off there reloads only that tab). */
export function followOtherTab(e: Pick<StorageEvent, "key" | "newValue">, doc: Document = document, full: ReadonlyArray<() => void> = elsewhere): void {
  if (e.key !== AIRPLANE_KEY || e.newValue === null || on) return;
  if (full.length) {
    for (const fn of full) fn();
    return;
  }
  addAirplaneCsp(doc);
  blankFrames(doc);
  try {
    workerChannel?.postMessage({ kind: "state", on: true, tab: AIRPLANE_TAB });
  } catch {
    /* why: a closed channel: workers that ask again hear "on" */
  }
}

if (typeof window !== "undefined" && typeof document !== "undefined") {
  try {
    window.addEventListener("storage", (e) => followOtherTab(e));
  } catch {
    /* why: no storage events here */
  }
}

/** Tests only: the flag as if the page had just loaded with it. */
export function __setAirplaneFlag(value: boolean): void {
  on = value;
}

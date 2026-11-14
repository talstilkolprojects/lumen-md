/**
 * Plan W6.45: the in-page probes of the responsiveness specs, shared by
 * e2e/inp-devices.spec.ts (desktop, emulated phone, real BrowserStack
 * devices). Every function here runs in the page (page.evaluate), so it uses
 * nothing from its module scope.
 *
 *   INP            Event Timing API: per interaction (interactionId), the
 *                  longest entry's duration (input → next paint). The browser
 *                  reports only entries ≥ durationThreshold (16 ms); an
 *                  interaction it does not report counts as 16 ms.
 *   keypress→paint from a keydown's timeStamp to the frame after it: rAF runs
 *                  before the paint, and a message posted from it lands once
 *                  that frame is painted. Works where Event Timing does not
 *                  (Safari).
 */

export interface InpEntry {
  id: number;
  start: number;
  duration: number;
  name: string;
}

declare global {
  interface Window {
    __lumenInp?: InpEntry[];
    __lumenK2p?: number[];
  }
}

/** Whether this engine reports Event Timing ("event" entries with interactionId). */
export function supportsEventTiming(): boolean {
  const types = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes ?? [];
  return types.includes("event") && "interactionId" in (globalThis.PerformanceEventTiming?.prototype ?? {});
}

/** Start collecting Event Timing entries into window.__lumenInp. */
export function installInpObserver(): boolean {
  const types = (PerformanceObserver as unknown as { supportedEntryTypes?: readonly string[] }).supportedEntryTypes ?? [];
  if (!types.includes("event")) return false;
  const seen: InpEntry[] = [];
  window.__lumenInp = seen;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries() as PerformanceEventTiming[]) {
      if (e.interactionId) seen.push({ id: e.interactionId, start: e.startTime, duration: e.duration, name: e.name });
    }
  }).observe({ type: "event", durationThreshold: 16, buffered: false } as PerformanceObserverInit);
  return true;
}

/** Start timing every keydown to the frame after it, into window.__lumenK2p. */
export function installKeyToPaint(): void {
  const times: number[] = [];
  window.__lumenK2p = times;
  document.addEventListener(
    "keydown",
    (e) => {
      const t0 = e.timeStamp;
      requestAnimationFrame(() => {
        const ch = new MessageChannel();
        ch.port1.onmessage = () => times.push(performance.now() - t0);
        ch.port2.postMessage(0);
      });
    },
    { capture: true },
  );
}

/** Resolve after two frames: the one an input produced and the next. */
export function twoFrames(): Promise<void> {
  return new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
}

// ── Node side ──

/** The q-quantile, nearest-rank (q = 0.75 → p75). 0 for no values. */
export function quantile(values: readonly number[], q: number): number {
  const s = [...values].sort((a, b) => a - b);
  if (!s.length) return 0;
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
}

/**
 * Durations per step from the Event Timing entries and each step's start
 * time: the longest entry that started in the step's window, 16 ms when the
 * browser reported none (it reports only entries of 16 ms or more).
 */
export function interactionsFromEntries(names: readonly string[], starts: readonly number[], entries: readonly InpEntry[]): { name: string; ms: number }[] {
  return names.map((name, i) => {
    const from = starts[i];
    const to = starts[i + 1] ?? Number.POSITIVE_INFINITY;
    const own = entries.filter((e) => e.start >= from && e.start < to).map((e) => e.duration);
    return { name, ms: own.length ? Math.max(...own) : 16 };
  });
}

/** A note of about `bytes` bytes of ordinary Markdown (headings, links, tasks, code), in English and Hebrew. */
export function noteOfSize(bytes: number): string {
  let s = "";
  for (let i = 0; s.length < bytes; i++) {
    s += `## Section ${i}\n\nParagraph ${i} with **bold** text, a [[n${i}]] link and \`code\`. שורה ${i} בעברית עם **הדגשה**.\n\n- [ ] task ${i}\n- two\n\n`;
    if (i % 50 === 0) s += "```js\nconst x = " + i + ";\n```\n\n";
  }
  return s;
}

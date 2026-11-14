/**
 * Widgets, Shortcuts and Siri (plan W3.4): the seam between the native
 * parts and the app.
 *
 * Every native entry point ends in one of two things the WebView handles:
 *
 * 1. **An action link** `lumen://<action>?…`, opened by a home-screen
 *    widget button, an Android App Shortcut, a Siri / Spotlight App
 *    Intent that opens the app, or any other app:
 *
 *    | Link | Opens |
 *    |---|---|
 *    | `lumen://capture` | the quick-capture box, focused for typing |
 *    | `lumen://capture?mode=voice` | the box, recording a voice note |
 *    | `lumen://capture?text=…` | adds the text to the inbox, no box |
 *    | `lumen://new` | a new note |
 *    | `lumen://search` · `lumen://search?q=…` | search, with the query |
 *    | `lumen://daily` | today's daily note |
 *
 *    A widget adds `t=<ms since epoch>` (the tap time), so the app can
 *    log how long the tap took to become a cursor (target: under 1 s).
 *
 * 2. **The pending-captures queue**: "Add to inbox" in Shortcuts / Siri
 *    runs without opening the app (the note lives in the WebView's storage,
 *    which a background intent can't reach), so the intent queues the text
 *    natively and the app adds it to the inbox the next time it starts or
 *    comes to the front, each entry with the time it was captured.
 *
 * The native code (ios/App/App/LumenNativePlugin.swift,
 * android/…/LumenNativePlugin.java) only forwards links and hands over the
 * queue; every decision is here, and tested.
 */

export type NativeAction =
  | { kind: "capture"; mode: "text" | "voice"; text: string | null }
  | { kind: "new" }
  | { kind: "search"; query: string }
  | { kind: "daily" };

export interface ParsedAction {
  action: NativeAction;
  /** When the widget was tapped (ms since epoch), if it said. */
  tappedAt: number | null;
}

export const MAX_TEXT = 8 * 1024;

const clean = (s: string) => [...s].filter((c) => c === "\n" || c === "\t" || c.charCodeAt(0) >= 0x20).join("");

/** Parse an action link; null for anything else (the app ignores it). */
export function parseNativeUrl(url: string): ParsedAction | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "lumen:") return null;
  // `lumen://capture` → host "capture"; `lumen:capture` → pathname "capture".
  const action = (u.host || u.pathname.replace(/^\/+/, "")).replace(/\/+$/, "").toLowerCase();
  const q = u.searchParams;
  const t = Number(q.get("t"));
  const tappedAt = Number.isFinite(t) && t > 1e12 && t < 1e14 ? t : null;
  const text = q.get("text");
  if (text !== null && text.length > MAX_TEXT) return null;
  switch (action) {
    case "capture": {
      const mode = q.get("mode") === "voice" ? "voice" : "text";
      const body = text === null ? null : clean(text).trim() || null;
      return { action: { kind: "capture", mode, text: mode === "voice" ? null : body }, tappedAt };
    }
    case "new":
      return { action: { kind: "new" }, tappedAt };
    case "search": {
      const query = clean(q.get("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      return { action: { kind: "search", query }, tappedAt };
    }
    case "daily":
      return { action: { kind: "daily" }, tappedAt };
    default:
      return null;
  }
}

/** A capture queued by a native intent while the app wasn't running. */
export interface PendingCapture {
  id: string;
  text: string;
  /** ISO 8601, when it was captured. */
  at: string;
}

/** Keep only well-formed captures, oldest first, without repeats. */
export function validPending(items: unknown): PendingCapture[] {
  if (!Array.isArray(items)) return [];
  const seen = new Set<string>();
  const out: PendingCapture[] = [];
  for (const x of items) {
    const p = x as Partial<PendingCapture>;
    if (typeof p?.id !== "string" || typeof p.text !== "string" || typeof p.at !== "string") continue;
    if (seen.has(p.id) || !p.text.trim() || p.text.length > MAX_TEXT || !Number.isFinite(Date.parse(p.at))) continue;
    seen.add(p.id);
    out.push({ id: p.id, text: clean(p.text).trim(), at: p.at });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Add queued captures to the inbox, each with its own time. Returns the ids
 * added; the native side deletes only those, so a failure keeps the rest
 * for next time.
 */
export async function drainPending(items: unknown, capture: (text: string, when: Date) => Promise<unknown>): Promise<string[]> {
  const done: string[] = [];
  for (const p of validPending(items)) {
    try {
      await capture(p.text, new Date(p.at));
      done.push(p.id);
    } catch {
      break; // keep this one and the rest, in order
    }
  }
  return done;
}

/** Tap → typing, in ms, when the widget sent its tap time (and the clocks agree). */
export function tapLatency(tappedAt: number | null, readyAt: number): number | null {
  if (tappedAt === null) return null;
  const ms = readyAt - tappedAt;
  return ms >= 0 && ms < 60_000 ? ms : null;
}

export interface NativeHandlers {
  capture: (mode: "text" | "voice", tappedAt: number | null) => void;
  captureText: (text: string, when: Date) => Promise<unknown>;
  newNote: () => void;
  search: (query: string) => void;
  daily: () => void;
}

export function applyAction(p: ParsedAction, h: NativeHandlers): void {
  const a = p.action;
  if (a.kind === "capture") {
    if (a.text) void h.captureText(a.text, new Date());
    else h.capture(a.mode, p.tappedAt);
  } else if (a.kind === "new") h.newNote();
  else if (a.kind === "search") h.search(a.query);
  else h.daily();
}

/** The native plugin's shape (both platforms implement it). */
export interface LumenNativePlugin {
  /** The link the app was launched with, once (cold start). */
  getLaunchUrl(): Promise<{ url: string | null }>;
  /** Pending captures from Siri / Shortcuts. */
  pendingCaptures(): Promise<{ items: unknown }>;
  /** Forget the captures that were added. */
  removeCaptures(o: { ids: string[] }): Promise<void>;
  addListener(event: "url" | "resume", fn: (e: { url?: string }) => void): Promise<{ remove: () => Promise<void> }>;
}

const isNativeApp = () => typeof window !== "undefined" && !!(window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.();

/** Start the bridge in the iOS / Android app; a no-op on the web and desktop. */
export async function initNativeBridge(h: NativeHandlers, plugin?: LumenNativePlugin): Promise<() => void> {
  if (!plugin && !isNativeApp()) return () => {};
  const p = plugin ?? (await import("@capacitor/core")).registerPlugin<LumenNativePlugin>("LumenNative");
  const onUrl = (url: string | null | undefined) => {
    const parsed = url ? parseNativeUrl(url) : null;
    if (parsed) applyAction(parsed, h);
  };
  const drain = async () => {
    try {
      const { items } = await p.pendingCaptures();
      const ids = await drainPending(items, h.captureText);
      if (ids.length) await p.removeCaptures({ ids });
    } catch {
      /* the plugin is missing in this build: nothing queued */
    }
  };
  const subs = await Promise.all([p.addListener("url", (e) => onUrl(e.url)), p.addListener("resume", () => void drain())]).catch(() => []);
  try {
    onUrl((await p.getLaunchUrl()).url);
  } catch {
    /* no launch link */
  }
  await drain();
  return () => subs.forEach((s) => void s.remove());
}

let pendingTap: number | null = null;
let lastLatency: number | null = null;

/** A widget tap is on its way to the quick-capture box. */
export function noteTap(tappedAt: number | null): void {
  pendingTap = tappedAt;
}

/** The box has the cursor: the tap's latency, kept for diagnostics (local only). */
export function tapReady(now: number = Date.now()): number | null {
  const ms = tapLatency(pendingTap, now);
  pendingTap = null;
  if (ms !== null) lastLatency = ms;
  return ms;
}

/** The last widget tap → typing time, in ms (Settings → diagnostics, and the manual test). */
export const lastTapLatency = (): number | null => lastLatency;

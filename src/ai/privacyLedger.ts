/**
 * Privacy ledger (T37): every network request the AI features make is
 * recorded — where it went, how many bytes left and came back, why, and
 * under which AI policy — and a request that the policy forbids is blocked
 * before it leaves the machine.
 *
 * It wraps `window.fetch` once at startup, so it sees the requests of every
 * AI module (providers, embeddings, transcription, grammar, research, model
 * downloads) without each call site having to remember it. Only AI traffic
 * is logged; fonts, sync and the app's own files are not.
 *
 * What is stored: time, host, method, byte counts, category, reason,
 * policy, decision. Never the prompt, the response or any header.
 *
 * Files the browser loads by itself (a FontFace, an image, a CSS `url()`)
 * never pass through `fetch`; for the canvas CDN (tldraw's fonts and icons)
 * they are recorded from the Resource Timing API after they load. The
 * ledger can log those, not block them.
 *
 * Not covered: requests made from inside Web Workers (web-llm and
 * transformers.js fetch model weights there — downloads, no user text),
 * unless the module that starts the worker reports them with
 * `recordWorkerRequest`. (The OCR language models are served from this
 * origin since plan 7.5, so OCR has nothing to report.)
 */
import { getAiPolicy, isLocalOrigin, type AiPolicy } from "./policy";
import { getBaseUrl } from "./ollamaProvider";
import { grammarEndpoint } from "./grammar";
import { researchEndpoint } from "../research/client";
import { LEDGER_CHANNEL, type WorkerLedgerMessage } from "./workerLedger";
import { monitoringEndpoint } from "../lib/telemetry";

export type LedgerCategory = "cloud-ai" | "cloud-text" | "local-ai" | "model-download" | "static-asset" | "research" | "third-party" | "monitoring" | "plugin";

/** How an error report is listed (plan 12.4: sent only with consent and a DSN). */
export const MONITORING_REASON = "Error report (Sentry / GlitchTip), content removed";

export interface LedgerEntry {
  id: number;
  ts: number;
  host: string;
  method: string;
  bytesOut: number;
  bytesIn: number | null;
  category: LedgerCategory;
  reason: string;
  policy: AiPolicy;
  decision: "allowed" | "blocked";
  status?: number;
  /** Allowed under `local-only` because the user consented to this request (an agent network tool). */
  consent?: boolean;
}

/** Thrown (as the fetch rejection) when the policy forbids a request. */
export class PrivacyBlockedError extends Error {
  constructor(public readonly host: string, public readonly reason: string) {
    super(`Blocked by the local-only AI policy: ${reason} (${host})`);
    this.name = "PrivacyBlockedError";
  }
}

interface Rule {
  test: (host: string, path: string) => boolean;
  category: LedgerCategory;
  reason: string;
}

const RULES: Rule[] = [
  { test: (h) => h === "api.openai.com", category: "cloud-ai", reason: "OpenAI" },
  { test: (h) => h === "api.anthropic.com", category: "cloud-ai", reason: "Anthropic (Claude)" },
  { test: (h) => h === "generativelanguage.googleapis.com", category: "cloud-ai", reason: "Google Gemini" },
  { test: (h) => h === "api.mistral.ai", category: "cloud-ai", reason: "Mistral" },
  { test: (h) => h === "api.languagetool.org", category: "cloud-text", reason: "LanguageTool grammar check" },
  { test: (h) => h === "kroki.io", category: "cloud-text", reason: "PlantUML rendering (kroki.io)" },
  // Jewish sources (plan W5.1): the reference the user asked for, nothing else.
  { test: (h) => h === "www.sefaria.org" || h === "sefaria.org", category: "cloud-text", reason: "Jewish sources (Sefaria): the reference only" },
  {
    test: (h) => h === "huggingface.co" || h.endsWith(".huggingface.co") || h.endsWith(".hf.co") || h === "hf.co",
    category: "model-download",
    reason: "Model download (Hugging Face)",
  },
  // Excalidraw (the canvas, plan 4.19) names esm.sh as the fallback for its
  // fonts. Lumen serves them from its own origin (EXCALIDRAW_ASSET_PATH), so
  // this host is never needed; a request to it would be third-party traffic.
  { test: (h) => h === "esm.sh", category: "third-party", reason: "Excalidraw font fallback CDN (not needed: fonts are served locally)" },
  {
    test: (h) => h === "raw.githubusercontent.com",
    category: "model-download",
    reason: "Dictionary / OCR model download (GitHub)",
  },
  // webR, the R runtime, downloaded only when the user asks from an R block
  // (plan W1.34: GPL-3.0, so not part of the app): webR's own CDN, then its
  // npm package on jsDelivr. Any other jsDelivr request is third-party traffic.
  { test: (h) => h === "webr.r-wasm.org", category: "model-download", reason: "webR (R runtime) download" },
  { test: (h, p) => h === "cdn.jsdelivr.net" && p.startsWith("/npm/webr@"), category: "model-download", reason: "webR (R runtime) download" },
  { test: (h) => h === "cdn.jsdelivr.net", category: "third-party", reason: "jsDelivr CDN (only the webR download is expected)" },
];

const MAX_ENTRIES = 500;
const PERSIST_KEY = "lumen.privacy.ledger";
const PERSIST_LAST = 200;

let entries: LedgerEntry[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
let installed = false;
let onBlocked: ((entry: LedgerEntry) => void) | null = null;

function load(): void {
  try {
    const raw = localStorage.getItem(PERSIST_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) {
      entries = parsed.filter((e): e is LedgerEntry => !!e && typeof e === "object" && typeof (e as LedgerEntry).host === "string");
      nextId = entries.reduce((m, e) => Math.max(m, e.id), 0) + 1;
    }
  } catch {
    entries = [];
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function save(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(PERSIST_KEY, JSON.stringify(entries.slice(-PERSIST_LAST)));
    } catch {
      /* why: storage full / denied */
    }
  }, 500);
}

function emit(): void {
  for (const fn of [...listeners]) fn();
}

// `entries` is an immutable snapshot (useSyncExternalStore compares by
// reference): every change replaces the array and the changed entry.
function record(e: Omit<LedgerEntry, "id" | "ts">): number {
  const entry: LedgerEntry = { ...e, id: nextId++, ts: Date.now() };
  entries = [...entries, entry].slice(-MAX_ENTRIES);
  save();
  emit();
  return entry.id;
}

function patch(id: number, change: Partial<LedgerEntry>): void {
  entries = entries.map((x) => (x.id === id ? { ...x, ...change } : x));
  save();
  emit();
}

/** Is `u` one of the configured endpoint's request URLs (same origin, exact path)? */
function atEndpoint(u: URL, endpoint: string | null | undefined, suffixes: readonly string[] = [""]): boolean {
  if (!endpoint) return false;
  let e: URL;
  try {
    e = new URL(endpoint, typeof location !== "undefined" ? location.href : "http://localhost/");
  } catch {
    return false;
  }
  if (e.origin !== u.origin) return false;
  const base = e.pathname.replace(/\/+$/, "");
  return suffixes.some((sfx) => u.pathname === `${base}${sfx}` || (base === "" && sfx === "" && u.pathname === "/"));
}

/** How a URL is treated, or null for traffic the ledger doesn't track. */
export function classify(url: string): { host: string; category: LedgerCategory; reason: string } | null {
  let u: URL;
  try {
    u = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost/");
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  // why: the error tracker named by the build's DSN, wherever it is hosted (Sentry, a self-hosted GlitchTip, even this origin)
  const tracker = monitoringEndpoint();
  if (tracker && u.href.startsWith(tracker)) return { host, category: "monitoring", reason: MONITORING_REASON };
  for (const r of RULES) if (r.test(host, u.pathname)) return { host, category: r.category, reason: r.reason };
  let ollamaHost = "";
  try {
    ollamaHost = new URL(getBaseUrl()).host.toLowerCase();
  } catch {
    /* why: no Ollama configured */
  }
  if (ollamaHost && u.host.toLowerCase() === ollamaHost) {
    return isLocalOrigin(u.href)
      ? { host, category: "local-ai", reason: "Ollama (this machine / LAN)" }
      : { host, category: "cloud-ai", reason: "Ollama on a remote server" };
  }
  // The configured endpoints, wherever they are hosted (a self-hosted
  // LanguageTool, a research worker on any domain).
  let grammar: string | null = null;
  try {
    grammar = grammarEndpoint();
  } catch {
    /* why: no grammar endpoint configured: nothing to match */
  }
  if (atEndpoint(u, grammar)) {
    return isLocalOrigin(u.href)
      ? { host, category: "local-ai", reason: "LanguageTool (this machine / LAN)" }
      : { host, category: "cloud-text", reason: "LanguageTool grammar check" };
  }
  let research: string | null = null;
  try {
    research = researchEndpoint();
  } catch {
    /* why: no research endpoint configured: nothing to match */
  }
  if (atEndpoint(u, research, ["/extract", "/search"])) {
    return isLocalOrigin(u.href)
      ? { host, category: "local-ai", reason: "Research (local service)" }
      : { host, category: "research", reason: "Research service" };
  }
  if (/\/(search|extract)(\?|$)/.test(u.pathname) && /research|searx/i.test(u.href)) {
    return isLocalOrigin(u.href)
      ? { host, category: "local-ai", reason: "Research (local SearXNG)" }
      : { host, category: "research", reason: "Research service" };
  }
  return null;
}

/** Categories whose requests carry the user's data (text, a query, the page address, an error report, a plugin's request). */
const CARRIES_DATA: ReadonlySet<LedgerCategory> = new Set(["cloud-ai", "cloud-text", "research", "third-party", "monitoring", "plugin"]);

/** Would the policy block this category? Model downloads and static assets carry no user data. */
export function blockedByPolicy(category: LedgerCategory, policy: AiPolicy): boolean {
  if (policy !== "local-only") return false;
  return CARRIES_DATA.has(category);
}

function bodySize(body: BodyInit | null | undefined): number {
  if (body == null) return 0;
  if (typeof body === "string") return new TextEncoder().encode(body).length;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof URLSearchParams) return new TextEncoder().encode(body.toString()).length;
  if (typeof FormData !== "undefined" && body instanceof FormData) {
    let n = 0;
    body.forEach((v) => {
      n += typeof v === "string" ? v.length : v.size;
    });
    return n;
  }
  return 0;
}

export interface LedgerOptions {
  /**
   * Record every request, also traffic `classify` doesn't track, with this
   * category and reason (an agent network tool: its requests always count).
   */
  force?: { category: LedgerCategory; reason: string };
  /** The user consented to these requests: `local-only` does not block them (they are still recorded). */
  consent?: boolean;
}

function hostOf(url: string): string {
  try {
    return new URL(url, typeof location !== "undefined" ? location.href : "http://localhost/").hostname.toLowerCase();
  } catch {
    return url;
  }
}

/** Bytes of the URL's query string: a GET sends its data there (tldraw's licence beacon sends the page address). */
function querySize(url: string): number {
  try {
    // `search` is percent-encoded ASCII, so its length is the byte count on the wire.
    const q = new URL(url, typeof location !== "undefined" ? location.href : "http://localhost/").search;
    return Math.max(0, q.length - 1);
  } catch {
    return 0;
  }
}

/** Wrap a fetch implementation with the ledger. Exported for tests. */
export function withLedger(inner: typeof fetch, opts: LedgerOptions = {}): typeof fetch {
  return async function ledgerFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const classified = classify(url);
    const hit = opts.force ? { host: classified?.host ?? hostOf(url), category: opts.force.category, reason: opts.force.reason } : classified;
    if (!hit) return inner(input, init);
    const policy = getAiPolicy();
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const bytesOut = bodySize(init?.body) + querySize(url);
    if (!opts.consent && blockedByPolicy(hit.category, policy)) {
      const id = record({ ...hit, method, bytesOut: 0, bytesIn: null, policy, decision: "blocked" });
      const entry = entries.find((x) => x.id === id);
      if (entry) onBlocked?.(entry);
      throw new PrivacyBlockedError(hit.host, hit.reason);
    }
    const consented = !!opts.consent && blockedByPolicy(hit.category, policy);
    const id = record({ ...hit, method, bytesOut, bytesIn: null, policy, decision: "allowed", ...(consented ? { consent: true } : {}) });
    const res = await inner(input, init);
    const len = Number(res.headers.get("content-length"));
    patch(id, {
      bytesIn: Number.isFinite(len) && res.headers.has("content-length") ? len : null,
      status: res.status,
    });
    return res;
  };
}

/**
 * Record a request a Web Worker is about to make (the wrapped `window.fetch`
 * cannot see it). Only tracked traffic is recorded; model downloads are
 * never blocked, so this only logs. Returns the entry, or null.
 */
export function recordWorkerRequest(url: string, method = "GET"): LedgerEntry | null {
  const hit = classify(url);
  if (!hit) return null;
  const id = record({ ...hit, method, bytesOut: 0, bytesIn: null, policy: getAiPolicy(), decision: "allowed" });
  return entries.find((x) => x.id === id) ?? null;
}

/**
 * Record speech sent to a network voice (Web Speech synthesis is not a fetch the
 * ledger can see). Only called when the policy and the user's opt-in allow it.
 */
export function recordSpeechVoice(voice: string, lang: string, bytes: number): LedgerEntry | null {
  const id = record({ host: `speech voice: ${voice}`, method: "SPEAK", bytesOut: bytes, bytesIn: null, category: "cloud-text", reason: `Read aloud (${lang}) with a network voice`, policy: getAiPolicy(), decision: "allowed" });
  return entries.find((x) => x.id === id) ?? null;
}

/**
 * Add the size of another sentence sent through the same network voice (one
 * entry per voice per reading). Returns false when the entry is gone (the
 * ledger was cleared, or the entry was evicted), so the caller records a new one.
 */
export function addSpeechVoiceBytes(id: number, bytes: number): boolean {
  const e = entries.find((x) => x.id === id);
  if (!e) return false;
  patch(id, { bytesOut: e.bytesOut + bytes });
  return true;
}

/**
 * Record use of the browser's speech recognition service (Chrome sends the audio
 * to Google). "blocked" when local-only refused it.
 */
export function recordSpeechRecognition(decision: "allowed" | "blocked"): LedgerEntry | null {
  const id = record({ host: "browser speech recognition", method: "AUDIO", bytesOut: 0, bytesIn: null, category: "cloud-text", reason: "Dictation through the browser's speech service", policy: getAiPolicy(), decision });
  return entries.find((x) => x.id === id) ?? null;
}

/**
 * Record a request that was refused before it was made (an agent network
 * tool under `local-only` without consent) and return the error to throw.
 */
export function recordBlockedRequest(url: string, category: LedgerCategory, reason: string, method = "GET"): PrivacyBlockedError {
  const host = hostOf(url);
  const id = record({ host, category, reason, method, bytesOut: 0, bytesIn: null, policy: getAiPolicy(), decision: "blocked" });
  const entry = entries.find((x) => x.id === id);
  if (entry) onBlocked?.(entry);
  return new PrivacyBlockedError(host, reason);
}

/** The page's own fetch before the ledger wrapped it (so a ledger fetch built on it records each request once). */
let unwrappedFetch: typeof fetch | null = null;

/**
 * A fetch that records every request in the ledger under `opts` — for a
 * caller that already decided the request may go (the agent network-tool
 * gate). Built on the unwrapped fetch, so the global wrapper neither
 * records it twice nor blocks a request the user consented to.
 */
export function ledgerFetch(opts: LedgerOptions): typeof fetch {
  const base: typeof fetch = unwrappedFetch ?? ((input, init) => globalThis.fetch(input, init));
  return withLedger(base, opts);
}

let rawFetch: typeof fetch | null = null;

/**
 * Requests that workers report (workerLedger.ts): recorded with the same
 * rules as the window's own. Untracked traffic (same origin) is ignored.
 * Exported for tests.
 */
export function listenToWorkerLedger(channel: Pick<BroadcastChannel, "addEventListener">): void {
  const ids = new Map<string, number>();
  channel.addEventListener("message", (ev: Event) => {
    const m = (ev as MessageEvent<WorkerLedgerMessage>).data;
    if (!m || typeof m !== "object") return;
    if (m.kind === "start" && typeof m.url === "string") {
      const hit = classify(m.url);
      if (!hit) return;
      const id = record({ ...hit, reason: `${hit.reason} (worker: ${m.worker})`, method: m.method || "GET", bytesOut: m.bytesOut || 0, bytesIn: null, policy: getAiPolicy(), decision: "allowed" });
      ids.set(m.id, id);
    } else if (m.kind === "end") {
      const id = ids.get(m.id);
      if (id === undefined) return;
      ids.delete(m.id);
      patch(id, { status: m.status, bytesIn: m.bytesIn });
    }
  });
}

/**
 * Throw `PrivacyBlockedError` (and record the block) when the policy forbids
 * `as.category` — for a request that goes out some other way than this
 * window's fetch, such as the research service fetching a page for the
 * clipper. Returns normally when allowed; recording the allowed request is
 * the caller's job (`guardedFetch` does it).
 */
export function refuseIfBlocked(
  url: string,
  as: { category: LedgerCategory; reason: string; quiet?: boolean },
  method = "GET",
): void {
  const policy = getAiPolicy();
  if (!blockedByPolicy(as.category, policy)) return;
  const host = hostOf(url);
  const id = record({ host, category: as.category, reason: as.reason, method, bytesOut: 0, bytesIn: null, policy, decision: "blocked" });
  const entry = entries.find((x) => x.id === id);
  // `quiet`: the caller shows its own, more specific message (the clipper's "clip from clipboard" hint)
  if (entry && !as.quiet) onBlocked?.(entry);
  throw new PrivacyBlockedError(host, as.reason);
}

/**
 * A request the app makes on the user's behalf to an address the rules
 * cannot know in advance (the web clipper fetching a page): recorded under
 * the given category and blocked when the policy forbids that category.
 */
export async function guardedFetch(url: string, init: RequestInit, as: { category: LedgerCategory; reason: string }): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  refuseIfBlocked(url, as, method);
  const host = hostOf(url);
  const policy = getAiPolicy();
  const id = record({ host, category: as.category, reason: as.reason, method, bytesOut: bodySize(init.body), bytesIn: null, policy, decision: "allowed" });
  // why: the raw fetch, so a host the rules also know is not recorded twice
  const res = await (rawFetch ?? fetch)(url, init);
  const len = res.headers.get("content-length");
  // why: after a redirect the page came from `res.url`'s site; record that host, keeping where it started
  const finalHost = res.redirected && res.url ? hostOf(res.url) : host;
  patch(id, {
    status: res.status,
    bytesIn: len != null && Number.isFinite(Number(len)) ? Number(len) : null,
    ...(finalHost !== host ? { host: finalHost, reason: `${as.reason} (redirected from ${host})` } : {}),
  });
  return res;
}

/** Categories whose files the browser itself loads (tldraw's FontFace fonts and CSS icons). */
const BROWSER_LOADED: ReadonlySet<LedgerCategory> = new Set(["static-asset", "third-party"]);

/**
 * Record a file the browser loaded by itself, from its Resource Timing
 * entry: a FontFace, an image, a CSS `url()` — requests `fetch` never sees.
 * `fetch()` entries are skipped (the wrapper recorded them, or blocked them
 * before they left). Only the canvas CDN's categories are recorded: an image
 * in a note that happens to sit on a model host is not AI traffic, and must
 * not show up as a model download. Exported for tests.
 */
export function recordBrowserResource(e: Pick<PerformanceResourceTiming, "name" | "initiatorType" | "transferSize">): LedgerEntry | null {
  if (e.initiatorType === "fetch") return null;
  if (typeof location !== "undefined") {
    try {
      if (new URL(e.name, location.href).origin === location.origin) return null; // the app's own files
    } catch {
      return null;
    }
  }
  const hit = classify(e.name);
  if (!hit || !BROWSER_LOADED.has(hit.category)) return null;
  // transferSize is 0 for a cross-origin file without Timing-Allow-Origin: unknown, not empty.
  const id = record({ ...hit, method: "GET", bytesOut: querySize(e.name), bytesIn: e.transferSize > 0 ? e.transferSize : null, policy: getAiPolicy(), decision: "allowed" });
  return entries.find((x) => x.id === id) ?? null;
}

function observeBrowserResources(): void {
  if (typeof PerformanceObserver === "undefined") return;
  try {
    const observer = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) recordBrowserResource(e as PerformanceResourceTiming);
    });
    observer.observe({ type: "resource", buffered: true });
  } catch {
    // why: an engine without resource timing — fetch traffic is still recorded
  }
}

/**
 * Record a cloud service the browser itself talks to, which no fetch shows
 * (the Web Speech API streams the microphone to the browser's vendor).
 * Under local-only it is recorded as blocked and the caller must not start it.
 */
export function recordBrowserService(host: string, reason: string): LedgerEntry {
  const policy = getAiPolicy();
  const decision = blockedByPolicy("cloud-ai", policy) ? "blocked" : "allowed";
  const id = record({ host, category: "cloud-ai", reason, method: "STREAM", bytesOut: 0, bytesIn: null, policy, decision });
  return entries.find((x) => x.id === id)!;
}

/**
 * A plugin's network request (plan 11.2): only to an origin the user granted
 * the plugin, and never under local-only — then it is recorded as blocked and
 * not sent. Returns the entry so the response size can be added.
 */
export function recordPluginRequest(pluginId: string, url: string, method: string, bytesOut: number): LedgerEntry {
  let host = "?";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    /* why: keep "?" */
  }
  const policy = getAiPolicy();
  const decision = blockedByPolicy("plugin", policy) ? "blocked" : "allowed";
  const id = record({ host, method, bytesOut, bytesIn: null, category: "plugin", reason: `Plugin ${pluginId}`, policy, decision });
  const entry = entries.find((x) => x.id === id)!;
  if (decision === "blocked") onBlocked?.(entry);
  return entry;
}

/** Response size and status of a recorded request. */
export function completeLedgerEntry(id: number, status: number, bytesIn: number | null): void {
  patch(id, { status, bytesIn });
}

/**
 * Record a desktop update check (plan 11.5): the Rust shell asks the release
 * server whether a newer version exists. It sends the app version and the
 * platform, no user data; "blocked" when local-only refused it.
 */
export function recordAppUpdateCheck(host: string, decision: "allowed" | "blocked"): LedgerEntry | null {
  const id = record({ host, method: "GET", bytesOut: 0, bytesIn: null, category: "static-asset", reason: "Desktop update check (app version and platform only)", policy: getAiPolicy(), decision });
  return entries.find((x) => x.id === id) ?? null;
}

/** Install once at startup. `blocked` is called for every blocked request. */
export function installPrivacyLedger(blocked?: (entry: LedgerEntry) => void): void {
  if (installed || typeof window === "undefined" || typeof window.fetch !== "function") return;
  installed = true;
  onBlocked = blocked ?? null;
  load();
  const original = window.fetch.bind(window);
  unwrappedFetch = original;
  rawFetch = original;
  window.fetch = withLedger(original);
  if (typeof BroadcastChannel !== "undefined") listenToWorkerLedger(new BroadcastChannel(LEDGER_CHANNEL));
  observeBrowserResources();
}

export function ledgerEntries(): readonly LedgerEntry[] {
  return entries;
}

export function subscribeLedger(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clearLedger(): void {
  entries = [];
  try {
    localStorage.removeItem(PERSIST_KEY);
  } catch {
    /* why: storage denied: the in-memory ledger is cleared, nothing was persisted */
  }
  emit();
}

/**
 * Did this request actually leave the device? Local traffic stays, and a
 * blocked attempt never reached the network.
 */
export function leftDevice(e: LedgerEntry): boolean {
  return e.decision === "allowed" && e.category !== "local-ai";
}

/** Totals for the panel header. */
export function ledgerSummary(list: readonly LedgerEntry[] = entries) {
  // why: the header says "left this device" — every allowed request that carried data counts, third-party included
  const cloud = list.filter((e) => e.decision === "allowed" && CARRIES_DATA.has(e.category));
  return {
    total: list.length,
    blocked: list.filter((e) => e.decision === "blocked").length,
    cloudRequests: cloud.length,
    cloudBytesOut: cloud.reduce((n, e) => n + e.bytesOut, 0),
    local: list.filter((e) => e.category === "local-ai").length,
    downloads: list.filter((e) => e.category === "model-download").length,
    // why: fonts and icons are not models — the panel labels this count separately
    staticAssets: list.filter((e) => e.category === "static-asset").length,
  };
}

/** Test hook. */
export function __resetLedger(): void {
  rawFetch = null;
  entries = [];
  nextId = 1;
  installed = false;
  onBlocked = null;
  unwrappedFetch = null;
  listeners.clear();
}

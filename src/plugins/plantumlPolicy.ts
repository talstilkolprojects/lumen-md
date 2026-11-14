/**
 * PlantUML diagrams are drawn by kroki.io, an online service: the diagram's
 * source leaves the device. Like every other third-party service (plan
 * 6.17), that happens only under the explicit `cloud` AI policy — or, under
 * local-only / local-first, for one diagram the user chose to send ("Render
 * with kroki.io" on that block). Every request is in the privacy ledger; a
 * blocked one is recorded once per diagram.
 */
import { getAiPolicy, thirdPartyServicesAllowed, type AiPolicy } from "../ai/policy";
import { ledgerFetch, recordBlockedRequest } from "../ai/privacyLedger";
import { fetchWithRetry } from "../lib/fetchRetry";

export const KROKI_URL = "https://kroki.io/plantuml/svg";
const OPT_IN_KEY = "lumen.plantuml.krokiOptIn";
const OPT_IN_MAX = 200;
const REASON = "PlantUML rendering (kroki.io)";

/** Diagrams sent this session, kept even when storage refuses the opt-in. */
const sessionOptIns = new Set<string>();
const recordedBlocks = new Set<string>();

/** Short, stable fingerprint of a diagram's source (FNV-1a). */
export function diagramId(source: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${h.toString(16).padStart(8, "0")}:${source.length}`;
}

function storedOptIns(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(OPT_IN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Did the user choose to send this exact diagram? (An edited diagram asks again.) */
export function krokiOptedIn(source: string): boolean {
  const id = diagramId(source);
  return sessionOptIns.has(id) || storedOptIns().includes(id);
}

/** The user chose to send this diagram to kroki.io. */
export function optInKroki(source: string): void {
  const id = diagramId(source);
  sessionOptIns.add(id);
  try {
    const list = storedOptIns().filter((x) => x !== id);
    localStorage.setItem(OPT_IN_KEY, JSON.stringify([...list, id].slice(-OPT_IN_MAX)));
  } catch {
    /* why: storage blocked: this session only */
  }
}

/** May this diagram go to kroki.io now? */
export function krokiAllowed(source: string, policy: AiPolicy = getAiPolicy()): boolean {
  return thirdPartyServicesAllowed(policy) || krokiOptedIn(source);
}

/** Thrown instead of a request the policy doesn't allow. */
export class KrokiBlockedError extends Error {
  constructor() {
    super("PlantUML rendering via kroki.io is off under this AI policy");
    this.name = "KrokiBlockedError";
  }
}

/**
 * Send the diagram to kroki.io, if allowed; the SVG text. Under the cloud
 * policy the request goes through the page's (ledgered) fetch; with a
 * per-diagram opt-in it goes through a ledger fetch marked as consented, so
 * local-only doesn't block what the user chose to send.
 */
export async function renderViaKroki(source: string): Promise<string> {
  const policy = getAiPolicy();
  if (!krokiAllowed(source, policy)) {
    const id = diagramId(source);
    if (!recordedBlocks.has(id)) {
      recordedBlocks.add(id);
      recordBlockedRequest(KROKI_URL, "cloud-text", REASON, "POST");
    }
    throw new KrokiBlockedError();
  }
  const init: RequestInit = { method: "POST", headers: { "Content-Type": "text/plain" }, body: source };
  const res = thirdPartyServicesAllowed(policy)
    ? await fetchWithRetry(KROKI_URL, init, { label: "plantuml.render", maxRetries: 2, baseDelayMs: 500, maxDelayMs: 2000 })
    : await ledgerFetch({ force: { category: "cloud-text", reason: REASON }, consent: true })(KROKI_URL, init);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(text || `Kroki returned ${res.status}`);
  }
  return res.text();
}

/** Tests. */
export function __resetKrokiPolicy(): void {
  sessionOptIns.clear();
  recordedBlocks.clear();
}

/**
 * Airplane-mode certificate (plan W5.9): "from X to Y, airplane mode was on,
 * N attempts, N blocked, N reached the network" — with every attempt of the
 * window listed, and the exact scope of what it counts (`counts` /
 * `notCounted`, review 12.11), as canonical JSON (keys sorted, no whitespace: the same
 * certificate always gives the same bytes) and its SHA-256.
 *
 * Signing: the plan signs it with the signed privacy report's mechanism
 * (W2.24: a minisign Ed25519 key of this device). That work is not on this
 * branch's base yet, so `sealCertificate` takes the signer as a parameter;
 * without one the certificate carries its digest only, which proves the file
 * was not changed after it was made only to someone who saw the digest then.
 * When W2.24 is merged, pass its signer here (one line in NetworkMonitor).
 */
import type { EgressAttempt } from "./airplane";

/** /2 (review 12.11): attempts, not bytes; requests in flight at the switch; the stated scope. */
export const CERTIFICATE_FORMAT = "lumen-airplane-certificate/2";

/** What the certificate counts: every one of these that reached the network is in `left`. */
export const CERTIFICATE_COUNTS: readonly string[] = [
  "Every request this page made through fetch, XMLHttpRequest, WebSocket, EventSource, sendBeacon or RTCPeerConnection after airplane mode's wrappers loaded, and every fetch of its workers: each attempt counts once, whatever its size.",
  "Every resource load (image, font, style sheet, script) the browser lists in Resource Timing: a load from another origin counts as reaching the network even when the browser reports 0 bytes; a load from the app's own origin counts when it transferred bytes (it did not come from a cache).",
  "Every request, socket and peer still open when the switch went on: counted as having reached the network, then aborted or closed at that moment.",
  "Every frame open when the switch went on with something in it, whatever its sandbox (playground and live-js runners, HTML and Live CSS previews, embeds, frames in shadow roots, frames a script navigated, <object> and <embed>): counted as having reached the network, then stopped at that moment (its page replaced by about:blank).",
  "Every window the app or a frame of its own origin opened (window.open): counted, then closed at that moment. Every frame that could open windows while the switch was off (its sandbox allowed popups, or it had none and held another site's page) and whose windows this page can't reach, from the moment it was made, whether it is still open at the switch or not: counted as a window that may have reached the network (the last 500 such frames one by one, any before them as one more). Every service worker of the app's origin other than the app's own: counted, then unregistered.",
];

/** What it does not prove, said plainly. */
export const CERTIFICATE_NOT_COUNTED: readonly string[] = [
  "Requests made through a reference to fetch taken before airplane mode's wrappers loaded are not listed; the browser's Content-Security-Policy still refuses them to any other site.",
  "Frames load nothing from a URL while the switch is on (frame-src allows blob: only). What a frame open before the switch sent, before it was stopped, is counted once as that frame, not request by request.",
  "While the switch is on, no frame gets allow-popups, however it is made, so none can open a window. A window a frame opened before the switch is out of this page's reach: it is counted (above), not closed, and may keep loading. A frame from another site, unless it is one of the known embed providers, has no storage or service worker of its own. A service worker that a known provider (YouTube, Vimeo and the others of the embed block) registered before the switch is outside this page and may keep running. A frame inside a closed shadow root made before airplane mode loaded, or inside a closed declarative shadow root (setHTMLUnsafe, parseHTMLUnsafe), is out of reach.",
  "The page keeps its last 500 attempts, and the certificate is made from those: in a session with more, the earlier ones are not in it.",
  "What other apps, browser extensions or the operating system send is outside this page.",
];

export interface CertificateSummary {
  attempts: number;
  blocked: number;
  /** blob:, data: and loopback (a local model). */
  local: number;
  /** The app's own files, answered from a cache only. */
  cacheOnly: number;
  /** Requests, sockets and peers that were open when the switch went on (counted in `left` too). */
  inFlight: number;
  /** Attempts that reached the network (attempts, not bytes). The claim is that this is 0. */
  left: number;
}

export interface AirplaneCertificate {
  format: typeof CERTIFICATE_FORMAT;
  app: string;
  from: number;
  to: number;
  summary: CertificateSummary;
  /** The exact scope of the claim (CERTIFICATE_COUNTS / CERTIFICATE_NOT_COUNTED). */
  counts: readonly string[];
  notCounted: readonly string[];
  attempts: EgressAttempt[];
}

export interface SealedCertificate {
  text: string;
  sha256: string;
  /** A detached signature, when a signer was given. */
  signature?: string;
}

/** JSON with object keys sorted at every level and no whitespace (the same as W2.24's report). */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v === undefined ? null : v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/**
 * Did this attempt reach the network? Blocked attempts and CSP refusals did
 * not; local and cache-only ones stay on the device. A request in flight when
 * the switch went on did. A resource counts by attempt: one with no size
 * (another origin: the browser hides it) did; one of the app's own origin
 * that transferred 0 bytes came from a cache.
 */
export function reachedNetwork(a: EgressAttempt): boolean {
  if (a.decision === "in-flight") return true;
  if (a.decision !== "allowed" || a.kind === "csp") return false;
  if (a.kind === "resource") return a.transferSize === undefined || a.transferSize > 0;
  return true;
}

export function summarize(attempts: readonly EgressAttempt[]): CertificateSummary {
  return {
    attempts: attempts.length,
    blocked: attempts.filter((a) => a.decision === "blocked").length,
    local: attempts.filter((a) => a.decision === "local").length,
    cacheOnly: attempts.filter((a) => a.decision === "cache-only").length,
    inFlight: attempts.filter((a) => a.decision === "in-flight").length,
    left: attempts.filter(reachedNetwork).length,
  };
}

export function appVersion(): string {
  const v = import.meta.env?.VITE_LUMEN_VERSION as string | undefined;
  return v?.trim() || "dev";
}

/** The certificate of the window [from, to]: every attempt in it. */
export function buildCertificate(all: readonly EgressAttempt[], from: number, to: number, app: string = appVersion()): AirplaneCertificate {
  const attempts = all.filter((a) => a.ts >= from && a.ts <= to);
  return { format: CERTIFICATE_FORMAT, app, from, to, summary: summarize(attempts), counts: CERTIFICATE_COUNTS, notCounted: CERTIFICATE_NOT_COUNTED, attempts };
}

async function sha256Hex(text: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sealCertificate(cert: AirplaneCertificate, sign?: (text: string) => Promise<string>): Promise<SealedCertificate> {
  const text = canonicalJson(cert);
  const sealed: SealedCertificate = { text, sha256: await sha256Hex(text) };
  if (sign) sealed.signature = await sign(text);
  return sealed;
}

/** Check a certificate's text against its digest, and that its summary matches its attempts. */
export async function verifyCertificate(sealed: SealedCertificate): Promise<{ ok: boolean; cert: AirplaneCertificate | null }> {
  let cert: AirplaneCertificate | null = null;
  try {
    cert = JSON.parse(sealed.text) as AirplaneCertificate;
  } catch {
    return { ok: false, cert: null };
  }
  const ok =
    cert?.format === CERTIFICATE_FORMAT &&
    (await sha256Hex(sealed.text)) === sealed.sha256 &&
    canonicalJson(cert) === sealed.text &&
    canonicalJson(summarize(cert.attempts.filter((a) => a.ts >= cert!.from && a.ts <= cert!.to))) === canonicalJson(cert.summary);
  return { ok, cert };
}

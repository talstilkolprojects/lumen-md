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

/**
 * /3 (review 14): the summary counts every attempt from the page's own
 * tally, which no flood of attempts can push out; the list holds every
 * attempt that reached the network and the last 500 others (`listed`,
 * `dropped`). /2 (review 12.11): attempts, not bytes; requests in flight at
 * the switch; the stated scope. A /2 certificate is still read and checked.
 */
export const CERTIFICATE_FORMAT = "lumen-airplane-certificate/3";
export const CERTIFICATE_FORMAT_V2 = "lumen-airplane-certificate/2";

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
  "The certificate counts every attempt of the window. It lists every one that reached the network, and of the others (blocked, local, cache-only) the last 500: `dropped` says how many are counted but not listed.",
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
  /** Of those, windows that may have opened (POPUP, review 8): counted, not closed. */
  popups: number;
  /** Attempts in `attempts` (every one that reached the network is among them). */
  listed: number;
  /** Attempts counted here but not listed: the oldest blocked, local and cache-only ones past the list's 500. */
  dropped: number;
}

/** The page's running count of attempts, by decision, since `from` (the switch, or the page's start). */
export interface EgressTally {
  from: number;
  attempts: number;
  blocked: number;
  local: number;
  cacheOnly: number;
  inFlight: number;
  left: number;
  popups: number;
}

export interface AirplaneCertificate {
  format: typeof CERTIFICATE_FORMAT | typeof CERTIFICATE_FORMAT_V2;
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

/** A window opened (or that may have) outside the page's reach: counted, never closed by it. */
export const isPopup = (a: EgressAttempt): boolean => a.kind === "frame" && a.method === "POPUP";

/** The /2 summary: the listed attempts only. */
function summarizeV2(attempts: readonly EgressAttempt[]) {
  return {
    attempts: attempts.length,
    blocked: attempts.filter((a) => a.decision === "blocked").length,
    local: attempts.filter((a) => a.decision === "local").length,
    cacheOnly: attempts.filter((a) => a.decision === "cache-only").length,
    inFlight: attempts.filter((a) => a.decision === "in-flight").length,
    left: attempts.filter(reachedNetwork).length,
  };
}

/**
 * The summary of a window: from the page's tally when it covers the whole
 * window (review 14: a list bounded at 500 lost a real leak's record under a
 * flood of blocked attempts), else from the listed attempts alone.
 */
export function summarize(attempts: readonly EgressAttempt[], tally?: EgressTally | null, from = Number.NEGATIVE_INFINITY): CertificateSummary {
  const l = { ...summarizeV2(attempts), popups: attempts.filter(isPopup).length, listed: attempts.length, dropped: 0 };
  if (!tally || tally.from > from || tally.attempts < l.attempts || tally.left < l.left) return l;
  return {
    attempts: tally.attempts,
    blocked: tally.blocked,
    local: tally.local,
    cacheOnly: tally.cacheOnly,
    inFlight: tally.inFlight,
    left: tally.left,
    popups: tally.popups,
    listed: l.listed,
    dropped: tally.attempts - l.listed,
  };
}

export function appVersion(): string {
  const v = import.meta.env?.VITE_LUMEN_VERSION as string | undefined;
  return v?.trim() || "dev";
}

/** The certificate of the window [from, to]: every attempt in it the page still lists, counted with its tally (`egressTally()`). */
export function buildCertificate(all: readonly EgressAttempt[], from: number, to: number, app: string = appVersion(), tally: EgressTally | null = null): AirplaneCertificate {
  const attempts = all.filter((a) => a.ts >= from && a.ts <= to);
  return { format: CERTIFICATE_FORMAT, app, from, to, summary: summarize(attempts, tally, from), counts: CERTIFICATE_COUNTS, notCounted: CERTIFICATE_NOT_COUNTED, attempts };
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

/** The file the monitor downloads: the certificate, its digest, its minisign signature and the key that made it. */
export interface CertificateFile {
  certificate: string;
  sha256: string;
  /** minisign signature of `certificate` (its UTF-8 bytes): `minisign -Vm cert.txt -P <key>` checks it. */
  minisig: string;
  /** minisign public key of the device that signed it. */
  publicKey: string;
}

/**
 * Seal and sign a certificate with this device's report key (W2.24's
 * signer, ./report.ts; audit W10.C11): every certificate the monitor
 * exports is signed, so a changed byte fails its check.
 */
export async function signedCertificateFile(cert: AirplaneCertificate, key?: import("./report").SigningKey): Promise<CertificateFile> {
  const r = await import("./report");
  const k = key ?? (await r.deviceSigningKey());
  const sealed = await sealCertificate(cert, async (text) => r.minisign(text, k, `lumen-md airplane certificate ${cert.app} ${new Date(cert.to).toISOString()} sha256:${await sha256Hex(text)}`));
  return { certificate: sealed.text, sha256: sealed.sha256, minisig: sealed.signature!, publicKey: await r.publicKeyText(k.publicRaw) };
}

/** Check a certificate's text against its digest, and that its summary matches its attempts. */
export async function verifyCertificate(sealed: SealedCertificate): Promise<{ ok: boolean; cert: AirplaneCertificate | null }> {
  let cert: AirplaneCertificate | null = null;
  try {
    cert = JSON.parse(sealed.text) as AirplaneCertificate;
  } catch {
    return { ok: false, cert: null };
  }
  if (!cert || typeof cert !== "object" || !Array.isArray(cert.attempts)) return { ok: false, cert: null };
  const sealedOk = (await sha256Hex(sealed.text)) === sealed.sha256 && canonicalJson(cert) === sealed.text;
  const listed = cert.attempts.filter((a) => a.ts >= cert!.from && a.ts <= cert!.to);
  let ok = false;
  if (cert.format === CERTIFICATE_FORMAT_V2) {
    // A /2 certificate: its summary is its listed attempts'.
    ok = sealedOk && canonicalJson(summarizeV2(listed)) === canonicalJson(cert.summary);
  } else if (cert.format === CERTIFICATE_FORMAT) {
    // /3: every attempt that reached the network is listed, so those counts must match the list exactly; the
    // others may count more than the list holds, by `dropped`.
    const l = summarize(listed);
    const s = cert.summary;
    ok =
      sealedOk &&
      s.listed === listed.length &&
      s.dropped >= 0 &&
      s.attempts === s.listed + s.dropped &&
      s.left === l.left &&
      s.inFlight === l.inFlight &&
      s.popups === l.popups &&
      s.blocked >= l.blocked &&
      s.local >= l.local &&
      s.cacheOnly >= l.cacheOnly &&
      s.blocked - l.blocked + (s.local - l.local) + (s.cacheOnly - l.cacheOnly) === s.dropped;
  }
  return { ok, cert };
}

/**
 * Error monitoring (plan 12.4) — off by default.
 *
 * Nothing is loaded and nothing is sent unless BOTH hold:
 *   1. the user turned error reports on (`lumen.monitoring.consent = "1"`,
 *      the Telemetry pill in the status bar), and
 *   2. the build names an error tracker: `VITE_SENTRY_DSN` (Sentry, or a
 *      self-hosted GlitchTip, which speaks the same protocol).
 *
 * A DSN is public by design (it ships in every Sentry-enabled page and only
 * lets a client *submit* events), so a build-time variable is the right
 * place for it — it is not a secret.
 *
 * Only then is `./sentryMonitor` (and with it `@sentry/browser`) imported.
 * Its transport sends through the privacy ledger under the "monitoring"
 * category, and its `beforeSend` strips note content, titles and paths.
 * This file stays small: it is on the startup path.
 */
import { setErrorSink } from "./logger";

const CONSENT_KEY = "lumen.monitoring.consent";
/** The old opt-out flag (monitoring used to be on when a DSN was set). Cleared on any change. */
const LEGACY_OPT_OUT_KEY = "lumen.telemetry.optOut";

/** Has the user turned error reports on? False by default and when storage is unavailable. */
export function getMonitoringConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

/** The Telemetry pill. Turning it on starts monitoring right away (still only with a DSN). */
export function setMonitoringConsent(on: boolean): void {
  try {
    if (on) localStorage.setItem(CONSENT_KEY, "1");
    else localStorage.removeItem(CONSENT_KEY);
    localStorage.removeItem(LEGACY_OPT_OUT_KEY);
  } catch {
    // why: private mode — consent can't be stored, so monitoring stays off
  }
  if (on) void initTelemetry();
  else setErrorSink(null);
}

let dsnOverride: string | null = null;

/**
 * Vite inlines `import.meta.env.VITE_*` at transform time, so `vi.stubEnv`
 * can't reach this module. Tests set the DSN here instead (null resets).
 */
export function __setMonitoringDsnForTesting(dsn: string | null): void {
  dsnOverride = dsn;
}

function readEnvDsn(): string | undefined {
  if (dsnOverride !== null) return dsnOverride;
  try {
    return import.meta.env.VITE_SENTRY_DSN as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * The configured DSN, or null when it is missing or not a usable
 * `https://<key>@host/<project>` address (http only for localhost).
 */
export function monitoringDsn(): string | null {
  const raw = readEnvDsn()?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
    if (!u.username || !/\/\d+\/?$/.test(u.pathname)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Origin of the error tracker (for the ledger's rules), or null without a DSN. */
export function monitoringOrigin(): string | null {
  const dsn = monitoringDsn();
  return dsn ? new URL(dsn).origin : null;
}

/**
 * Where the tracker takes reports — `<origin>[/<prefix>]/api/<project>/` —
 * or null without a DSN. The ledger matches this, not the whole origin: a
 * self-hosted GlitchTip may share the app's own origin.
 */
export function monitoringEndpoint(): string | null {
  const dsn = monitoringDsn();
  if (!dsn) return null;
  const u = new URL(dsn);
  const m = /^(.*)\/(\d+)\/?$/.exec(u.pathname);
  return m ? `${u.origin}${m[1]}/api/${m[2]}/` : null;
}

/** What `initTelemetry` loads; replaceable in tests. */
export type MonitorLoader = () => Promise<{ startSentry: (dsn: string) => Promise<void> }>;

const defaultLoader: MonitorLoader = () => import("./sentryMonitor");

let monitor: Awaited<ReturnType<MonitorLoader>> | null = null;

/**
 * Start monitoring if the user consented and the build has a DSN.
 * Safe to call many times (startup, and again when the user turns it back
 * on: `startSentry` initialises the SDK once and re-attaches the error sink).
 * Resolves to whether the monitor is running.
 */
export async function initTelemetry(load: MonitorLoader = defaultLoader): Promise<boolean> {
  if (!getMonitoringConsent()) return false;
  const dsn = monitoringDsn();
  if (!dsn) return false;
  try {
    monitor ??= await load();
    await monitor.startSentry(dsn);
    return true;
  } catch {
    // SDK failed to load (offline / blocked) — monitoring stays off
    return false;
  }
}

/** Test hook. */
export function __resetTelemetry(): void {
  monitor = null;
  setErrorSink(null);
}

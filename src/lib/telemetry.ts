/**
 * Error telemetry — built on `@sentry/react` SDK.
 *
 * Wire-up:
 * 1. Set `VITE_SENTRY_DSN` (e.g. `https://abcdef@o123.ingest.sentry.io/4567`).
 * 2. Call `initTelemetry()` once at startup (in `main.tsx`).
 * 3. The user can opt out by setting `localStorage["lumen.telemetry.optOut"] = "1"`.
 *    Settings UI surfaces a toggle that flips this key.
 *
 * If the DSN is missing or the user opted out, the sink is a no-op and the
 * SDK is never initialised — saving the network + bundle weight that the
 * SDK's auto-instrumentation would otherwise add.
 */

// Type-only import — the SDK itself is loaded lazily inside initTelemetry()
// so Sentry never sits in the eager boot path (it was bundled into
// vendor-react and cost first-paint time for every user, even opted-out ones).
import type { ErrorEvent as SentryErrorEvent } from "@sentry/react";
import { setErrorSink } from "./logger";

const OPT_OUT_KEY = "lumen.telemetry.optOut";

function isOptedOut(): boolean {
  try {
    return localStorage.getItem(OPT_OUT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Public toggle — used by the Settings UI. */
export function setTelemetryOptOut(value: boolean): void {
  try {
    if (value) localStorage.setItem(OPT_OUT_KEY, "1");
    else localStorage.removeItem(OPT_OUT_KEY);
  } catch {
    // private mode — silently ignore; telemetry will fall back to disabled
  }
}

export function getTelemetryOptOut(): boolean {
  return isOptedOut();
}

function readEnvDsn(): string | undefined {
  try {
    return import.meta.env.VITE_SENTRY_DSN as string | undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strip user-content fields from outgoing events. Lumen documents are
 * private to the user — we never want a stack trace + breadcrumb chain
 * to leak the doc body, vault contents, or auth tokens.
 *
 * Approach: redact any `extra` / `contexts` / `breadcrumbs.message` field
 * whose key looks like user content (`note.*`, `doc.*`, `aiKey`, `vault`).
 */
function scrubPii(event: SentryErrorEvent): SentryErrorEvent | null {
  const REDACT = /^(note\.|doc\.|aiKey|vault|workspace\.|password)/i;

  const redactObj = (obj: Record<string, unknown> | undefined): void => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      if (REDACT.test(k)) obj[k] = "[redacted]";
    }
  };
  redactObj(event.extra as Record<string, unknown> | undefined);
  redactObj(event.contexts as unknown as Record<string, unknown> | undefined);
  if (event.breadcrumbs) {
    for (const bc of event.breadcrumbs) {
      if (bc.data) redactObj(bc.data);
    }
  }
  return event;
}

let initialized = false;

/**
 * Wire telemetry into the logger error sink. Safe to call multiple times.
 * Initialises the Sentry SDK only when a DSN is set and the user hasn't
 * opted out — otherwise the SDK isn't loaded at all.
 */
export function initTelemetry(): void {
  if (initialized) return;
  initialized = true;

  const dsn = readEnvDsn();
  if (!dsn) return; // no DSN = no telemetry, that's fine
  if (isOptedOut()) return;

  // Lazy-load the SDK off the boot path; telemetry wiring tolerates the
  // few-ms gap (errors before init simply aren't reported, same as before
  // init() returned).
  void import("@sentry/react")
    .then((Sentry) => {
      Sentry.init({
        dsn,
        integrations: [Sentry.browserTracingIntegration()],
        tracesSampleRate: 0.1,
        release: "lumen@0.1.0",
        beforeSend(event) {
          // PII scrub before any event leaves the browser.
          return scrubPii(event as SentryErrorEvent);
        },
      });

      setErrorSink((...args: unknown[]) => {
        if (isOptedOut()) return;
        const errArg = args.find((a) => a instanceof Error) as Error | undefined;
        const messageArgs = args.filter((a) => a !== errArg).map(formatArg).join(" ");
        if (errArg) {
          Sentry.captureException(errArg, { extra: { message: messageArgs } });
        } else if (messageArgs) {
          Sentry.captureMessage(messageArgs, "error");
        }
      });
    })
    .catch(() => {
      /* SDK failed to load (offline/blocked) — telemetry stays off */
    });
}

/** Pretty-print non-Error args for `extra.message`. */
function formatArg(a: unknown): string {
  if (a == null) return String(a);
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

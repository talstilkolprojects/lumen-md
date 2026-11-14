/**
 * Lightweight logger that gates debug/info output to development mode and
 * forwards warnings/errors in production. The Sentry hook is wired here once
 * `src/lib/telemetry.ts` registers itself, so any `log.error` reaches both the
 * console and the error tracker without scattering Sentry imports.
 */

type Args = unknown[];
type Sink = (...args: Args) => void;

const isDev = (() => {
  try {
    return Boolean((import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV);
  } catch {
    return false;
  }
})();

let errorSink: Sink | null = null;

/** Telemetry layers (e.g. Sentry) call this to receive `log.error` payloads. */
export function setErrorSink(sink: Sink | null): void {
  errorSink = sink;
}

const tag = "[lumen]";

/**
 * The last warnings and errors, for the diagnostics bundle (plan W3.7) —
 * without content: only the message text (the code's own words), scrubbed
 * of anything that looks like a path, a URL path, an address or a key, and
 * the name and scrubbed message of an Error. Other arguments are recorded by
 * type only, never by value.
 */
export interface LogRecord {
  t: number;
  level: "warn" | "error";
  message: string;
}
const RING = 200;
const ring: LogRecord[] = [];

/** Strip what could be personal from a log line: file paths, URL paths and queries, quoted text, e-mails, keys, long numbers. */
export function contentFree(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+\S+/g, "$1 [redacted]")
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abpr]|AIza)[-_A-Za-z0-9]{8,}/g, "[key]")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[e-mail]")
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^\s/?#]+)[^\s]*/gi, "$1/[…]")
    .replace(/(^|[\s(:=])(["«“„'])[^"»”\n]*?(["»”'])(?=$|[\s),.;:!?])/g, "$1$2…$3")
    // A path: from a word with a "/" after it (no space before that first "/"), up to a file extension.
    .replace(/[^\s/"'«“„]+(?:\/[^/\n]+?)+\.\w{1,8}\b/g, "[path]")
    .replace(/[^\s/"'«“„]+\.(?:md|markdown|base|canvas|txt|pdf|png|jpe?g|gif|webp|svg|csv|json|docx?|zip)\b/gi, "[path]")
    .replace(/\b\d{6,}\b/g, "[n]")
    .slice(0, 300);
}

function remember(level: LogRecord["level"], args: Args) {
  const parts: string[] = [];
  for (const a of args) {
    if (typeof a === "string") parts.push(contentFree(a));
    else if (a instanceof Error) parts.push(`${a.name}: ${contentFree(a.message)}`);
    else if (a !== undefined) parts.push(`[${a === null ? "null" : Array.isArray(a) ? "array" : typeof a}]`);
  }
  ring.push({ t: Date.now(), level, message: parts.join(" ") });
  if (ring.length > RING) ring.splice(0, ring.length - RING);
}

/** The last warnings and errors, oldest first (content-free; see `contentFree`). */
export function recentLogs(): readonly LogRecord[] {
  return ring.slice();
}

export const log = {
  debug: (...args: Args) => {
    // hygiene-allow: the logger is the single sanctioned console sink (dev-only debug level)
    if (isDev) console.log(tag, ...args);
  },
  info: (...args: Args) => {
    if (isDev) console.info(tag, ...args);
  },
  warn: (...args: Args) => {
    remember("warn", args);
    console.warn(tag, ...args);
  },
  error: (...args: Args) => {
    remember("error", args);
    console.error(tag, ...args);
    if (errorSink) {
      try {
        errorSink(...args);
      } catch {
        // why: sink failures must never crash the app; the console already has the error
      }
    }
  },
};

export type Logger = typeof log;

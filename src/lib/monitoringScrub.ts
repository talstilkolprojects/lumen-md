/**
 * What an error report may carry (plan 12.4). Loaded only with the Sentry
 * monitor, never on the startup path.
 *
 * Allowlist, not blocklist: the event is rebuilt from the few fields that
 * describe *the code* — the error's class name and stack frames of the
 * app's own scripts — and everything else is dropped. That includes every
 * free-text message: an error message can embed a title or note text
 * without quotes ("Failed to save Quarterly plan"), and no pattern can tell
 * that apart from the app's own words. The stack trace says where it
 * happened; the class name says what kind of error it was.
 */
import type { ErrorEvent, Exception, StackFrame } from "@sentry/browser";

const MAX_FRAMES = 50;

/** An error class name (`TypeError`, `WorkspaceConflictError`), or "Error" for anything else. */
export function scrubType(type: string | undefined): string {
  return type && /^[A-Za-z_$][\w$]{0,60}$/.test(type) ? type : "Error";
}

/** A script URL reduced to its file name (no origin, path, query or hash). */
export function scrubFilename(name: string | undefined): string | undefined {
  if (!name) return name;
  const noQuery = name.split(/[?#]/)[0];
  const base = noQuery.split(/[/\\]/).pop() ?? "";
  return /^[\w.@-]{1,120}$/.test(base) ? base : "[file]";
}

function scrubFrame(f: StackFrame): StackFrame {
  const out: StackFrame = {};
  const filename = scrubFilename(f.filename);
  if (filename !== undefined) out.filename = filename;
  if (f.function && /^[\w$.<>@ -]{1,120}$/.test(f.function)) out.function = f.function;
  if (typeof f.lineno === "number") out.lineno = f.lineno;
  if (typeof f.colno === "number") out.colno = f.colno;
  if (typeof f.in_app === "boolean") out.in_app = f.in_app;
  return out;
}

function scrubException(e: Exception): Exception {
  // why: no `value` — the message is free text and may hold the user's words
  const out: Exception = { type: scrubType(e.type) };
  if (e.mechanism) out.mechanism = { type: scrubType(e.mechanism.type), handled: e.mechanism.handled };
  const frames = e.stacktrace?.frames;
  // why: Sentry lists frames oldest-first; the newest ones (the end) are where the error happened
  if (frames?.length) out.stacktrace = { frames: frames.slice(-MAX_FRAMES).map(scrubFrame) };
  return out;
}

/**
 * The event as it may leave the device. Returns a new object; fields that
 * aren't listed here are not sent. An event with no exception (a bare
 * message) has nothing left to send and is dropped (null).
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent | null {
  const values = event.exception?.values;
  if (!values?.length) return null;
  const out: ErrorEvent = { type: undefined, exception: { values: values.map(scrubException) } };
  if (event.event_id) out.event_id = event.event_id;
  if (event.timestamp !== undefined) out.timestamp = event.timestamp;
  if (event.level) out.level = event.level;
  if (event.platform) out.platform = event.platform;
  if (event.release) out.release = event.release;
  if (event.environment) out.environment = event.environment;
  // why: SDK metadata only; its settings carry infer_ip "never" (no IP address stored)
  if (event.sdk) out.sdk = event.sdk;
  return out;
}

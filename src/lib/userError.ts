/**
 * Errors in words a person can act on (plan W3.2). A caught error's own
 * text — `TypeError: Failed to fetch`, `QuotaExceededError`, a stack — is
 * for the log, never for the screen. `explainError()` turns it into one
 * sentence in the user's language that says what happened, what is safe,
 * and what to do (docs: "Writing messages"). The raw text goes to the
 * logger, where the Doctor and a bug report can read it.
 *
 * scripts/check-raw-errors.mjs fails CI when a caught error's message,
 * stack or String() reaches t(), a toast, a dialog or JSX.
 */
import { t } from "../i18n";
import { log } from "./logger";

export type ErrorKind =
  | "cancelled"
  | "quota"
  | "permission"
  | "network"
  | "timeout"
  | "notFound"
  | "badFile"
  | "conflict"
  | "rateLimit"
  | "aiNoKey"
  | "aiPolicy"
  | "noLocalModel"
  | "unavailable"
  | "unknown";

/**
 * An error whose message is already written for the person (translated,
 * says what to do): explainError() shows it as it is. Throw this — with a
 * t() message — instead of a plain Error when the words are meant for the UI.
 */
export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

function nameOf(e: unknown): string {
  if (e && typeof e === "object" && "name" in e && typeof (e as { name: unknown }).name === "string") return (e as { name: string }).name;
  return "";
}

function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return "";
}

/** What kind of failure this is, from the error's name and the words its engine uses. */
export function errorKind(e: unknown): ErrorKind {
  const name = nameOf(e);
  const msg = messageOf(e);
  const code = e && typeof e === "object" && "code" in e ? String((e as { code: unknown }).code) : "";
  if (name === "AbortError" || code === "ABORTED") return "cancelled";
  if (code === "NO_KEY") return "aiNoKey";
  if (name === "PrivacyBlockedError" || name === "AiPolicyError" || code === "POLICY") return "aiPolicy";
  if (name === "NoLocalModelError" || code === "NO_LOCAL") return "noLocalModel";
  if (name === "ResearchUnavailableError") return "unavailable";
  if (name === "RateLimitError" || /\b429\b|rate.?limit|too many requests/i.test(msg)) return "rateLimit";
  if (name === "QuotaExceededError" || /quota|disk is full|no space/i.test(msg)) return "quota";
  if (name === "NotAllowedError" || name === "SecurityError" || /permission|not allowed|denied/i.test(msg)) return "permission";
  if (name === "TimeoutError" || /timed? ?out/i.test(msg)) return "timeout";
  if ((name === "TypeError" && /fetch|network|load failed/i.test(msg)) || name === "NetworkError" || /network|offline|ECONNREFUSED|ENOTFOUND|HTTP 5\d\d/i.test(msg)) return "network";
  if (name === "NotFoundError" || /not found|no such file|ENOENT|HTTP 404/i.test(msg)) return "notFound";
  if (name === "SyntaxError" || name === "DataError" || name === "EncodingError" || /unexpected token|invalid (json|zip|format)|not a zip|corrupt/i.test(msg)) return "badFile";
  if (name === "WorkspaceConflictError" || name === "InvalidModificationError" || /already exists|conflict/i.test(msg)) return "conflict";
  return "unknown";
}

/** True for a cancel the person did themselves (closed a picker, pressed Stop): show nothing. */
export function isCancel(e: unknown): boolean {
  return errorKind(e) === "cancelled";
}

/**
 * One sentence for the screen: what happened, what is safe, what to do.
 * The raw error is logged (never shown). `where` names the action for the log.
 */
export function explainError(e: unknown, where = "ui"): string {
  if (e instanceof UserFacingError) return e.message;
  const kind = errorKind(e);
  if (kind === "cancelled") return "";
  log.warn(`[${where}] ${nameOf(e) || "Error"}: ${messageOf(e) || String(e)}`);
  return t(`error.${kind}`);
}

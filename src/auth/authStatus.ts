/**
 * User-facing auth status + error descriptions
 * (PRODUCT_IMPROVEMENT_MASTER_PLAN 1.4 / 2.4).
 *
 * Every auth surface (toolbar, sign-in dialog, org settings, SSO
 * callback) renders one of five states with a sentence the user can act
 * on and — for anything that needs fixing — a "Learn more" docs link.
 * Raw provider errors are classified into a small set of reasons so the
 * user sees "Can't reach the sign-in service — check your connection"
 * instead of `TypeError: Failed to fetch`.
 */

import type { AuthStatus } from "./types";
import { t } from "../i18n";
import { docsUrl } from "../lib/docsLinks";

export type AuthStatusKind = "loading" | "signedIn" | "signedOut" | "notConfigured" | "error";

export type AuthErrorReason =
  | "notConfigured"
  | "network"
  | "invalidCredentials"
  | "sessionExpired"
  | "ssoNoConnection"
  | "ssoStateMismatch"
  | "ssoDenied"
  | "unknown";

export interface AuthStatusDescription {
  kind: AuthStatusKind;
  /** Short label, e.g. "Signed in". */
  title: string;
  /** One sentence telling the user what this means / what to do. */
  hint: string;
  /** Docs page for states that need action; absent when nothing to fix. */
  learnMoreUrl?: string;
  /** Classified reason when `kind === "error"`. */
  reason?: AuthErrorReason;
}

export interface AuthStatusInput {
  status: AuthStatus;
  providerName?: string;
  error?: string;
  userLabel?: string;
}

/** Map a raw error (message or Error) onto a reason we have copy for. */
export function classifyAuthError(err: unknown): AuthErrorReason {
  const msg = (err instanceof Error ? err.message : String(err ?? "")).toLowerCase();
  if (!msg) return "unknown";
  if (/requires lumen cloud|not configured|vite_supabase|vite_workos/.test(msg)) return "notConfigured";
  if (/no_sso_connection|no sso organization/.test(msg)) return "ssoNoConnection";
  if (/state_mismatch|invalid or expired sso state/.test(msg)) return "ssoStateMismatch";
  if (/access_denied/.test(msg)) return "ssoDenied";
  if (/failed to fetch|networkerror|network request failed|load failed|timeout|timed out|offline|workos_unreachable|econn/.test(msg)) {
    return "network";
  }
  if (/invalid login|invalid credentials|invalid email or password|wrong password|invalid_grant/.test(msg)) {
    return "invalidCredentials";
  }
  if (/expired|jwt|401|unauthori[sz]ed|session/.test(msg)) return "sessionExpired";
  return "unknown";
}

const REASON_TOPIC: Record<AuthErrorReason, { anchor?: string; sso?: boolean }> = {
  notConfigured: { anchor: "enable-accounts" },
  network: { anchor: "troubleshooting" },
  invalidCredentials: { anchor: "troubleshooting" },
  sessionExpired: { anchor: "troubleshooting" },
  ssoNoConnection: { sso: true, anchor: "error-reasons" },
  ssoStateMismatch: { sso: true, anchor: "error-reasons" },
  ssoDenied: { sso: true, anchor: "error-reasons" },
  unknown: { anchor: "troubleshooting" },
};

/** Actionable description of an auth error. */
export function describeAuthError(err: unknown): AuthStatusDescription {
  const reason = classifyAuthError(err);
  const topic = REASON_TOPIC[reason];
  if (reason === "notConfigured") {
    return {
      kind: "notConfigured",
      reason,
      title: t("auth.status.notConfigured"),
      hint: t("auth.status.notConfigured.hint"),
      learnMoreUrl: docsUrl("signIn", topic.anchor),
    };
  }
  return {
    kind: "error",
    reason,
    title: t("auth.status.error"),
    hint: t(`auth.error.${reason}`),
    learnMoreUrl: docsUrl(topic.sso ? "sso" : "signIn", topic.anchor),
  };
}

/** Describe the current auth store state for status UI. */
export function describeAuthStatus(input: AuthStatusInput): AuthStatusDescription {
  const provider = (input.providerName ?? "local").toLowerCase();
  if (input.status === "error") return describeAuthError(input.error ?? "");
  if (input.status === "loading") {
    return { kind: "loading", title: t("auth.status.loading"), hint: t("auth.status.loading.hint") };
  }
  if (input.status === "authenticated") {
    return {
      kind: "signedIn",
      title: t("auth.status.signedIn"),
      hint: input.userLabel
        ? t("auth.status.signedIn.hint", { user: input.userLabel })
        : t("auth.status.signedIn.hintAnon"),
    };
  }
  if (provider === "local") {
    return {
      kind: "notConfigured",
      title: t("auth.status.notConfigured"),
      hint: t("auth.status.notConfigured.hint"),
      learnMoreUrl: docsUrl("signIn", "enable-accounts"),
    };
  }
  return {
    kind: "signedOut",
    title: t("auth.status.signedOut"),
    hint: t("auth.status.signedOut.hint"),
    learnMoreUrl: docsUrl("signIn"),
  };
}

/**
 * Read (and strip) the `?sso=ok|error&reason=…` flash params the SSO
 * worker appends after its callback redirect. Returns null when absent.
 */
export function consumeSsoFlash(
  loc: Pick<Location, "search" | "pathname" | "hash"> | null = typeof window !== "undefined" ? window.location : null,
  replace: (url: string) => void = (url) => {
    try {
      window.history.replaceState(window.history.state, "", url);
    } catch {
      /* why: sandboxed iframe — leave the URL alone */
    }
  },
): { ok: true } | { ok: false; reason: string } | null {
  if (!loc) return null;
  const params = new URLSearchParams(loc.search);
  const sso = params.get("sso");
  if (sso !== "ok" && sso !== "error") return null;
  const reason = params.get("reason") ?? "unknown";
  params.delete("sso");
  params.delete("reason");
  const qs = params.toString();
  replace(`${loc.pathname}${qs ? `?${qs}` : ""}${loc.hash}`);
  return sso === "ok" ? { ok: true } : { ok: false, reason };
}

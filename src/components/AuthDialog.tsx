import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../ui/useFocusTrap";
import { useAuth } from "../auth/useAuth";
import { describeAuthError, describeAuthStatus, type AuthStatusDescription } from "../auth/authStatus";
import { isWorkosEnabled, signInWithSso } from "../auth/workosProvider";
import { loadOrgSettings } from "../lib/orgSettings";
import { t } from "../i18n";

/**
 * Email/password + OAuth sign-in dialog.
 *
 * Renders only the buttons the active provider supports. The local provider
 * exposes none of them, so the dialog falls back to a friendly "Lumen Cloud
 * not configured" notice with setup instructions. When the WorkOS SSO
 * worker is configured an "organization domain" sign-in is offered too.
 *
 * Errors are classified by `describeAuthError` so the user gets an
 * actionable sentence + "Learn more" link instead of a raw provider
 * message (PRODUCT_IMPROVEMENT 1.4 / 2.4).
 */

interface Props {
  open: boolean;
  onClose: () => void;
}

type Mode = "signin" | "signup";

export function AuthDialog({ open, onClose }: Props) {
  const { provider, signIn, signUp, signInWithProvider, status, error: storeError } = useAuth();
  const [mode, setMode] = useState<Mode>("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<AuthStatusDescription | null>(null);
  const [ssoDomain, setSsoDomain] = useState("");
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setEmail("");
    setPassword("");
    setError(null);
    setMode("signin");
    setSubmitting(false);
    setSsoDomain(loadOrgSettings().domains[0] ?? "");
  }, [open]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it.
  useFocusTrap(dialogRef, { active: open, onEscape: onClose });

  if (!open) return null;

  const supportsPassword = !!provider.signInWithPassword;
  const supportsOauth = !!provider.signInWithProvider;
  const ssoEnabled = isWorkosEnabled();
  const isLocal = provider.name === "local" && !ssoEnabled;
  // Bootstrap failure (e.g. provider unreachable) — surface it up front.
  const bootError = status === "error" ? describeAuthStatus({ status, providerName: provider.name, error: storeError }) : null;
  const shownError = error ?? bootError;
  const localStatus = describeAuthStatus({ status: "anonymous", providerName: "local" });

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (mode === "signin") await signIn(email, password);
      else await signUp(email, password);
      onClose();
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleOauth(p: "google" | "github") {
    setSubmitting(true);
    setError(null);
    try {
      await signInWithProvider(p);
      onClose();
    } catch (err) {
      setError(describeAuthError(err));
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSso(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const url = await signInWithSso(ssoDomain.trim());
      window.location.assign(url);
    } catch (err) {
      setError(describeAuthError(err));
      setSubmitting(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="auth-dialog-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "hsl(0 0% 0% / 0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        padding: 16,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        style={{
          background: "hsl(var(--bg))",
          color: "hsl(var(--fg))",
          border: "1px solid hsl(var(--border-strong))",
          borderRadius: 14,
          padding: 24,
          width: "min(420px, 100%)",
          boxShadow: "0 20px 60px -10px hsl(0 0% 0% / 0.5)",
        }}
      >
        <div id="auth-dialog-title" style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>
          {mode === "signin" ? t("auth.dialog.signInTitle") : t("auth.dialog.signUpTitle")}
        </div>
        <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))", marginBottom: 16 }}>
          {t("auth.dialog.intro")}
        </div>

        {isLocal ? (
          <div
            style={{
              padding: 14,
              borderRadius: 10,
              background: "hsl(var(--bg-subtle))",
              border: "1px dashed hsl(var(--border))",
              fontSize: 12,
              color: "hsl(var(--fg-muted))",
              lineHeight: 1.5,
            }}
          >
            <strong style={{ color: "hsl(var(--fg))" }}>{localStatus.title}</strong>
            <br />
            {localStatus.hint}
            <br />
            <span dir="ltr">
              <code>VITE_SUPABASE_URL</code> + <code>VITE_SUPABASE_ANON_KEY</code> / <code>VITE_WORKOS_ENDPOINT</code>
            </span>
            {localStatus.learnMoreUrl && (
              <>
                {" "}
                <LearnMore href={localStatus.learnMoreUrl} />
              </>
            )}
          </div>
        ) : (
          <>
            {supportsPassword && (
              <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <label style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
                  {t("auth.dialog.email")}
                  <input
                    type="email"
                    autoComplete="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    style={inputStyle}
                  />
                </label>
                <label style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
                  {t("auth.dialog.password")}
                  <input
                    type="password"
                    autoComplete={mode === "signin" ? "current-password" : "new-password"}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    style={inputStyle}
                  />
                </label>
                <button
                  type="submit"
                  disabled={submitting}
                  style={{
                    ...btnPrimary,
                    opacity: submitting ? 0.6 : 1,
                    cursor: submitting ? "wait" : "pointer",
                  }}
                >
                  {submitting ? "…" : mode === "signin" ? t("auth.signIn") : t("auth.dialog.createAccount")}
                </button>
              </form>
            )}

            {supportsOauth && (
              <>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    margin: "16px 0 12px",
                    fontSize: 11,
                    color: "hsl(var(--fg-muted))",
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: "hsl(var(--border))" }} />
                  <span>{t("auth.dialog.or")}</span>
                  <div style={{ flex: 1, height: 1, background: "hsl(var(--border))" }} />
                </div>
                <div style={{ display: "flex", gap: 10 }}>
                  <button type="button" onClick={() => handleOauth("google")} disabled={submitting} style={btnSecondary}>
                    {t("auth.dialog.google")}
                  </button>
                  <button type="button" onClick={() => handleOauth("github")} disabled={submitting} style={btnSecondary}>
                    {t("auth.dialog.github")}
                  </button>
                </div>
              </>
            )}

            {supportsPassword && (
              <button
                type="button"
                onClick={() => setMode((m) => (m === "signin" ? "signup" : "signin"))}
                style={{
                  marginTop: 14,
                  border: "none",
                  background: "transparent",
                  color: "hsl(var(--accent))",
                  fontSize: 12,
                  cursor: "pointer",
                  textAlign: "start",
                  padding: 0,
                }}
              >
                {mode === "signin" ? t("auth.dialog.needAccount") : t("auth.dialog.haveAccount")}
              </button>
            )}

            {ssoEnabled && (
              <form
                onSubmit={handleSso}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: supportsPassword || supportsOauth ? 16 : 0,
                  paddingTop: supportsPassword || supportsOauth ? 14 : 0,
                  borderTop: supportsPassword || supportsOauth ? "1px solid hsl(var(--border))" : undefined,
                }}
              >
                <label style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>
                  {t("auth.dialog.ssoDomain")}
                  <input
                    type="text"
                    inputMode="url"
                    autoComplete="off"
                    dir="ltr"
                    required
                    placeholder="acme.com"
                    value={ssoDomain}
                    onChange={(e) => setSsoDomain(e.target.value)}
                    style={inputStyle}
                  />
                </label>
                <button type="submit" disabled={submitting} style={btnSecondary}>
                  {t("auth.dialog.ssoContinue")}
                </button>
              </form>
            )}

            {shownError && (
              <div
                role="alert"
                style={{
                  marginTop: 12,
                  padding: "8px 12px",
                  borderRadius: 8,
                  background: "hsl(0 80% 50% / 0.1)",
                  color: "hsl(0 80% 65%)",
                  border: "1px solid hsl(0 80% 50% / 0.4)",
                  fontSize: 12,
                }}
              >
                <strong>{shownError.title}</strong> — {shownError.hint}
                {shownError.learnMoreUrl && (
                  <>
                    {" "}
                    <LearnMore href={shownError.learnMoreUrl} />
                  </>
                )}
              </div>
            )}
          </>
        )}

        <button
          type="button"
          onClick={onClose}
          style={{
            marginTop: 18,
            width: "100%",
            padding: "8px 12px",
            border: "1px solid hsl(var(--border))",
            background: "transparent",
            color: "hsl(var(--fg))",
            borderRadius: 8,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          {t("auth.dialog.close")}
        </button>
      </div>
    </div>
  );
}

function LearnMore({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: "hsl(var(--accent))", textDecoration: "underline", whiteSpace: "nowrap" }}
    >
      {t("toast.learnMore")}
    </a>
  );
}

const inputStyle: React.CSSProperties = {
  display: "block",
  width: "100%",
  marginTop: 4,
  padding: "8px 10px",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 13,
  outline: "none",
};

const btnPrimary: React.CSSProperties = {
  marginTop: 4,
  padding: "10px 14px",
  background: "linear-gradient(135deg,#7c5cff,#22d3ee)",
  color: "white",
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 600,
  cursor: "pointer",
};

const btnSecondary: React.CSSProperties = {
  flex: 1,
  padding: "9px 12px",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 8,
  fontSize: 12,
  fontWeight: 500,
  cursor: "pointer",
};

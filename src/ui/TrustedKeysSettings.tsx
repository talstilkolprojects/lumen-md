/**
 * Trusted plugin-signing keys (PRODUCT_IMPROVEMENT_MASTER_PLAN 1.3).
 *
 * UI over `plugins/signing.ts`: lists built-in (env) and user-trusted
 * Ed25519 keys by SHA-256 fingerprint, lets the user paste a public key
 * (base64 SPKI or PEM) — validated before it is stored — and remove
 * user keys. Built-in keys are read-only: they come from the deployment.
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { KeyRound, Trash2, X, ShieldCheck } from "lucide-react";
import {
  listTrustedKeys,
  trustPublicKey,
  untrustKey,
  formatFingerprint,
  parseEd25519PublicKey,
} from "../plugins/signing";
import { uiConfirm } from "./PromptDialog";
import { showAiToast } from "./AiToast";
import { docsUrl } from "../lib/docsLinks";
import { t } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Rendered as a tab of the settings screen: no backdrop, no own close. */
  embedded?: boolean;
}

type KeyRow = { fingerprint: string; source: "builtin" | "user" };

export function TrustedKeysSettings({ open, onClose, embedded = false }: Props) {
  const [keys, setKeys] = useState<KeyRow[] | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [highlight, setHighlight] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setKeys(await listTrustedKeys());
  }, []);

  useEffect(() => {
    if (!open) return;
    setDraft("");
    setError(null);
    setHighlight(null);
    void refresh();
  }, [open, refresh]);


  const handleAdd = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);
      const pre = parseEd25519PublicKey(draft);
      if (!pre.ok) {
        setError(t(`trustedKeys.error.${pre.error}`));
        return;
      }
      setBusy(true);
      try {
        const res = await trustPublicKey(draft);
        if (!res.ok) {
          setError(t(`trustedKeys.error.${res.error}`));
          return;
        }
        setDraft("");
        setHighlight(res.fingerprint);
        await refresh();
        showAiToast(
          res.alreadyTrusted ? t("trustedKeys.alreadyTrusted") : t("trustedKeys.added"),
          res.alreadyTrusted ? "info" : "success",
        );
      } catch (err) {
        showAiToast(t("trustedKeys.saveFailed", { error: (err as Error).message }), "error", {
          learnMoreUrl: docsUrl("pluginSigning"),
        });
      } finally {
        setBusy(false);
      }
    },
    [draft, refresh],
  );

  const handleRemove = useCallback(
    async (fingerprint: string) => {
      const ok = await uiConfirm({
        title: t("trustedKeys.remove.title"),
        message: t("trustedKeys.remove.confirm", { fingerprint: fingerprint.slice(0, 16) }),
      });
      if (!ok) return;
      try {
        await untrustKey(fingerprint);
      } catch (err) {
        showAiToast(t("trustedKeys.saveFailed", { error: (err as Error).message }), "error", {
          learnMoreUrl: docsUrl("pluginSigning"),
        });
        return;
      }
      await refresh();
      showAiToast(t("trustedKeys.removed"), "success");
    },
    [refresh],
  );

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open && !embedded, onEscape: onClose });

  if (!open) return null;

  const builtin = keys?.filter((k) => k.source === "builtin") ?? [];
  const user = keys?.filter((k) => k.source === "user") ?? [];

  return (
    <div className={embedded ? undefined : "cmd-palette-backdrop"} onClick={embedded ? undefined : onClose}>
      <div
        className={embedded ? undefined : "cmd-palette"}
        ref={trapRef}
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : "true"}
        aria-labelledby="trusted-keys-title"
        onClick={(e) => e.stopPropagation()}
        style={embedded ? { display: "flex", flexDirection: "column" } : { maxWidth: 640, maxHeight: "82vh", display: "flex", flexDirection: "column" }}
      >
        <div style={header}>
          <KeyRound size={16} aria-hidden="true" />
          <h2 id="trusted-keys-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("trustedKeys.title")}
          </h2>
          {!embedded && (
            <button type="button" onClick={onClose} aria-label={t("trustedKeys.close")} style={iconBtn}>
              <X size={14} />
            </button>
          )}
        </div>

        <div style={{ overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
          <p style={muted}>
            {t("trustedKeys.intro")}{" "}
            <a href={docsUrl("pluginSigning")} target="_blank" rel="noopener noreferrer" style={link}>
              {t("toast.learnMore")}
            </a>
          </p>

          <section aria-labelledby="trusted-keys-user">
            <h3 id="trusted-keys-user" style={sectionTitle}>
              {t("trustedKeys.section.user")}
            </h3>
            {keys === null ? (
              <p style={muted}>{t("trustedKeys.loading")}</p>
            ) : user.length === 0 ? (
              <p style={muted} data-testid="trusted-keys-empty">
                {t("trustedKeys.empty")}
              </p>
            ) : (
              <ul style={list}>
                {user.map((k) => (
                  <li
                    key={k.fingerprint}
                    style={{ ...row, background: highlight === k.fingerprint ? "hsl(var(--accent) / 0.08)" : undefined }}
                  >
                    <code style={fp} title={k.fingerprint} dir="ltr">
                      {formatFingerprint(k.fingerprint)}
                    </code>
                    <button
                      type="button"
                      onClick={() => void handleRemove(k.fingerprint)}
                      aria-label={t("trustedKeys.remove.aria", { fingerprint: k.fingerprint.slice(0, 16) })}
                      title={t("trustedKeys.remove.title")}
                      style={iconBtn}
                    >
                      <Trash2 size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {builtin.length > 0 && (
            <section aria-labelledby="trusted-keys-builtin">
              <h3 id="trusted-keys-builtin" style={sectionTitle}>
                {t("trustedKeys.section.builtin")}
              </h3>
              <ul style={list}>
                {builtin.map((k) => (
                  <li key={k.fingerprint} style={row}>
                    <code style={fp} title={k.fingerprint} dir="ltr">
                      {formatFingerprint(k.fingerprint)}
                    </code>
                    <span style={badge}>
                      <ShieldCheck size={11} aria-hidden="true" /> {t("trustedKeys.builtinBadge")}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <form onSubmit={handleAdd} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <label htmlFor="trusted-keys-input" style={sectionTitle}>
              {t("trustedKeys.add.label")}
            </label>
            <textarea
              id="trusted-keys-input"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              placeholder={"-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA…\n-----END PUBLIC KEY-----"}
              rows={4}
              dir="ltr"
              spellCheck={false}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "trusted-keys-error" : "trusted-keys-help"}
              style={textarea}
            />
            {error ? (
              <p id="trusted-keys-error" role="alert" style={{ ...muted, color: "hsl(0 70% 60%)" }}>
                {error}
              </p>
            ) : (
              <p id="trusted-keys-help" style={muted}>
                {t("trustedKeys.add.help")}
              </p>
            )}
            <div>
              <button type="submit" disabled={busy || !draft.trim()} className="icon-btn" style={primaryBtn}>
                {t("trustedKeys.add.submit")}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 16px",
  borderBottom: "1px solid hsl(var(--border))",
};
const iconBtn: React.CSSProperties = {
  marginInlineStart: "auto",
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg-muted))",
  cursor: "pointer",
  padding: 4,
  display: "flex",
};
const muted: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))" };
const link: React.CSSProperties = { color: "hsl(var(--accent))", textDecoration: "underline" };
const sectionTitle: React.CSSProperties = {
  margin: "0 0 6px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "hsl(var(--fg-muted))",
};
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 };
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
};
const fp: React.CSSProperties = {
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 11,
  wordBreak: "break-all",
  flex: 1,
};
const badge: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  fontSize: 10,
  padding: "2px 6px",
  borderRadius: 999,
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--fg-muted))",
  whiteSpace: "nowrap",
};
const textarea: React.CSSProperties = {
  width: "100%",
  fontFamily: "ui-monospace, Menlo, monospace",
  fontSize: 11.5,
  padding: 8,
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
  resize: "vertical",
};
const primaryBtn: React.CSSProperties = { width: "auto", padding: "6px 16px", fontSize: 12 };

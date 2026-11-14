/**
 * Organization admin panel (MASTER_PLAN ε.1.3 / TASKS F4.4).
 *
 * Sections:
 *   - Organization name + allowed e-mail domains — stored locally
 *     (`lib/orgSettings.ts`); there is no org backend yet, and offline /
 *     self-hosted builds must still work, so the panel says "local only".
 *   - SSO status — derived from the auth layer: worker configured?
 *     signed in through WorkOS? which org id?
 *   - Members — no directory API exists yet, so with an SSO session we
 *     list the signed-in member and explain Directory Sync; without SSO
 *     a "Connect SSO" empty state links to the docs.
 *   - Audit log — gated by `useCapability("auditLog")` (Team plan; open
 *     when billing isn't configured).
 *
 * Reachable from the command palette (`settings.organization`).
 */

import { useCallback, useEffect, useState, useRef } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Building2, X, Plus, Trash2, ShieldCheck, Users, ScrollText } from "lucide-react";
import { useAuth } from "../auth/useAuth";
import { isWorkosEnabled } from "../auth/workosProvider";
import { describeAuthStatus } from "../auth/authStatus";
import { useCapability } from "../billing/gates";
import { loadOrgSettings, saveOrgSettings, normalizeDomain, type OrgSettings as OrgSettingsData } from "../lib/orgSettings";
import { docsUrl } from "../lib/docsLinks";
import { showAiToast } from "./AiToast";
import { UpgradeNotice } from "./UpgradeNotice";
import { t } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Opens the audit log dialog. Omitted → the audit section is hidden. */
  onOpenAuditLog?: () => void;
  /** Rendered as a tab of the settings screen: no backdrop, no own close. */
  embedded?: boolean;
}

export type SsoState = "notConfigured" | "configured" | "connected";

export function OrgSettings({ open, onClose, onOpenAuditLog, embedded = false }: Props) {
  const status = useAuth((s) => s.status);
  const user = useAuth((s) => s.user);
  const providerName = useAuth((s) => s.provider.name);
  const authError = useAuth((s) => s.error);
  const auditEntitled = useCapability("auditLog");

  const [settings, setSettings] = useState<OrgSettingsData>(() => loadOrgSettings());
  const [domainDraft, setDomainDraft] = useState("");
  const [domainError, setDomainError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSettings(loadOrgSettings());
    setDomainDraft("");
    setDomainError(null);
    setDirty(false);
  }, [open]);


  const addDomain = useCallback(() => {
    const d = normalizeDomain(domainDraft);
    if (!d) {
      setDomainError(t("org.domains.invalid"));
      return;
    }
    if (settings.domains.includes(d)) {
      setDomainError(t("org.domains.duplicate", { domain: d }));
      return;
    }
    setSettings((s) => ({ ...s, domains: [...s.domains, d] }));
    setDomainDraft("");
    setDomainError(null);
    setDirty(true);
  }, [domainDraft, settings.domains]);

  const handleSave = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (saveOrgSettings(settings)) {
        setDirty(false);
        showAiToast(t("org.saved"), "success");
      } else {
        showAiToast(t("org.saveFailed"), "error", { learnMoreUrl: docsUrl("organization", "offline-and-self-hosted") });
      }
    },
    [settings],
  );

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open && !embedded, onEscape: onClose });

  if (!open) return null;

  const ssoConfigured = isWorkosEnabled();
  const ssoSession = status === "authenticated" && user?.provider === "workos";
  const ssoState: SsoState = ssoSession ? "connected" : ssoConfigured ? "configured" : "notConfigured";
  const authDescription = describeAuthStatus({
    status,
    providerName,
    error: authError,
    userLabel: user?.email ?? user?.name ?? user?.id,
  });

  return (
    <div className={embedded ? undefined : "cmd-palette-backdrop"} onClick={embedded ? undefined : onClose}>
      <div
        className={embedded ? undefined : "cmd-palette"}
        ref={trapRef}
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : "true"}
        aria-labelledby="org-settings-title"
        onClick={(e) => e.stopPropagation()}
        style={embedded ? { display: "flex", flexDirection: "column" } : { maxWidth: 640, maxHeight: "85vh", display: "flex", flexDirection: "column" }}
      >
        <div style={header}>
          <Building2 size={16} aria-hidden="true" />
          <h2 id="org-settings-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("org.title")}
          </h2>
          {!ssoSession && (
            <span style={pill} data-testid="org-local-only">
              {t("org.localOnly")}
            </span>
          )}
          {!embedded && (
            <button type="button" onClick={onClose} aria-label={t("org.close")} style={closeBtn}>
              <X size={14} />
            </button>
          )}
        </div>

        <div style={{ overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 18 }}>
          {!ssoSession && <p style={muted}>{t("org.localOnly.hint")}</p>}

          {/* ── General ─────────────────────────────────────────── */}
          <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label htmlFor="org-name" style={sectionTitle}>
                {t("org.name.label")}
              </label>
              <input
                id="org-name"
                value={settings.name}
                maxLength={120}
                placeholder={t("org.name.placeholder")}
                onChange={(e) => {
                  setSettings((s) => ({ ...s, name: e.target.value }));
                  setDirty(true);
                }}
                style={input}
              />
            </div>

            <div>
              <label htmlFor="org-domain" style={sectionTitle}>
                {t("org.domains.label")}
              </label>
              <p style={{ ...muted, marginBottom: 6 }}>{t("org.domains.help")}</p>
              {settings.domains.length > 0 && (
                <ul style={list} aria-label={t("org.domains.label")}>
                  {settings.domains.map((d) => (
                    <li key={d} style={row}>
                      <code dir="ltr" style={{ flex: 1, fontSize: 12 }}>
                        {d}
                      </code>
                      <button
                        type="button"
                        onClick={() => {
                          setSettings((s) => ({ ...s, domains: s.domains.filter((x) => x !== d) }));
                          setDirty(true);
                        }}
                        aria-label={t("org.domains.remove", { domain: d })}
                        style={iconBtn}
                      >
                        <Trash2 size={13} />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                <input
                  id="org-domain"
                  value={domainDraft}
                  dir="ltr"
                  placeholder="acme.com"
                  aria-invalid={domainError ? true : undefined}
                  aria-describedby={domainError ? "org-domain-error" : undefined}
                  onChange={(e) => {
                    setDomainDraft(e.target.value);
                    setDomainError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addDomain();
                    }
                  }}
                  style={{ ...input, flex: 1 }}
                />
                <button type="button" onClick={addDomain} className="icon-btn" style={smallBtn}>
                  <Plus size={13} aria-hidden="true" /> {t("org.domains.add")}
                </button>
              </div>
              {domainError && (
                <p id="org-domain-error" role="alert" style={{ ...muted, color: "hsl(0 70% 60%)", marginTop: 4 }}>
                  {domainError}
                </p>
              )}
            </div>

            <div>
              <button type="submit" disabled={!dirty} className="icon-btn" style={smallBtn}>
                {t("org.save")}
              </button>
            </div>
          </form>

          {/* ── SSO ─────────────────────────────────────────────── */}
          <section aria-labelledby="org-sso-title">
            <h3 id="org-sso-title" style={sectionTitle}>
              <ShieldCheck size={12} aria-hidden="true" /> {t("org.sso.title")}
            </h3>
            <div style={card} data-testid="org-sso-status" data-state={ssoState}>
              <strong style={{ fontSize: 13 }}>{t(`org.sso.${ssoState}`)}</strong>
              <p style={muted}>
                {ssoState === "connected"
                  ? t("org.sso.connected.hint", { org: user?.orgId ?? "—" })
                  : t(`org.sso.${ssoState}.hint`)}{" "}
                <a href={docsUrl("sso")} target="_blank" rel="noopener noreferrer" style={link}>
                  {t("toast.learnMore")}
                </a>
              </p>
              <p style={{ ...muted, marginTop: 6 }} data-testid="org-auth-status" data-kind={authDescription.kind}>
                {t("org.sso.account")}: <strong>{authDescription.title}</strong> — {authDescription.hint}
              </p>
            </div>
          </section>

          {/* ── Members ─────────────────────────────────────────── */}
          <section aria-labelledby="org-members-title">
            <h3 id="org-members-title" style={sectionTitle}>
              <Users size={12} aria-hidden="true" /> {t("org.members.title")}
            </h3>
            {ssoSession && user ? (
              <>
                <ul style={list} data-testid="org-members">
                  <li style={row}>
                    <span style={{ flex: 1, fontSize: 13 }}>{user.name ?? user.email ?? user.id}</span>
                    {user.email && user.name && (
                      <code dir="ltr" style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                        {user.email}
                      </code>
                    )}
                    <span style={pill}>{t("org.members.you")}</span>
                  </li>
                </ul>
                <p style={{ ...muted, marginTop: 6 }}>{t("org.members.directoryHint")}</p>
              </>
            ) : (
              <div style={{ ...card, textAlign: "center" }} data-testid="org-members-empty">
                <strong style={{ fontSize: 13 }}>{t("org.members.empty.title")}</strong>
                <p style={muted}>{t("org.members.empty.hint")}</p>
                <a href={docsUrl("sso")} target="_blank" rel="noopener noreferrer" style={link}>
                  {t("org.members.empty.cta")}
                </a>
              </div>
            )}
          </section>

          {/* ── Audit log ───────────────────────────────────────── */}
          {onOpenAuditLog && (
            <section aria-labelledby="org-audit-title">
              <h3 id="org-audit-title" style={sectionTitle}>
                <ScrollText size={12} aria-hidden="true" /> {t("audit.title")}
              </h3>
              {auditEntitled ? (
                <button
                  type="button"
                  onClick={() => {
                    onClose();
                    onOpenAuditLog();
                  }}
                  className="icon-btn"
                  style={smallBtn}
                >
                  {t("org.audit.open")}
                </button>
              ) : (
                <UpgradeNotice compact plan="team" message={t("billing.upgrade.auditLog")} />
              )}
            </section>
          )}
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
const closeBtn: React.CSSProperties = {
  marginInlineStart: "auto",
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg-muted))",
  cursor: "pointer",
  padding: 4,
  display: "flex",
};
const iconBtn: React.CSSProperties = { ...closeBtn, marginInlineStart: 0 };
const muted: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))" };
const link: React.CSSProperties = { color: "hsl(var(--accent))", textDecoration: "underline", fontSize: 12 };
const sectionTitle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  margin: "0 0 6px",
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "hsl(var(--fg-muted))",
};
const input: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 13,
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
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
const card: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  padding: 12,
  border: "1px dashed hsl(var(--border))",
  borderRadius: 8,
};
const pill: React.CSSProperties = {
  fontSize: 10,
  padding: "2px 8px",
  borderRadius: 999,
  border: "1px solid hsl(var(--border))",
  color: "hsl(var(--fg-muted))",
  whiteSpace: "nowrap",
};
const smallBtn: React.CSSProperties = {
  width: "auto",
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "6px 12px",
  fontSize: 12,
};

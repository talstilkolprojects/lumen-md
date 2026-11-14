/**
 * CollabSettings – small dialog to set/clear the custom signaling server URL
 * (`lumen.collab.signaling`) and the optional persistent Hocuspocus server
 * (`lumen.collab.ws`, read by src/collab/yjs.ts).
 *
 * The persistent server is a Pro capability (`Capabilities.persistentCollab`).
 * When not entitled the field is disabled with an upgrade notice, and saving
 * clears any stored persistent URL so sessions fall back to WebRTC P2P --
 * but only once the plan is known (never while it is loading or failed). With
 * no billing backend configured (self-hosted) the gate is open.
 * Accessible from the command palette or toolbar.
 */
import { useState } from "react";
import { t } from "../i18n";
import { useCapability, useEntitlementResolved } from "../billing/gates";
import { UpgradeNotice } from "./UpgradeNotice";
import { getSecret, setSecret } from "../lib/secretStore";

interface Props {
  onClose: () => void;
}

const SIGNALING_KEY = "lumen.collab.signaling";
const PERSISTENT_KEY = "lumen.collab.ws";
// Kept here (not imported from collab/yjs) so opening the settings doesn't
// load the yjs stack.
const PUBLIC_SIGNALING_KEY = "lumen.collab.publicSignaling";
const WS_TOKEN_KEY = "lumen.collab.wsToken";

function readKey(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}

function writeKey(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage denied */
  }
}

export function CollabSettings({ onClose }: Props) {
  const persistentAllowed = useCapability("persistentCollab");
  // While the plan is loading (or its check failed) "not allowed" is only a
  // placeholder: keep the saved persistent URL rather than erase it.
  const planKnown = useEntitlementResolved();
  const [url, setUrl] = useState(() => readKey(SIGNALING_KEY));
  const [wsUrl, setWsUrl] = useState(() => readKey(PERSISTENT_KEY));
  const [wsToken, setWsToken] = useState(() => getSecret(WS_TOKEN_KEY) ?? "");
  const [publicSignaling, setPublicSignaling] = useState(() => readKey(PUBLIC_SIGNALING_KEY) === "1");

  const handleSave = () => {
    writeKey(SIGNALING_KEY, url.trim());
    writeKey(PUBLIC_SIGNALING_KEY, publicSignaling ? "1" : "");
    if (persistentAllowed) {
      writeKey(PERSISTENT_KEY, wsUrl.trim());
      setSecret(WS_TOKEN_KEY, wsToken.trim() || null);
    }
    else if (planKnown) writeKey(PERSISTENT_KEY, ""); // an established downgrade
    onClose();
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        // CSS var → React rejects it as a number, so cast through unknown.
        zIndex: "var(--z-modal, 500)" as unknown as number,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "hsl(0 0% 0% / 0.5)",
        backdropFilter: "blur(4px)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          background: "hsl(var(--bg))",
          border: "1px solid hsl(var(--border))",
          borderRadius: 12,
          padding: 24,
          width: 400,
          maxWidth: "90vw",
        }}
      >
        <h3
          style={{
            margin: "0 0 8px",
            fontSize: 15,
            fontWeight: 600,
            color: "hsl(var(--fg))",
          }}
        >
          {t("collab.settings.title")}
        </h3>
        <p
          style={{
            margin: "0 0 16px",
            fontSize: 12,
            color: "hsl(var(--fg-muted))",
            lineHeight: 1.5,
          }}
        >
          {t("collab.settings.signalingHint")}
        </p>
        <input
          type="url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="wss://your-signaling-server.example.com"
          style={{
            width: "100%",
            padding: "8px 12px",
            fontSize: 13,
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            background: "hsl(var(--bg-subtle))",
            color: "hsl(var(--fg))",
            outline: "none",
            boxSizing: "border-box",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") onClose();
          }}
          autoFocus
        />
        <label style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 12, fontSize: 12, color: "hsl(var(--fg))" }}>
          <input type="checkbox" checked={publicSignaling} onChange={(e) => setPublicSignaling(e.target.checked)} />
          <span>
            {t("collab.settings.publicSignaling")}
            <span style={{ display: "block", color: "hsl(var(--fg-muted))", marginTop: 2 }}>{t("collab.settings.publicSignaling.hint")}</span>
          </span>
        </label>
        <label
          htmlFor="collab-persistent-url"
          style={{
            display: "block",
            margin: "16px 0 6px",
            fontSize: 12,
            fontWeight: 600,
            color: "hsl(var(--fg))",
          }}
        >
          {t("collab.persistent.label")}
        </label>
        <p style={{ margin: "0 0 8px", fontSize: 12, color: "hsl(var(--fg-muted))", lineHeight: 1.5 }}>
          {t("collab.persistent.hint")}
        </p>
        <input
          id="collab-persistent-url"
          type="url"
          value={persistentAllowed ? wsUrl : ""}
          onChange={(e) => setWsUrl(e.target.value)}
          disabled={!persistentAllowed}
          aria-disabled={!persistentAllowed}
          placeholder="wss://your-yjs-server.example.com"
          style={{
            width: "100%",
            padding: "8px 12px",
            fontSize: 13,
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            background: "hsl(var(--bg-subtle))",
            color: "hsl(var(--fg))",
            outline: "none",
            boxSizing: "border-box",
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            opacity: persistentAllowed ? 1 : 0.5,
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") onClose();
          }}
        />
        {persistentAllowed && (
          <input
            type="password"
            aria-label={t("collab.persistent.token")}
            value={wsToken}
            onChange={(e) => setWsToken(e.target.value)}
            placeholder={t("collab.persistent.token")}
            autoComplete="off"
            style={{
              width: "100%",
              marginTop: 8,
              padding: "8px 12px",
              fontSize: 13,
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              background: "hsl(var(--bg-subtle))",
              color: "hsl(var(--fg))",
              boxSizing: "border-box",
            }}
          />
        )}
        {!persistentAllowed && (
          <div style={{ marginTop: 8 }}>
            <UpgradeNotice compact plan="pro" message={t("billing.upgrade.persistentCollab")} />
          </div>
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            marginTop: 16,
          }}
        >
          <button
            onClick={onClose}
            className="icon-btn"
            style={{
              width: "auto",
              padding: "6px 16px",
              fontSize: 12,
            }}
          >
            {t("collab.settings.cancel")}
          </button>
          <button
            onClick={handleSave}
            style={{
              padding: "6px 16px",
              fontSize: 12,
              border: "none",
              borderRadius: 8,
              background: "hsl(var(--accent))",
              color: "white",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            {t("collab.settings.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

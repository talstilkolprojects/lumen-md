/**
 * Selective sync settings (plan W1.8): folders, file types and the largest
 * attachment this device syncs. Saved on this device only; shown before the
 * vault is unlocked too, so a phone can leave `Videos/` out before its first
 * round.
 */

import { useState, useSyncExternalStore, type FormEvent } from "react";
import { t } from "../../../i18n";
import "../strings";
import { hasRules, parseRulesForm } from "../rules";
import type { SyncSession } from "./session";
import { explainError } from "../../../lib/userError";

const field: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
};
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };

export function SyncRulesForm({ session }: { session: SyncSession }) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const r = s.rules;
  const [folders, setFolders] = useState(r.folders.join("\n"));
  const [exts, setExts] = useState(r.extensions.join(", "));
  const [maxMb, setMaxMb] = useState(r.maxAttachmentBytes === null ? "" : String(Math.round((r.maxAttachmentBytes / 1024 / 1024) * 10) / 10));
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const saved = session.setRules(parseRulesForm(folders, exts, maxMb));
      setFolders(saved.folders.join("\n"));
      setExts(saved.extensions.join(", "));
      setMessage(t("e2ee.rules.saved"));
    } catch (err) {
      setMessage(null);
      setError(explainError(err));
    }
  }

  return (
    <details style={{ paddingTop: 10, borderTop: "1px solid hsl(var(--border))" }} open={hasRules(r) || undefined}>
      <summary style={{ fontWeight: 600, cursor: "pointer" }}>{t("e2ee.rules.title")}</summary>
      <form onSubmit={submit} style={{ display: "grid", gap: 8, marginTop: 8 }} aria-label={t("e2ee.rules.title")}>
        <div style={muted}>{t("e2ee.rules.note")}</div>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          {t("e2ee.rules.folders")}
          <textarea dir="auto" rows={3} value={folders} onChange={(e) => setFolders(e.target.value)} style={{ ...field, resize: "vertical" }} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          {t("e2ee.rules.extensions")}
          <input dir="ltr" value={exts} onChange={(e) => setExts(e.target.value)} style={field} />
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          {t("e2ee.rules.maxSize")}
          <input dir="ltr" inputMode="decimal" value={maxMb} onChange={(e) => setMaxMb(e.target.value)} style={field} />
        </label>
        {/* empty-action: the rule fields above and Save below */}
        {!hasRules(r) && <div style={muted}>{t("e2ee.rules.none")}</div>}
        <button type="submit" style={{ justifySelf: "start" }}>
          {t("e2ee.rules.save")}
        </button>
        {message && (
          <div role="status" style={muted}>
            {message}
          </div>
        )}
        {error && (
          <div role="alert" style={{ fontSize: 12, color: "hsl(0 70% 50%)" }}>
            {error}
          </div>
        )}
      </form>
    </details>
  );
}

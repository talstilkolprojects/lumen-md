/**
 * Passphrase entry for the encrypted sync (plan 3.4): "create" asks twice
 * and enforces a minimum length; "unlock" asks once and shows a wrong
 * passphrase inline. Loaded on demand with the rest of src/sync/e2ee/.
 */

import { useState, type FormEvent } from "react";
import { t } from "../../../i18n";
import { WrongPassphraseError } from "../header";
import "../strings";

export const MIN_PASSPHRASE_LENGTH = 12;

interface Props {
  mode: "create" | "unlock";
  /** Resolves when the vault is created / unlocked; a rejection is shown in the form. */
  onSubmit: (passphrase: string) => Promise<void>;
}

const field: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
};

export function PassphraseForm({ mode, onSubmit }: Props) {
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "create") {
      if ([...pass].length < MIN_PASSPHRASE_LENGTH) return setError(t("e2ee.setup.tooShort", { n: MIN_PASSPHRASE_LENGTH }));
      if (pass !== again) return setError(t("e2ee.setup.mismatch"));
    }
    setError(null);
    setBusy(true);
    try {
      await onSubmit(pass);
    } catch (err) {
      setError(err instanceof WrongPassphraseError ? t("e2ee.setup.wrong") : String((err as Error)?.message ?? err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} aria-labelledby="e2ee-setup-title" style={{ display: "grid", gap: 10, maxWidth: 420 }}>
      <div id="e2ee-setup-title" style={{ fontWeight: 700 }}>
        {t("e2ee.setup.title")}
      </div>
      <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("e2ee.setup.note")}</div>
      <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
        {t("e2ee.setup.passphrase")}
        <input type="password" autoComplete={mode === "create" ? "new-password" : "current-password"} value={pass} onChange={(e) => setPass(e.target.value)} style={field} />
      </label>
      {mode === "create" && (
        <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
          {t("e2ee.setup.repeat")}
          <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} style={field} />
        </label>
      )}
      {error && (
        <div role="alert" style={{ fontSize: 12, color: "hsl(0 70% 50%)" }}>
          {error}
        </div>
      )}
      <button
        type="submit"
        disabled={busy || pass.length === 0}
        style={{ padding: "6px 14px", border: "none", borderRadius: 6, background: "hsl(var(--accent))", color: "white", cursor: "pointer", justifySelf: "start" }}
      >
        {t(mode === "create" ? "e2ee.setup.create" : "e2ee.setup.unlock")}
      </button>
    </form>
  );
}

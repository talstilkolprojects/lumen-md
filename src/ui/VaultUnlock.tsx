/**
 * The unlock screen of an encrypted vault (plan 11.4). It covers the whole
 * app while the vault is locked — at start-up and after auto-lock — so no
 * note is on screen without the passphrase. Vault calls made meanwhile wait
 * and go on once it is unlocked. "Forgot the passphrase?" opens the vault
 * with the recovery key and sets a new passphrase; with a damaged header,
 * that is the only way and it is shown at once.
 */

import { useEffect, useRef, useState, type FormEvent } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../i18n";
import { encryptionStatus, recover, unlock, UNLOCKED_EVENT } from "../storage/vault/encrypted/session";
import { WrongPassphraseError, MIN_PASSPHRASE_LENGTH } from "../storage/vault/encrypted/format";
import "../storage/vault/encrypted/strings";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";


const field: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
};
const button: React.CSSProperties = { padding: "8px 16px", border: "none", borderRadius: 6, background: "hsl(var(--accent))", color: "white", cursor: "pointer", justifySelf: "start" };
const link: React.CSSProperties = { background: "none", border: 0, padding: 0, color: "hsl(var(--accent))", cursor: "pointer", font: "inherit", fontSize: 13, justifySelf: "start" };

/** A vault-lock failure in words (never the error's own text: explainError). */
const describeVaultError = (err: unknown) => (err instanceof WrongPassphraseError ? t("vaultEnc.wrong") : explainError(err, "vault-encryption"));

export function VaultUnlockScreen() {
  const status = encryptionStatus();
  const [mode, setMode] = useState<"passphrase" | "recovery">(status.headerError ? "recovery" : "passphrase");
  const [pass, setPass] = useState("");
  const [key, setKey] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef<HTMLInputElement>(null);

  useEffect(() => {
    first.current?.focus();
  }, [mode]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "recovery") {
      if ([...next].length < MIN_PASSPHRASE_LENGTH) return setError(t("vaultEnc.tooShort", { n: MIN_PASSPHRASE_LENGTH }));
      if (next !== again) return setError(t("vaultEnc.mismatch"));
    }
    setError(null);
    setBusy(true);
    try {
      if (mode === "passphrase") await unlock(pass);
      else await recover(key, next);
    } catch (err) {
      setError(describeVaultError(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="vault-unlock-title"
      data-testid="vault-unlock"
      style={{ position: "fixed", inset: 0, zIndex: 10000, background: "hsl(var(--bg))", color: "hsl(var(--fg))", display: "grid", placeItems: "center", padding: 16 }}
    >
      <form onSubmit={submit} style={{ display: "grid", gap: 12, width: "min(420px, 100%)" }}>
        <div id="vault-unlock-title" style={{ fontWeight: 700, fontSize: 18 }}>
          🔐 {t("vaultEnc.lockedTitle")}
        </div>
        <HelpButton topic="security/vault-encryption#passphrase-recovery-key-lock" />
        {status.headerError ? (
          <div role="alert" style={{ fontSize: 13 }}>
            {t("vaultEnc.headerBroken", { reason: status.headerError })}
          </div>
        ) : (
          <div style={{ fontSize: 13, color: "hsl(var(--fg-muted))" }}>{t("vaultEnc.lockedNote")}</div>
        )}
        {mode === "passphrase" ? (
          <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
            {t("vaultEnc.passphrase")}
            <input ref={first} type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} style={field} />
          </label>
        ) : (
          <>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              {t("vaultEnc.recoveryKey")}
              <input ref={first} autoComplete="off" spellCheck={false} dir="ltr" value={key} onChange={(e) => setKey(e.target.value)} style={{ ...field, fontFamily: "ui-monospace, monospace" }} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              {t("vaultEnc.newPassphrase")}
              <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} style={field} />
            </label>
            <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
              {t("vaultEnc.repeat")}
              <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} style={field} />
            </label>
          </>
        )}
        {error && (
          <div role="alert" style={{ fontSize: 13, color: "hsl(var(--danger))" }}>
            {error}
          </div>
        )}
        <button type="submit" disabled={busy || (mode === "passphrase" ? !pass : !key)} style={button}>
          {t(mode === "passphrase" ? "vaultEnc.unlock" : "vaultEnc.recover")}
        </button>
        {mode === "passphrase" && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setMode("recovery");
            }}
            style={link}
          >
            {t("vaultEnc.forgot")}
          </button>
        )}
      </form>
    </div>
  );
}

let host: HTMLElement | null = null;
let root: Root | null = null;

function hide(): void {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}

/** Show the unlock screen (idempotent); it goes away by itself once the vault is unlocked. */
export function showVaultUnlock(): void {
  if (host) return;
  host = document.createElement("div");
  host.id = "lumen-vault-unlock";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<VaultUnlockScreen />);
  window.addEventListener(UNLOCKED_EVENT, hide, { once: true });
}

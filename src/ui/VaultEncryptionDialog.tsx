/**
 * Vault encryption at rest (plan 11.4): turn it on (passphrase twice, the
 * recovery key shown and confirmed before anything is written, progress),
 * and for an encrypted vault: auto-lock, lock now, change passphrase, check
 * and repair, turn it off. Opened from the command palette; loaded on use.
 */

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../i18n";
import { vaultEncryptionReady } from "../storage/vault";
import {
  autoLockMinutes,
  changePassphrase,
  disableEncryption,
  enableEncryption,
  kdfUpgradeAvailable,
  lock,
  repair,
  setAutoLockMinutes,
  upgradeKdf,
} from "../storage/vault/encrypted/session";
import type { ConvertProgress, ConvertReport } from "../storage/vault/encrypted/convert";
import { WrongPassphraseError, MIN_PASSPHRASE_LENGTH } from "../storage/vault/encrypted/format";
import "../storage/vault/encrypted/strings";

const field: React.CSSProperties = { width: "100%", padding: "6px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit" };
const primary: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 6, background: "hsl(var(--accent))", color: "white", cursor: "pointer", justifySelf: "start" };
const secondary: React.CSSProperties = { padding: "6px 14px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer", justifySelf: "start" };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };

const messageOf = (err: unknown) => (err instanceof WrongPassphraseError ? t("vaultEnc.wrong") : String((err as Error)?.message ?? err));

function Field({ label, value, onChange, autoComplete = "new-password" }: { label: string; value: string; onChange: (v: string) => void; autoComplete?: string }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      {label}
      <input type="password" autoComplete={autoComplete} value={value} onChange={(e) => onChange(e.target.value)} style={field} />
    </label>
  );
}

function Alert({ children }: { children: ReactNode }) {
  return (
    <div role="alert" style={{ fontSize: 12, color: "hsl(0 70% 50%)" }}>
      {children}
    </div>
  );
}

/** What a conversion report says to the user. */
function reportLines(r: ConvertReport): string[] {
  const out: string[] = [];
  if (r.retry.length) out.push(t("vaultEnc.retry", { n: r.retry.length }));
  if (r.broken.length) out.push(t("vaultEnc.broken", { n: r.broken.length, paths: r.broken.slice(0, 5).join(", ") }));
  return out;
}

function checkNew(pass: string, again: string): string | null {
  if ([...pass].length < MIN_PASSPHRASE_LENGTH) return t("vaultEnc.tooShort", { n: MIN_PASSPHRASE_LENGTH });
  if (pass !== again) return t("vaultEnc.mismatch");
  return null;
}

function TurnOn({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [recovery, setRecovery] = useState<{ key: string; answer: (ok: boolean) => void } | null>(null);
  const [saved, setSaved] = useState(false);
  const [progress, setProgress] = useState<ConvertProgress | null>(null);
  const [lines, setLines] = useState<string[] | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const bad = checkNew(pass, again);
    if (bad) return setError(bad);
    setError(null);
    setBusy(true);
    try {
      const r = await enableEncryption(pass, {
        confirmRecoveryKey: (key) => new Promise<boolean>((answer) => setRecovery({ key, answer })),
        onProgress: setProgress,
      });
      setRecovery(null);
      if (r) setLines([t("vaultEnc.doneOn"), ...reportLines(r.report)]);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  if (lines) {
    return (
      <div style={{ display: "grid", gap: 8 }} data-testid="vault-enc-done">
        {lines.map((l) => (
          <div key={l}>{l}</div>
        ))}
        <button type="button" onClick={onDone} style={primary}>
          {t("vaultEnc.close")}
        </button>
      </div>
    );
  }

  if (recovery) {
    return (
      <div style={{ display: "grid", gap: 10 }}>
        <strong>{t("vaultEnc.recoveryTitle")}</strong>
        <code dir="ltr" data-testid="vault-recovery-key" style={{ fontSize: 16, letterSpacing: 1, padding: "8px 10px", border: "1px dashed hsl(var(--border))", borderRadius: 6, userSelect: "all", textAlign: "center" }}>
          {recovery.key}
        </code>
        <div style={muted}>{t("vaultEnc.recoveryNote")}</div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 13 }}>
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          {t("vaultEnc.recoverySaved")}
        </label>
        <div style={{ display: "flex", gap: 8 }}>
          <button type="button" disabled={!saved} onClick={() => recovery.answer(true)} style={primary}>
            {t("vaultEnc.encryptNow")}
          </button>
          <button
            type="button"
            onClick={() => {
              recovery.answer(false);
              setRecovery(null);
            }}
            style={secondary}
          >
            {t("vaultEnc.cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={submit} style={{ display: "grid", gap: 10 }}>
      <div style={{ fontSize: 13 }}>{t("vaultEnc.intro")}</div>
      <div role="note" style={{ fontSize: 13, padding: "8px 10px", borderInlineStart: "3px solid hsl(40 90% 50%)", background: "hsl(40 90% 50% / 0.08)" }}>
        {t("vaultEnc.warning")}
      </div>
      <Field label={t("vaultEnc.passphrase")} value={pass} onChange={setPass} />
      <Field label={t("vaultEnc.repeat")} value={again} onChange={setAgain} />
      {error && <Alert>{error}</Alert>}
      {progress && busy && <div style={muted}>{t("vaultEnc.progress", { done: progress.done, total: progress.total })}</div>}
      <button type="submit" disabled={busy || !pass} style={primary}>
        {t("vaultEnc.turnOn")}
      </button>
    </form>
  );
}

function Manage({ onDone }: { onDone: () => void }) {
  const [minutes, setMinutes] = useState(autoLockMinutes());
  const [panel, setPanel] = useState<"none" | "change" | "off" | "kdf">("none");
  // Review 12.11: a PBKDF2 vault moves to Argon2id only when the user asks.
  const [canUpgrade, setCanUpgrade] = useState(kdfUpgradeAvailable());
  const [cur, setCur] = useState("");
  const [pass, setPass] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string[]>([]);
  const [progress, setProgress] = useState<ConvertProgress | null>(null);

  const run = async (job: () => Promise<string[]>) => {
    setBusy(true);
    setError(null);
    try {
      setInfo(await job());
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
      setProgress(null);
    }
  };

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>{t("vaultEnc.statusOn")}</div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
        {t("vaultEnc.autoLock")}
        <select
          value={minutes}
          onChange={(e) => {
            const n = Number(e.target.value);
            setMinutes(n);
            setAutoLockMinutes(n);
          }}
          style={{ ...field, width: "auto" }}
        >
          {[5, 15, 30, 60, 0].map((n) => (
            <option key={n} value={n}>
              {n ? t("vaultEnc.minutes", { n }) : t("vaultEnc.never")}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => {
            onDone();
            lock();
          }}
          style={secondary}
        >
          {t("vaultEnc.lockNow")}
        </button>
        <button type="button" onClick={() => setPanel(panel === "change" ? "none" : "change")} style={secondary}>
          {t("vaultEnc.change")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const r = await repair(setProgress);
              return [t("vaultEnc.repaired", { encrypted: r.scan.encrypted, plain: r.scan.plain.length, broken: r.scan.broken.length, recovered: r.recovered }), ...reportLines(r.report)];
            })
          }
          style={secondary}
        >
          {t("vaultEnc.repair")}
        </button>
        <button type="button" onClick={() => setPanel(panel === "off" ? "none" : "off")} style={secondary}>
          {t("vaultEnc.turnOff")}
        </button>
        {canUpgrade && (
          <button type="button" onClick={() => setPanel(panel === "kdf" ? "none" : "kdf")} style={secondary} data-testid="vault-kdf-upgrade">
            {t("vaultEnc.kdfUpgrade")}
          </button>
        )}
      </div>
      {panel === "kdf" && canUpgrade && (
        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await upgradeKdf(cur);
              setCanUpgrade(kdfUpgradeAvailable());
              setPanel("none");
              return [t("vaultEnc.kdfUpgraded")];
            });
          }}
        >
          <div role="note" style={{ fontSize: 13, padding: "8px 10px", borderInlineStart: "3px solid hsl(40 90% 50%)", background: "hsl(40 90% 50% / 0.08)" }}>
            {t("vaultEnc.kdfUpgradeNote")}
          </div>
          <Field label={t("vaultEnc.current")} value={cur} onChange={setCur} autoComplete="current-password" />
          <button type="submit" disabled={busy || !cur} style={primary}>
            {t("vaultEnc.kdfUpgrade")}
          </button>
        </form>
      )}
      {panel === "change" && (
        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            const bad = checkNew(pass, again);
            if (bad) return setError(bad);
            void run(async () => {
              await changePassphrase(cur, pass);
              setPanel("none");
              return [t("vaultEnc.changed")];
            });
          }}
        >
          <Field label={t("vaultEnc.current")} value={cur} onChange={setCur} autoComplete="current-password" />
          <Field label={t("vaultEnc.newPassphrase")} value={pass} onChange={setPass} />
          <Field label={t("vaultEnc.repeat")} value={again} onChange={setAgain} />
          <button type="submit" disabled={busy || !cur || !pass} style={primary}>
            {t("vaultEnc.change")}
          </button>
        </form>
      )}
      {panel === "off" && (
        <form
          style={{ display: "grid", gap: 8 }}
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const r = await disableEncryption(cur, setProgress);
              if (r.done) onDone();
              return [r.done ? t("vaultEnc.doneOff") : t("vaultEnc.notDone"), ...reportLines(r.report)];
            });
          }}
        >
          <div style={muted}>{t("vaultEnc.turnOffNote")}</div>
          <Field label={t("vaultEnc.current")} value={cur} onChange={setCur} autoComplete="current-password" />
          <button type="submit" disabled={busy || !cur} style={primary}>
            {t("vaultEnc.turnOff")}
          </button>
        </form>
      )}
      {progress && <div style={muted}>{t("vaultEnc.progress", { done: progress.done, total: progress.total })}</div>}
      {error && <Alert>{error}</Alert>}
      {info.map((l) => (
        <div key={l} role="status" style={{ fontSize: 13 }}>
          {l}
        </div>
      ))}
    </div>
  );
}

export function VaultEncryptionDialog({ onClose }: { onClose: () => void }) {
  const [state, setState] = useState<"loading" | "none" | "encrypted">("loading");
  useEffect(() => {
    void vaultEncryptionReady().then((s) => setState(s === "locked" || s === "unlocked" ? "encrypted" : "none"));
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 9000, background: "rgb(0 0 0 / 0.35)", display: "grid", placeItems: "center", padding: 16 }}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="vault-enc-title"
        data-testid="vault-encryption"
        style={{ width: "min(480px, 100%)", maxHeight: "90vh", overflow: "auto", background: "hsl(var(--bg-elevated, var(--bg)))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 10, padding: 16, display: "grid", gap: 12 }}
      >
        <div style={{ display: "flex", alignItems: "center" }}>
          <strong id="vault-enc-title" style={{ flex: 1 }}>
            🔐 {t("vaultEnc.title")}
          </strong>
          <button type="button" onClick={onClose} aria-label={t("vaultEnc.close")} style={{ background: "none", border: 0, cursor: "pointer", color: "inherit" }}>
            ✕
          </button>
        </div>
        {state === "none" && <TurnOn onDone={onClose} />}
        {state === "encrypted" && <Manage onDone={onClose} />}
      </div>
    </div>
  );
}

let host: HTMLElement | null = null;
let root: Root | null = null;

function close(): void {
  root?.unmount();
  root = null;
  host?.remove();
  host = null;
}

export function showVaultEncryptionDialog(): void {
  if (host) return;
  host = document.createElement("div");
  host.id = "lumen-vault-encryption";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<VaultEncryptionDialog onClose={close} />);
}

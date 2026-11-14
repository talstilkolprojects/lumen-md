/**
 * "Share as an encrypted link" (plan W5.10): the open note, read-only,
 * encrypted on this device into a link (src/share/linkShare.ts). Nothing is
 * uploaded: the note and its key sit in the link's #fragment. A note too
 * large for a link is offered as an encrypted file plus a key-only link.
 *
 * Loaded on use from the command palette (src/commands/domains/export.ts).
 */
import "./shareStrings";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Link2, X } from "lucide-react";
import { t } from "../i18n";
import { createShareLink, EXPIRY_DAYS, MAX_LINK_DATA, SHARE_FILE_EXTENSION, ShareLinkError, shareOrigin, type ShareLink } from "./linkShare";

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const field: React.CSSProperties = { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };

const DAY = 24 * 60 * 60 * 1000;

/** Where share links open the viewer: this page on a public https host, else the public app (review 12.11). */
function appOrigin(): string {
  return shareOrigin();
}

function CopyField({ value, label, testId }: { value: string; label: string; testId: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div style={row}>
      <input readOnly dir="ltr" style={{ ...field, flex: 1, minWidth: 0, fontFamily: "ui-monospace, monospace", fontSize: 12 }} value={value} aria-label={label} data-testid={testId} onFocus={(e) => e.currentTarget.select()} />
      <button
        type="button"
        style={ghost}
        onClick={() => {
          navigator.clipboard?.writeText(value).then(
            () => setCopied(true),
            () => {
              /* why: clipboard denied: the field is selected on focus to copy by hand */
            },
          );
        }}
      >
        {copied ? t("shareLink.copied") : label}
      </button>
    </div>
  );
}

function download(bytes: Uint8Array, name: string) {
  const url = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "application/octet-stream" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function ShareLinkDialog({ title, markdown, onClose }: { title: string; markdown: string; onClose: () => void }) {
  const [days, setDays] = useState<number>(0);
  const [separateKey, setSeparateKey] = useState(false);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      const created = Date.now();
      setLink(await createShareLink({ title, markdown, created, ...(days ? { expires: created + days * DAY } : {}) }, appOrigin()));
    } catch (e) {
      setError(e instanceof ShareLinkError && e.code === "unsupported" ? t("shareLink.unsupported") : t("shareLink.failed", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const fileName = `${(title.replace(/\.[^.]+$/, "") || "note").replace(/[^\p{L}\p{N}._-]+/gu, "-")}${SHARE_FILE_EXTENSION}`;

  return (
    <div className="cmd-palette-backdrop">
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("shareLink.title")} data-testid="share-link" style={{ maxWidth: 600, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Link2 size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("shareLink.title")}</h2>
          <button ref={closeRef} type="button" style={ghost} onClick={onClose} aria-label={t("shareLink.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("shareLink.intro")}</p>
          <div style={row}>
            <label style={row}>
              <span>{t("shareLink.expiry")}</span>
              <select style={field} value={days} onChange={(e) => { setDays(Number(e.target.value)); setLink(null); }} data-testid="share-link-expiry">
                {EXPIRY_DAYS.map((d) => (
                  <option key={d} value={d}>
                    {d === 0 ? t("shareLink.expiry.never") : d === 1 ? t("shareLink.expiry.day") : t("shareLink.expiry.days", { n: d })}
                  </option>
                ))}
              </select>
            </label>
            <label style={row}>
              <input type="checkbox" checked={separateKey} onChange={(e) => setSeparateKey(e.target.checked)} data-testid="share-link-separate" />
              <span>{t("shareLink.separateKey")}</span>
            </label>
          </div>
          {days > 0 && <p style={{ ...muted, margin: 0 }}>{t("shareLink.expiryNote")}</p>}
          <div style={row}>
            <button type="button" style={primary} onClick={() => void create()} disabled={busy} data-testid="share-link-create">
              {t("shareLink.create")}
            </button>
          </div>
          {error && (
            <div role="alert" style={{ fontSize: 13, color: "hsl(0 70% 55%)" }}>
              {error}
            </div>
          )}
          {link && link.url && link.urlWithoutKey && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="share-link-result">
              <CopyField value={separateKey ? link.urlWithoutKey : link.url} label={t("shareLink.copy")} testId="share-link-url" />
              {separateKey && (
                <>
                  <span style={muted}>{t("shareLink.keyHint")}</span>
                  <CopyField value={link.key} label={t("shareLink.copyKey")} testId="share-link-key" />
                </>
              )}
              <span style={muted}>{t("shareLink.size", { chars: link.dataChars.toLocaleString(), max: MAX_LINK_DATA.toLocaleString() })}</span>
            </div>
          )}
          {link && !link.url && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="share-link-too-big">
              <p style={{ margin: 0 }} role="status">
                {t("shareLink.tooBig", { chars: link.dataChars.toLocaleString(), max: MAX_LINK_DATA.toLocaleString() })}
              </p>
              <div style={row}>
                <button type="button" style={primary} onClick={() => download(link.file, fileName)} data-testid="share-link-file">
                  {t("shareLink.downloadFile")}
                </button>
              </div>
              <CopyField value={link.fileUrl} label={t("shareLink.copy")} testId="share-link-file-url" />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the share dialog for one note (one dialog at a time). */
export function openShareLink(note: { title: string; markdown: string }): void {
  openHost?.close();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (openHost?.close === close) openHost = null;
    try {
      root.unmount();
    } catch {
      /* why: already unmounted by an earlier close */
    }
    host.remove();
  };
  openHost = { close };
  root.render(<ShareLinkDialog title={note.title} markdown={note.markdown} onClose={close} />);
}

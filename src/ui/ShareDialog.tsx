/**
 * Share dialog (plan W1.19): make a share link for the open collab room —
 * view, comment or edit, expiring after an hour, a day, a week or a month —
 * see the room's links and revoke any of them; and "Shared with me", the
 * links this device has opened, with their current state.
 *
 * Opened from the command palette on its own root, so the app shell holds
 * no state for it. Everything it does is checked by the collab server.
 */

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Share2, X } from "lucide-react";
import type { CollabSession } from "../collab/yjs";
import {
  collabAccessKey,
  collabServerUrl,
  createShare,
  forgetShared,
  listShares,
  listSharedWithMe,
  ownerSecret,
  refreshSharedWithMe,
  revokeShare,
  shareLink,
  ROLES,
  SHARE_TTLS,
  type Role,
  type ShareInfo,
  type ShareTtl,
  type SharedWithMe,
} from "../collab/sharing";
import { RoomTokenError } from "../collab/roomToken";
import { getLocale, t } from "../i18n";
import "../collab/sharingStrings";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";
import { EmptyState, learnHow } from "./EmptyState";

type Tab = "share" | "shared";

interface Props {
  session: CollabSession | null;
  initialTab?: Tab;
  onClose: () => void;
  /** Test seam: the server address (default: Collab settings / the build). */
  serverUrl?: string | null;
}

const muted: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))" };
const field: React.CSSProperties = { padding: "5px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", fontSize: 13 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "6px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6, fontSize: 12, flexWrap: "wrap" };
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 };

/** A sharing failure in words (never the error's own text: explainError). */
function describeShareError(e: unknown): string {
  const reason = e instanceof RoomTokenError ? e.reason : "";
  const known = ["owner-required", "unauthorized", "unreachable", "timeout", "revoked", "expired", "no-share"];
  return known.includes(reason) ? t(`share.error.${reason}`) : explainError(e, "share");
}

const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString(getLocale()));

function ShareTab({ session, server }: { session: CollabSession | null; server: string | null }) {
  const [role, setRole] = useState<Role>("view");
  const [ttl, setTtl] = useState<ShareTtl>("week");
  const [label, setLabel] = useState("");
  const [shares, setShares] = useState<ShareInfo[] | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const room = session?.roomName ?? null;
  const refresh = useCallback(async () => {
    if (!server || !room || !ownerSecret(room)) return setShares([]);
    try {
      setShares(await listShares(server, room, collabAccessKey()));
    } catch (e) {
      setError(describeShareError(e));
      setShares([]);
    }
  }, [server, room]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!session) return <p style={muted}>{t("share.needSession")}</p>;
  if (!server) return <p style={muted}>{t("share.needServer")}</p>;
  if (session.share) return <p style={muted}>{t("share.notOwner")}</p>;
  // Plan W2.20: a shared room is end-to-end encrypted, so the server only
  // ever sees ciphertext. A room without its own key would give it plaintext.
  if (!session.encrypted || !session.sharePassword) return <p style={muted}>{t("share.needEncrypted")}</p>;

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const s = await createShare(server!, session!.roomName, { role, ttl, label: label.trim(), accessKey: collabAccessKey(), e2ee: true });
      const l = shareLink(session!.roomName, session!.sharePassword, s.id);
      setLink(l);
      setLabel("");
      navigator.clipboard?.writeText(l).catch(() => undefined);
      await refresh();
    } catch (err) {
      setError(describeShareError(err));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    try {
      await revokeShare(server!, session!.roomName, id, collabAccessKey());
      await refresh();
    } catch (err) {
      setError(describeShareError(err));
    }
  }

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <p style={muted}>{t("share.intro")}</p>
      <p style={muted} data-testid="share-e2ee">
        {t("share.e2ee")}
      </p>
      <form onSubmit={create} style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "end" }} aria-label={t("share.create")}>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          {t("share.role")}
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} style={field}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {t(`share.role.${r}`)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
          {t("share.expires")}
          <select value={ttl} onChange={(e) => setTtl(e.target.value as ShareTtl)} style={field}>
            {(Object.keys(SHARE_TTLS) as ShareTtl[]).map((k) => (
              <option key={k} value={k}>
                {t(`share.ttl.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <label style={{ display: "grid", gap: 4, fontSize: 12, flex: 1, minWidth: 120 }}>
          {t("share.label")}
          <input dir="auto" value={label} maxLength={80} onChange={(e) => setLabel(e.target.value)} style={field} />
        </label>
        <button type="submit" disabled={busy} style={{ ...field, cursor: "pointer" }}>
          {t("share.create")}
        </button>
      </form>
      {link && (
        <div style={{ display: "grid", gap: 4 }}>
          <code dir="ltr" data-testid="share-link" style={{ userSelect: "all", wordBreak: "break-all", fontSize: 11 }}>
            {link}
          </code>
          <span style={muted} role="status">
            {t("share.copied")}
          </span>
        </div>
      )}
      {error && (
        <p role="alert" style={{ ...muted, color: "hsl(var(--danger))" }}>
          {error}
        </p>
      )}
      <section aria-labelledby="share-links">
        <h3 id="share-links" style={{ margin: "0 0 6px", fontSize: 12, fontWeight: 600 }}>
          {t("share.links")}
        </h3>
        {shares === null ? (
          <p style={muted}>{t("share.loading")}</p>
        ) : shares.length === 0 ? (
          // empty-action: the "create a link" form above
          <p style={muted}>{t("share.none")}</p>
        ) : (
          <ul style={list} data-testid="share-list">
            {shares.map((s) => (
              <li key={s.id} style={row} data-state={s.state}>
                <strong>{t(`share.role.${s.role}`)}</strong>
                {s.label && <bdi dir="auto">{s.label}</bdi>}
                <span style={muted}>{t(`share.state.${s.state}`, { date: when(s.expiresAt) })}</span>
                {s.state === "active" && (
                  <button type="button" style={{ marginInlineStart: "auto" }} onClick={() => void revoke(s.id)} aria-label={t("share.revoke.aria", { role: t(`share.role.${s.role}`) })}>
                    {t("share.revoke")}
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SharedTab({ server }: { server: string | null }) {
  const [items, setItems] = useState<SharedWithMe[]>(() => listSharedWithMe());
  useEffect(() => {
    if (!server) return;
    let live = true;
    void refreshSharedWithMe(server).then((x) => live && setItems(x));
    return () => {
      live = false;
    };
  }, [server]);
  if (items.length === 0) return <EmptyState style={{ padding: 0 }} message={t("share.withMe.none")} action={learnHow("collab/sharing#shared-with-me")} />;
  return (
    <ul style={list} data-testid="shared-with-me">
      {items.map((x) => (
        <li key={x.share} style={row} data-state={x.state}>
          <bdi dir="auto" style={{ fontWeight: 600 }}>
            {x.title || x.room}
          </bdi>
          <span style={muted}>{t(`share.role.${x.role}`)}</span>
          <span style={muted}>{x.state === "unknown" ? t("share.state.unknown") : t(`share.state.${x.state}`, { date: when(x.expiresAt) })}</span>
          <span style={{ marginInlineStart: "auto", display: "flex", gap: 6 }}>
            {x.state === "active" && x.link && (
              <a href={x.link} style={{ color: "hsl(var(--accent))" }}>
                {t("share.withMe.open")}
              </a>
            )}
            <button
              type="button"
              onClick={() => {
                forgetShared(x.share);
                setItems(listSharedWithMe());
              }}
            >
              {t("share.withMe.forget")}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ShareDialog({ session, initialTab = "share", onClose, serverUrl }: Props) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const server = serverUrl === undefined ? collabServerUrl() : serverUrl;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="cmd-palette-backdrop" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 620, maxHeight: "82vh", display: "flex", flexDirection: "column" }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
          <Share2 size={16} aria-hidden="true" />
          <h2 id="share-dialog-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("share.title")}
          </h2>
          <HelpButton topic="collab/sharing" />
          <button type="button" onClick={onClose} aria-label={t("share.close")} style={{ marginInlineStart: "auto", border: "none", background: "transparent", color: "inherit", cursor: "pointer" }}>
            <X size={14} />
          </button>
        </div>
        <div role="tablist" aria-label={t("share.title")} style={{ display: "flex", gap: 4, padding: "8px 16px 0" }}>
          {(["share", "shared"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)} style={{ ...field, fontWeight: tab === k ? 600 : 400 }}>
              {t(k === "share" ? "share.tab.share" : "share.tab.withMe")}
            </button>
          ))}
        </div>
        <div role="tabpanel" style={{ overflow: "auto", padding: "12px 16px" }}>
          {tab === "share" ? <ShareTab session={session} server={server} /> : <SharedTab server={server} />}
        </div>
      </div>
    </div>
  );
}

/** Open the dialog on its own root. */
export function openShareDialog(opts: { session: CollabSession | null; tab?: Tab }): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    try {
      root.unmount();
    } catch {
      // why: the dialog root is already unmounted
      /* already gone */
    }
    host.remove();
  };
  root.render(<ShareDialog session={opts.session} initialTab={opts.tab} onClose={close} />);
}

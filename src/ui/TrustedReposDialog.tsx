/**
 * Settings → Trusted repositories (plan W1.33).
 *
 * One switch per cloned repository: "trust this repo". Off by default,
 * stored on this device only (`agents/repoTrust.ts`). With it on, a write
 * an agent proposes while reading that repository's notes is staged
 * without the extra outside-content question; it still waits for review,
 * and web requests still ask. Opened from the command palette; mounted on
 * its own root so the app shell carries no state for it.
 */

import { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ShieldCheck, X } from "lucide-react";
import { ensureProvenanceBackfill } from "../agents/provenance";
import { isRepoTrusted, setRepoTrusted } from "../agents/repoTrust";
import { uiConfirm } from "./PromptDialog";
import { showAiToast } from "./AiToast";
import { docsUrl } from "../lib/docsLinks";
import { t } from "../i18n";
import "./trustedReposDialogStrings";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";

interface Props {
  onClose: () => void;
  /** The cloned repositories; defaults to the folders of the git volume. */
  loadRepos?: () => Promise<string[]>;
}

type Row = { repo: string; trusted: boolean };

async function clonedRepos(): Promise<string[]> {
  // Open the git volume only when it exists (it pulls isomorphic-git).
  if (typeof indexedDB === "undefined") return [];
  if (typeof indexedDB.databases === "function" && !(await indexedDB.databases()).some((d) => d.name === "lumen-git")) return [];
  return (await import("../sync/git")).listGitRepos();
}

export function TrustedReposDialog({ onClose, loadRepos = clonedRepos }: Props) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [failed, setFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Clones made before the injection guard get their provenance record first: trust binds to it.
      await ensureProvenanceBackfill();
      setRows((await loadRepos()).map((repo) => ({ repo, trusted: isRepoTrusted(repo) })));
    } catch {
      setFailed(true);
      setRows([]);
    }
  }, [loadRepos]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const toggle = useCallback(
    async (repo: string, next: boolean) => {
      // Turning trust on is the risky direction: ask, and say what it means.
      if (next && !(await uiConfirm({ title: t("trustedRepos.confirm.title"), message: t("trustedRepos.confirm.body", { repo }) }))) return;
      try {
        setRepoTrusted(repo, next);
      } catch (e) {
        showAiToast(t("trustedRepos.saveFailed", { error: explainError(e) }), "error");
        return;
      }
      setRows((rs) => rs?.map((r) => (r.repo === repo ? { ...r, trusted: isRepoTrusted(repo) } : r)) ?? rs);
      showAiToast(t(next ? "trustedRepos.on" : "trustedRepos.off", { repo }), "success");
    },
    [],
  );

  return (
    <div className="cmd-palette-backdrop" onClick={onClose}>
      <div
        className="cmd-palette"
        role="dialog"
        aria-modal="true"
        aria-labelledby="trusted-repos-title"
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: 560, maxHeight: "82vh", display: "flex", flexDirection: "column" }}
      >
        <div style={header}>
          <ShieldCheck size={16} aria-hidden="true" />
          <h2 id="trusted-repos-title" style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("trustedRepos.title")}
          </h2>
          <HelpButton topic="security/trusted-repos" />
          <button type="button" onClick={onClose} aria-label={t("trustedRepos.close")} style={iconBtn}>
            <X size={14} />
          </button>
        </div>
        <div style={{ overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 12 }}>
          <p style={muted}>
            {t("trustedRepos.intro")}{" "}
            <a href={docsUrl("trustedRepos")} target="_blank" rel="noopener noreferrer" style={link}>
              {t("toast.learnMore")}
            </a>
          </p>
          {rows === null ? (
            <p style={muted}>{t("trustedRepos.loading")}</p>
          ) : rows.length === 0 ? (
            <p style={muted} data-testid="trusted-repos-empty" role={failed ? "alert" : undefined}>
              {t(failed ? "trustedRepos.loadFailed" : "trustedRepos.empty")}
            </p>
          ) : (
            <ul style={list}>
              {rows.map((r) => (
                <li key={r.repo} style={row}>
                  <bdi style={name} dir="auto">
                    {r.repo}
                  </bdi>
                  <label style={switchLabel}>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={r.trusted}
                      aria-checked={r.trusted}
                      aria-label={t("trustedRepos.toggle.aria", { repo: r.repo })}
                      onChange={(e) => void toggle(r.repo, e.target.checked)}
                    />
                    {t(r.trusted ? "trustedRepos.state.on" : "trustedRepos.state.off")}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/** Open the dialog on its own root (command palette → "Trusted repositories…"). */
export function openTrustedReposDialog(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    try {
      root.unmount();
    } catch {
      /* already gone */
    }
    host.remove();
  };
  root.render(<TrustedReposDialog onClose={close} />);
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
const list: React.CSSProperties = { listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 4 };
const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "6px 8px",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
};
const name: React.CSSProperties = { flex: 1, fontSize: 13, wordBreak: "break-all" };
const switchLabel: React.CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, whiteSpace: "nowrap" };

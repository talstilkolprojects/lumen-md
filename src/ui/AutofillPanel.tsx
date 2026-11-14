/**
 * The approval queue for AI-filled properties (plan 5.10): each proposal
 * shows its note and every property's before → after; nothing is written
 * until Approve (one note) or Approve all. Lazy — mounted by
 * "AI: Fill Properties…", never in the startup bundle.
 */
import { useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Check, X } from "lucide-react";
import { t } from "../i18n";
import { AutofillQueue, type Proposal } from "../properties/autofill";
import { showAiToast } from "./AiToast";
import "./autofillPanelStrings";
import { HelpButton } from "./HelpButton";
import { explainError } from "../lib/userError";
import { EmptyState, runCommand } from "./EmptyState";

const btn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };

let queue: AutofillQueue | null = null;

/** The one queue of this tab, writing through the vault (the only writer is approve()). */
export function autofillQueue(): AutofillQueue {
  return (queue ??= new AutofillQueue({
    read: async (path) => (await import("../storage/workspace")).readWorkspaceFile(path),
    write: async (path, text) => {
      const ws = await import("../storage/workspace");
      await ws.writeWorkspaceFile(path, text);
      window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
    },
  }));
}

const show = (v: unknown) => (v === null || v === undefined || v === "" ? "—" : Array.isArray(v) ? v.join(", ") : String(v));

function Row({ p, busy, onApprove, onReject }: { p: Proposal; busy: boolean; onApprove: () => void; onReject: () => void }) {
  return (
    <li data-testid="autofill-proposal" data-path={p.path} style={{ padding: "10px 16px", borderBottom: "1px solid hsl(var(--border))", listStyle: "none" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <strong style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }} dir="auto">
          {p.path}
        </strong>
        <button type="button" style={btn} disabled={busy} onClick={onApprove} data-testid="autofill-approve">
          <Check size={12} /> {t("autofill.approve")}
        </button>
        <button type="button" style={btn} disabled={busy} onClick={onReject} data-testid="autofill-reject">
          <X size={12} /> {t("autofill.reject")}
        </button>
      </div>
      <table style={{ width: "100%", fontSize: 12, marginTop: 6, borderCollapse: "collapse" }}>
        <tbody>
          {p.changes.map((c) => (
            <tr key={c.key}>
              <td style={{ padding: "2px 6px", color: "hsl(var(--fg-muted))" }}>{c.key}</td>
              <td style={{ padding: "2px 6px", textDecoration: "line-through", color: "hsl(var(--fg-muted))" }} dir="auto">
                {show(c.before)}
              </td>
              <td style={{ padding: "2px 6px" }} dir="auto">
                {show(c.after)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </li>
  );
}

export function AutofillPanel({ onClose }: { onClose: () => void }) {
  const q = autofillQueue();
  const [items, setItems] = useState<readonly Proposal[]>(q.list());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const off = q.subscribe(() => setItems(q.list()));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, [q, onClose]);

  const approve = async (ids: string[]) => {
    setBusy(true);
    let written = 0;
    let stale = 0;
    try {
      for (const id of ids) {
        const r = await q.approve(id);
        if (r === "written") written++;
        else if (r === "stale") stale++;
      }
    } catch (e) {
      showAiToast(explainError(e), "error");
    } finally {
      setBusy(false);
    }
    if (written) showAiToast(t("autofill.written", { n: written }), "success");
    if (stale) showAiToast(t("autofill.stale", { n: stale }), "info");
  };

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("autofill.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 680, padding: 0, display: "flex", flexDirection: "column", maxHeight: "82vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <strong style={{ flex: 1 }}>{t("autofill.title")}</strong>
          <HelpButton topic="workspace/ai-autofill" />
          <button type="button" style={btn} disabled={busy || !items.length} onClick={() => void approve(items.map((p) => p.id))} data-testid="autofill-approve-all">
            {t("autofill.approveAll", { n: items.length })}
          </button>
          <button type="button" style={btn} onClick={onClose} aria-label={t("privacy.close")}>
            <X size={14} />
          </button>
        </header>
        <p style={{ margin: 0, padding: "8px 16px", fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("autofill.hint")}</p>
        <div style={{ overflow: "auto", flex: 1 }}>
          {items.length === 0 ? (
            <EmptyState message={t("autofill.empty")} action={{ label: t("cmd.ai.autofill"), onClick: () => (onClose(), runCommand("ai.autofill")) }} />
          ) : (
            <ul style={{ margin: 0, padding: 0 }}>
              {items.map((p) => (
                <Row key={p.id} p={p} busy={busy} onApprove={() => void approve([p.id])} onReject={() => q.reject(p.id)} />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

let mounted: { root: Root; host: HTMLElement } | null = null;

export function openAutofillPanel(): void {
  if (mounted) return;
  const host = document.createElement("div");
  host.id = "autofill-panel-root";
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (!mounted) return;
    const m = mounted;
    mounted = null;
    m.root.unmount();
    m.host.remove();
  };
  mounted = { root, host };
  root.render(<AutofillPanel onClose={close} />);
}

/**
 * AgentReviewPanel (plan 5.11): the changes agents proposed, waiting for
 * the user. Agents' write tools only stage changes (agents/staging.ts);
 * this is where each one is shown as a diff and approved or rejected —
 * one by one, or all at once. Nothing is written before an approval, and
 * an approval whose text moved underneath is refused with the reason.
 *
 * Loaded on demand (palette command, the status-bar badge, the toast).
 * The list follows the queue live: a cancelled run's proposals leave the
 * pending list as they are withdrawn.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { FileDiff, X } from "lucide-react";
import { getLocale, t } from "../i18n";
import { approveStagedChange, listStagedChanges, onStagedChanges, rejectStagedChange } from "../agents/staging";
import { approveAll, inlineDiff, lineDiffRows, rejectAll, reviewModel, type RunGroup } from "../agents/review";
import type { StagedChange } from "../agents/types";

interface Props {
  open: boolean;
  onClose: () => void;
}

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const ghost: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const card: React.CSSProperties = { padding: "10px 12px", borderRadius: 8, background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", display: "flex", flexDirection: "column", gap: 8 };
const code: React.CSSProperties = { fontFamily: "var(--font-mono, ui-monospace, monospace)", fontSize: 12 };
// The editor's suggestion marks (editor/suggestingExtension.ts), so a proposal reads like a tracked change.
const INS: React.CSSProperties = { textDecoration: "underline 2px", textDecorationColor: "hsl(145 60% 40%)", textUnderlineOffset: 3, background: "hsl(145 60% 45% / 0.14)" };
const DEL: React.CSSProperties = { textDecoration: "line-through 2px", textDecorationColor: "hsl(0 75% 55%)", background: "hsl(0 75% 55% / 0.12)" };
const STATUS_COLOR: Record<StagedChange["status"], string> = {
  pending: "hsl(var(--fg-muted))",
  applied: "hsl(142 70% 45%)",
  rejected: "hsl(var(--fg-muted))",
  conflict: "hsl(0 80% 60%)",
};

function agentName(agentId: string | undefined): string {
  return agentId ?? t("agentReview.unknownAgent");
}

function timeOf(ms: number): string {
  try {
    return new Date(ms).toLocaleTimeString(getLocale(), { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function target(c: StagedChange): string {
  if (c.kind === "range") return c.path ? t("agentReview.target.documentPath", { path: c.path }) : t("agentReview.target.document");
  return c.before === null ? t("agentReview.target.newFile", { path: c.path }) : c.path;
}

/** What happened to a settled change, in words. */
function outcomeText(c: StagedChange): string {
  if (c.status === "applied") {
    if (c.asSuggestion) return t("agentReview.status.suggestion");
    if (c.appliedTo === "tab") return t("agentReview.status.tab");
    if (c.appliedTo === "file") return t("agentReview.status.file");
    // No undo history took the edit (Preview / WYSIWYG): don't promise Undo.
    return t(c.noUndo ? "agentReview.status.documentNoUndo" : "agentReview.status.document");
  }
  if (c.status === "rejected") return c.withdrawn ? t("agentReview.status.withdrawn") : t("agentReview.status.rejected");
  if (c.status === "conflict") {
    const code = c.conflict ?? "failed";
    return t(`agentReview.conflict.${code}`, { error: c.error ?? "" });
  }
  return "";
}

function InlineDiff({ before, after }: { before: string; after: string }) {
  const parts = useMemo(() => inlineDiff(before, after), [before, after]);
  return (
    <div dir="auto" data-testid="agent-change-inline" style={{ ...code, whiteSpace: "pre-wrap", wordBreak: "break-word", padding: "6px 8px", borderRadius: 6, background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", maxHeight: 260, overflowY: "auto" }}>
      {parts.map((p, i) =>
        p.op === "eq" ? (
          <span key={i}>{p.text}</span>
        ) : p.op === "add" ? (
          <ins key={i} style={INS}>{p.text}</ins>
        ) : (
          <del key={i} style={DEL}>{p.text}</del>
        ),
      )}
    </div>
  );
}

function LineDiff({ before, after }: { before: string | null; after: string }) {
  const rows = useMemo(() => lineDiffRows(before, after), [before, after]);
  if (!rows) return <div style={muted}>{t("agentReview.tooBig")}</div>;
  return (
    <div data-testid="agent-change-lines" style={{ ...code, borderRadius: 6, background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", maxHeight: 320, overflow: "auto" }}>
      {rows.map((r, i) =>
        r.op === "gap" ? (
          <div key={i} style={{ ...muted, padding: "2px 8px", fontStyle: "italic" }}>
            {t("agentReview.gap", { count: r.skipped })}
          </div>
        ) : (
          <Fragment key={i}>
            <div
              data-op={r.op}
              style={{
                display: "flex",
                gap: 8,
                padding: "0 8px",
                background: r.op === "add" ? "hsl(145 60% 45% / 0.14)" : r.op === "del" ? "hsl(0 75% 55% / 0.12)" : undefined,
              }}
            >
              <span aria-hidden style={{ width: 12, flexShrink: 0, color: r.op === "add" ? "hsl(145 60% 40%)" : r.op === "del" ? "hsl(0 75% 55%)" : "hsl(var(--fg-muted))" }}>
                {r.op === "add" ? "+" : r.op === "del" ? "−" : " "}
              </span>
              <span dir="auto" style={{ whiteSpace: "pre-wrap", wordBreak: "break-word", flex: 1, textDecoration: r.op === "del" ? "line-through" : undefined, textDecorationColor: "hsl(0 75% 55% / 0.6)" }}>
                {r.text || " "}
              </span>
            </div>
            {r.noEol && (
              <div data-testid="agent-change-no-eol" style={{ ...muted, padding: "0 8px 0 28px", fontStyle: "italic" }}>
                {t("agentReview.noEol")}
              </div>
            )}
          </Fragment>
        ),
      )}
    </div>
  );
}

function ChangeCard({ change, busy, onApprove, onReject }: { change: StagedChange; busy: boolean; onApprove?: () => void; onReject?: () => void }) {
  const pending = change.status === "pending";
  return (
    <article style={{ ...card, opacity: pending ? 1 : 0.85 }} data-testid={`agent-change-${change.id}`} data-status={change.status}>
      <div style={row}>
        <strong dir="auto" style={{ flex: 1, fontSize: 13 }}>{change.summary}</strong>
        <code style={{ ...muted, ...code }}>{change.tool}</code>
      </div>
      <div style={muted} dir="auto">{target(change)}</div>
      {pending && (change.kind === "range" ? <InlineDiff before={change.before} after={change.after} /> : <LineDiff before={change.before} after={change.after} />)}
      {pending ? (
        <div style={{ ...row, justifyContent: "flex-end" }}>
          <button type="button" style={ghost} onClick={onReject} disabled={busy} data-testid="agent-change-reject">
            {t("agentReview.reject")}
          </button>
          <button type="button" style={primary} onClick={onApprove} disabled={busy} data-testid="agent-change-approve">
            {t("agentReview.approve")}
          </button>
        </div>
      ) : (
        <div role="status" data-testid="agent-change-outcome" title={change.error} style={{ fontSize: 12, color: STATUS_COLOR[change.status] }}>
          {outcomeText(change)}
        </div>
      )}
    </article>
  );
}

function GroupHeader({ group }: { group: RunGroup }) {
  return (
    <div style={{ ...row, fontSize: 12 }}>
      <span style={{ fontWeight: 600 }}>{t("agentReview.proposedBy", { agent: agentName(group.agentId) })}</span>
      <span style={muted}>{timeOf(group.createdAt)}</span>
      {group.runId && (
        <code style={{ ...muted, ...code, direction: "ltr", unicodeBidi: "isolate" }} title={group.runId}>
          {t("agentReview.run", { run: group.runId.slice(-8) })}
        </code>
      )}
    </div>
  );
}

export function AgentReviewPanel({ open, onClose }: Props) {
  const [list, setList] = useState<readonly StagedChange[]>(() => listStagedChanges({ all: true }));
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setList(listStagedChanges({ all: true }));
    const off = onStagedChanges((next) => setList([...next]));
    return () => {
      off();
    };
  }, []);
  const model = useMemo(() => reviewModel(list), [list]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const run = useCallback(async (work: () => Promise<unknown> | unknown) => {
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }, []);

  if (!open) return null;
  const pendingChanges = model.pending.flatMap((g) => g.changes);

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("agentReview.title")} data-testid="agent-review-panel">
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, padding: 0, display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <FileDiff size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("agentReview.title")}</h2>
          {model.pendingCount > 0 && (
            <>
              <button type="button" style={ghost} disabled={busy} onClick={() => void run(() => rejectAll(pendingChanges))} data-testid="agent-review-reject-all">
                {t("agentReview.rejectAll")}
              </button>
              <button type="button" style={primary} disabled={busy} onClick={() => void run(() => approveAll(pendingChanges))} data-testid="agent-review-approve-all">
                {t("agentReview.approveAll", { count: model.pendingCount })}
              </button>
            </>
          )}
          <button type="button" style={ghost} onClick={onClose} aria-label={t("agentReview.close")}>
            <X size={16} />
          </button>
        </header>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, lineHeight: 1.5, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("agentReview.intro")}</p>
          {model.pendingCount === 0 && (
            <div style={{ ...muted, padding: "12px 0", textAlign: "center" }} data-testid="agent-review-empty">
              {t("agentReview.empty")}
            </div>
          )}
          {model.pending.map((g) => (
            <section key={g.key} style={{ display: "flex", flexDirection: "column", gap: 8 }} data-testid="agent-review-group">
              <GroupHeader group={g} />
              {g.changes.map((c) => (
                <ChangeCard
                  key={c.id}
                  change={c}
                  busy={busy}
                  onApprove={() => void run(() => approveStagedChange(c.id))}
                  onReject={() => void run(() => rejectStagedChange(c.id))}
                />
              ))}
            </section>
          ))}
          {model.settled.length > 0 && (
            <section style={{ display: "flex", flexDirection: "column", gap: 8 }} aria-labelledby="agent-review-done">
              <div id="agent-review-done" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))" }}>
                {t("agentReview.done")}
              </div>
              {model.settled.map((c) => (
                <ChangeCard key={c.id} change={c} busy={busy} />
              ))}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * AiSuggestionsPanel — what the improvement agent proposes when an AI
 * command ends without a usable answer: the diagnosis, what was tried, and
 * suggestions that are real actions (pull a model, switch executor, allow
 * the cloud, retry with a larger model…). After an action the failed
 * command runs again.
 */

import { useEffect, useState } from "react";
import { Lightbulb, X } from "lucide-react";
import { t } from "../i18n";
import { markNotGood, onAgentAnswer, onAgentSuggestions, rerunCommand, runSuggestion, type AnswerEvent, type SuggestionsEvent } from "../agents/suggestions";
import type { Suggestion } from "../agents/types";

function label(s: Suggestion): string {
  return s.raw ? s.title : t(s.title, s.params);
}

function detail(s: Suggestion): string | null {
  if (!s.detail) return null;
  return s.raw ? s.detail : t(s.detail, s.params);
}

/** Palette commands whose answer can be judged "not good" (5.6.3): one answer per run, put into the note. */
const JUDGED = new Set(["ai.actionItems", "ai.translate", "ai.diagram", "ai.chart", "tools.autoTag", "tools.suggestLinks", "ai.outline", "tools.checkGrammar", "research.ask", "ai.styleProfile", "git.commit"]);

/** "Not good" after an AI command's answer (5.6.3): one click re-runs it, asking for a different answer. */
function NotGood() {
  const [answer, setAnswer] = useState<AnswerEvent | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onAgentAnswer((e) => {
      if (!JUDGED.has(e.commandId ?? "")) return;
      setAnswer(e);
      clearTimeout(timer);
      timer = setTimeout(() => setAnswer(null), 12_000);
    });
    return () => {
      off();
      clearTimeout(timer);
    };
  }, []);
  if (!answer) return null;
  return (
    <div role="status" data-testid="ai-not-good" style={{ position: "fixed", bottom: 40, insetInlineStart: 16, zIndex: 99997, display: "flex", gap: 8, alignItems: "center", padding: "6px 10px", borderRadius: 10, background: "hsl(var(--bg-subtle))", border: "1px solid hsl(var(--border))", fontSize: 12.5 }}>
      <span>{t("agent.notGood.prompt", { agent: answer.run.agentId })}</span>
      <button
        type="button"
        onClick={() => {
          setAnswer(null);
          void markNotGood(answer.run, answer.commandId);
        }}
        style={{ padding: "3px 9px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit", cursor: "pointer" }}
      >
        {t("agent.notGood.button")}
      </button>
      <button type="button" aria-label={t("agent.panel.close")} onClick={() => setAnswer(null)} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
        <X size={12} />
      </button>
    </div>
  );
}

export function AiSuggestionsPanel() {
  const [event, setEvent] = useState<SuggestionsEvent | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string>("");
  const [live, setLive] = useState<AbortController | null>(null);

  useEffect(() => onAgentSuggestions((e) => {
    setEvent(e);
    setBusy(null);
    setProgress("");
  }), []);

  if (!event) return <NotGood />;
  const { run } = event;

  const act = async (s: Suggestion) => {
    setBusy(s.id);
    const ctrl = new AbortController();
    setLive(ctrl);
    try {
      const again = await runSuggestion(s, run, { onProgress: setProgress, signal: ctrl.signal });
      if (again) {
        setEvent(null);
        rerunCommand(event.commandId ?? run.commandId);
      }
    } catch (e) {
      setProgress(`${(e as Error).message}`);
    } finally {
      setBusy(null);
      setLive(null);
    }
  };
  const close = () => {
    live?.abort();
    setEvent(null);
  };

  return (
    <div
      role="dialog"
      aria-label={t("agent.panel.title")}
      style={{
        position: "fixed",
        bottom: 40,
        insetInlineStart: 16,
        zIndex: 99998,
        width: 380,
        maxWidth: "calc(100vw - 32px)",
        padding: 14,
        borderRadius: 12,
        background: "hsl(var(--bg-subtle))",
        border: "1px solid hsl(var(--border))",
        boxShadow: "0 8px 30px hsl(0 0% 0% / 0.2)",
        color: "hsl(var(--fg))",
        fontSize: 13,
        display: "flex",
        flexDirection: "column",
        gap: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Lightbulb size={16} style={{ color: "hsl(var(--accent))" }} />
        <strong style={{ flex: 1 }}>{t("agent.panel.title")}</strong>
        <button type="button" aria-label={t("agent.panel.close")} onClick={close} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
          <X size={14} />
        </button>
      </div>
      <div style={{ color: "hsl(var(--fg-muted))" }}>
        {t("agent.panel.summary", { agent: run.agentId, attempts: run.attempts, executor: run.executor ?? "—", model: run.model ?? "—" })}
        {run.error ? <div style={{ marginTop: 4, fontFamily: "var(--font-mono, monospace)", fontSize: 12 }}>{run.error.slice(0, 240)}</div> : null}
      </div>
      {run.suggestions.length ? (
        <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
          {run.suggestions.map((s) => (
            <li key={s.id} style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
              <div style={{ flex: 1 }}>
                <div>{label(s)}</div>
                {detail(s) ? <div style={{ color: "hsl(var(--fg-muted))", fontSize: 12 }}>{detail(s)}</div> : null}
              </div>
              {s.action ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void act(s)}
                  style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit", cursor: "pointer", whiteSpace: "nowrap" }}
                >
                  {busy === s.id ? "…" : t("agent.panel.do")}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <div>{t("agent.panel.none")}</div>
      )}
      {progress ? <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{progress}</div> : null}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" onClick={() => rerunCommand("ai.trace")} style={{ background: "none", border: "none", color: "hsl(var(--accent))", cursor: "pointer" }}>
          {t("agent.panel.trace")}
        </button>
      </div>
    </div>
  );
}

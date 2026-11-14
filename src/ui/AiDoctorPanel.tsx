/**
 * AiDoctorPanel (MASTER_PLAN v3, T21): the AI doctor's report as a list of
 * checks, each with its status and its fix — a command to copy or a button
 * that does it. "Run golden cases" sends one fixture per agent through the
 * real runtime so the user sees whether the local model actually answers.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Stethoscope, X } from "lucide-react";
import { t } from "../i18n";
import "../agents/doctorStrings";
import type { DoctorFinding, DoctorReport, DoctorStatus } from "../agents/doctor";
import { HelpButton } from "./HelpButton";
import "./aiDoctorPanelStrings";

interface Props {
  open: boolean;
  onClose: () => void;
}

const box: React.CSSProperties = {
  padding: "10px 14px",
  borderRadius: 8,
  background: "hsl(var(--bg-subtle))",
  border: "1px solid hsl(var(--border))",
  display: "flex",
  flexDirection: "column",
  gap: 6,
};
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const ghost: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const pre: React.CSSProperties = { margin: 0, padding: "6px 8px", fontSize: 11, borderRadius: 6, background: "hsl(var(--bg))", border: "1px solid hsl(var(--border))", whiteSpace: "pre-wrap", direction: "ltr", textAlign: "start", userSelect: "all" };

const COLOR: Record<DoctorStatus, string> = {
  // The text tokens (>= 4.5:1 on the panel backgrounds); --success/--warning are not.
  ok: "hsl(var(--ok))",
  warn: "hsl(var(--warn))",
  fail: "hsl(var(--danger))",
  skip: "hsl(var(--fg-muted))",
};
const MARK: Record<DoctorStatus, string> = { ok: "✓", warn: "!", fail: "✗", skip: "–" };

export function AiDoctorPanel({ open, onClose }: Props) {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [running, setRunning] = useState<"quick" | "golden" | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [pulling, setPulling] = useState<{ model: string; status: string } | null>(null);
  const abort = useRef<AbortController | null>(null);

  const run = useCallback(async (golden: boolean) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setRunning(golden ? "golden" : "quick");
    try {
      const { runDoctor } = await import("../agents/doctor");
      const r = await runDoctor({ golden, signal: ac.signal });
      if (!ac.signal.aborted) setReport(r);
    } finally {
      if (abort.current === ac) setRunning(null);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void run(false);
    return () => abort.current?.abort();
  }, [open, run]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open, onEscape: onClose });

  if (!open) return null;

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied((c) => (c === id ? null : c)), 1500);
    } catch {
      /* why: the <pre> is select-all; the user can copy by hand */
    }
  };

  const act = async (f: DoctorFinding) => {
    const fix = f.fix;
    if (!fix?.action) return;
    if (fix.action === "persist") {
      const { requestPersistentStorage } = await import("../storage/persistentStorage");
      await requestPersistentStorage();
      void run(false);
    } else if (fix.action === "openSettings") {
      onClose();
      window.dispatchEvent(new CustomEvent("lumen-open-ai-settings"));
    } else if (fix.action === "setPolicyLocalFirst") {
      const { setAiPolicy } = await import("../ai/policy");
      setAiPolicy("local-first");
      void run(false);
    } else if (fix.action === "pullModel" && fix.arg) {
      const { pullOllamaModel } = await import("../ai/ollamaProvider");
      setPulling({ model: fix.arg, status: "…" });
      try {
        for await (const p of pullOllamaModel(fix.arg)) {
          const pct = p.total && p.completed ? ` ${Math.round((p.completed / p.total) * 100)}%` : "";
          setPulling({ model: fix.arg, status: `${p.status}${pct}` });
        }
        setPulling(null);
        void run(false);
      } catch (e) {
        setPulling({ model: fix.arg, status: (e as Error).message });
      }
    } else if (fix.action === "downloadHebrewDictionary") {
      // The user's own click (the dictionary is AGPL, 5.7 MB: the label says so).
      const { downloadHebrewDictionary } = await import("../ai/hebrewSpellService");
      try {
        await downloadHebrewDictionary();
      } finally {
        void run(false);
      }
    } else if (fix.action === "useLocalServices") {
      // Point grammar and research at docker/local-ai.yml on this machine.
      const [{ LOCAL_SERVICES }, { GRAMMAR_ENDPOINT_KEY, clearGrammarCache }] = await Promise.all([import("../agents/doctor"), import("../ai/grammar")]);
      try {
        localStorage.setItem(GRAMMAR_ENDPOINT_KEY, LOCAL_SERVICES.grammar);
        localStorage.setItem("lumen.research.endpoint", LOCAL_SERVICES.research);
      } catch {
        /* why: storage denied: the command above still works by hand */
      }
      clearGrammarCache();
      void run(false);
    } else if (fix.action === "retry") {
      void run(false);
    }
  };

  const copyReport = async () => {
    if (!report) return;
    const { formatDoctorReport } = await import("../agents/doctor");
    await copy("report", formatDoctorReport(report, (k) => t(k)));
  };

  // 14.2: open the feedback form with this report ready to attach (still only if the user ticks it).
  const reportProblem = async () => {
    if (!report) return;
    const [{ formatDoctorReport }, { openFeedback }] = await Promise.all([import("../agents/doctor"), import("./FeedbackDialog")]);
    onClose();
    openFeedback({ doctorReport: formatDoctorReport(report, (k) => t(k)), kind: "bug" });
  };

  const findings = report?.findings ?? [];
  const golden = findings.filter((f) => f.id.startsWith("golden."));
  const checks = findings.filter((f) => !f.id.startsWith("golden."));

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} ref={trapRef} role="dialog" aria-modal="true" aria-label={t("ai.doctor.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 640, padding: 0, display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Stethoscope size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("ai.doctor.title")}</h2>
          {report && (
            <span style={muted} data-testid="doctor-summary">
              {t("ai.doctor.summary", { ok: report.summary.ok, warn: report.summary.warn, fail: report.summary.fail })}
            </span>
          )}
          <HelpButton topic="ai/doctor" />
          <button type="button" style={ghost} onClick={onClose} aria-label={t("ai.doctor.close")}>
            <X size={16} />
          </button>
        </header>

        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 10, fontSize: 13, lineHeight: 1.5, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("ai.doctor.intro")}</p>
          {running && !report && <div style={muted} data-testid="doctor-running">{t("ai.doctor.running")}</div>}

          {checks.map((f) => (
            <section key={f.id} style={box} data-testid={`doctor-${f.id}`} data-status={f.status}>
              <div style={row}>
                <span aria-hidden style={{ color: COLOR[f.status], fontWeight: 700, width: 14, textAlign: "center" }}>{MARK[f.status]}</span>
                <strong style={{ flex: 1 }}>{t(f.title)}</strong>
                <span style={{ ...muted, color: COLOR[f.status] }}>{t(`ai.doctor.status.${f.status}`)}</span>
                {typeof f.ms === "number" && <span style={muted}>{f.ms} ms</span>}
              </div>
              {f.detail && <div style={{ ...muted, direction: "ltr", textAlign: "start", unicodeBidi: "isolate" }}>{f.detail}</div>}
              {f.fix && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }} data-testid="doctor-fix">
                  <div style={row}>
                    <span>{t(f.fix.label)}</span>
                    {f.fix.action && (
                      <button type="button" style={primary} onClick={() => void act(f)} disabled={!!pulling}>
                        {t(`ai.doctor.action.${f.fix.action}`)}
                      </button>
                    )}
                    {f.fix.command && (
                      <button type="button" style={ghost} onClick={() => void copy(f.id, f.fix!.command!)}>
                        {copied === f.id ? t("ai.doctor.copied") : t("ai.doctor.copy")}
                      </button>
                    )}
                    {f.fix.url && (
                      <a href={f.fix.url} target="_blank" rel="noreferrer" style={{ fontSize: 12 }}>
                        {f.fix.url.replace(/^https?:\/\//, "")}
                      </a>
                    )}
                  </div>
                  {f.fix.command && <pre style={pre}>{f.fix.command}</pre>}
                  {pulling && f.fix.action === "pullModel" && f.fix.arg === pulling.model && (
                    <div style={muted} aria-live="polite">{t("ai.doctor.pulling", { model: pulling.model, status: pulling.status })}</div>
                  )}
                </div>
              )}
            </section>
          ))}

          {golden.length > 0 && (
            <section style={box} aria-labelledby="ai-doctor-golden">
              <div id="ai-doctor-golden" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))" }}>{t("ai.doctor.golden")}</div>
              {golden.map((f) => (
                <div key={f.id} style={row} data-testid={`doctor-${f.id}`} data-status={f.status}>
                  <span aria-hidden style={{ color: COLOR[f.status], fontWeight: 700, width: 14, textAlign: "center" }}>{MARK[f.status]}</span>
                  <span style={{ flex: 1, direction: "ltr", textAlign: "start", unicodeBidi: "isolate" }}>{f.detail}</span>
                  {typeof f.ms === "number" && <span style={muted}>{f.ms} ms</span>}
                </div>
              ))}
            </section>
          )}

          <div style={{ ...row, justifyContent: "flex-end" }}>
            <button type="button" style={ghost} onClick={() => void copyReport()} disabled={!report}>
              {copied === "report" ? t("ai.doctor.copied") : t("ai.doctor.copyReport")}
            </button>
            <button type="button" style={ghost} onClick={() => void reportProblem()} disabled={!report} data-testid="doctor-report-problem">
              {t("ai.doctor.report")}
            </button>
            <button type="button" style={ghost} onClick={() => void run(false)} disabled={!!running}>
              {running === "quick" ? t("ai.doctor.running") : t("ai.doctor.rerun")}
            </button>
            <button type="button" style={primary} onClick={() => void run(true)} disabled={!!running} data-testid="doctor-golden-run">
              {running === "golden" ? t("ai.doctor.goldenRunning") : t("ai.doctor.runGolden")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

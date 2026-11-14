/**
 * The import wizard (plan W1.26): pick the app the notes come from, pick
 * its export, see what will come in and what will not, import into a new
 * folder, and undo it in one click.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Download, X } from "lucide-react";
import "./strings";
import { t } from "../../i18n";
import { IMPORT_SOURCES, SOURCE_ACCEPT, SOURCE_NAMES } from "./convert";
import { addToImport, commitImport, prepareImport, readPicked, undoImport, type PreparedImport, type UndoRecord } from "./commit";
import { linkPercent, reportMarkdown, skipText, warningText } from "./report";
import type { ImportReport, ImportSourceId } from "./types";
import { toast } from "../../store/useToastStore";
import { HelpButton } from "../../ui/HelpButton";
import { explainError } from "../../lib/userError";

interface Props {
  open: boolean;
  onClose: () => void;
}

type Step = { kind: "source" } | { kind: "busy"; text: string } | { kind: "review"; prep: PreparedImport; picked: Map<string, Uint8Array> } | { kind: "done"; report: ImportReport; undo: UndoRecord };

const btn: React.CSSProperties = { padding: "6px 12px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...btn, background: "hsl(var(--accent))", color: "hsl(var(--accent-fg))", borderColor: "transparent" };
const muted: React.CSSProperties = { margin: 0, fontSize: 12, color: "hsl(var(--fg-muted))" };
const SHOWN = 50;

function Issues<T>({ title, items, line, testId }: { title: string; items: T[]; line: (x: T) => string; testId: string }) {
  if (!items.length) return null;
  return (
    <details data-testid={testId} style={{ fontSize: 12 }}>
      <summary style={{ cursor: "pointer" }}>{title}</summary>
      <ul style={{ margin: "4px 0", paddingInlineStart: 18, maxHeight: 160, overflowY: "auto" }}>
        {items.slice(0, SHOWN).map((x, i) => (
          <li key={i} dir="auto">
            {line(x)}
          </li>
        ))}
        {items.length > SHOWN && <li>{t("importWizard.more", { n: items.length - SHOWN })}</li>}
      </ul>
    </details>
  );
}

export function ImportWizard({ open, onClose }: Props) {
  const [source, setSource] = useState<ImportSourceId>("obsidian");
  const [step, setStep] = useState<Step>({ kind: "source" });
  const [error, setError] = useState<string | null>(null);
  const [savedReport, setSavedReport] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const folderRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step.kind !== "busy") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, step.kind]);

  const prepare = useCallback(async (picked: Map<string, Uint8Array>, name: string, as: ImportSourceId) => {
    setError(null);
    setStep({ kind: "busy", text: t("importWizard.reading", { n: picked.size }) });
    try {
      const prep = await prepareImport(picked, name, as);
      if (!prep.vault.notes.size && !prep.vault.attachments.size) {
        setError(t("importWizard.error.nothing", { source: SOURCE_NAMES[as] }));
        setStep({ kind: "source" });
        return;
      }
      setStep({ kind: "review", prep, picked });
    } catch (e) {
      setError(t("importWizard.error.failed", { error: explainError(e) }));
      setStep({ kind: "source" });
    }
  }, []);

  const onPicked = useCallback(
    async (list: FileList | null) => {
      if (!list?.length) return;
      const { files, name } = await readPicked(list);
      await prepare(files, name, source);
    },
    [prepare, source],
  );

  const run = async (prep: PreparedImport, picked: Map<string, Uint8Array>) => {
    setStep({ kind: "busy", text: t("importWizard.importing") });
    try {
      const { report, undo } = await commitImport(prep);
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      setSavedReport(null);
      setStep({ kind: "done", report, undo });
    } catch (e) {
      setError(t("importWizard.error.failed", { error: explainError(e) }));
      setStep({ kind: "review", prep, picked });
    }
  };

  const undo = async (u: UndoRecord) => {
    const r = await undoImport(u);
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    toast.success(t(r === "removed" ? "importWizard.undone" : r === "trashed" ? "importWizard.undoneTrash" : "importWizard.undoGone"));
    setStep({ kind: "source" });
  };

  const saveReport = async (report: ImportReport, u: UndoRecord) => {
    const path = await addToImport(u, `${t("importWizard.report.heading")}.md`, reportMarkdown(report));
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
    setSavedReport(path);
  };

  if (!open) return null;

  const body = () => {
    switch (step.kind) {
      case "busy":
        return (
          <p role="status" aria-live="polite" style={{ margin: 8, fontSize: 13 }}>
            {step.text}
          </p>
        );
      case "source":
        return (
          <>
            <p style={{ ...muted, fontSize: 13 }}>{t("importWizard.intro")}</p>
            <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
              <legend style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>{t("importWizard.chooseSource")}</legend>
              <div role="radiogroup" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: 6 }}>
                {IMPORT_SOURCES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    role="radio"
                    aria-checked={source === s}
                    data-testid={`import-source-${s}`}
                    onClick={() => setSource(s)}
                    style={{ ...btn, textAlign: "start", background: source === s ? "hsl(var(--bg-subtle))" : "transparent", borderColor: source === s ? "hsl(var(--accent))" : "hsl(var(--border))" }}
                  >
                    {SOURCE_NAMES[s]}
                  </button>
                ))}
              </div>
            </fieldset>
            <p data-testid="import-how" style={{ margin: 0, fontSize: 13 }}>
              {t(`importWizard.how.${source}`)}
            </p>
            <div
              data-testid="import-drop"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                void onPicked(e.dataTransfer.files);
              }}
              style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: 12, border: "1px dashed hsl(var(--border))", borderRadius: 8 }}
            >
              <button type="button" style={primary} onClick={() => fileRef.current?.click()} data-testid="import-pick-file">
                {t("importWizard.pickFile")}
              </button>
              <button type="button" style={btn} onClick={() => folderRef.current?.click()} data-testid="import-pick-folder">
                {t("importWizard.pickFolder")}
              </button>
              <span style={muted}>{t("importWizard.drop")}</span>
              <input ref={fileRef} type="file" multiple accept={SOURCE_ACCEPT[source]} hidden data-testid="import-file-input" onChange={(e) => void onPicked(e.currentTarget.files)} />
              <input
                ref={(el) => {
                  folderRef.current = el;
                  if (el) el.setAttribute("webkitdirectory", "");
                }}
                type="file"
                hidden
                data-testid="import-folder-input"
                onChange={(e) => void onPicked(e.currentTarget.files)}
              />
            </div>
          </>
        );
      case "review": {
        const { prep } = step;
        const v = prep.vault;
        const bases = [...v.notes.keys()].filter((p) => p.endsWith(".base")).length;
        const pct = linkPercent({ links: prep.links });
        return (
          <>
            {prep.detected !== prep.source && (
              <div role="note" style={{ fontSize: 13, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>{t("importWizard.detected", { source: SOURCE_NAMES[prep.detected] })}</span>
                <button
                  type="button"
                  style={btn}
                  data-testid="import-use-detected"
                  onClick={() => {
                    setSource(prep.detected);
                    void prepare(step.picked, prep.name, prep.detected);
                  }}
                >
                  {t("importWizard.useDetected", { source: SOURCE_NAMES[prep.detected] })}
                </button>
              </div>
            )}
            <p data-testid="import-summary" style={{ margin: 0, fontSize: 13 }} dir="auto">
              {t("importWizard.review.summary", { notes: v.notes.size - bases, attachments: v.attachments.size, bases, folder: prep.folder })}
            </p>
            <p style={muted}>{prep.links.total ? t("importWizard.review.links", { resolved: prep.links.resolved, total: prep.links.total, pct }) : t("importWizard.review.noLinks")}</p>
            <Issues testId="import-skipped" title={t("importWizard.review.skipped", { n: v.skipped.length })} items={v.skipped} line={(i) => `${i.path} — ${skipText(i)}`} />
            <Issues testId="import-warnings" title={t("importWizard.review.warnings", { n: v.warnings.length })} items={v.warnings} line={(i) => `${i.path} — ${warningText(i)}`} />
            <Issues testId="import-unresolved" title={t("importWizard.review.unresolved", { n: prep.links.total - prep.links.resolved })} items={prep.links.unresolved} line={(u) => `${u.path} → ${u.target}`} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button type="button" style={btn} onClick={() => setStep({ kind: "source" })}>
                {t("importWizard.back")}
              </button>
              <button type="button" style={primary} data-testid="import-start" onClick={() => void run(prep, step.picked)}>
                {t("importWizard.start")}
              </button>
            </div>
          </>
        );
      }
      case "done": {
        const { report, undo: u } = step;
        return (
          <>
            <p data-testid="import-done" style={{ margin: 0, fontSize: 14, fontWeight: 600 }} dir="auto">
              {t("importWizard.done.title", { folder: report.folder })}
            </p>
            <p style={{ margin: 0, fontSize: 13 }} dir="auto">
              {t("importWizard.review.summary", { notes: report.notes, attachments: report.attachments, bases: report.bases, folder: report.folder })}
            </p>
            <p style={muted}>{report.links.total ? t("importWizard.review.links", { resolved: report.links.resolved, total: report.links.total, pct: linkPercent(report) }) : t("importWizard.review.noLinks")}</p>
            {report.attachmentsLost > 0 && (
              <p role="alert" style={{ margin: 0, fontSize: 13 }}>
                {t("importWizard.lost", { n: report.attachmentsLost })}
              </p>
            )}
            <p style={muted}>{t("importWizard.done.dates")}</p>
            <Issues testId="import-skipped" title={t("importWizard.review.skipped", { n: report.skipped.length })} items={report.skipped} line={(i) => `${i.path} — ${skipText(i)}`} />
            <Issues testId="import-warnings" title={t("importWizard.review.warnings", { n: report.warnings.length })} items={report.warnings} line={(i) => `${i.path} — ${warningText(i)}`} />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button type="button" style={btn} data-testid="import-undo" onClick={() => void undo(u)}>
                {t("importWizard.undo")}
              </button>
              <button type="button" style={btn} disabled={!!savedReport} data-testid="import-save-report" onClick={() => void saveReport(report, u)}>
                {t("importWizard.report.save")}
              </button>
              <button type="button" style={primary} onClick={onClose}>
                {t("importWizard.close")}
              </button>
            </div>
          </>
        );
      }
    }
  };

  return (
    <div className="cmd-palette-backdrop" onClick={() => step.kind !== "busy" && onClose()} role="dialog" aria-modal="true" aria-label={t("importWizard.title")} data-testid="import-wizard">
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 620, padding: 0, display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Download size={16} />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flex: 1 }}>{t("importWizard.title")}</h2>
          <HelpButton topic="workspace/import" />
          <button type="button" style={btn} onClick={onClose} disabled={step.kind === "busy"} aria-label={t("importWizard.close")}>
            <X size={14} />
          </button>
        </header>
        <div style={{ overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
          {error && (
            <p role="alert" data-testid="import-error" style={{ margin: 0, fontSize: 13, color: "hsl(var(--fg))", fontWeight: 600 }}>
              {error}
            </p>
          )}
          {body()}
        </div>
      </div>
    </div>
  );
}

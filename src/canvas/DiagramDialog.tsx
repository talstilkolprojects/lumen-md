/**
 * The canvas's diagram dialog (plan W2.18): paste Mermaid, or describe the
 * diagram and let the local model draw it; the definition is checked, then
 * converted into elements you can edit, placed in the middle of the view.
 */

import { useEffect, useRef, useState } from "react";
import "./diagramStrings";
import { t } from "../i18n";
import { precheck } from "./mermaidPrep";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";

export interface DiagramDialogProps {
  onInsert: (code: string) => Promise<{ missing: string[]; editable: boolean } | { error: string }>;
  onClose: () => void;
}

export function DiagramDialog({ onInsert, onClose }: DiagramDialogProps) {
  const [code, setCode] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState<"draw" | "insert" | null>(null);
  const [status, setStatus] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    area.current?.focus();
    return () => abort.current?.abort();
  }, []);

  async function draw() {
    if (!prompt.trim()) return;
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setBusy("draw");
    setStatus({ kind: "info", text: t("canvas.diagram.drawing") });
    try {
      const { drawDiagram } = await import("./drawAgent");
      const r = await drawDiagram(prompt, ac.signal);
      if (ac.signal.aborted) return;
      if (r.ok) {
        setCode(r.code);
        setStatus({ kind: "info", text: t("canvas.diagram.drawn") });
      } else setStatus({ kind: "error", text: r.code === "no-local-model" ? t("canvas.diagram.noLocalModel") : t("canvas.diagram.drawFailed", { error: r.error }) });
    } catch (e) {
      if (!ac.signal.aborted) setStatus({ kind: "error", text: t("canvas.diagram.drawFailed", { error: explainError(e) }) });
    } finally {
      if (abort.current === ac) setBusy(null);
    }
  }

  async function insert() {
    const pre = precheck(code);
    if (!pre.ok && pre.reason !== "not-editable") {
      setStatus({ kind: "error", text: t(pre.reason === "empty" ? "canvas.diagram.empty" : "canvas.diagram.unknown") });
      return;
    }
    setBusy("insert");
    const r = await onInsert(code);
    setBusy(null);
    if ("error" in r) setStatus({ kind: "error", text: t("canvas.diagram.invalid", { error: r.error }) });
    else if (r.missing.length) setStatus({ kind: "error", text: t("canvas.diagram.missing", { labels: r.missing.join(", ") }) });
    else onClose();
  }

  const pre = code.trim() ? precheck(code) : null;
  return (
    <div className="lumen-diagram-backdrop" role="dialog" aria-modal="true" aria-labelledby="lumen-diagram-title" data-testid="canvas-diagram-dialog" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="lumen-diagram">
        <h2 id="lumen-diagram-title" className="lumen-diagram-title">
          {t("canvas.diagram.title")}
        </h2>
        <HelpButton topic="workspace/canvas-diagrams" />
        <label className="lumen-diagram-label" htmlFor="lumen-diagram-prompt">
          {t("canvas.diagram.describe")}
        </label>
        <div className="lumen-diagram-row">
          <input
            id="lumen-diagram-prompt"
            dir="auto"
            className="lumen-diagram-input"
            value={prompt}
            placeholder={t("canvas.diagram.describePlaceholder")}
            data-testid="canvas-diagram-prompt"
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") void draw();
              if (e.key === "Escape") onClose();
            }}
          />
          <button type="button" className="lumen-canvas-btn accent" disabled={!prompt.trim() || busy !== null} onClick={() => void draw()} data-testid="canvas-diagram-draw">
            {busy === "draw" ? t("canvas.diagram.drawing") : t("canvas.diagram.draw")}
          </button>
        </div>
        <p className="lumen-diagram-note">{t("canvas.diagram.localOnly")}</p>
        <label className="lumen-diagram-label" htmlFor="lumen-diagram-code">
          {t("canvas.diagram.code")}
        </label>
        <textarea
          id="lumen-diagram-code"
          ref={area}
          dir="ltr"
          className="lumen-diagram-code"
          value={code}
          spellCheck={false}
          // i18n-allow: a Mermaid code sample (the syntax is not translated; the node labels show Hebrew works)
          placeholder={"flowchart TD\n  A[\"התחלה\"] --> B[\"סוף\"]"}
          data-testid="canvas-diagram-code"
          onChange={(e) => setCode(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Escape") onClose();
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void insert();
          }}
        />
        {pre && !pre.ok && pre.reason === "not-editable" && <p className="lumen-diagram-note">{t("canvas.diagram.notEditable", { kind: pre.kind ?? "" })}</p>}
        {status && (
          <p className={`lumen-diagram-status ${status.kind}`} role={status.kind === "error" ? "alert" : "status"} data-testid="canvas-diagram-status">
            {status.text}
          </p>
        )}
        <div className="lumen-diagram-actions">
          <button type="button" className="lumen-canvas-btn" onClick={onClose}>
            {t("canvas.close")}
          </button>
          <button type="button" className="lumen-canvas-btn accent" disabled={!code.trim() || busy !== null} onClick={() => void insert()} data-testid="canvas-diagram-insert">
            {busy === "insert" ? t("canvas.diagram.inserting") : t("canvas.diagram.insert")}
          </button>
        </div>
      </div>
    </div>
  );
}

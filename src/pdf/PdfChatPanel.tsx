/**
 * "Ask this PDF" (plan 6.8): a question box beside the reader; the answer
 * comes from the PDF's own text on this device, with each citation's page
 * and line — a click opens the page and marks the quote. Lazy: loaded when
 * the reader's Ask button is first pressed.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import type { PdfAnswer, PdfIndexProgress, PdfSummary } from "./pdfChat";
import "./pdfChatPanelStrings";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";

interface Props {
  path: string;
  onCite: (page: number, quote: string) => void;
  onClose: () => void;
}

type Status = { kind: "idle" } | { kind: "indexing"; p: PdfIndexProgress } | { kind: "thinking" } | { kind: "error"; message: string };

export function PdfChatPanel({ path, onCite, onClose }: Props) {
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [answer, setAnswer] = useState<(PdfAnswer & { question: string }) | null>(null);
  /** Plan 6.11: a grounded summary of the whole PDF. */
  const [summary, setSummary] = useState<PdfSummary | null>(null);
  const ctrl = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    return () => ctrl.current?.abort();
  }, []);

  const busy = status.kind === "indexing" || status.kind === "thinking";

  const summarizeAll = async () => {
    if (busy) return;
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setAnswer(null);
    setSummary(null);
    setStatus({ kind: "thinking" });
    try {
      const [{ summarizePdf }, { aiOperation }] = await Promise.all([import("./pdfChat"), import("../ai/aiAbort")]);
      const op = aiOperation();
      op.signal.addEventListener("abort", () => c.abort(op.signal.reason), { once: true });
      try {
        const res = await summarizePdf(path, { signal: c.signal, onProgress: (p) => !c.signal.aborted && setStatus({ kind: "indexing", p }) });
        if (c.signal.aborted) return;
        setSummary(res);
        setStatus({ kind: "idle" });
      } finally {
        op.end();
      }
    } catch (e) {
      if (c.signal.aborted) {
        setStatus({ kind: "idle" });
        return;
      }
      setStatus({ kind: "error", message: explainError(e) });
    }
  };

  const ask = async () => {
    const q = question.trim();
    if (!q || busy) return;
    ctrl.current?.abort();
    const c = (ctrl.current = new AbortController());
    setAnswer(null);
    setSummary(null);
    setStatus({ kind: "thinking" });
    try {
      const [{ askPdf }, { aiOperation }] = await Promise.all([import("./pdfChat"), import("../ai/aiAbort")]);
      // Esc / "AI: Cancel" stop it too.
      const op = aiOperation();
      op.signal.addEventListener("abort", () => c.abort(op.signal.reason), { once: true });
      try {
        const res = await askPdf(path, q, {
          signal: c.signal,
          onProgress: (p) => {
            if (!c.signal.aborted) setStatus({ kind: "indexing", p });
          },
        });
        if (c.signal.aborted) return;
        setAnswer({ ...res, question: q });
        setStatus({ kind: "idle" });
      } finally {
        op.end();
      }
    } catch (e) {
      if (c.signal.aborted) {
        setStatus({ kind: "idle" });
        return;
      }
      setStatus({ kind: "error", message: explainError(e) });
    }
  };

  return (
    <aside className="pdf-side pdf-ask" aria-label={t("pdf.ask.title")} data-testid="pdf-ask-panel">
      <div className="pdf-ask-head">
        <h3>{t("pdf.ask.title")}</h3>
        <HelpButton topic="workspace/pdf-chat" />
        <button type="button" className="icon-btn pdf-text-btn" onClick={onClose}>
          {t("privacy.close")}
        </button>
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <textarea
          ref={inputRef}
          dir="auto"
          rows={2}
          value={question}
          placeholder={t("pdf.ask.placeholder")}
          aria-label={t("pdf.ask.placeholder")}
          data-testid="pdf-ask-input"
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className="pdf-ask-actions">
          {busy ? (
            <button type="button" className="icon-btn pdf-text-btn" onClick={() => ctrl.current?.abort()}>
              {t("dialog.cancel")}
            </button>
          ) : (
            <>
              <button type="button" className="icon-btn pdf-text-btn" data-testid="pdf-summarize" onClick={() => void summarizeAll()}>
                {t("pdf.summarize")}
              </button>
              <button type="submit" className="pdf-primary" disabled={!question.trim()} data-testid="pdf-ask-submit">
                {t("pdf.ask.submit")}
              </button>
            </>
          )}
        </div>
      </form>
      <p className="pdf-muted" aria-live="polite" data-testid="pdf-ask-status">
        {status.kind === "indexing"
          ? t(status.p.ocr ? "pdf.ask.ocr" : "pdf.ask.indexing", { page: status.p.page, pages: status.p.pages })
          : status.kind === "thinking"
            ? t("pdf.ask.thinking")
            : status.kind === "error"
              ? t("pdf.ask.failed", { error: status.message })
              : ""}
      </p>
      {answer && (
        <div className="pdf-ask-answer" data-testid="pdf-ask-answer">
          {answer.notFound ? (
            <p>{t("pdf.ask.notFound")}</p>
          ) : (
            <p dir="auto">{answer.answer}</p>
          )}
          {answer.citations.length > 0 && (
            <ol className="pdf-hl-list" data-testid="pdf-ask-citations">
              {answer.citations.map((c, i) => (
                <li key={`${c.page}:${c.line}:${i}`}>
                  <button type="button" className="pdf-hl-quote" dir="auto" data-page={c.page} data-line={c.line} onClick={() => onCite(c.page, c.quote)}>
                    <span className="pdf-hl-page">{t("pdf.ask.cite", { page: c.page, line: c.line })}</span> “{c.quote}”
                  </button>
                </li>
              ))}
            </ol>
          )}
          {answer.dropped > 0 && <p className="pdf-muted">{t("pdf.ask.dropped", { n: answer.dropped })}</p>}
        </div>
      )}
      {summary && (
        <div className="pdf-ask-answer" data-testid="pdf-summary" data-engine={summary.engine}>
          <h3>{t("pdf.summary.title")}</h3>
          <ol className="pdf-hl-list">
            {summary.sentences.map((s, i) => (
              <li key={i}>
                {s.page !== null ? (
                  <button type="button" className="pdf-hl-quote" dir="auto" data-page={s.page} onClick={() => onCite(s.page!, s.text.split(/\.\.\.|…/)[0].trim())}>
                    <span className="pdf-hl-page">{t("pdf.ask.cite", { page: s.page, line: s.line ?? 1 })}</span> {s.text}
                  </button>
                ) : (
                  <span dir="auto">{s.text}</span>
                )}
              </li>
            ))}
          </ol>
          <p className="pdf-muted">{t(summary.engine === "extractive" ? "pdf.summary.extractive" : "pdf.summary.local")}</p>
        </div>
      )}
    </aside>
  );
}

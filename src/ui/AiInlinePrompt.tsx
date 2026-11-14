/**
 * AiInlinePrompt — A non-blocking floating overlay that replaces window.prompt()
 * for AI-related inputs (Ghostwriter, Rewrite, etc.).
 *
 * Usage: call `openAiPrompt(question)` which returns a Promise<string | null>.
 * Mount <AiInlinePromptOverlay /> once in the app root.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X } from "lucide-react";
import { t } from "../i18n";
import { getAiPromptHistory, rememberAiPrompt } from "../storage/aiPromptHistory";

/** Pending prompt resolve function stored in module scope. */
let pendingResolve: ((value: string | null) => void) | null = null;

const listeners = new Set<(question: string) => void>();

/**
 * Show a floating AI prompt overlay. Returns the user's input or null if cancelled.
 * Replaces window.prompt() with a non-blocking, styled UI.
 */
export function openAiPrompt(question: string): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    pendingResolve = resolve;
    listeners.forEach((fn) => fn(question));
  });
}

export function AiInlinePromptOverlay() {
  const [visible, setVisible] = useState(false);
  const [question, setQuestion] = useState("");
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Prompt history: snapshot taken when the overlay opens; `historyIndex`
  // is -1 while the user is typing freely, otherwise the index into it.
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  useEffect(() => {
    const show = (q: string) => {
      setQuestion(q);
      setValue("");
      setHistory(getAiPromptHistory());
      setHistoryIndex(-1);
      setVisible(true);
      setTimeout(() => inputRef.current?.focus(), 0);
    };
    listeners.add(show);
    return () => { listeners.delete(show); };
  }, []);

  const submit = useCallback(() => {
    const v = value.trim();
    if (v) rememberAiPrompt(v);
    setVisible(false);
    if (pendingResolve) {
      pendingResolve(v || null);
      pendingResolve = null;
    }
  }, [value]);

  const cancel = useCallback(() => {
    setVisible(false);
    if (pendingResolve) {
      pendingResolve(null);
      pendingResolve = null;
    }
  }, []);

  const onKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        cancel();
      } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        // Only cycle when the input is empty or we're already browsing
        // history — never clobber a prompt the user is typing.
        const browsing = historyIndex >= 0;
        if (!history.length || (!browsing && value !== "")) return;
        e.preventDefault();
        let next = historyIndex;
        if (e.key === "ArrowUp") next = Math.min(historyIndex + 1, history.length - 1);
        else if (browsing) next = historyIndex - 1;
        setHistoryIndex(next);
        setValue(next >= 0 ? history[next] : "");
      }
    },
    [submit, cancel, history, historyIndex, value],
  );

  if (!visible) return null;

  return (
    <div
      onClick={cancel}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 10000,
        background: "hsl(var(--bg) / 0.5)",
        backdropFilter: "blur(4px)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "18vh",
        animation: "cmdFadeIn 120ms ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(520px, 90vw)",
          background: "hsl(var(--bg))",
          border: "1px solid hsl(var(--border-strong))",
          borderRadius: 12,
          boxShadow:
            "0 20px 60px -10px hsl(0 0% 0% / 0.4), 0 8px 20px -4px hsl(0 0% 0% / 0.2)",
          overflow: "hidden",
          animation: "cmdSlideIn 160ms cubic-bezier(0.2, 0.9, 0.3, 1.2)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "12px 14px",
            borderBottom: "1px solid hsl(var(--border))",
            fontSize: 13,
            color: "hsl(var(--accent))",
            fontWeight: 600,
          }}
        >
          <Sparkles size={14} />
          <span>{question}</span>
          <div style={{ flex: 1 }} />
          <button
            onClick={cancel}
            aria-label={t("dialog.cancel")}
            style={{
              background: "transparent",
              border: "none",
              color: "hsl(var(--fg-muted))",
              cursor: "pointer",
              padding: 2,
            }}
          >
            <X size={14} />
          </button>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "12px 14px" }}>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setHistoryIndex(-1);
            }}
            onKeyDown={onKey}
            placeholder={t("ai.prompt.placeholder")}
            style={{
              flex: 1,
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              padding: "8px 12px",
              background: "hsl(var(--bg-subtle))",
              color: "hsl(var(--fg))",
              fontSize: 14,
              fontFamily: "inherit",
              outline: "none",
            }}
          />
          <button
            onClick={submit}
            aria-label={t("ai.prompt.submit")}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              background: "hsl(var(--accent))",
              color: "hsl(var(--accent-fg))",
              border: "none",
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {t("ai.prompt.submit")}
          </button>
        </div>
        <div
          style={{
            padding: "6px 14px 8px",
            fontSize: 11,
            color: "hsl(var(--fg-muted))",
            display: "flex",
            gap: 12,
          }}
        >
          <span>
            <kbd style={{ background: "hsl(var(--bg-muted))", border: "1px solid hsl(var(--border))", borderRadius: 3, padding: "1px 4px", fontSize: 10, fontFamily: "monospace" }}>↵</kbd>{" "}
            {t("ai.inline.submit")}
          </span>
          <span>
            <kbd style={{ background: "hsl(var(--bg-muted))", border: "1px solid hsl(var(--border))", borderRadius: 3, padding: "1px 4px", fontSize: 10, fontFamily: "monospace" }}>Esc</kbd>{" "}
            {t("dialog.cancel")}
          </span>
          {history.length > 0 && (
            <span data-testid="ai-prompt-history-hint">{t("ai.prompt.historyHint")}</span>
          )}
        </div>
      </div>
    </div>
  );
}

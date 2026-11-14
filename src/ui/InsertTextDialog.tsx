import { useEffect, useMemo, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import { smartDetect, renderAs, ALL_KINDS, type DetectedKind } from "../data/smartDetect";
import { HelpButton } from "./HelpButton";
import "./insertTextDialogStrings";

/**
 * Smart Insert dialog — single text area, the system figures out what to
 * do with it. Recognises 17+ content kinds (YouTube/Twitter/Maps embeds,
 * CSV/TSV/JSON tables, SQL → table, Mermaid / Graphviz / PlantUML diagrams,
 * GeoJSON maps, ECharts specs, math, ABC music, BibTeX, raw HTML, code with
 * language sniff, plain markdown).
 *
 * The user can always override the auto-detection via a dropdown.
 */

type InsertMode = "append" | "replace" | "atCursor";

export interface InsertTextResult {
  markdown: string;
  mode: InsertMode;
}

function PreviewSnippet({ markdown }: { markdown: string }) {
  const trimmed = markdown.length > 600 ? markdown.slice(0, 600) + "\n…" : markdown;
  return (
    <pre
      style={{
        fontSize: 11,
        lineHeight: 1.45,
        margin: 0,
        padding: 10,
        background: "hsl(var(--bg-subtle))",
        border: "1px solid hsl(var(--border))",
        borderRadius: 6,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
        color: "hsl(var(--fg))",
        fontFamily: "JetBrains Mono, ui-monospace, monospace",
        maxHeight: 200,
        overflow: "auto",
      }}
    >
      {trimmed || t("insertText.previewEmpty")}
    </pre>
  );
}

function InsertTextDialogImpl({
  onResolve,
}: {
  onResolve: (v: InsertTextResult | null) => void;
}) {
  const [text, setText] = useState("");
  const [forceKind, setForceKind] = useState<"auto" | DetectedKind>("auto");
  const [codeLang, setCodeLang] = useState("");
  const [mode, setMode] = useState<InsertMode>("atCursor");

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const taRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    setTimeout(() => taRef.current?.focus(), 0);
  }, []);

  // Focus stays in the dialog and returns on close; Escape cancels (plan 10.1).
  useFocusTrap(dialogRef, { onEscape: () => onResolve(null) });

  // Auto-detect runs every time the input changes.
  const detection = useMemo(() => smartDetect(text), [text]);
  const effectiveKind: DetectedKind =
    forceKind === "auto" ? detection.kind : forceKind;
  const converted = useMemo(() => {
    if (forceKind === "auto") return detection.rendered;
    return renderAs(text, effectiveKind, codeLang);
  }, [text, forceKind, effectiveKind, codeLang, detection]);

  function confirm() {
    if (!text.trim()) {
      onResolve(null);
      return;
    }
    onResolve({ markdown: converted, mode });
  }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        confirm();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, forceKind, codeLang, mode]);

  const detectedLabel =
    forceKind === "auto"
      ? detection.label
      : ALL_KINDS.find((k) => k.kind === forceKind)?.label ?? "📝 Markdown";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="insert-text-title"
      style={{
        position: "fixed",
        inset: 0,
        background: "var(--overlay)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
        zIndex: 9999,
        animation: "cmdFadeIn var(--duration-fast) var(--ease-out)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onResolve(null);
      }}
    >
      <div
        ref={dialogRef}
        style={{
          background: "hsl(var(--bg))",
          color: "hsl(var(--fg))",
          border: "1px solid hsl(var(--border-strong))",
          borderRadius: 12,
          boxShadow: "var(--shadow-xl)",
          width: "min(720px, calc(100vw - 32px))",
          padding: 18,
          display: "flex",
          flexDirection: "column",
          gap: 12,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div id="insert-text-title" style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>
            {t("insertText.title")}
          </div>
          <HelpButton topic="editor/smart-insert" />
        </div>
        <div style={{ fontSize: 12, color: "hsl(var(--fg-muted))", marginTop: -6 }}>
          {t("insertText.smartHelp")}
        </div>

        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("insertText.smartPlaceholder")}
          aria-label={t("insertText.title")}
          style={{
            width: "100%",
            minHeight: 180,
            maxHeight: "40vh",
            resize: "vertical",
            padding: 10,
            fontFamily: "JetBrains Mono, ui-monospace, monospace",
            fontSize: 12,
            lineHeight: 1.5,
            border: "1px solid hsl(var(--border))",
            borderRadius: 8,
            background: "hsl(var(--bg-subtle))",
            color: "hsl(var(--fg))",
            outline: "none",
          }}
        />

        {/* Detection badge — always visible, prominent */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            padding: "8px 12px",
            background:
              detection.kind === "markdown" && forceKind === "auto"
                ? "hsl(var(--bg-subtle))"
                : "hsl(var(--accent) / 0.10)",
            border: `1px solid ${
              detection.kind === "markdown" && forceKind === "auto"
                ? "hsl(var(--border))"
                : "hsl(var(--accent) / 0.35)"
            }`,
            borderRadius: 8,
            fontSize: 13,
          }}
        >
          <span style={{ color: "hsl(var(--fg-muted))", fontSize: 11 }}>
            {t("insertText.detectedAs")}:
          </span>
          <span style={{ fontWeight: 600 }}>{detectedLabel}</span>
          <select
            value={forceKind}
            onChange={(e) => setForceKind(e.target.value as "auto" | DetectedKind)}
            aria-label={t("insertText.detect")}
            style={{
              marginInlineStart: "auto",
              padding: "3px 8px",
              fontSize: 11,
              background: "hsl(var(--bg))",
              color: "hsl(var(--fg))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
            }}
          >
            <option value="auto">{t("insertText.auto")}</option>
            {ALL_KINDS.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.label}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          {effectiveKind === "code" && (
            <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
              <span style={{ color: "hsl(var(--fg-muted))" }}>{t("insertText.codeLang")}:</span>
              <input
                value={codeLang || detection.codeLang || ""}
                onChange={(e) => setCodeLang(e.target.value)}
                // i18n-allow: an example language code, the same in every language
                placeholder="ts"
                aria-label={t("insertText.codeLang")}
                style={{
                  width: 80,
                  padding: "4px 8px",
                  background: "hsl(var(--bg-subtle))",
                  color: "hsl(var(--fg))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 6,
                }}
              />
            </label>
          )}

          <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 12 }}>
            <span style={{ color: "hsl(var(--fg-muted))" }}>{t("insertText.mode")}:</span>
            <select
              value={mode}
              onChange={(e) => setMode(e.target.value as InsertMode)}
              aria-label={t("insertText.mode")}
              style={{
                padding: "4px 8px",
                background: "hsl(var(--bg-subtle))",
                color: "hsl(var(--fg))",
                border: "1px solid hsl(var(--border))",
                borderRadius: 6,
              }}
            >
              <option value="atCursor">{t("insertText.mode.atCursor")}</option>
              <option value="append">{t("insertText.mode.append")}</option>
              <option value="replace">{t("insertText.mode.replace")}</option>
            </select>
          </label>
        </div>

        <div>
          <div style={{ fontSize: 11, color: "hsl(var(--fg-muted))", marginBottom: 4, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em" }}>
            {t("insertText.preview")}
          </div>
          <PreviewSnippet markdown={converted} />
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 4, alignItems: "center" }}>
          <span style={{ marginInlineEnd: "auto", fontSize: 11, color: "hsl(var(--fg-muted))" }}>
            ⌘↵ {t("insertText.hintInsert")} · Esc {t("insertText.hintCancel")}
          </span>
          <button
            onClick={() => onResolve(null)}
            style={{
              padding: "6px 14px",
              background: "transparent",
              color: "hsl(var(--fg))",
              border: "1px solid hsl(var(--border))",
              borderRadius: 6,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            {t("insertText.cancel")}
          </button>
          <button
            onClick={confirm}
            disabled={!text.trim()}
            style={{
              padding: "6px 14px",
              background: text.trim() ? "hsl(var(--accent))" : "hsl(var(--border))",
              color: text.trim() ? "white" : "hsl(var(--fg-muted))",
              border: "none",
              borderRadius: 6,
              cursor: text.trim() ? "pointer" : "not-allowed",
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            {t("insertText.confirm")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function openInsertTextDialog(): Promise<InsertTextResult | null> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const cleanup = () => {
      try {
        root.unmount();
      } catch {
        // why: double-unmount in StrictMode is harmless
      }
      host.remove();
    };
    root.render(
      <InsertTextDialogImpl
        onResolve={(v) => {
          cleanup();
          resolve(v);
        }}
      />,
    );
  });
}

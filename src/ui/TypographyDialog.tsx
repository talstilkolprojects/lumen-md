/**
 * The "Hebrew typography" dialog (plan W2.9): turn each rule on or off,
 * turn fixing-as-you-type on or off, and apply the rules to the whole note
 * after a preview of every change. Applying is one undo step.
 * Loaded on first use from the command palette.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import { t } from "../i18n";
import { showAiToast } from "./AiToast";
import { applyEdits, loadTypographySettings, saveTypographySettings, typographyEdits, TYPO_RULES, type TypographySettings, type TypoEdit } from "../text/hebrewTypography";
import "./typographyDialogStrings";
import { HelpButton } from "./HelpButton";

export interface TypographyTarget {
  getView: () => EditorView | null;
  getContent: () => string;
  setContent: (s: string) => void;
}

/** A change in its line, for the preview: the text around it before and after. */
function context(text: string, e: TypoEdit): { before: string; after: string } {
  const s = Math.max(0, text.lastIndexOf("\n", e.from - 1) + 1, e.from - 24);
  const nl = text.indexOf("\n", e.to);
  const end = Math.min(nl < 0 ? text.length : nl, e.to + 24);
  return { before: text.slice(s, end), after: text.slice(s, e.from) + e.insert + text.slice(e.to, end) };
}

function TypographyDialogImpl({ target, onClose }: { target: TypographyTarget; onClose: () => void }) {
  const [settings, setSettings] = useState<TypographySettings>(() => loadTypographySettings());
  const text = useMemo(() => target.getContent(), [target]);
  const edits = useMemo(() => typographyEdits(text, settings.rules), [text, settings]);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const update = (next: TypographySettings) => {
    setSettings(next);
    saveTypographySettings(next);
  };

  const apply = () => {
    const view = target.getView();
    if (view && view.state.doc.toString() === text) {
      view.dispatch({ changes: edits.map((e) => ({ from: e.from, to: e.to, insert: e.insert })), userEvent: "input.typography" });
    } else target.setContent(applyEdits(text, edits));
    showAiToast(t("typo.applied", { count: edits.length }), "success");
    onClose();
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="typo-title"
      data-testid="typography-dialog"
      style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: "8vh", zIndex: 9999 }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={ref}
        style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, width: "min(640px, calc(100vw - 32px))", maxHeight: "80vh", overflow: "auto", padding: 18, display: "flex", flexDirection: "column", gap: 10 }}
      >
        <h2 id="typo-title" style={{ margin: 0, fontSize: 16 }}>
          {t("typo.title")}
        </h2>
        <HelpButton topic="editor/hebrew-typography" />
        <label style={{ display: "flex", gap: 8, alignItems: "center", fontWeight: 600 }}>
          <input type="checkbox" checked={settings.asYouType} onChange={(e) => update({ ...settings, asYouType: e.target.checked })} />
          {t("typo.asYouType")}
        </label>
        <fieldset style={{ border: "1px solid hsl(var(--border))", borderRadius: 8, padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
          {TYPO_RULES.map((r) => (
            <label key={r} style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }} dir="auto">
              <input type="checkbox" data-rule={r} checked={settings.rules[r] !== false} onChange={(e) => update({ ...settings, rules: { ...settings.rules, [r]: e.target.checked } })} />
              {t(`typo.rule.${r}`)}
            </label>
          ))}
        </fieldset>
        <div role="status" style={{ fontSize: 13, fontWeight: 600 }} data-testid="typography-count">
          {/* empty-action: the rule checkboxes above */}
          {edits.length ? t("typo.preview", { count: edits.length }) : t("typo.none")}
        </div>
        {edits.length > 0 && (
          <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12, maxHeight: 240, overflow: "auto" }} data-testid="typography-preview">
            {edits.slice(0, 100).map((e) => {
              const c = context(text, e);
              return (
                <li key={`${e.from}-${e.rule}`} dir="rtl">
                  <span style={{ textDecoration: "line-through", opacity: 0.6 }}>{c.before}</span> → <span>{c.after}</span>
                </li>
              );
            })}
          </ul>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" onClick={onClose}>
            {t("typo.close")}
          </button>
          <button type="button" onClick={apply} disabled={!edits.length} data-testid="typography-apply">
            {t("typo.apply")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function openTypographyDialog(target: TypographyTarget): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const before = document.activeElement as HTMLElement | null;
  const close = () => {
    try {
      root.unmount();
    } catch {
      // double unmount is harmless
    }
    host.remove();
    before?.focus?.();
  };
  root.render(<TypographyDialogImpl target={target} onClose={close} />);
}

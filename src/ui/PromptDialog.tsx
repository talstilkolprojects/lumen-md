import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../i18n";
import "./PromptDialog.css";
import { useFocusTrap } from "./useFocusTrap";
import { HelpButton } from "./HelpButton";

/**
 * Lightweight, themed replacement for native window.prompt / confirm / alert.
 *
 * Usage:
 *   const v = await uiPrompt({ message: "URL?", defaultValue: "https://" });
 *   const ok = await uiConfirm({ message: "Discard?" });
 *   await uiAlert({ message: "Saved." });
 *
 * The dialog is keyboard-friendly (Esc/Enter), focus-trapped to itself, and
 * restores focus to the previously-focused element on close.
 */

type Kind = "prompt" | "confirm" | "alert";

interface DialogOpts {
  message: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  /** When provided, the input is rendered with this placeholder. */
  placeholder?: string;
  title?: string;
  /**
   * When provided (prompt kind), the dialog renders a real <select> dropdown
   * of these options instead of a free-text input. Resolves the chosen value.
   */
  choices?: { value: string; label: string }[];
}

interface InternalProps extends DialogOpts {
  kind: Kind;
  onResolve: (value: string | boolean | null) => void;
}

function PromptDialogImpl({
  kind,
  message,
  defaultValue = "",
  okLabel,
  cancelLabel,
  placeholder,
  title,
  choices,
  onResolve,
}: InternalProps) {
  const initialValue =
    choices && choices.length
      ? choices.some((c) => c.value === defaultValue)
        ? defaultValue
        : choices[0].value
      : defaultValue;
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selectRef = useRef<HTMLSelectElement | null>(null);
  const okRef = useRef<HTMLButtonElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Initial focus: input for prompt, OK for confirm/alert.
    setTimeout(() => {
      if (kind === "prompt" && choices && choices.length) {
        selectRef.current?.focus();
      } else if (kind === "prompt") {
        inputRef.current?.focus();
        inputRef.current?.select();
      } else {
        okRef.current?.focus();
      }
    }, 0);
  }, [kind, choices]);

  function submit() {
    if (kind === "prompt") onResolve(value);
    else if (kind === "confirm") onResolve(true);
    else onResolve(null);
  }

  function cancel() {
    if (kind === "prompt") onResolve(null);
    else if (kind === "confirm") onResolve(false);
    else onResolve(null);
  }

  // Focus stays in the dialog (Tab cycles, focus returns on close); Escape cancels.
  useFocusTrap(dialogRef, { onEscape: cancel });

  return (
    <div
      className="prompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) cancel();
      }}
    >
      <div className="prompt-dialog" ref={dialogRef}>
        <div id="prompt-dialog-title" className="prompt-title">
          {title ?? message}
        </div>
        {title && <div className="prompt-message">{message}</div>}
        {kind === "prompt" && choices && choices.length > 0 ? (
          <select
            ref={selectRef}
            className="prompt-input"
            aria-label={title ?? message}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
          >
            {choices.map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </select>
        ) : kind === "prompt" ? (
          <input
            ref={inputRef}
            className="prompt-input"
            aria-label={title ?? message}
            value={value}
            placeholder={placeholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            spellCheck={false}
          />
        ) : null}
        <div className="prompt-actions">
          <span style={{ marginInlineEnd: "auto" }}>
            <HelpButton topic="editor/tools#dialogs" />
          </span>
          {kind !== "alert" && (
            <button
              type="button"
              className="prompt-btn prompt-btn-cancel"
              onClick={cancel}
            >
              {cancelLabel ?? t("dialog.cancel")}
            </button>
          )}
          <button
            ref={okRef}
            type="button"
            className="prompt-btn prompt-btn-ok"
            onClick={submit}
          >
            {okLabel ?? t("dialog.ok")}
          </button>
        </div>
      </div>
    </div>
  );
}

function show<T>(kind: Kind, opts: DialogOpts): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    const cleanup = () => {
      try {
        root.unmount();
      } catch {
        /* why: the root may already be unmounted by an earlier close */
      }
      host.remove();
    };
    root.render(
      <PromptDialogImpl
        kind={kind}
        {...opts}
        onResolve={(v) => {
          cleanup();
          resolve(v as T);
        }}
      />,
    );
  });
}

export function uiPrompt(opts: DialogOpts): Promise<string | null> {
  return show<string | null>("prompt", opts);
}
/** Like uiPrompt, but renders a real <select> dropdown of `choices`. */
export function uiSelect(
  opts: DialogOpts & { choices: { value: string; label: string }[] },
): Promise<string | null> {
  return show<string | null>("prompt", opts);
}
export function uiConfirm(opts: DialogOpts): Promise<boolean> {
  return show<boolean>("confirm", opts);
}
export function uiAlert(opts: DialogOpts): Promise<null> {
  return show<null>("alert", opts);
}

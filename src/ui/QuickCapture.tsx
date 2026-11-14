/**
 * The quick-capture box (plan 4.16): one text field, Enter adds it to the
 * end of inbox.md (Shift+Enter starts a new line), Esc closes. Opened by
 * ⌥⌘N, the command palette, the installed app's "Quick capture" shortcut
 * (`/?capture=1`) and the desktop menu — two steps from anywhere: open,
 * type, Enter. Loaded lazily.
 */

import { useEffect, useRef, useState } from "react";
import { Inbox } from "lucide-react";
import { t } from "../i18n";
import { captureToInbox, INBOX_PATH, openInbox } from "../capture/quickCapture";
import { isOPFSAvailable } from "../storage/workspace";
import { toast } from "../store/useToastStore";
import "./PromptDialog.css";

interface Props {
  open: boolean;
  onClose: () => void;
}

export function QuickCapture({ open, onClose }: Props) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    return () => previous?.focus?.();
  }, [open]);

  if (!open) return null;

  // No closing while a save is pending: the save closes the box when it
  // lands, and must not close a box reopened meanwhile (review #268).
  const close = () => {
    if (!busy) onClose();
  };

  const save = async () => {
    if (busy || !text.trim()) return;
    if (!isOPFSAvailable()) {
      toast.error(t("capture.noWorkspace"));
      return;
    }
    setBusy(true);
    try {
      await captureToInbox(text);
      setText("");
      toast.success(t("capture.saved", { path: INBOX_PATH }));
      onClose();
    } catch (e) {
      toast.error(t("capture.failed", { error: e instanceof Error ? e.message : String(e) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="prompt-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-capture-title"
      data-testid="quick-capture"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="prompt-dialog" style={{ width: "min(480px, calc(100vw - 32px))" }}>
        <div id="quick-capture-title" className="prompt-title" style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <Inbox size={16} aria-hidden="true" />
          {t("capture.title")}
        </div>
        <textarea
          ref={ref}
          className="prompt-input"
          dir="auto"
          rows={3}
          value={text}
          // Saving: what's typed now would be lost when the box clears (review #268).
          readOnly={busy}
          aria-busy={busy}
          aria-label={t("capture.title")}
          placeholder={t("capture.placeholder")}
          style={{ resize: "vertical", fontFamily: "inherit", lineHeight: 1.5 }}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              e.stopPropagation();
              close();
            } else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void save();
            }
          }}
        />
        <div className="prompt-message">{t("capture.hint")}</div>
        <div className="prompt-actions">
          <button
            type="button"
            className="prompt-btn prompt-btn-cancel"
            disabled={busy}
            onClick={() => {
              onClose();
              void openInbox().catch((e: unknown) => toast.error(t("capture.failed", { error: e instanceof Error ? e.message : String(e) })));
            }}
          >
            {t("capture.openInbox")}
          </button>
          <button type="button" className="prompt-btn prompt-btn-cancel" disabled={busy} onClick={close}>
            {t("dialog.cancel")}
          </button>
          <button type="button" className="prompt-btn prompt-btn-ok" disabled={busy || !text.trim()} onClick={() => void save()}>
            {t("capture.save")}
          </button>
        </div>
      </div>
    </div>
  );
}

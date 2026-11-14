/**
 * The tray's quick-capture window (plan W3.9): one text box; Enter adds it
 * to the inbox (Shift+Enter for a new line), Escape closes. It writes through
 * the same vault layer as the app, so the note shows up in the open window.
 */

import { useEffect, useRef, useState } from "react";
import { getLocale, t } from "../i18n";
import { formatCapture, INBOX_PATH } from "../desktop/shell";
import "./quickCaptureWindowStrings";

async function closeWindow(): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().hide();
  } catch {
    window.close();
  }
}

export function QuickCaptureWindow() {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    ref.current?.focus();
    const onFocus = () => ref.current?.focus();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  const save = async () => {
    if (!text.trim()) return;
    setStatus("saving");
    try {
      const ws = await import("../storage/workspace");
      let existing = "";
      try {
        existing = await ws.readWorkspaceFile(INBOX_PATH);
      } catch {
        /* a new inbox */
      }
      const next = await formatCapture(text, existing);
      if (next !== null) await ws.writeWorkspaceFile(INBOX_PATH, next);
      setText("");
      setStatus("saved");
      setTimeout(() => {
        setStatus("idle");
        void closeWindow();
      }, 600);
    } catch {
      setStatus("error");
    }
  };

  return (
    <main dir={getLocale() === "he" || getLocale() === "ar" ? "rtl" : "ltr"} style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, height: "100vh", boxSizing: "border-box", background: "hsl(var(--bg))", color: "hsl(var(--fg))" }}>
      <label htmlFor="quick-capture" style={{ fontSize: 13, fontWeight: 600 }}>
        {t("desktop.capture.title")}
      </label>
      <textarea
        id="quick-capture"
        ref={ref}
        dir="auto"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void save();
          } else if (e.key === "Escape") void closeWindow();
        }}
        placeholder={t("desktop.capture.placeholder")}
        style={{ flex: 1, resize: "none", fontSize: 15, padding: 8, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg-subtle))", color: "inherit" }}
      />
      <div role="status" aria-live="polite" style={{ fontSize: 12, color: "hsl(var(--fg-muted))", minBlockSize: 16 }}>
        {status === "saved" ? t("desktop.captured") : status === "error" ? t("desktop.capture.failed") : t("desktop.capture.hint", { inbox: INBOX_PATH })}
      </div>
    </main>
  );
}

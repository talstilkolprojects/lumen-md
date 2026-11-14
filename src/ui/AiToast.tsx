/**
 * AiToast — Replaces all browser alert() calls with an elegant toast system.
 * Usage: import { showAiToast } from "./AiToast" then call showAiToast("message")
 */

import { useEffect, useState } from "react";
import { Sparkles, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { t as i18n } from "../i18n";

export type ToastType = "info" | "success" | "error";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  /** Optional "Learn more" docs link (PRODUCT_IMPROVEMENT 2.4). */
  learnMoreUrl?: string;
}

export interface AiToastOptions {
  /** Absolute docs URL rendered as a "Learn more" link — see `lib/docsLinks`. */
  learnMoreUrl?: string;
}

let nextId = 0;
const listeners = new Set<(toast: Toast) => void>();

/** Show a toast notification from anywhere — no hooks needed. */
export function showAiToast(message: string, type: ToastType = "info", opts: AiToastOptions = {}) {
  const toast: Toast = { id: nextId++, message, type, learnMoreUrl: opts.learnMoreUrl };
  listeners.forEach((fn) => fn(toast));
}

const ICONS: Record<ToastType, typeof Sparkles> = {
  info: Sparkles,
  success: CheckCircle2,
  error: AlertTriangle,
};

const COLORS: Record<ToastType, string> = {
  info: "hsl(var(--accent))",
  success: "hsl(140 60% 50%)",
  error: "hsl(0 70% 60%)",
};

export function AiToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const add = (t: Toast) => {
      setToasts((prev) => [...prev.slice(-4), t]);
      // Toasts with a docs CTA stay longer so the link is actually clickable.
      setTimeout(() => {
        setToasts((prev) => prev.filter((x) => x.id !== t.id));
      }, t.learnMoreUrl ? 9000 : 4000);
    };
    listeners.add(add);
    return () => { listeners.delete(add); };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div
      // Stays live under a modal overlay that makes the app inert (the PDF
      // reader): a save error must still be shown and announced.
      data-modal-exempt=""
      style={{
        position: "fixed",
        bottom: 40,
        right: 16,
        zIndex: 99999,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "none",
      }}
    >
      {toasts.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div
            key={t.id}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 16px",
              borderRadius: 10,
              background: "hsl(var(--bg-subtle))",
              border: `1px solid ${COLORS[t.type]}40`,
              boxShadow: `0 4px 20px ${COLORS[t.type]}15, 0 1px 4px hsl(0 0% 0% / 0.15)`,
              color: "hsl(var(--fg))",
              fontSize: 13,
              fontFamily: "inherit",
              maxWidth: 380,
              animation: "toast-slide-in 0.3s ease-out",
            }}
          >
            <Icon size={15} style={{ color: COLORS[t.type], flexShrink: 0 }} />
            <span style={{ flex: 1 }}>
              {t.message}
              {t.learnMoreUrl && (
                <>
                  {" "}
                  <a
                    href={t.learnMoreUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "hsl(var(--accent))", textDecoration: "underline", whiteSpace: "nowrap" }}
                  >
                    {i18n("toast.learnMore")}
                  </a>
                </>
              )}
            </span>
            <button
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
              aria-label={i18n("toast.dismiss")}
              style={{
                background: "transparent",
                border: "none",
                color: "hsl(var(--fg-muted))",
                cursor: "pointer",
                padding: 2,
                flexShrink: 0,
              }}
            >
              <X size={13} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

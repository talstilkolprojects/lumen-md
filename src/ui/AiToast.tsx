/**
 * AiToast — Replaces all browser alert() calls with an elegant toast system.
 * Usage: import { showAiToast } from "./AiToast" then call showAiToast("message")
 *
 * Accessibility (WCAG 2.2, plan W3.8): the toasts sit in live regions that
 * are always on the page — errors in an assertive one (`role="alert"`),
 * the rest in a polite one (`role="status"`) — so screen readers read them
 * (4.1.3). A toast stays while the pointer is over it or focus is in it,
 * and its time starts again after (2.2.1).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles, X, AlertTriangle, CheckCircle2 } from "lucide-react";
import { t as i18n } from "../i18n";

export type ToastType = "info" | "success" | "error";

interface Toast {
  id: number;
  message: string;
  type: ToastType;
  /** Optional "Learn more" docs link (PRODUCT_IMPROVEMENT 2.4). */
  learnMoreUrl?: string;
  action?: AiToastAction;
}

export interface AiToastAction {
  label: string;
  onClick: () => void;
}

export interface AiToastOptions {
  /** Absolute docs URL rendered as a "Learn more" link — see `lib/docsLinks`. */
  learnMoreUrl?: string;
  /** A button in the toast (e.g. "Review"); clicking it also dismisses the toast. */
  action?: AiToastAction;
}

let nextId = 0;
const listeners = new Set<(toast: Toast) => void>();

/** Show a toast notification from anywhere — no hooks needed. */
export function showAiToast(message: string, type: ToastType = "info", opts: AiToastOptions = {}) {
  const toast: Toast = { id: nextId++, message, type, learnMoreUrl: opts.learnMoreUrl, action: opts.action };
  listeners.forEach((fn) => fn(toast));
}

const ICONS: Record<ToastType, typeof Sparkles> = {
  info: Sparkles,
  success: CheckCircle2,
  error: AlertTriangle,
};

/** The status token of each toast type (src/index.css). */
const TONE: Record<ToastType, "accent" | "success" | "danger"> = {
  info: "accent",
  success: "success",
  error: "danger",
};
const COLORS: Record<ToastType, string> = {
  info: "hsl(var(--accent))",
  success: "hsl(var(--success))",
  error: "hsl(var(--danger))",
};

export function AiToastContainer() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());
  const held = useRef(new Set<number>());

  const remove = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer) clearTimeout(timer);
    timers.current.delete(id);
    held.current.delete(id);
    setToasts((prev) => prev.filter((x) => x.id !== id));
  }, []);
  // Toasts with a docs CTA stay longer so the link is actually clickable.
  const schedule = useCallback((t: Toast) => {
    const old = timers.current.get(t.id);
    if (old) clearTimeout(old);
    timers.current.set(t.id, setTimeout(() => !held.current.has(t.id) && remove(t.id), t.learnMoreUrl || t.action ? 9000 : 4000));
  }, [remove]);
  const hold = (t: Toast) => {
    held.current.add(t.id);
    const timer = timers.current.get(t.id);
    if (timer) clearTimeout(timer);
  };
  const release = (t: Toast) => {
    held.current.delete(t.id);
    schedule(t);
  };

  useEffect(() => {
    const add = (t: Toast) => {
      setToasts((prev) => [...prev.slice(-4), t]);
      schedule(t);
    };
    listeners.add(add);
    const all = timers.current;
    return () => {
      listeners.delete(add);
      for (const timer of all.values()) clearTimeout(timer);
    };
  }, [schedule]);

  const box = {
    position: "fixed",
    bottom: 40,
    insetInlineEnd: 16,
    zIndex: 99999,
    display: "flex",
    flexDirection: "column",
    gap: 8,
    pointerEvents: "none",
  } as const;
  // Two live regions, always present (a region added with its message is not read).
  return (
    <>
      <div role="alert" aria-live="assertive" aria-atomic="false" data-testid="toasts-alert" style={{ ...box, bottom: 40 + 64 * toasts.filter((x) => x.type !== "error").length }}>
        {renderToasts(toasts.filter((x) => x.type === "error"))}
      </div>
      <div role="status" aria-live="polite" aria-atomic="false" data-testid="toasts-status" style={box}>
        {renderToasts(toasts.filter((x) => x.type !== "error"))}
      </div>
    </>
  );

  function renderToasts(list: Toast[]) {
    return (
      <>
      {list.map((t) => {
        const Icon = ICONS[t.type];
        return (
          <div
            key={t.id}
            onMouseEnter={() => hold(t)}
            onMouseLeave={() => release(t)}
            onFocus={() => hold(t)}
            onBlur={() => release(t)}
            style={{
              pointerEvents: "auto",
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "10px 16px",
              borderRadius: 10,
              background: "hsl(var(--bg-subtle))",
              border: `1px solid hsl(var(--${TONE[t.type]}) / 0.25)`,
              boxShadow: `0 4px 20px hsl(var(--${TONE[t.type]}) / 0.08), var(--shadow-sm)`,
              color: "hsl(var(--fg))",
              fontSize: 13,
              fontFamily: "inherit",
              maxWidth: 380,
              animation: "toast-slide-in var(--duration-base) var(--ease-out)",
            }}
          >
            <Icon size={15} aria-hidden="true" style={{ color: COLORS[t.type], flexShrink: 0 }} />
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
            {t.action && (
              <button
                type="button"
                className="toast-action"
                data-testid="toast-action"
                onClick={() => {
                  setToasts((prev) => prev.filter((x) => x.id !== t.id));
                  t.action!.onClick();
                }}
                style={{ color: COLORS[t.type] }}
              >
                {t.action.label}
              </button>
            )}
            <button
              onClick={() => remove(t.id)}
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
              <X size={13} aria-hidden="true" />
            </button>
          </div>
        );
      })}
      </>
    );
  }
}

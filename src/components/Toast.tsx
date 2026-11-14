import { useEffect } from "react";
import { X, Info, CheckCircle2, AlertTriangle, AlertCircle } from "lucide-react";
import { useToastStore, type Toast as ToastType, type ToastKind } from "../store/useToastStore";
import { t } from "../i18n";

const ICONS: Record<ToastKind, typeof Info> = {
  info: Info,
  success: CheckCircle2,
  warning: AlertTriangle,
  error: AlertCircle,
};

const KIND_CLASSES: Record<ToastKind, string> = {
  info: "border-s-sky-400 bg-sky-50 text-sky-950 dark:bg-sky-950/40 dark:text-sky-100 dark:border-s-sky-500",
  success:
    "border-s-emerald-400 bg-emerald-50 text-emerald-950 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-s-emerald-500",
  warning:
    "border-s-amber-400 bg-amber-50 text-amber-950 dark:bg-amber-950/40 dark:text-amber-100 dark:border-s-amber-500",
  error:
    "border-s-rose-500 bg-rose-50 text-rose-950 dark:bg-rose-950/40 dark:text-rose-100 dark:border-s-rose-500",
};

function ToastCard({ toast }: { toast: ToastType }) {
  const Icon = ICONS[toast.kind];
  const dismiss = useToastStore((s) => s.dismiss);

  useEffect(() => {
    if (toast.ttlMs <= 0) return;
    const handle = window.setTimeout(() => dismiss(toast.id), toast.ttlMs);
    return () => window.clearTimeout(handle);
  }, [toast.id, toast.ttlMs, dismiss]);

  const isAlert = toast.kind === "error" || toast.kind === "warning";

  return (
    <div
      role={isAlert ? "alert" : "status"}
      aria-live={isAlert ? "assertive" : "polite"}
      className={
        "pointer-events-auto flex w-80 max-w-[calc(100vw-2rem)] items-start gap-3 rounded-md border-s-4 p-3 shadow-md ring-1 ring-black/5 dark:ring-white/10 " +
        KIND_CLASSES[toast.kind]
      }
    >
      <Icon size={18} className="mt-0.5 shrink-0" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">{toast.title}</div>
        {toast.body ? (
          <div className="mt-1 text-xs opacity-90 wrap-break-word">{toast.body}</div>
        ) : null}
        {toast.learnMoreUrl ? (
          <a
            href={toast.learnMoreUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1 inline-block text-xs font-medium underline"
          >
            {t("toast.learnMore")}
          </a>
        ) : null}
        {toast.action ? (
          <button
            type="button"
            onClick={() => {
              dismiss(toast.id);
              toast.action!.run();
            }}
            className="mt-2 block rounded-sm border border-current px-2 py-0.5 text-xs font-medium hover:opacity-80"
          >
            {toast.action.label}
          </button>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label={t("toast.dismiss")}
        className="shrink-0 rounded-sm p-1 opacity-70 hover:opacity-100 focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-current"
      >
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div
      aria-label={t("toast.region")}
      className="pointer-events-none fixed bottom-4 end-4 z-1000 flex flex-col gap-2 [direction:ltr]"
    >
      {toasts.map((item) => (
        <ToastCard key={item.id} toast={item} />
      ))}
    </div>
  );
}

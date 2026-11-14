/**
 * Listens for "open help" (a panel's "?", the palette, the error screen) and
 * mounts the help panel — loaded, with the packed docs, on first use.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { OPEN_HELP_EVENT } from "./HelpButton";

const HelpPanel = lazy(() => import("./HelpPanel"));

export function HelpHost() {
  const [open, setOpen] = useState<{ topic: string; query: string; n: number } | null>(null);
  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ topic?: string; query?: string }>).detail ?? {};
      setOpen((o) => ({ topic: d.topic ?? "", query: d.query ?? "", n: (o?.n ?? 0) + 1 }));
    };
    window.addEventListener(OPEN_HELP_EVENT, on);
    return () => window.removeEventListener(OPEN_HELP_EVENT, on);
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <HelpPanel key={open.n} topic={open.topic} initialQuery={open.query} onClose={() => setOpen(null)} />
    </Suspense>
  );
}

import { useEffect, useRef } from "react";

/**
 * Listen for a window event while the component is mounted (W6.25: the
 * many `lumen-open-*` listeners of App.tsx, one line each). The listener is
 * added once; it always calls the latest `handler`, so a handler that reads
 * fresh props or state needs no dependency list.
 */
export function useWindowEvent(name: string, handler: (e: Event) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const on = (e: Event) => latest.current(e);
    window.addEventListener(name, on);
    return () => window.removeEventListener(name, on);
  }, [name]);
}

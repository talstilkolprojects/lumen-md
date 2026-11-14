/**
 * Mounts the mobile editing toolbar (plan W1.25) only where it can show: on
 * a touch screen, or once the customise sheet is asked for from the palette.
 * The toolbar and its actions load then, so a desktop browser never fetches
 * them at startup.
 */

import { lazy, Suspense, useEffect, useState } from "react";

const MobileKeyboardBar = lazy(() => import("./MobileKeyboardBar").then((m) => ({ default: m.MobileKeyboardBar })));

const coarsePointer = (): boolean => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;

export function MobileKeyboardBarHost() {
  const [mount, setMount] = useState<{ customize: boolean } | null>(() => (coarsePointer() ? { customize: false } : null));
  useEffect(() => {
    if (mount) return;
    // Until the toolbar is loaded it can't hear the palette's request itself.
    const open = () => setMount({ customize: true });
    window.addEventListener("lumen-mobile-customize", open);
    return () => window.removeEventListener("lumen-mobile-customize", open);
  }, [mount]);
  if (!mount) return null;
  return (
    <Suspense fallback={null}>
      <MobileKeyboardBar startCustomizing={mount.customize} />
    </Suspense>
  );
}

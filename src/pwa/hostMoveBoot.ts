/**
 * Plan W6.9: a build for the old address after a host move (VITE_MOVED_TO,
 * docs self-hosting/cut-over). Imported by src/main.tsx right after the
 * Trusted Types policies, before any module can write localStorage: an empty
 * localStorage means this browser never used the app at this address, so it
 * has no notes here and goes straight to the new one. Anyone else gets the
 * banner of src/pwa/hostMove.ts (a lazy chunk). Without VITE_MOVED_TO this
 * module does nothing.
 */
import { moveTarget } from "./moveTarget";

const movedTo: string | undefined = import.meta.env.VITE_MOVED_TO;
if (movedTo) {
  let fresh = false;
  try {
    fresh = localStorage.length === 0;
  } catch {
    /* why: storage blocked: notes may still be here, show the banner */
  }
  const target = moveTarget(movedTo, location);
  if (target && fresh) location.replace(target);
  else if (target)
    void import("./hostMove").then((m) => {
      const show = () => m.showMoveBanner(movedTo);
      if (document.body) show();
      else addEventListener("DOMContentLoaded", show, { once: true });
    });
}

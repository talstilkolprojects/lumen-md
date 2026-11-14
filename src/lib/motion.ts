/**
 * Reduced motion (plan 10.1.4). The stylesheet already shortens every CSS
 * animation and transition under `prefers-reduced-motion: reduce`; scrolling
 * started from script goes through here, so it jumps instead of gliding.
 */
export function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** "smooth", or "auto" when the user asked for less motion. */
export function scrollBehavior(): ScrollBehavior {
  return prefersReducedMotion() ? "auto" : "smooth";
}

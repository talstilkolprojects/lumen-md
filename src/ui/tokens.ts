/**
 * The design system's tokens for inline styles (plan W3.1). Every value is a
 * CSS custom property defined in src/index.css, so the theme presets, dark
 * mode and prefers-reduced-motion change them in one place.
 *
 * scripts/check-design.mjs holds src/ui to it: no hard-coded colour, motion
 * only on transform and opacity, durations from the scale below.
 */

const hsl = (name: string, alpha?: number) => (alpha === undefined ? `hsl(var(--${name}))` : `hsl(var(--${name}) / ${alpha})`);

export const color = {
  bg: hsl("bg"),
  bgSubtle: hsl("bg-subtle"),
  bgMuted: hsl("bg-muted"),
  fg: hsl("fg"),
  fgMuted: hsl("fg-muted"),
  border: hsl("border"),
  accent: hsl("accent"),
  accentFg: hsl("accent-fg"),
  danger: hsl("danger"),
  success: hsl("success"),
  warning: hsl("warning"),
  info: hsl("info"),
  overlay: "var(--overlay)",
  /** A status colour at a given opacity: tint("danger", 0.1). */
  tint: (name: "danger" | "success" | "warning" | "info" | "accent" | "border", alpha: number) => hsl(name, alpha),
} as const;

export const gradient = {
  brand: "var(--gradient-brand)",
  ai: "var(--gradient-ai)",
  success: "var(--gradient-success)",
} as const;

export const shadow = {
  sm: "var(--shadow-sm)",
  md: "var(--shadow-md)",
  lg: "var(--shadow-lg)",
  xl: "var(--shadow-xl)",
  accent: "var(--shadow-accent)",
} as const;

export const space = { 1: "var(--space-1)", 2: "var(--space-2)", 3: "var(--space-3)", 4: "var(--space-4)", 6: "var(--space-6)", 8: "var(--space-8)" } as const;
export const radius = { sm: "var(--radius-sm)", md: "var(--radius-md)", lg: "var(--radius-lg)", full: "var(--radius-full)" } as const;
export const text = { xs: "var(--text-xs)", sm: "var(--text-sm)", md: "var(--text-md)", lg: "var(--text-lg)", xl: "var(--text-xl)" } as const;

export type Speed = "fast" | "base" | "slow";
/** 100 ms (menus, hovers), 250 ms (dialogs, toasts), 350 ms (panels). */
export const duration: Record<Speed, string> = { fast: "var(--duration-fast)", base: "var(--duration-base)", slow: "var(--duration-slow)" };
export const ease = { out: "var(--ease-out)", inOut: "var(--ease-in-out)" } as const;

/** A transition on transform and / or opacity only — the type refuses anything that moves layout. */
export function transition(props: ReadonlyArray<"transform" | "opacity">, speed: Speed = "fast"): string {
  return props.map((p) => `${p} ${duration[speed]} ${ease.out}`).join(", ");
}

/** An entrance animation (keyframes in src/ui/CommandPalette.css / src/index.css). */
export function enter(keyframes: "cmdFadeIn" | "cmdSlideIn" | "toast-slide-in" | "in", speed: Speed = "fast"): string {
  return `${keyframes} ${duration[speed]} ${ease.out}`;
}

/** A colour from a token, resolved for <canvas> (which cannot read var()). */
export function resolvedColor(name: string, alpha = 1, root: Element | null = typeof document !== "undefined" ? document.documentElement : null): string {
  const v = root ? getComputedStyle(root).getPropertyValue(`--${name}`).trim() : "";
  // design-allow: the token resolver builds the colour from the token's own value
  return v ? `hsl(${v} / ${alpha})` : "currentColor";
}

/** `hsl(h s% l%)` (a palette colour) at a given opacity. */
export function withAlpha(hslColor: string, alpha: number): string {
  return hslColor.replace(/\)\s*$/, ` / ${alpha})`);
}

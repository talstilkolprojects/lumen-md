---
title: Design system
description: Lumen's tokens for colour, space, radius, type, elevation and motion, the rules the code is held to, and the shared components.
---

Every surface of Lumen draws from one set of tokens. They are CSS custom
properties in `src/index.css`, so dark mode, the theme presets (Settings →
Theme) and *reduce motion* change them in one place. Inline styles use them
through `src/ui/tokens.ts`.

## Tokens

| Group | Tokens | Use |
|---|---|---|
| Surfaces and text | `--bg`, `--bg-subtle`, `--bg-muted`, `--bg-inset`, `--fg`, `--fg-subtle`, `--fg-muted`, `--border`, `--border-strong`, `--accent`, `--accent-fg` | HSL triplets: `hsl(var(--bg))`, `hsl(var(--accent) / 0.15)` |
| Status | `--danger`, `--success`, `--warning`, `--info` | errors and destructive actions, confirmations, cautions, information; tuned for light and dark |
| Gradients | `--gradient-brand`, `--gradient-ai`, `--gradient-success` | the logo, the AI button, progress — decoration only |
| Behind a modal | `--overlay` | every dialog backdrop |
| Elevation | `--shadow-sm`, `--shadow-md`, `--shadow-lg`, `--shadow-xl`, `--shadow-accent` | badges, popovers, menus, dialogs; the accent glow |
| Space | `--space-1` … `--space-8` (4 px steps) | padding and gaps |
| Radius | `--radius-sm` 4, `--radius-md` 6, `--radius-lg` 10, `--radius-full` | |
| Type | `--text-xs` 11 … `--text-xl` 18 px | |
| Motion | `--duration-fast` 100 ms, `--duration-base` 250 ms, `--duration-slow` 350 ms; `--ease-out`, `--ease-in-out` | menus and hovers; dialogs and toasts; panels |

In TypeScript: `color.danger`, `color.tint("danger", 0.1)`, `shadow.lg`,
`transition(["opacity"], "base")`, `enter("cmdSlideIn")`. A `<canvas>`
cannot read `var()`: use `resolvedColor("fg", 0.15)` when drawing.

## Rules

1. **No hard-coded colour in `src/ui`** — no hex, `rgb()` or `hsl()` with
   numbers. Colours a person picks for their content (the note colours of
   the canvas) are content, marked `design-allow`.
2. **Only `transform` and `opacity` move**, with the three durations.
   Nothing animates width, height, top/left or margins: a progress bar
   scales (`transform: scaleX()`), a menu slides (`translateY`), a hover
   changes colour instantly.
3. **Reduce motion is respected everywhere**: with the system setting on,
   the duration tokens become 0 and a global rule cuts every remaining
   animation.
4. **Logical sides**: `marginInlineStart`, `insetInlineEnd`, `textAlign:
   "start"` — a surface mirrors in Hebrew by itself. Viewport coordinates
   from `getBoundingClientRect()` stay physical.
5. **A modal backdrop is `var(--overlay)`; a shadow is a step of the scale.**

`npm run design:check` runs both gates: `scripts/check-design.mjs` (rules
1–2 on all of `src/ui`, and no layout animation anywhere in `src`) and
`scripts/design-audit.mjs`, which runs the checklist (rules 1, 2, 4, 5) on
the 40 surfaces listed in `scripts/design-surfaces.json`. A real exception is
marked `design-allow: <reason>` in the code.

## Shared components

| Component | Where | For |
|---|---|---|
| Dialogs | `uiAlert`, `uiConfirm`, `uiPrompt`, `uiSelect` (`src/ui/PromptDialog.tsx`) | every question and confirmation; never `window.confirm` |
| Modal frame | `.cmd-palette-backdrop` + `.cmd-palette` (`src/ui/CommandPalette.css`) | panels such as the trash, the AI doctor, settings |
| Toasts | `showAiToast()` (`src/ui/AiToast.tsx`), `toast.*` (`src/store/useToastStore.ts`) | short messages; `action` for an Undo |
| Icon button | `.icon-btn` (`src/index.css`) | toolbar and panel buttons |
| Command palette | `src/ui/CommandPalette.tsx` | every action has a command |

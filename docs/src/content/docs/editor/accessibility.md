---
title: Accessibility
description: Keyboard use, screen readers, contrast and reduced motion in Lumen — and how each is checked.
---

Lumen is meant to be used without a mouse, with a screen reader, in Hebrew
or English, in light or dark mode.

## Keyboard

- **⌘K / Ctrl+K** opens the command palette; every feature is a command
  there. **⌘/ / Ctrl+/** lists the shortcuts.
- **Dialogs keep focus.** When a dialog opens, focus moves into it. Tab
  and Shift+Tab stay inside it, **Escape** closes it, and focus returns to
  where it was before (for example the editor). This holds for every modal
  dialog: the palette, search, settings, prompts, setup, version history,
  sign-in, sync conflicts and the rest.
- **The sidebar's edge** is a separator you can reach with Tab. **←/→**
  resize the sidebar by 16 px (**Shift**: 48 px), **Home** / **End** make it
  narrowest / widest. In right-to-left layouts the arrows follow the edge's
  direction.
- The command list in the palette can be reached with Tab and scrolled with
  the keyboard.

## Screen readers

Dialogs are announced with their names (`role="dialog"`, `aria-modal`, a
label). The editor has a label, the palette is a combobox with a listbox,
and the sidebar edge reports its width (`aria-valuenow`).

## Contrast

Text meets WCAG AA (at least 4.5:1) in light and dark mode: the accent
colour, muted text, inline code and the status-bar indicators (saved,
warning, error) were adjusted for this.

## Reduced motion

With the system's *reduce motion* setting on, animations and transitions are
cut to an instant, and scrolling that Lumen starts (the outline, comments,
typewriter mode, page view) jumps instead of gliding.

## How it is checked

- `e2e/a11y.spec.ts` runs [axe-core](https://github.com/dequelabs/axe-core)
  (WCAG 2.0/2.1 A and AA rules, colour contrast included) on the main
  screen, the command palette, search, the shortcuts list, theme settings and
  setup — in English (left-to-right) and Hebrew (right-to-left), light and
  dark. Any *serious* or *critical* finding fails the build.
- The same file walks a keyboard-only path: palette, a dialog that keeps
  focus for 25 Tab presses and gives it back, and the sidebar edge.
- `src/__tests__/useFocusTrap.test.tsx` covers the shared focus trap.

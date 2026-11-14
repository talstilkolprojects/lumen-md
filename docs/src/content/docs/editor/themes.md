---
title: Themes and CSS snippets
description: Five built-in themes, among them one for Hebrew reading, theme files on the documented tokens, and CSS snippets from the vault that can never reach the network.
---

**Settings → Theme** (command palette: *Theme settings*) changes how Lumen
looks, live, without a reload: a theme switch takes one frame.

## Built-in themes

| Theme | For |
|---|---|
| Default | Lumen's own light and dark palette |
| Sepia | warm paper, low glare |
| Nord | cool blue-grey |
| High contrast | black on white and white on black, text at 7:1 |
| **Ktav (Hebrew reading)** | paper and ink, a Hebrew serif in the editor and the preview, more space between lines |

Every theme passes WCAG AA in both light and dark mode: body and muted text
at 4.5:1 or more against the background, the accent at 3:1, and text on the
accent at 4.5:1. The **Contrast** section of the settings shows the numbers
for what you have chosen, including your own accent colour.

**Ktav** sets the editor and the preview to a Hebrew serif that ships with
the system (Frank Ruehl CLM, David, Noto Serif Hebrew, then Times New
Roman), 16 px, with a line height of 1.85 and a 70-character measure. You
can change any of these after choosing the theme.

## Theme files and the tokens

**Export** saves your theme as JSON; **Import** reads one back, strictly
validated (8 KB at most, unknown keys refused). A theme only sets the
documented tokens: the custom properties below, consumed as
`hsl(var(--token))`.

| Token | Is |
|---|---|
| `--bg`, `--bg-subtle`, `--bg-muted`, `--bg-inset` | backgrounds, from the page to inset wells |
| `--fg`, `--fg-subtle`, `--fg-muted` | text, from body text to hints |
| `--border`, `--border-strong` | lines |
| `--accent`, `--accent-fg` | links, focus, buttons; text on the accent |
| `--editor-font`, `--editor-font-size`, `--editor-line-height` | the editor's type |
| `--content-width`, `--preview-width` | the measure of the editor and the preview |
| `--font-serif`, `--preview-line-height` | the preview's type (set by Ktav) |

The design system's other tokens — spacing, radii, shadows, motion — are
listed in *Contributing → Design system*; snippets can use them too.

## CSS snippets

Put `.css` files in the vault's `.lumen/snippets/` folder (Lumen also reads
`.obsidian/snippets/`, so a vault from Obsidian keeps its snippets). Each one
appears under **CSS snippets** in the theme settings with a switch. Changes
to the files apply as you save them.

Snippets can restyle anything, but **they can't load anything from the
network**. Before a snippet reaches the page, Lumen reads it the way the
browser does and removes:

- every `@import`;
- any declaration with `url()`, `image-set()`, `image()`, `cross-fade()`,
  `element()` or `attr(… url)` pointing anywhere but a `data:` image or font
  or a `#fragment`. That holds however it is written: `URL(`, `u\72l(`, quoted or
  not, inside a custom property or a `var()` fallback;
- old script hooks (`expression()`, `behavior`, `-moz-binding`) and
  `@document`.

The settings list what was removed, with the line and the reason. The
page's Content Security Policy is a second line, but on its own it would
allow a stylesheet to load images from any HTTPS site, so the sanitizer is
what keeps snippets off the network. As a third line, Lumen watches for any
request a stylesheet makes to another site, and the **privacy ledger**
would show it. Its tests check that a snippet full of remote URLs makes no
request at all.

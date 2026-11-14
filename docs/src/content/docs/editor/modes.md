---
title: Editor modes
description: Source / Split / Preview / WYSIWYG — pick the one that fits the task.
---

Lumen has four editor surfaces. Switch with `⌘1` / `⌘2` / `⌘3` / `⌘4`.

## Source (`⌘1`)

Plain CodeMirror 6 with markdown highlighting. Use it when you want to
write fast, see exactly what the file contains, or paste pre-formatted
markdown. The "Smart Insert" pill (`⌘⇧V`) is most powerful here.

**Best for**: writers who think in markdown; data-heavy notes where you
want the fence delimiters visible.

## Split (`⌘2`, default)

Editor on one side, live preview on the other. The split orientation
follows your viewport — horizontal on wide screens, vertical on phones.
Override via the **Scroll orientation** menu in the top bar.

Scroll-link is on by default — both panes track the same heading even at
different content heights.

**Best for**: most authoring sessions. You see the rendered output the
moment you type.

## Preview (`⌘3`)

Read-only render of the markdown. Tables, charts, diagrams, math, embeds
— everything in its final form. Print from here with
`⌘K → Print / Save as PDF…`, which keeps the colours so PDFs come out
faithful.

**Best for**: reading notes back, proof-reading, sharing your screen.

## WYSIWYG (`⌘4`)

Notion-grade editing on top of Milkdown / ProseMirror. Slash menu (`/`),
inline math, drag-and-drop block reordering. Round-trips to plain
markdown — so a doc you wrote in WYSIWYG opens cleanly in Source.

**Best for**: visual thinkers; rich documents (presentations, decks);
anyone migrating from Notion.

## Toggle without leaving the keyboard

| Key | Mode |
| --- | --- |
| `⌘1` | Source |
| `⌘2` | Split |
| `⌘3` | Preview |
| `⌘4` | WYSIWYG |

The mode is remembered across reloads, so you come back to the view you
last used.

## Suggesting mode (track changes)

Turn it on from the command palette ("Turn on suggesting mode (track changes)") or with
the **Editing / Suggesting** pill in the status bar. While it is on, edits
in the Source / Split editor and in WYSIWYG are recorded as
[CriticMarkup](https://github.com/CriticMarkup/CriticMarkup-toolkit), so
the file stays plain markdown:

| You do | Stored as |
| --- | --- |
| Type text | `{++inserted++}` |
| Delete text (Backspace, Delete, cut) | `{--deleted--}` |
| Type over a selection | `{~~old~>new~~}` |
| Write a note by hand | `{>>comment<<}` / `{==highlight==}` |

- Typing next to your own insertion extends it, and consecutive deletions
  merge. Deleting text inside your own `{++ ++}` really deletes it.
- Undo / redo, edits from collaborators, and edits inside code blocks or
  inline code are never turned into suggestions.
- The editor shows insertions underlined in green, deletions struck
  through in red and comments highlighted; the preview renders them as
  `<ins>`, `<del>` and `<mark>`.
- Palette commands: accept / reject the suggestion at the cursor, accept
  all, reject all, next / previous suggestion. All of them work in
  WYSIWYG too; accept all / reject all also work from Preview.
- **In WYSIWYG** suggestions show as underlined insertions and struck-out
  deletions (hover for the author). Typing is recorded as an insertion,
  Backspace / Delete leave the text struck out and step over it, and
  typing over a selection becomes a substitution. Structural edits —
  joining two paragraphs with Backspace — aren't recorded as a
  suggestion and are undone; turn suggesting off for those.
- The status-bar pill shows how many suggestions the document contains.
- **Who suggested it.** When you are signed in, each new suggestion is
  followed by an author tag — a comment holding only `@name`, e.g.
  `{++new text++}{>>@Tal<<}`. The tag belongs to its change: accepting
  or rejecting the change removes it too. Hover a suggestion to see
  "Suggested by …"; the preview shows the name as a small comment.
  Typing inside someone else's suggestion keeps their name on it.

## TypeScript checks in code blocks

Run **Enable TypeScript checks in code blocks** from the command palette.
In the Source / Split editor, every ` ```ts `, ` ```typescript ` and
` ```tsx ` block (and JavaScript blocks, see below) is then checked by the
real TypeScript compiler:

- Errors get a wavy underline — hover it for the message (`TS2322: …`).
- Hovering a name shows its type (and its JSDoc, if any).
- Completions pop up while you type (after `.` or a few letters;
  `Ctrl-Space` forces them).
- Each block is checked on its own (its declarations don't leak into
  other blocks), in strict mode against the ES2022 and DOM libraries.
  Imports of npm packages aren't resolved and aren't reported.
- JavaScript blocks (` ```js `, ` ```javascript `, ` ```live-js `) get
  syntax errors, hover and completions; add `// @ts-check` as the first
  line to also get type errors.
- ` ```live-js shared ` blocks are checked together per scope
  (`shared=name`), in document order — a later block sees the names an
  earlier one declared, exactly as when they run. Re-declaring a name
  there is allowed.

The compiler (~1.3 MB compressed) runs in a background worker and is
downloaded only after you turn the setting on; it is not part of the
offline app shell. The setting is remembered.

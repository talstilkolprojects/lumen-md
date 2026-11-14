---
title: Links, embeds and block references
description: Link notes with [[ and its completion, preview a link by hovering, turn plain mentions into links, embed a note or one of its sections, and link to a single paragraph with ^id.
---

Notes link to each other with `[[Note name]]`, as in Obsidian. The links
work in the source editor, in the preview and in WYSIWYG, and they keep
working when a note is renamed or moved.

## Link completion

Type `[[` and a list of matching notes opens. It matches the way the vault
names notes: case, niqqud, final letters and spaces don't matter, so
`[[שלום` finds `שָׁלוֹם.md`. A name that two notes share is inserted as its
path.

| You type | The list offers |
|---|---|
| `[[que` | notes whose name, or an alias in their front matter (`aliases:`), matches |
| `[[Note#` | the headings of that note |
| `[[#` | the headings of the open note |
| `[[Note#^` | the block ids (`^id`) of that note |

Picking an alias inserts `[[Note|Alias]]`. When no note has exactly the
name you typed, the last entry is **Create note «…»**: it writes
`Name.md` with a `# Name` heading and never overwrites an existing file.
**↑** / **↓** move, **Enter** or **Tab** inserts, **Esc** closes the list.
Inside code the list stays closed.

## Hover preview

In the preview, point at a `[[link]]` for a moment, or move the keyboard
focus to it, and a card shows the first 20 lines of the note, rendered.
`[[Note#Heading]]` starts the card at that heading, and `[[Note#^id]]`
shows that block. **Esc**, moving away or leaving the link hides it. In
the source editor the same card opens when the mouse rests on a link. A
link to a note that doesn't exist yet says so instead.

## Unlinked mentions

The backlinks panel (**⌘K → Toggle backlinks**) lists the notes that link
here, and below them **Unlinked mentions**: notes that write this note's
title as plain text. Each has a **Link** button that turns that mention
into `[[Title]]`, or `[[Title|as written]]` when the case differs.

Only whole words count. A Hebrew prefix (ו, ה, ב, ל, מ, ש, כ, וב, של) stays
outside the link, so `בתל אביב` becomes `ב[[תל אביב]]`. Text inside links,
URLs, code, front matter and HTML is never touched, and a note never
counts as mentioning itself. Mentions match the title, not the aliases.

## Embeds

`![[…]]` shows another note, or part of it, inside this one:

| Syntax | Shows |
|---|---|
| `![[Note]]` | the whole note, with a small link that opens it |
| `![[Note#Heading]]` | that section, up to the next heading of the same or a higher level |
| `![[Note#^id]]` | one block |
| `![[#Heading]]` | a section of the note you are in |
| `![[image.png]]`, `![[image.png\|300]]` | an image from the vault, optionally 300 px wide (`\|300x200` sets both sides) |
| `![[file.pdf]]` | a card that opens the PDF |

Embeds nest up to three levels. A note that embeds itself, directly or
through other notes, shows a notice instead of looping, and so do a
missing note and a missing section. When an embedded note changes, the
embed updates. A Hebrew note embedded in an English one keeps its own
direction.

## Block references

A paragraph or list item that ends with ` ^id` can be linked on its own:
`[[Note#^id]]` opens the note and scrolls to it, and `![[Note#^id]]`
embeds it. A table, quote or code block gets its id on a line of its own
right after it. The `^id` marker is hidden in the preview.

**⌘K → Copy link to block** does this for you in the source editor: it
gives the block at the cursor an id (six letters and digits, unique in
the note; a block that has one keeps it) and copies `[[Note#^id]]`. On a
heading it copies the heading's link. In WYSIWYG the command points you to
the source editor (**⌘1**).

## Renaming and moving

Renaming or moving a note rewrites every link to it, and keeps the
`#heading`, `#^id` and `|alias` parts. Moving an image rewrites only the
embeds that pointed at that file, not ones that open a file with the same
name in another folder. [Vault Doctor](/workspace/doctor/) reports links
to block ids that no longer exist.

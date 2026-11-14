---
title: Templates
description: Start a note from a template — the built-in ones, the gallery, and the ones you install — and where an installed template lives.
---

## Start from a template

The command palette lists templates as commands. Pick one and it opens
as a **new, unsaved tab**: it never writes into the note you have open,
and a name that is already taken gets a number (*Meeting notes 2.md*).

## The template gallery

`⌘K → Browse template gallery` opens the gallery: filter by category,
search by name, and **Install** a template. Installing writes it to
`templates/<id>.md` in your vault and adds it to the palette under
**Templates: <name>**. It is an ordinary note, so you can edit it like
any other. With the interface in Hebrew, templates that have a Hebrew
version install in Hebrew.

The gallery's list ships with the app (`public/templates/registry.json`),
so browsing it makes no request to any other site.

## Adding a template to the gallery

See `public/templates/CONTRIBUTING.md` in the repository: one Markdown
file plus an entry in `registry.json` (and a Hebrew file under
`public/templates/he/` when there is one).

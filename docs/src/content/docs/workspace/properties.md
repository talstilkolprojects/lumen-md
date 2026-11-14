---
title: Note properties
description: The note's front matter as typed fields — text, number, date, list, checkbox and link — where an edit changes only that value.
---

**⌘K → Properties: edit this note's frontmatter** opens a side panel with the
YAML front matter of the open note, one row per key.

## Field types

Each key gets a field that fits its value: **text**, **number**, **date**,
**list**, **checkbox** or **link** (`[[Note]]`). Pick a different type from the
row's menu. A link opens its note, and says so when no note has that name yet.
Values that other notes already use for the same key are offered as you type.

## Adding and removing

At the bottom, type a property name, pick its type and press **Add property**.
A name that already exists is refused, with its name. The **×** on a row
removes that key.

## What changes in the file

Only the value you edited. Comments, the order of keys, quoting and line
endings stay as they were, so the note's history shows one small change. A
value the panel can't show as a field (a nested map, for example) is
read-only here: edit it in the editor.

When the front matter isn't valid YAML, the panel doesn't guess. It says so,
and you fix it in the editor.

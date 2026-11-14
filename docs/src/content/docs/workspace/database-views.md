---
title: Database views
description: Editable Table / Cards / Kanban / List / Calendar views over your YAML frontmatter.
---

The `database` block turns any folder of markdown notes (with consistent
YAML frontmatter) into a queryable collection — and renders the result
as one of five interactive views — and lets you edit it.

## Tag your notes

Drop YAML frontmatter on every note you want to include:

```yaml
---
type: book
title: Invisible Cities
author: Italo Calvino
rating: 5
status: reading
cover: https://example.com/cover.jpg
---

(body…)
```

The fields you use are entirely up to you — `type` is the only one Lumen
treats specially (it's the row filter).

## Drop a database block

```database
source: books/         # folder under workspace root
type: book             # filter by frontmatter.type
view: kanban           # table | cards | kanban | list | calendar | map
where: status != "done" AND (rating >= 4 OR contains(tags, "fav"))
groupBy: status        # kanban columns; sections in the other views
columns: [want, reading, done]   # kanban columns shown even when empty
sort: [-rating, title] # '-' (or ' desc') for descending
fields: [title, author, rating, status]
cover: cover           # for cards
```

Lumen scans the workspace, matches every note where `frontmatter.type`
equals `book` and the `where:` filter holds, and renders the requested view.
(`sortBy:` and `view: gallery` from older specs still work.)

## Filter

`where:` — and the **Filter** box above the view — take an expression over
the frontmatter, after Dataview's `WHERE`:

- `AND` / `&&`, `OR` / `||`, `NOT` / `!`, parentheses. `AND` binds tighter.
- `=` `!=` `<` `<=` `>` `>=`. Numbers compare as numbers, `YYYY-MM-DD`
  dates as dates. `tags = "fav"` is true when the list holds `fav`.
- `contains(field, "x")`, `startswith(…)`, `endswith(…)`, `empty(field)`.
- `file.name`, `file.path`, `file.folder` describe the note itself.
- Field names may be in any script: `סטטוס = "הושלם"`.

The **Sort** and **Group** menus re-order and section the view without
changing the spec.

## Views

- **Table** — click a cell (or focus it and press F2) to edit it; Enter
  saves, Escape cancels; checkboxes toggle. Long tables render only the
  rows on screen. Click a title to open the note.
- **Cards** — cover image + key fields. Set `cover: <fieldName>` to pick
  which frontmatter URL becomes the card image.
- **Kanban** — columns by `groupBy`. Drag a card by its handle to another
  column to change that property — or with the keyboard: focus the handle,
  Space, ← / →, Space (Escape cancels).
- **List** — titles with a few fields.
- **Calendar** — agenda of every note with a parseable `dateField`.
- **Map** — a marker per note with coordinates (`location: "32.08, 34.78"`,
  or `lat` + `lng`). See [Database formulas and map view](/workspace/database-formulas/).

## Formula columns

`formulas:` adds computed columns — `total: price * qty`,
`late: if(due < today(), "late", "")` — that the filter, sort and group can
use too. Syntax and every function: [Database formulas and map
view](/workspace/database-formulas/).

## Editing

An edit changes that one value in that one note's frontmatter — comments,
quoting, key order and the note's body stay exactly as they were. A note
whose frontmatter doesn't parse is never written (you get a message
instead). Editing the note that is open goes through its editor, so undo
works.

## Edit many notes at once

Tick the box at the start of a row in the **table** view (or on a card in the **kanban** view)
to select it. **Shift**-click another box to select every row between them. The box in the
header selects every note the filter shows; click it again to clear. Notes in a `.base` file's
table select the same way.

While notes are selected, a bar opens above the view:

- **Field**: any property, or a new name (Hebrew names work: `שפה`, `תאריך עברי`).
- **Action**: *Set a value*, *Add a tag*, *Remove a tag*, *Clear the field* or *Change the type*.
- The bar says how many of the selected notes will change before you apply it.

**Change N notes** writes every note's frontmatter, and only its frontmatter: the body, the
comments, the quoting and the order of the other properties stay byte for byte, and each file
is saved atomically. A note whose frontmatter doesn't parse, or whose value can't be converted
without losing it (`forty` to a number), is left as it was and counted in a message.

The whole change is one step: **Undo** in the message, or **Ctrl+Z** outside the editor, puts
every note back. A note you edited again after the bulk change is left as you left it, and the
message says how many.

## Live updates

Edit a note in another tab and the database view re-runs the query
automatically (a `lumen-workspace-changed` event triggers the refresh).

## Tips

- Mix views — keep one big database block at the top of a hub note and
  switch between Kanban and Gallery with the tab strip.
- Combine with **Smart Insert** — drop a YAML spec on an empty line and
  Lumen wraps it as a `database` fence for you.
- Values that are maps or nested lists show as read-only text; edit them in
  the note.

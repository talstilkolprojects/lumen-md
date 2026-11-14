---
title: Obsidian Bases (.base files)
description: Open, embed and edit Obsidian Bases files — what is supported, what is not, and how the golden set is checked.
---

A vault that comes from Obsidian keeps its **Bases**: `.base` files (YAML)
that turn notes into tables, cards, lists, kanban boards and maps. Lumen
reads and writes the same files, so the views survive the move both ways.

## Three ways to show a base

- **Open the `.base` file** from the workspace: the preview shows its views
  (one tab per view). The editor still shows the YAML.
- **Embed it in a note**: `![[Books.base]]` alone on a line, or
  `![[Books.base#Favourites]]` for one view.
- **Write it inline** in a fenced block:

````markdown
```base
filters:
  and:
    - file.hasTag("book")
    - 'status != "read"'
formulas:
  hours: (pages / 50).round(1)
views:
  - type: table
    name: To read
    order: [file.name, note.author, formula.hours]
    sort:
      - property: formula.hours
        direction: ASC
```
````

## What is supported

| Part of the file | Supported |
|---|---|
| `filters:` — a statement, or nested `and:` / `or:` / `not:` lists | yes (`not:` matches when none of its items match) |
| `formulas:` — computed properties, `formula.<name>`, a formula may use another | yes (a formula that refers to itself is reported) |
| `properties:` — `displayName` for column headers | yes |
| `summaries:` — your own summary formulas over `values` | yes |
| `views:` — `type`, `name`, `filters`, `order`, `sort`, `groupBy`, `limit`, `summaries` | yes |
| View types `table`, `cards` (`image:`), `list`, `kanban` (by `groupBy`), `map` (`coordinates:`) | yes |
| Plugin view types | shown as a table |
| Built-in summaries Average, Min, Max, Sum, Range, Median, Stddev, Earliest, Latest, Checked, Unchecked, Empty, Filled, Unique | yes |
| `this` — the `.base` file when opened, the embedding note when embedded | yes |

Expressions use the Bases language: `note.x` (or just `x`), `file.x`,
`formula.x`, `this.file.x`; operators `+ - * / %`, `== != < <= > >=`,
`! && ||`; text, numbers, lists `[a, b]`, regular expressions `/a.c/i`;
date arithmetic with durations (`today() - "1w"`, `date(note.due) + "1M"`).

**Functions:** 66 of the 68 functions in the Bases reference run (97 %):
all global functions except `icon()`, and every method on any value, text,
numbers, dates, lists (including `map`, `filter`, `reduce` with `value`,
`index`, `acc`), links, files, objects and regular expressions.

Not supported, with a clear message instead of a wrong value:

- `icon()` — the error reads "Bases function icon() is not supported here yet".
  Obsidian's icon set is too large to load in a note.
- `html()` — shown as plain text, never as markup (counted as not supported).

## Differences to know

- **Dates are UTC.** `today()` is the UTC date, as in database formulas, so a
  base gives the same answer on every machine.
- **`file.name` includes the extension** (`Dune.md`), as in Obsidian;
  `file.basename` is `Dune`.
- **`file.ctime`** is the modification time: the browser's file storage does
  not keep a creation time.
- **Text order** is natural (`2` before `10`), Latin before Hebrew.

## Sorting and saving

Click a column header to sort (again to reverse). For an embedded base,
**Save this sort to …** writes the new `sort:` into that view of the `.base`
file — comments, key order and everything else in the file stay as they
were. Opening and saving a base without edits keeps the same YAML data.

## Golden set

`src/__tests__/fixtures/bases/` holds 20 `.base` files and the vault they
run over (`vault.ts`). `expected.json` lists, for each file, the rows and
their order, and some values, worked out by hand from the Bases rules. The
test `basesGolden.test.ts` checks all 20, and that each file read and
written back unedited holds the same YAML.

To confirm against Obsidian 1.14: create the notes of `vault.ts` in an empty
vault, copy the 20 `.base` files into it, open each one and compare its
first view with `expected.json`. Any difference is a bug to file.

## Relations and rollups (Lumen)

Two top-level keys add Notion-style relations and rollups. They are a Lumen
extension: the file stays valid YAML, but Obsidian does not read these keys,
so their columns are empty there.

```yaml
relations:
  tasks:                 # notes whose `project` property links here
    property: project
    incoming: true
  team: members          # the notes this note's `members` links point to
rollups:
  hours:    { relation: tasks, property: estimate, function: sum }
  open:     { relation: tasks, function: count }
  next_due: { relation: tasks, property: due, function: earliest }
  cost:     { relation: team, property: rate, function: sum }
views:
  - type: table
    name: Projects
    order: [file.name, relation.tasks, rollup.hours, rollup.next_due]
```

- A **relation** follows a link property: one `[[link]]` or a list of
  them, as Obsidian writes them (aliases and paths resolve like any link).
  Outgoing by default: the notes the property points to. With
  `incoming: true` it runs the other way: the notes whose property points
  at this one. That gives you both sides of a link without writing it twice.
- A **rollup** computes `count`, `sum`, `avg`, `min`, `max`, `earliest` or
  `latest` over a property of the related notes. That can be `note.x`,
  `file.x`, one of the base's formulas (`formula.x`, computed for each
  related note), or another rollup.
- In a view, the columns are `relation.<name>` and `rollup.<name>`.
  Their headers are the names, unless `properties:` gives them a
  `displayName`.

## Calendar and timeline views (Lumen)

```yaml
views:
  - type: calendar
    name: Due
    date: due            # default: date
  - type: timeline
    name: Phases
    date: start
    end: finish          # optional: without it an item is one day long
```

- **Calendar** shows a month with each note on the day of its date.
  **Timeline** shows a bar from the start date to the end date for each note.
- To move a note to another day, drag it, or focus it and press
  **Alt + ←/→** for a day, **Alt + ↑/↓** for a week (the arrows follow the
  text direction, so in Hebrew → moves back). Only that date property changes in the note's file; every other byte
  stays as it was. A timeline bar keeps its length, so its end moves by
  the same number of days.
- In Obsidian these view types show as a table.

## Big bases and CSV

- A table of more than 200 rows draws only the rows in sight, so 10,000
  rows scroll smoothly. Filtering and sorting 10,000 notes takes well under
  100 ms.
- **Export CSV** saves the current view: its columns and rows, UTF-8 with a
  BOM, so Excel opens Hebrew correctly.
- **Import CSV…** adds one note per row to a folder named after the base:
  - The first column is the note's name.
  - The other columns become properties: numbers, `true` / `false` and
    text, with Hebrew headers kept.
  - Properties the base's filter pins (such as `type == "task"`) are added,
    so the new notes show in the view.
  - A name that's taken gets a number.

## Real vaults

The golden set was written from the Bases documentation. To check Lumen
against files people really write, `src/__tests__/fixtures/obsidian-corpus/`
holds byte-for-byte copies of seven public vaults with open licences (MIT,
and MIT + CC BY 4.0), each pinned to a commit in `manifest.json` with its
licence and a SHA-256 per file: 333 notes, 44 `.base` files and a canvas,
with callouts, `%%` comments, embeds, block ids, frontmatter and Dataview
inline fields. `node scripts/obsidian-corpus.mjs` checks the copies;
`--fetch` downloads them again. The test `obsidianCorpus.test.ts` runs
Lumen's own open → save path over every file:

- **Open and save, no edit:** every note and every `.base` comes back
  byte-identical — also when the note was saved by Windows (a byte-order
  mark and CRLF line endings stay; before W4.30 the first edit turned every
  line ending into LF and opening dropped the mark).
- **Properties:** writing a value that is already there changes nothing,
  for every editable property. A key written twice (`tags:` twice is common)
  is shown but not editable: a write could reach only one of the two.
- **Bases:** all 89 views run over their own vault without an error. The
  syntax of the first Bases releases is read too: `sort: - column: x`,
  top-level `display:`, `not()` and `empty()`, and an empty formula.
- **Rename and rename back:** the linking notes come back byte-identical; a
  `./` prefix, a `.md` in a wiki link and a Hebrew file name in a Markdown
  link are kept as written. The one exception is a link written in another
  case (`[[evergreen]]` comes back as `[[Evergreen]]`), which Obsidian
  rewrites the same way.

The WYSIWYG editor writes the note's body again on the first edit (its
Markdown writer has its own spelling of lists and emphasis); edit notes from
another app in the source editor.

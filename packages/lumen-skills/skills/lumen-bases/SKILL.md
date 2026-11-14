---
name: lumen-bases
description: Create and edit Lumen .base files (database views over Markdown notes, compatible with Obsidian Bases) with filters, formulas, views, sorting, grouping and summaries. Use when the user works with .base files, a table or card view of notes, or asks for a database of their notes in Lumen.
license: MIT
---

# Lumen Bases (.base)

A `.base` file is YAML. It selects notes, computes columns and shows views. Lumen opens it as a
table (or cards), and embeds it in a note with a ```` ```base ```` block. The format is Obsidian's.

## Shape

```yaml
filters:                      # which notes (optional; default: every note)
  and:
    - file.inFolder("Projects")
    - 'status != "done"'
formulas:                     # computed columns, referred to as formula.<name>
  overdue: 'due < today()'
  score: 'priority * 2'
properties:                   # display names (optional)
  status:
    displayName: Status
views:
  - type: table               # table | cards
    name: Open
    filters: 'priority >= 2'  # narrows the base's filters for this view
    order: [file.name, status, priority, due, formula.overdue]
    sort:
      - property: priority
        direction: DESC
    groupBy:
      property: status
      direction: ASC
    limit: 100
    summaries:
      priority: Average
```

## Rules

1. Write valid YAML: quote every expression that contains `:`, `"`, `#`, `!`, `<` or `>` with single quotes.
2. Note properties are bare (`status`) or `note.status`; file fields are `file.name`, `file.path`,
   `file.folder`, `file.ext`, `file.mtime`, `file.ctime`, `file.tags`, `file.links`; formulas are `formula.<name>`.
3. Functions: `file.inFolder("x")`, `file.hasTag("x")`, `file.hasLink("x")`, `today()`, `now()`, `date("2026-01-31")`,
   `if(cond, a, b)`, `link("Note")`, list `.contains(x)`, text `.lower()`, `.contains(x)`, `.startsWith(x)`.
4. `and:` / `or:` / `not:` take lists of expressions. A view's `filters` is ANDed with the base's.
5. `order` lists the columns, in order. Every `sort` and `groupBy` property should also be in `order`.
6. Hebrew property names work (`סטטוס`); quote them in expressions when they contain spaces.
7. Never put note content in a `.base`: it only describes the view.

## Check your work

The file must parse as YAML, have `views:` with at least one view, and every expression must close its
quotes and parentheses. See `examples/` for files Lumen opens without an error.

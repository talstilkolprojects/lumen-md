---
title: Embedded queries and saved searches
description: A ```query block lists the notes that match a search, a ```dataview block runs common Obsidian Dataview queries, and saved searches sit in the sidebar. All of them update as the vault changes.
---

## ```query blocks

Write a search in a `query` block and the preview lists the notes that
match it, kept up to date as you save notes:

````markdown
```query
tag:project -tag:done
view: table
sort: modified desc
limit: 20
```
````

The search uses the same [operators](/workspace/search-operators/) as the
search dialog: words, `tag:`, `path:`, `"exact phrase"`, `/regex/` and
`-term` to leave notes out. Lines of the form `option: value` set how it
shows:

| Option | Values | Default |
|---|---|---|
| `view` | `list`, `table` (note, folder, modified, tags) | `list` |
| `sort` | `relevance`, `name`, `path`, `modified` — then `asc` or `desc` | `relevance` |
| `limit` | 1–500 | 50 |

A line starting with `//` is a comment. The note that holds the block is
never in its own results. An option it can't read is shown above the
results, not silently dropped.

## ```dataview blocks

Vaults that come from Obsidian are full of
[Dataview](https://blacksmithgu.github.io/obsidian-dataview/) blocks.
Lumen runs the common part of its query language, so they render here
without the plugin:

````markdown
```dataview
TABLE status, due FROM #project WHERE status != "done" SORT due ASC
```
````

- **`LIST [expr]`** and **`TABLE [WITHOUT ID] expr [AS "name"], …`**
- **`FROM`** `#tag`, `"folder"`, `[[note]]` (notes that link to it), with
  `AND`, `OR`, `-` and parentheses
- **`WHERE`** comparisons (`= != < > <= >=`), `and` / `or` / `!`, `+ - * /`
- **`SORT`** one or more fields, `ASC` / `DESC`; **`LIMIT`** n
- Fields: front matter, inline fields (`key:: value`, `[key:: value]`) and
  `file.name`, `file.path`, `file.folder`, `file.link`, `file.mtime`,
  `file.ctime`, `file.size`, `file.tags`, `file.outlinks`
- Functions: `contains`, `icontains`, `startswith`, `endswith`, `length`,
  `lower`, `upper`, `date(today)`, `dur(7 days)`, `default`, `choice`,
  `round`, `number`, `string`, `join`, `regexmatch`

`TASK`, `CALENDAR`, `GROUP BY`, `FLATTEN` and DataviewJS are not supported:
the block says so instead of guessing. Nothing in a query is run as code —
the language is parsed and interpreted, and a test checks that the query
code has no `eval`.

## Live updates

Both kinds of block re-run when a note is saved, deleted or renamed. In a
vault of 1,000 notes, re-running after a save takes well under 100 ms.

## Saved searches

In the search dialog, **☆ Save search** keeps the search. Saved searches are
listed at the top of the file sidebar; a click opens the dialog on that
search again, and × removes it. They are kept in this browser, not in the
vault.

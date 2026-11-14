---
title: Database formulas and map view
description: Computed columns for the database block — syntax, every function, limits — and the map view for notes with coordinates.
---

A `database` block can add **formula columns**: values computed from each
note's frontmatter. They show up in every view, and the filter, sort and
group controls can use them like any other property.

```database
source: shop/
type: item
formulas:
  total: price * qty
  big: total >= 100          # a formula can use the ones above it
  late: if(due < today() and status != "done", "late", "")
  שנה: year(תאריך)
```

Every formula column is shown: with `fields:` in the spec, the formula
columns not listed there come after the listed fields (list one in
`fields:` to put it elsewhere). Formula cells are read-only (they are not written to the notes). A note a
formula can't compute — say `price: "n/a"` in `price * qty` — shows
**error** in that cell, with the reason on hover; the other notes are
unaffected.

## Trying a formula

Click **ƒ Formula column** above the view, give the column a name and type
a formula: it is checked as you type, and **Add column** shows it at once.
To keep it, copy the line it shows into the block's `formulas:`.

**Write with AI** turns a description ("days left until the due date, and
nothing once it's done") into a formula, using the local model (Ollama or
in-browser). The answer is checked by the same parser: a formula that does
not parse, calls an unknown function or uses a property the database does
not have is sent back to the model with the error, so what you get always
parses.

## Syntax

| | |
|---|---|
| Numbers | `12`, `3.5`, `.5`, `1e3` |
| Text | `"text"` or `'text'`; `\"` and `\\` inside |
| Yes / no / nothing | `true`, `false`, `null` |
| Lists | `[1, 2, 3]` |
| Properties | `price`, `תאריך`, `meta.owner`; `prop("due date")` for names with spaces or symbols |
| The note itself | `file.name`, `file.path`, `file.folder` |
| Arithmetic | `+ - * / %`, `^` (power, right to left: `2 ^ 3 ^ 2` is 512) |
| Text join | `&`, or `+` when a side is plain text |
| Comparison | `=` (`==`), `!=` (`<>`), `<`, `<=`, `>`, `>=` — not chained (`a < b < c` is an error) |
| Logic | `and` / `&&`, `or` / `||`, `not` / `!` |

Precedence, loosest first: `or`, `and`, `not`, comparison, `&`, `+ -`,
`* / %`, unary `-`, `^`. Keywords and function names are case-insensitive.

**Values** follow the filter's rules: numbers stay numbers, numeric text
(`"12"`) counts as a number, `YYYY-MM-DD` text compares as a date, a list
equals a value it holds (`tags = "fav"`), `=` compares text ignoring case,
and `<` / `>` order text by character code — the same result in every
language setting (alphabetical for Hebrew; capitals before small letters).
An empty property makes arithmetic empty (`price * qty` with no `qty` is
empty, not an error). `0.1 + 0.2` is `0.3`.

**Dates** are in UTC, so a formula gives the same answer in every time
zone: `2026-10-20` is midnight UTC, and a time written without an offset
(`2026-10-20T12:00`) is read as UTC too. `date + 7` and `date - 7` move by days; `date - date` is the number
of days between them.

## Functions

**Logic**

- `if(condition, then, else?)` — `then` when the condition holds, else `else` (empty when left out). Only the branch taken is computed.
- `and(a, b, …)`, `or(a, b, …)`, `not(x)`
- `coalesce(a, b, …)` (or `ifempty`) — the first argument that is not empty
- `empty(x)` — no value, empty text or empty list
- `prop("name")` — the property called name

**Text**

- `concat(a, b, …)` — joined as text
- `len(x)` (or `length`) — characters in text (Hebrew letters count one each), items in a list
- `upper(text)`, `lower(text)`, `trim(text)`
- `contains(textOrList, value)` — ignoring case; for a list, whether it holds the value
- `startswith(text, prefix)`, `endswith(text, suffix)` — ignoring case
- `replace(text, find, with)` — every occurrence; plain text, not a pattern
- `slice(text, start, end?)` (or `substring`) — 0-based; negative counts from the end
- `left(text, n)`, `right(text, n)`, `repeat(text, n)`
- `join(list, separator?)` — `", "` unless given; `split(text, separator)` — a list
- `text(x)` — as text (dates as `YYYY-MM-DD`); `number(x)` — as a number, empty when it is not one

**Math**

- `abs(x)`, `floor(x)`, `ceil(x)`, `sqrt(x)`, `pow(x, y)`, `mod(x, y)`
- `round(x, digits?)` — halves away from zero; `round(1.005, 2)` is `1.01`
- `min(…)`, `max(…)`, `sum(…)`, `avg(…)` (or `average`), `count(…)` — numbers or lists of numbers; empty values are skipped

**Dates**

- `today()`, `now()`
- `date("2026-10-20")`, `date(2026, 10, 20)`
- `year(d)`, `month(d)` (1–12), `day(d)`, `weekday(d)` (1 = Sunday … 7 = Saturday)
- `dateadd(d, n, unit?)` — unit `"days"` (default), `"weeks"`, `"months"`, `"years"`, `"hours"`, `"minutes"`; Jan 31 + 1 month is Feb 28
- `datediff(later, earlier, unit?)` — whole units from earlier to later (a month counts once its day is reached)

## Errors and limits

Every problem is reported as a formula error with the character it is at:
a syntax error, an unknown function, the wrong number of arguments, a value
of the wrong type (`"a" * 2`), or math that has no answer (division by
zero, `sqrt(-1)`, a number too large).

Formulas run in Lumen's own interpreter over a fixed set of operations and
the functions above — never as JavaScript, so a formula cannot reach
anything but the note's frontmatter. Each one has fixed limits, counted in
steps rather than time, so it always finishes and the same formula always
behaves the same way:

| Limit | Value |
|---|---|
| Length of a formula | 2,000 characters |
| Nesting (parentheses, calls, chained operators) | 64 levels |
| Parts in a formula | 1,000 |
| Steps for one note | 20,000 |
| Length of a text value | 20,000 characters |
| Items in a list value | 2,000 |

Plugin-defined formula functions (running in a QuickJS sandbox) are
planned; they will add to this list without changing the built-ins.

## Map view

The **Map** tab places every note that has coordinates on a map
(OpenStreetMap tiles; Leaflet is loaded only when you open the tab). A
note's coordinates come from:

- the property named by `location:` in the spec, or else
- a `location` (or `coordinates`) property, or else
- `lat` (or `latitude`) and `lng` (or `lon`, `longitude`) properties.

A location can be written `"32.08, 34.78"`, `[32.08, 34.78]` or
`{lat: 32.08, lng: 34.78}`. Click a marker for the note's title (which opens
it) and a few of its fields. Notes without coordinates are counted under
the map.

```database
source: trips/
view: map
location: place
fields: [date, rating]
```

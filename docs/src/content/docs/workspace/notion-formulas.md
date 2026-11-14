---
title: Notion's formulas in Bases
description: Notion's formula functions (dates, text, numbers, lists with current and index, lookups through relations) inside .base formulas and filters, plus two for Hebrew.
---

A `.base` formula or filter can use Notion's formula functions next to
Obsidian's own, so a database brought over from Notion keeps its formulas.
Where a name is already an Obsidian function (`if`, `min`, `max`, `empty`,
`now`, `today`, `link`, `date`, `list`, `number`), Obsidian's meaning stays,
because a `.base` file must mean in Lumen what it means in Obsidian.

## The functions

| Group | Functions |
|---|---|
| Logic | `ifs`, `let`, `lets`, `equal`, `unequal`, `prop("Name")` |
| Text | `length`, `substring`, `contains`, `test`, `match`, `replace` (the first match), `replaceAll`, `lower`, `upper`, `trim`, `repeat`, `split`, `join`, `format`, `concat` |
| Numbers | `add`, `subtract`, `multiply`, `divide`, `mod`, `pow`, `abs`, `round(n, places)`, `ceil`, `floor`, `sqrt`, `cbrt`, `sign`, `exp`, `ln`, `log10`, `log2`, `sum`, `mean`, `median`, `toNumber`, `pi`, `e` |
| Dates | `dateAdd`, `dateSubtract`, `dateBetween`, `formatDate`, `parseDate`, `timestamp`, `fromTimestamp`, `year`, `month` (1–12), `week` (ISO), `day` (1 = Monday … 7 = Sunday), `dayOfMonth` (Notion's `date()`), `hour`, `minute` |
| Lists | `map`, `filter`, `find`, `findIndex`, `some`, `every`, `count`: the expression sees `current` and `index`. `at` (a negative index counts from the end), `first`, `last`, `slice`, `sort`, `reverse`, `unique`, `includes`, `flat` |
| Relations | `relation.<name>` (the related notes), `current.prop("X")` on one of them, `lookup(relation.<name>, "X")`, `rollup.<name>` |
| Hebrew | `hebrewDate(date)` gives "ב׳ בכסלו תשפ״ז", and `hebrewDate(date, "day" \| "month" \| "year")` one part. `stripNikud(text)` removes the vowel marks |

`dateBetween(a, b, unit)` is a − b in whole units, toward zero, as in
Notion. Units are years, quarters, months, weeks, days, hours, minutes,
seconds and milliseconds. An empty date or number gives an empty result, so
a row without the property shows nothing instead of an error.

## Examples

```yaml
relations:
  subs: { property: Parent, incoming: true }
formulas:
  daysLeft: dateBetween(Due, today(), "days")
  hours: sum(map(relation.subs, current.prop("Estimate")))
  done: round(count(relation.subs, current.prop("Done")) / length(relation.subs) * 100) + "%"
  priority: ifs(Priority == 1, "High", Priority == 2, "Medium", "Low")
  hebrew: hebrewDate(Due)
```

## For scripts and plugins

A plugin with the `bases:read` permission reads a view's rows with
`lumen.bases.query()`. With `bases:write`, `lumen.bases.update()` changes note
properties behind one approval screen per call. See
[Plugin API](/plugins/api/). Automations can run
[when a row of a base changes](/workspace/automations/).

## Speed

10,000 notes, with two filters for every view, one view filter, a formula
column and a two-key sort, run in tens of milliseconds once warm. Simple
filter statements (a property compared with a value, `file.inFolder`,
`file.hasTag`, and `&&`, `||`, `!` of those) run without the interpreter,
with the same results.

## How it was checked

A golden set of 53 formulas as Notion users write them, with the values
Notion documents (`src/__tests__/basesNotion.test.ts`), uses every function
above.

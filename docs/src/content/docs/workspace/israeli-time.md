---
title: Israeli time
description: A Sunday–Thursday work week, the Hebrew date next to dates, and deadlines that move off Shabbat and chagim with a note saying why.
---

Lumen's calendar knows the Israeli week and the Jewish holidays (from its own
[Hebrew calendar](/workspace/hebrew-calendar/)). Nothing here rewrites a note: a moved
deadline is a suggestion shown next to the date you wrote.

## Settings

Open the calendar under the file tree and click its settings button.

| Setting | Default | |
|---|---|---|
| Work week | Sunday–Thursday when holidays are as in Israel, else Monday–Friday | In a Sunday–Thursday week Friday and Shabbat are the weekend; in a Monday–Friday week, Shabbat and Sunday. The calendar draws days off in a muted colour. |
| Hebrew dates | On for a Hebrew interface | The Hebrew date next to dates in a note's properties and in database views: `א׳ בתשרי תשפ״ז` in Hebrew, `1 Tishri 5787` otherwise. |
| A deadline on Shabbat or a chag | Suggest the next working day | Or the previous working day, or don't move it (only say why). |

The calendar starts the week on Sunday for Hebrew (and English), and on Monday for
French, German and Russian, as each language's own calendar does.

## Which days are off

- **Shabbat**, and the weekend of your work week.
- **Every yom tov:** Rosh Hashana (two days), Yom Kippur, the first day of Sukkot, Shemini
  Atzeret, the first and seventh days of Pesach and Shavuot. In the diaspora, the second
  days too. These are the Jewish rest days of the Hours of Work and Rest Law, 1951 (§18A).
- **Yom HaAtzmaut**, in Israel: a statutory holiday (Independence Day Law, 1949), on the
  day the government rules set (moved off Friday, Shabbat and Monday).

These days are working days, but get a note: **erev chag** (often a short day),
**Chol HaMoed** (many offices close), **fasts** (Tzom Gedaliah, 17 Tammuz, Tisha B'Av…),
**Yom HaZikaron** and **Yom HaShoah**.

## Deadlines

A **deadline** is a property named `due`, `deadline`, `due_date`, `יעד`, `תאריך יעד`,
`דדליין` or `מועד אחרון`. If it falls on a day off, you get a note:

> due: 2026-09-12 (א׳ בתשרי תשפ״ז) ⚠ Falls on Shabbat · Rosh Hashana I: suggested 2026-09-14 (Tzom Gedaliah)

Moving to the **next** working day is how Israeli law counts a period whose last day is a
day of rest (Interpretation Law, 1981, §10). Choose **previous** if you'd rather finish
before the chag.

### In a database view

Name the deadline column in the `database` block:

````md
```database
source: projects/
view: table
fields: [status, due]
deadline: due        # moved off Shabbat / chag, working days left
hebrewDate: true     # optional: overrides the setting for this block
```
````

The deadline column shows the date, the Hebrew date, the suggested working day when it
moves, and **working days left** (or overdue), counted over your work week and the
holidays. In the **calendar** view, every day has its Hebrew date and holidays, and each
item whose deadline is a day off has the suggestion under it.

## Checked

`src/__tests__/israeliTime.test.ts` has 30 golden deadlines from 2026 to 2028: every chag
on a weekday and on Shabbat, erev chag, Chol HaMoed, Yom HaAtzmaut's moves, the previous
working day, the diaspora's second days and a Monday–Friday week. Each Hebrew date is
checked against the browser's own Hebrew calendar (ICU) as well as Lumen's.

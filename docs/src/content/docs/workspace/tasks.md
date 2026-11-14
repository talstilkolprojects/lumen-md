---
title: Tasks across the vault
description: Checklist items with dates and priorities in any note, gathered by queries, a Today panel and reminders. Same syntax as the Obsidian Tasks plugin.
---

Any checklist item in any note is a task. Lumen reads the format of the
[Tasks plugin for Obsidian](https://publish.obsidian.md/tasks/) (MIT),
so notes written for it work unchanged.

```markdown
- [ ] Pay rent #home ⏫ 📅 2026-11-01
- [ ] Draft the report ⏳ 2026-10-27 🛫 2026-10-25
- [x] Book flights ✅ 2026-10-20
- [ ] Water the plants 🔁 every week 📅 2026-10-26
```

| Symbol | Meaning |
|---|---|
| 📅 | due date |
| ⏳ | scheduled date |
| 🛫 | start date |
| ➕ | created |
| ✅ / ❌ | done / cancelled date |
| 🔺 ⏫ 🔼 🔽 ⏬ | priority: highest … lowest |
| 🔁 | recurrence (kept as text) |
| 🆔 / ⛔ | task id / depends on |

Status characters: `[ ]` todo, `[x]` done, `[/]` in progress, `[-]` cancelled.

## Queries

A `tasks` code block lists matching tasks from the whole vault. Ticking
a box there updates the note it came from: only the checkbox and the `✅`
date change, the rest of the line stays exactly as you wrote it. If the note
changed since the list was shown, nothing is written and the block says so.
A recurring task is marked done; Lumen does not add its next occurrence (the
Obsidian plugin does). Only Markdown notes are read for tasks.

````markdown
```tasks
not done
due before in 7 days
tags include #home
sort by due
group by folder
limit 20
```
````

Supported instructions: `done`, `not done`; `due | scheduled | starts |
done | created | cancelled | happens` with `on`, `before`, `after`, `on or
before`, `on or after`, or `in <date> <date>`; `has/no … date`; `priority is
(above|below|not) <level>`; `description | path | folder | filename | heading |
tag` with `includes`, `does not include`, `regex matches /…/`; `tags include`;
`status.type is …`; `is recurring`; `is blocked`; `(a) OR (b)`, `(a) AND (b)`,
`NOT (a)`; `sort by … [reverse]`; `group by …`; `limit N`; `hide …`.
Dates can be `YYYY-MM-DD`, `today`, `tomorrow`, `yesterday`, `in 3 days`,
`2 weeks ago`, `next week`. An instruction Lumen doesn't understand is
shown as an error, never silently dropped.

## Today and upcoming

Command palette → **Tasks: Today and upcoming**. It shows overdue and today's
tasks, then the next 7 days.

## Reminders

In that panel, turn on **Reminders**. While Lumen is open, every task due or
scheduled today gives one notification per day: the browser's, or the
operating system's in the desktop app. Nothing leaves your device.

## Speed

The tasks are indexed with the rest of the vault in a background worker.
A query over 1,000 tasks takes under 100 ms (checked on every change).

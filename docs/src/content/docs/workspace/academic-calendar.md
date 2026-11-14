---
title: Israeli academic calendar
description: Semesters, Moed A and Moed B, breaks and make-up days of your institution in the daily note, and the year as an ICS file.
---

Every Israeli institution publishes its academic calendar as a different
PDF. Lumen keeps these dates as data, one file per institution and year,
each linked to the official document.

## Choose your institution

Choose **Academic calendar: choose an institution…** in the command palette
and pick the institution and year.

Then add `{{academic}}` to your daily-note template (Settings → Daily notes).
A new daily note gets a line such as:

> שבוע 6 בסמסטר א׳ · 23 יום למועד א׳

During a break the line names the break, a make-up day says so, and during
an exam period it says which one.

## Export to a calendar

**Export the academic calendar (ICS)** saves the year as an `.ics` file:
one all-day event for each semester, exam period, break and make-up day.
Import it into Google Calendar or Apple Calendar.

## Where the dates come from

The files are in `data/academic/<institution>/<year>.json`. Dates are facts,
so there is no copyright question, and each file links to the official
document. A file is used only after someone checked every field against
that document (`"verified": true`). Until then Lumen shows nothing from it.

To add or fix an institution, open a pull request with its file and the
link to its official calendar. `scripts/academic/check-calendar.mjs`
compares a file with a table typed from the document.

## What is not here yet

- The dates themselves. The institutions listed so far (Haifa, Tel Aviv,
  Bar-Ilan, Oranim) have a file with the link to the official document, but
  the dates still need to be copied and checked.
- Moving a deadline out of an academic break in the database views, and
  adding exam periods to a course in student mode. The calendar already
  computes both; the views don't call it yet.

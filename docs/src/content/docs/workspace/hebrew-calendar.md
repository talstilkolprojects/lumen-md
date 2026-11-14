---
title: Daily notes and the Hebrew calendar
description: The calendar's holidays, fasts and weekly Torah portion, for Israel or the diaspora, and the {{holiday}} and {{parasha}} placeholders of the daily note.
---

**Show / hide the calendar** (command palette) shows a month under the file tree. A day with a daily
note is marked; clicking a day opens its note, or creates it from your
template.

## Holidays and the Torah portion

The calendar knows the Jewish year: the festivals, the fasts, Rosh Chodesh,
the Israeli national days, and the Torah portion of every Shabbat.

- Days with a holiday or a fast have a mark on top. Hover a day, or reach
  it with a screen reader, for its civil date, its Hebrew date, its holidays
  and, on Shabbat, its portion.
- Under the grid, the month's holidays are listed by day.
- Names are in Hebrew when the UI is in Hebrew, and in English otherwise.

### Israel or the diaspora

The festivals have one day of yom tov in Israel and two in the diaspora, so
the two calendars differ: Simchat Torah, the eighth day of Pesach and the
second day of Shavuot are diaspora days only. When one of them falls on
Shabbat, Israel reads the next Torah portion that week, and the two
schedules realign a few weeks later, when the diaspora reads two portions
together and Israel reads them separately.

The **⚙ settings** of the calendar have a checkbox,
**Holidays and Torah portions as in Israel**. Until you change it, Lumen
picks Israel when the UI is in Hebrew or your time zone is Israel's.

### What is included

| | |
|---|---|
| Festivals | Rosh Hashana, Yom Kippur, Sukkot with Chol HaMoed and Hoshana Raba, Shemini Atzeret and Simchat Torah, Pesach with Chol HaMoed, Shavuot |
| Fasts | Tzom Gedaliah, 10 Tevet, Ta'anit Esther, Ta'anit Bechorot, 17 Tammuz, Tish'a B'Av |
| Other days | Chanukah, Tu BiShvat, Purim Katan, Purim, Shushan Purim, Pesach Sheni, Lag BaOmer, Tu B'Av, the eve of the festivals, Rosh Chodesh |
| Israeli days | Yom HaShoah, Yom HaZikaron, Yom HaAtzmaut, Yom Yerushalayim |

Fasts that fall on Shabbat move as they do in practice: Tzom Gedaliah,
17 Tammuz and Tish'a B'Av to Sunday, Ta'anit Esther and Ta'anit Bechorot to
Thursday. Yom HaShoah, Yom HaZikaron and Yom HaAtzmaut move as Israeli law
sets them, so that they never touch Shabbat.

## In the daily note

Two placeholders join `{{date}}`, `{{hebrewDate}}`, `{{weekday}}` and
`{{title}}` in the daily-note template:

| Placeholder | Becomes |
|---|---|
| `{{holiday}}` | the day's holidays, separated by `·`, or nothing |
| `{{parasha}}` | this week's Torah portion (the Shabbat on or after the day), or the festival read instead |

For example, the template

```markdown
# {{title}}

{{hebrewDate}} · {{parasha}} {{holiday}}
```

gives, on Friday 16 May 2025 in Israel, a line with the Hebrew date,
`Emor` and `Lag BaOmer` (in a Hebrew UI: `פרשת אמור` and `ל״ג בעומר`).

## How it is computed

The calendar is Lumen's own code: the fixed Hebrew calendar (the molad and
the four postponements of Rosh Hashana), the holiday rules, and the rules
for which Torah portions are read together, from the Shulchan Aruch. No
calendar library is used; the common one is under the GPL, which Lumen
does not ship. A whole year — holidays and every Shabbat, for Israel and
for the diaspora — is computed in a few milliseconds, in your browser.

The tests check the arithmetic against the browser's own Hebrew calendar on
every day from 1990 to 2060, and every holiday rule against a hand-checked
table of the years 2025–2030.


## Your morning

`⌘K` → **Daily note: “Your morning”** adds a block to today's note, and from
then on writes it each morning when you open today's note. It is off until
you run it, and `⌘K` → **Daily note: turn off “Your morning”** stops it.

The block has:

- the Hebrew date, this week's parasha and today's holidays;
- the notes changed since the last morning, newest first (daily notes are
  left out);
- the open tasks due today or earlier. Due dates can be written as
  `📅 2026-11-12` (Tasks), `[due:: 2026-11-12]` (Dataview) or
  `@due(2026-11-12)`;
- how many review cards are waiting, with the first few.

Every row links to its note or card.

Everything comes from this device: the vault index that search keeps in
memory, `.lumen/review.json` and the Hebrew calendar. Nothing is sent
anywhere. On a 10,000-note vault the block takes a few milliseconds, once
the index is built.

The block sits between `<!-- lumen:morning:start -->` and
`<!-- lumen:morning:end -->`. Writing it again replaces only that part, so
your own text in the note stays as it is. While today's note is open with
edits, the block is written into the editor instead of the file.

---
title: Usage on this device
description: Lumen counts starts, commands and errors on your device only. The weekly report is off until you turn it on, and you send it yourself. Nothing leaves without your click.
---

Lumen has no analytics and no tracking. To know whether the app is used and
what breaks, it keeps a few **counters on your device**. They never leave
it unless you send them yourself.

## What is counted

Per day, in the browser's local storage (`lumen.usage.v1`):

| Counter | What it holds |
|---|---|
| Starts | how many times the app opened |
| Commands | how many times each command ran, by its id from the app's code (`file.exportHtml`, `help.feedback` …) |
| Errors | how many uncaught errors happened: one number, no message, no stack, no file |

The counters hold no note text, no file names, no user or device id and no
time of day. A counter name has to look like a command id: no spaces, no
slashes, no runs of digits or capitals. Anything you typed can't become one.
Commands named after something in your vault are counted under one fixed
name each: every installed template as `template.apply`, every recent file
as `recent.open`, every plugin command as `plugin.command`. So a template
called after a source never shows its name.
The last 60 days are kept.

## The dashboard

**Help: Usage on this device** in the command palette shows:

- the day you started using Lumen
- how many of the last 7 and 30 days you used it
- whether you came back after a week and after a month
- the most used commands, and how many commands went unused for 30 days

There you can turn counting off, which also clears the counts, or clear them
at any time.

## The weekly report: only when you send it

The dialog shows the whole report as JSON, exactly as it would be sent. It
holds counts only: the app version, the week, days used, retention, starts,
errors, the 20 most used commands of the app, and the number of unused ones.

- **Open on GitHub** opens a new tab with a GitHub issue form that has the
  report in it. Nothing is sent until you submit that form yourself. The
  click is listed in the [privacy ledger](/ai/privacy/) with its size.
- **Copy** puts the JSON on the clipboard.
- **Remind me once a week** is off by default. When you turn it on, a
  notice appears once a week with a button that opens the dialog. The notice
  sends nothing.

Without one of these clicks, Lumen makes no request for usage. The tests
check this (`src/__tests__/usageMetrics.test.ts`): counting, errors, the
dashboard and the report make 0 requests and add 0 ledger entries. A report
built after secrets were planted in the vault's storage contains none of
them.

## Activation and time to first value

To know whether a first visit works, Lumen also keeps a few marks of its own
on your device (`lumen.activation.v1`, plan W11.P4):

| Mark | What it holds |
|---|---|
| First run | the day setup first opened |
| Editor ready | how long the last 20 starts took from opening to an editable cursor (TTFV-1), in ms |
| First note of your own | the day it was saved, and how long after setup opened when that was in the same session (TTFV-2) |
| Import | the first day an import finished with at least one note, and how many have |
| Second day | the first later day Lumen opened |

Only days, yes/no facts and durations: no time of day, no note names, no
text. You count as *activated* after a note of your own or an import, plus a
return on another day within 7 days of the first run. Turning counting off
clears these marks too.

If you joined the beta and send the weekly beta report, it carries only the
summary: activated or not, the mean TTFV-1 (rounded to 100 ms), TTFV-2
(rounded to the second), and the yes/no facts. Never the individual starts.
The tests check this (`src/__tests__/activationTtfv.test.ts`): the marks and
the report make 0 requests and add 0 ledger entries.

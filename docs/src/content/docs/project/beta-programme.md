---
title: The beta programme
description: Join the beta from inside Lumen, send feedback as a prefilled GitHub issue, and — only if you ask — a weekly report of counts. Nothing leaves without your click.
---

The beta programme gives you new features first, and gives the project
what it needs most: people who write in Hebrew using Lumen for real.

## Join from the app

Command palette → **Help: Beta programme**, then tick **Join the beta on
this device**. Joining does three things, all on this device:

- **Beta features on.** Every feature still in beta is turned on here, as
  if you had switched each one on in **Feature flags…**.
- **Beta updates (desktop app).** The update channel becomes *beta*, so the
  app installs beta releases too. It reads the release pipeline's
  `beta-channel` pointer on GitHub Releases. The web beta is a separate site;
  see [Beta channel and feature flags](/getting-started/beta/).
- **The day you joined** is kept, to number your weeks in the beta.

Untick the box to leave. The flags go back to the build's default and
updates follow stable releases again. The app never installs an older
version, so you keep the current one until a stable release passes it.

## Feedback

The same panel has a short form: what kind (*something is broken*, *an
idea*, *a question*), which part of the app, a title and the text.
**Open feedback on GitHub** opens a new tab with a GitHub issue filled in
and labelled `beta-feedback`. Nothing is sent until you submit it there.
Lumen has no feedback server.

If the text is too long for a link, it is copied for you to paste into
the issue. Whether the app version, platform and language go in is your
choice.

## The weekly report (a second opt-in)

Tick **Once a week, prepare a usage report I can send**. It is off by
default and only offered to testers who joined. Once a week a reminder
appears, and the panel shows the whole report before anything leaves.

What is in it is the [usage report](/security/usage-metrics/), counts only,
plus three fields:

| Field | Meaning |
|---|---|
| `cohort` | The Monday of the week you joined |
| `weeksInBeta` | Whole weeks since you joined |
| `channel` | `beta` or `stable` (the update channel) |

Days used, starts, errors and the app's own command names. No notes,
names, ids or time of day. **Open report on GitHub** opens an issue
labelled `beta-report` with the report as JSON. **Copy report** puts the
same text on the clipboard. Either way is recorded in the privacy log.

## How the reports are read

The project reads only the reports testers chose to send. The script
`npm run beta:funnel` reads the `beta-report` issues, or a folder of saved
reports, and counts the funnel:

- **Joined:** cohorts seen in any report.
- **Reported:** sent at least one report.
- **Active:** used Lumen on 3 or more of the 7 days, in some week.
- **Active 7 days:** used Lumen on all 7 days of a week.
- **Retained:** came back after a week (`retained7`).

A tester who never sends a report is not counted. That is the price of
not tracking anyone.

## The unmoderated usability tests

Twelve self-guided sessions run in Lumen's own test mode (Command palette
→ **Usability test (self-guided)…**, from the unmoderated round, #487),
with the tasks and the SUS questionnaire in Hebrew. The protocol is in
`research/usability/` in the repository. The tester sends the results by
hand, as with the reports, and `scripts/usability-analyze.mjs` reads them.
The beta funnel and the usability analysis are separate: neither joins the
other's data.

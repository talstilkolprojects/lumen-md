---
title: Calendar sync (CalDAV and ICS)
description: Keep the vault's dated tasks in sync with a CalDAV calendar (Fastmail, Nextcloud, iCloud), and see subscribed calendars' events in the daily note.
---

:::note[Status]
The sync engine and the daily-note block are in place and tested. The
Settings screen for connecting an account and the conflict dialog come in
the next release, together with native requests in the desktop app.
:::

## Tasks, both ways

Tasks with a date (`📅` due or `⏳` scheduled) sync with one CalDAV task
calendar as VTODOs. An edit on either side reaches the other: create, edit
the text or the date, mark done, delete. Tasks made on the server (on an
iPhone, in Thunderbird, in Nextcloud) are added to the inbox note,
`Tasks/Calendar.md` by default.

Each synced task carries a hidden id at the end of its line:

```markdown
- [ ] Send the report 📅 2026-11-20 <!-- lumen-caldav:lumen-7f3a -->
```

Other Markdown readers don't show it. Don't remove it: without it the task is
new to the calendar.

### When both sides changed

Each sync compares both sides with what they agreed on last time. If only one
side changed, its version wins. If both changed the same task, or one side
deleted a task the other edited, Lumen shows both versions and you choose
(in the conflict dialog):
keep this device's, keep the server's, or keep both. Nothing is overwritten
without asking.

## Subscriptions in the daily note

Add a calendar's ICS address (a "secret address" or a `webcal://` link) and
that day's events appear in each daily note, in a block between
`<!-- lumen-calendar:start -->` and `<!-- lumen-calendar:end -->`. The block
is read-only and is replaced on refresh. The rest of the note is never
touched. Recurring events, multi-day events and moved instances are handled.

## Privacy

- The password and the subscription addresses are kept only in the secret
  store, never in settings, files or logs. A private ICS address is itself a
  key.
- Every request appears in the privacy ledger as "CalDAV task sync" or
  "Calendar subscription".

## Desktop and web

In the web app, the server must allow this app's origin (CORS). If it
doesn't, Lumen says so instead of failing silently. The desktop app will send the
requests itself, so CORS won't apply there.

## Tested

200 random changes on both sides against a local Radicale server, with
conflicts answered at random, lost 0 tasks and duplicated 0. Create, done and
delete each reached the other side in one sync, in under half a second.

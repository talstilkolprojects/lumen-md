---
title: Testing with screen reader users
description: The kit for sessions with three Hebrew screen reader users — who to ask, the invitation, consent, the tasks, how a session is scored, and what happens to each barrier.
---

axe and the scripted readers find only part of what blocks people. Israeli
Standard 5568 is about real use, so before a release the
[screen reader protocol](/editor/screen-reader-protocol/) is also done by
**three people who use a screen reader every day, in Hebrew**. This page is
the kit for those sessions. The project owner recruits and runs them.

## Who

Three participants, one per setup, so every common reader is covered:

| Participant | Screen reader | System |
|---|---|---|
| 1 | NVDA (or JAWS) | Windows, Chrome or Firefox |
| 2 | VoiceOver | macOS or iPhone, Safari |
| 3 | TalkBack | Android, Chrome |

Each one uses the screen reader daily for at least a year and reads Hebrew
with it. No experience with Lumen or with Markdown is needed: the session
explains the four Markdown marks it uses.

## Organisations to ask

These Israeli organisations work with blind and low-vision people and with
digital accessibility. Ask them to pass the invitation on. Don't ask them
for anyone's contact details.

- **Migdal Or** (מגדלור), rehabilitation centre for the blind. It runs a
  national technology helpline staffed by blind and low-vision specialists,
  and accessibility checks for employers.
- **The Center for the Blind in Israel** (המרכז לעיוור בישראל).
- **Access Israel** (נגישות ישראל), aisrael.org. It runs usability testing
  with people with disabilities.
- **The Central Library for the Blind, Visually Impaired and Handicapped**,
  clfb.org.il. Its readers are experienced screen reader users.

## Compensation

A token payment, a gift card of 150–250 ₪ for a session of about an hour,
or a donation in the participant's name to one of the organisations above.
Volunteering is also fine if the participant prefers it. Say which in the
invitation.

## The invitation

> Lumen is a free, open-source note editor that works in Hebrew and runs on
> your own device. We're looking for three people who use NVDA, JAWS,
> VoiceOver or TalkBack every day, in Hebrew, for a one-hour session (online
> or in person). You'll do ten everyday tasks, like writing a note,
> finding one and changing a setting, while thinking aloud. We're testing
> the app, not you. Every barrier you hit will be fixed before the next
> release. [Payment: gift card of ___ ₪ / donation / volunteer.] Reply to
> ___ to take part.

## Consent

Before the session, read this to the participant and note their answer:

- Taking part is voluntary. They can stop at any time without giving a
  reason, and still receive the payment.
- With their permission, the screen and the screen reader's speech are
  recorded. The recording is used only to fix barriers and is deleted
  within 90 days. Without permission, only written notes are kept.
- Their name is not published. The results table shows the setup only.

## The session

Use the 14 steps of the [screen reader protocol](/editor/screen-reader-protocol/).
Pick the 10 everyday ones: steps 1–9 and 14. Give each task in words, not
key names. Example: "Write a note called תוכנית with a heading and one task".
Then wait.

For each task, write down:

- **done** (alone), **done with a hint**, or **not done** (a **blocker**)
- what the participant expected and what the reader said instead

A session passes when the participant completes **8 or more of the 10**
tasks unaided. The goal for the release is **3 sessions passed, and every
blocker fixed**.

## After the session

1. Open one [accessibility report](https://github.com/talstilkol/lumen-md/issues/new?template=accessibility.yml)
   per blocker, with the setup, the task and what the reader said.
2. Add a row to the protocol's results table: date, version, setup
   (people), tasks passed, the blockers with their issue links.
3. When a blocker's fix ships, ask the participant, if they agree, to
   check that task again.

## Accessibility statement

The [accessibility statement](/editor/accessibility-statement/) is the
document regulation 35 of the Equal Rights for Persons with Disabilities
(service accessibility adjustments) regulations, 2013 asks for. It must
name the standard (IS 5568, which adopts WCAG 2.0 AA), say what is
accessible and what is not yet, give a way to report a barrier and the
accessibility coordinator, and show when it was last reviewed. Update the
statement after each round of sessions. Part 2 of IS 5568 (September 2023)
covers documents people download, such as Word and PDF files. It applies
to the files Lumen exports. Check an export against it when its format
changes.

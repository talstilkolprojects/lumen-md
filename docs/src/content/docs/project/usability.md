---
title: Usability tests with Hebrew speakers
description: How Lumen is tested with people who write in Hebrew — the ten tasks, SUS, the consent-first session recorder that keeps no note text, and the analysis.
---

The project measures a lot, and sessions with real people measure what
nothing else does: whether someone who writes in Hebrew can do the common
things without help. The kit is in
[`research/usability/`](https://github.com/talstilkol/lumen-md/tree/main/research/usability)
and everything in it is in Hebrew, the participants' language.

## The study

- **Who:** 8 participants per round, at least 5: two students, two
  researchers, two writers and two developers. All work in Hebrew and are new
  to Lumen.
- **What:** ten tasks, one at a time, thinking aloud, with no help from the
  moderator:
  1. a new note;
  2. a checklist;
  3. linking notes;
  4. search;
  5. tags;
  6. Hebrew and English on one line;
  7. a table;
  8. export to PDF;
  9. restoring from the trash;
  10. the daily note.
- **Measured:**
  - success, success without help, and time, per task;
  - the ease question (SEQ, 1–7) after each task;
  - the System Usability Scale (SUS, 0–100) at the end.
- **Rounds:** the ten most severe issues from round 1 become plan tasks.
  Round 2, with new participants, checks the fixes. The goal is a mean SUS
  of at least 80, at least 90% unaided success, and all ten severe issues
  closed. The study is repeated before every major release.

## Take the test on your own

You can help without a meeting. The session takes about 30 minutes, on your own.

1. Open lumen-md.vercel.app in a **private window**.
2. Open the command palette (Ctrl+K, or ⌘K on a Mac) and choose **Usability test (self-guided)…**.
3. Read what is recorded and agree.

What happens then:

- Lumen gives you a random code such as `U-7K3F`, never your name.
- It adds a few practice notes to a folder named `בדיקת שימושיות`.
- It shows ten short tasks one at a time. You press **Done** or **I couldn't do it**, then rate how easy the task was.
- At the end come ten short statements about Lumen.

Where a task's result can be seen in the practice notes, Lumen checks it on
your device and keeps only **yes or no**, never the text.

At the end you save one `.zip` file and send it through the link in your
invitation. Then press **Delete my session data**. Nothing is sent until you
send the file yourself.

## The session recorder

Command palette → **Usability study (moderator)…** opens the moderator's
panel. It is off until then, and it records nothing until the participant
has signed the consent form and the moderator ticks the box.

| Recorded | Never recorded |
|---|---|
| when each task started and ended, and its outcome | anything typed into notes, note or file names |
| controls clicked, by role and by the app's own label | a label that isn't one of the app's UI strings (it becomes `[label]`) |
| commands run, by id | the participant's name (a code: P1, P2, …) |
| how many keys were pressed, and modifier shortcuts | which characters were typed |
| the SEQ and SUS answers, and the moderator's observation codes | free-text notes (the moderator keeps those on paper) |

- **Local:** the data stays in the browser and leaves only as the JSON file
  the moderator saves. The recorder makes no request.
- **Deletion:** *Delete session data* removes it, and anything left on the
  device is deleted after 30 days. The consent form promises that session
  files are deleted once the round's analysis is written.

## The analysis

`node scripts/usability-analyze.mjs <folder> --round 1` turns a round's
session files into a report:

- per task: success, success without help, median time, SEQ, errors and
  help opened;
- SUS per participant, and the mean with a 95% confidence interval.

With `--round 2 --findings …` it also checks the plan's acceptance criteria
against the findings file. With 5–8 people the numbers show a direction,
not statistical significance.

The Hebrew SUS wording is the study's own translation, not a validated one.
It compares rounds with each other; comparisons with published SUS norms
are approximate.

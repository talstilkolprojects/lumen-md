---
title: Meeting notes on this device
description: Record a meeting, transcribe it on this device, and get its decisions, tasks with owner and date, and open questions — tasks in the task panel, dates in a calendar file.
---

`⌘K → "🎙 Meeting notes (record on this device)"` records a meeting; when
you stop, Whisper transcribes it **on this device** (as the voice memo
does) and the `meeting-writer` agent turns the transcript into notes. For a
transcript you already have, use `⌘K → "AI: Meeting Notes from a
Transcript"` on the note (or a selection).

## What you get

```markdown
## Meeting · 2026-11-09 · 🛡 local

### Decisions
- Ship on Tuesday

### Tasks
- [ ] Send the budget (@Avi) 📅 2026-11-18
- [ ] Find out who pays for the venue

### Open questions
- Who pays for the venue?
```

- **Tasks** are checkbox lines in the [tasks format](/workspace/tasks/)
  (`📅` for the due date), so they appear in the task panel's *Today* /
  *Upcoming* and in `tasks` blocks once the note is saved. The owner is kept
  in the text as `@name`.
- **Dates** the meeting mentions ("next Wednesday") are worked out from the
  meeting's day; a date that isn't a real `YYYY-MM-DD` date is sent back to
  the model once, and an owner or date nobody said is never added.
- **Calendar.** When tasks have dates, Lumen offers to save them as an
  `.ics` file (one to-do per task, due on its date) for any calendar app.
- The transcript stays below the notes, folded.

The agent runs through the agent runtime: under the *local only* policy on
a local model (Ollama or the in-browser model).

## Measuring it

`npm run eval:meetings` reads the owner's golden meetings (plan 7.10
`meetings`, 15.11 — never committed) from `LUMEN_EVAL_MEETINGS_DIR` and
reports the share of each meeting's reference action items the notes found
(target: ≥ 90 %).

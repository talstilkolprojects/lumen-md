---
title: Automations (when… then…)
description: Simple rules that file, tag and log your notes on this device — with a dry run that changes nothing, a log of every run, and undo.
---

An automation is a rule: **when** something happens to a note, **then**
Lumen does something. Rules run on this device only; nothing is sent
anywhere.

| When… | Then… |
|---|---|
| a note is created (anywhere, or in a folder) | move it to a folder |
| a tag is added (in the frontmatter or as `#tag`) | add a tag |
| a property changes (to any value, or to one value) | apply a template (its text, and frontmatter keys the note does not have) |
| every day (once a day) | add a line to today's daily note (`{{link}}`, `{{title}}`, `{{date}}`) |

## Make a rule

Command palette → **Automations: new rule (when… then…)…**: pick the
trigger, then the action, and answer one question for each (the folder,
the tag, the property…). The rules are kept in `.lumen/automations.json`
in the vault, which you can also edit by hand.

## Dry run

**Automations: dry run on this note** shows what the rules would do to the
open note as if it had just been created — which rules, which files —
without writing anything.

## Undo

Every run is logged in `.lumen/automations-log.json` with the text of each
file before and after. **Automations: undo the last run** puts every file
back byte for byte, and moves moved notes back. When a file was edited by
hand after the run, undo stops and says which file, instead of overwriting
your edit.

## No loops

A rule's own changes can trigger other rules (tag → move → the move's
"created in Done" → tag), but a rule runs at most once per note in one
chain, and a chain stops after three steps. Two rules that would bounce a
note between folders forever stop after one round. A line added to the
daily note triggers nothing.

## How it was checked

`src/__tests__/automations.test.ts`: 20 golden rules, each run on a small
vault: the dry run writes nothing, the run gives exactly the expected
files, and undo gives back every byte; plus the loop guard, undo refusing
over a later edit, tags, the rules file and once-a-day.

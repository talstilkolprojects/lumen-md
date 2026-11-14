---
title: Issue triage
description: How new GitHub issues are labelled, checked for duplicates and linked to the plan within 24 hours.
---

Every new issue on [talstilkol/lumen-md](https://github.com/talstilkol/lumen-md/issues)
is looked at by a script within 24 hours, and a person reads it as well. The
script is `scripts/issue-triage.mjs`; the workflow `.github/workflows/issue-triage.yml`
runs it when an issue is opened or reopened and once a day at 06:23 UTC.

## What an issue gets

| What | When | Label |
|---|---|---|
| Kind | from words in the title and body (English and Hebrew) | `bug`, `enhancement`, `question` or `documentation` |
| Area | up to two, the ones whose words appear most | `area:editor`, `area:hebrew`, `area:ai`, `area:storage`, … |
| Possible duplicate | another issue, open or closed, has a near-identical title | `duplicate?` |
| Reproduction request | a bug with no steps, browser or version | `needs-repro` |
| Plan task | a task number in the text (for example `4.5`), else the plan task whose title shares the most words | — (in the comment) |
| Done | always | `triaged` |

When there is something to say (a possible duplicate, missing steps, a plan
task) the script leaves **one** comment, in English and Hebrew. It finds its
own comment again by a hidden marker, so a rerun never comments twice. Labels
that do not exist yet are created.

## What it does not do

- It never closes, assigns or edits an issue, and never removes a label.
- Issue text is only matched against word lists: it is not executed and not
  sent anywhere. The script talks to GitHub's REST API through `gh` with the
  workflow's own token (`issues: write`) and nothing else.

## The daily report

The daily run writes a report — the issues of the last 24 hours with the labels,
duplicate and plan task each got — to the job summary and as the artifact
`reports-issue-triage`. Any open issue older than 24 hours that still has no
`triaged` label is listed and **fails the run**, so the 24-hour promise is
checked every day.

## Running it yourself

```bash
node scripts/issue-triage.mjs                 # dry run: prints what it would do
node scripts/issue-triage.mjs --apply         # writes labels and comments
node scripts/issue-triage.mjs --json out.json # the report as JSON too
```

A dry run needs only a logged-in `gh`; `--apply` needs write access to issues.

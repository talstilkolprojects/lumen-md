---
title: Budgets that only go down
description: The bundle budgets and the performance gate's FCP and LCP limits are lowered after every train to what the train measured plus 2 %, and never raised. Exceptions carry an expiry date and fail once it has passed.
---

Lumen's size and speed limits only move one way: down (plan W6.26).
A budget that stays put after a saving invites the next growth.

## Where the limits live

| File | What it limits | Enforced by |
|---|---|---|
| `scripts/bundle-budgets.json` | Each chunk class (KB gzipped, per file) and the startup total | `npm run budget` |
| `perf-gate.config.json` | FCP and LCP of each profile, and the other metrics | `npm run perf:gate` |
| `lighthouserc.json` | Lighthouse scores and metrics, desktop | `npm run lighthouse` |
| `lighthouserc.mobile.json` | Lighthouse scores and metrics, phone | `npm run lighthouse` |

The first rule in `bundle-budgets.json` whose pattern matches a file
name sets that file's budget, so narrower patterns come first.

## After each train: the ratchet

The train's Vercel build runs the budget gate, which writes the
receipt `reports/bundle-sizes.json` and prints it as one
`bundle-sizes: {…}` line in the build log. Feed either one to the ratchet:

```bash
npm run budget:ratchet -- --sizes reports/bundle-sizes.json --train train-3 --sha <head>
npm run budget:ratchet -- --sizes-log vercel-build.log --perf perf-gate.json --first-party startup.log --write
```

- Each budget becomes the biggest measured file of its class plus 2 %
  (at least 1 KB), rounded up to a whole KB, but only when that is
  lower than the budget today. The startup total works the same way.
- With `--perf` (the JSON of `npm run perf:gate -- --json`), the FCP
  and LCP limits (`error` and `warn`) become the median run plus 2 %
  (at least 50 ms), when that is lower. Targets don't change.
- `--first-party` takes the log of the offline startup measure
  (`startup first-party: … KB gz`) and records it in the history,
  since the Vite build can't tell our own code from package code.
- Without `--write` it only prints what would go down. With `--write`
  it updates the files and appends a line to `history` in
  `bundle-budgets.json`. Commit that as its own commit.

## Exceptions expire

A rule with `expires` (YYYY-MM-DD) is an exception, and it must also
name the `task` that removes it. Today there is one: the Excalidraw
core module at 740 KB, until 2027-01-15, removed by W1.36. From the day
after its date, `npm run budget` fails until the rule is lowered or
decided again with a new date, and pr:check fails a later date.
To check a build on another day, set `LUMEN_TODAY=YYYY-MM-DD`.

## No raise gets in

- `npm run pr:check` fails a diff that loosens any of the three files.
  It compares the budget each chunk name gets before and after, so a
  raised number, a new rule wider than the one its files fell under, a
  removed rule whose files fall to a bigger one and a reordering all
  count. So do a later or dropped expiry date, a wider margin, a
  performance limit raised, removed or turned from `error` into `warn`,
  fewer runs, and a lower Lighthouse level or score. A budget number
  written into `scripts/bundle-budget.mjs` itself fails too.
- `npm run budget:history` checks every commit of the three files since
  the ratchet began and names any commit that raised a limit. Pass
  `-- --since all` to see the whole history, including the decisions
  made before the ratchet.

When a budget fails, split the chunk or load it lazily. The budget
doesn't move up.

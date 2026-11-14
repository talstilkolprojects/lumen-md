---
title: Skipped tests
description: Every skipped test says why, for which task and until when; npm run hygiene fails on one that does not, and npm run skips lists them all.
---

A skipped test looks like coverage but checks nothing. So every call that
skips or defers a test — `test.skip`, `it.skip`, `describe.skip`,
`*.skipIf`, `*.runIf`, `*.fixme`, `*.todo`, in `src/` (Vitest) and `e2e/`
(Playwright) — carries one structured comment, on its line or right above:

```ts
// skip-reason: <why it cannot run here> | task: <plan id or #PR> | until: YYYY-MM-DD
test.skip(dev, "the service worker runs on the production build only");
```

`npm run hygiene` (and so the Vercel preview build) fails when:

- a skip has no `skip-reason`, or it lacks the task or the date;
- the date has passed (fix the test, or justify it again with a new date) or
  is more than a year away;
- `e2e/` holds more than 15 skip calls.

## An engine gap goes through one helper

Playwright's WebKit on Linux has no Origin Private File System, so the vault
tests cannot run there. They call `vaultOrSkip(written, browserName)` from
`e2e/_opfs.ts` after seeding the vault: it skips on WebKit only, and **fails**
on Chromium and Firefox, where a vault that cannot be written is a bug — until
plan W4.12 those tests skipped quietly on every engine.

## The report

`npm run skips` prints every skip with its reason, task and date, sorted by
what it leaves out:

| Kind | Meaning |
| --- | --- |
| engine | the flow runs on the other engines |
| setup | the flow runs only in a special setup (production build, dev server, a model or service on the machine, an opt-in measurement) |
| deferred | a `todo`: written down, checks nothing yet |

It ends with the list of vault flows WebKit does not run. `npm run skips --
--json` gives the same as JSON.

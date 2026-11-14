---
title: Every PR on the train head
description: A pull request is based on the current train or on main, never on another PR's branch. pr:check warns about a stacked base and about drift, and fails an old merge base or a criss-cross. scripts/restack.mjs prints how to move a stacked PR onto the train.
---

Lumen used to stack pull requests: each PR's base was the branch of the
PR below it. By November 2026, 322 of 330 open PRs were stacked, on 175
different bases, up to 58 deep. That cost doubled histories (one branch
carried 1,398 commits of a replaced history), criss-cross merges and
about 50 hand resolutions in train 2. From now on (plan W6.22):

- **The base is the train head or `main`.** The current train is the
  highest-numbered `verify/train-N` branch on the remote
  (`verify/train-2` today). Not a `feat/*` branch, and not an older train.
- **Stay close to it.** Before the train, merge the train head into the
  branch, or restack it.
- **Stay young.** A branch whose merge base with its base is more than
  7 days old is out of date. Bring it up to date or close it.
- **The stack is at most one deep.** If your work needs another PR's
  code, wait for that PR to land in the train, then base yours on the
  train.

## What pr:check says

`npm run pr:check -- --base origin/<base>` has a section **Based on the
train head**:

| Finding | Result |
|---|---|
| The base is the current train or `main` | ok |
| The base is anything else (a stacked PR) | warning, with the restack command |
| The branch is behind its base (the train head, when stacked) | warning, with the count |
| The merge base is more than 7 days old (`--max-age-days`) | **fails** |
| More than one merge base (criss-cross) | **fails** |

`--train <branch>` names the train when the highest `verify/train-N`
isn't the one, for example while the next train is being built.

## Moving a stacked PR: scripts/restack.mjs

```bash
node scripts/restack.mjs --branch feat/my-thing --base feat/the-base
node scripts/restack.mjs --pr 412
node scripts/restack.mjs --all            # every open PR not on the train or main, parents first
```

It is a dry run. It reads git and GitHub and changes nothing. For each
PR it prints one of:

- **→ the commands.** It replays only the branch's own commits
  (`base..branch`) onto the train head, into a new branch
  `restack/<branch>`, then runs pr:check and pushes. Commits the train
  already has by patch are skipped. Merge commits are kept with
  `--rebase-merges`. Nothing is force-pushed and no PR's base changes:
  open a new PR from `restack/<branch>` that says "Supersedes #N".
- **✗ blocked.** The old base's own work isn't in the train yet, so the
  branch would lose code it builds on. Restack the base first, or wait
  for it to land in the train.
- **✓ nothing to do.** The PR is already on the train or `main`.
- **? not fetched.** Run it again with `--fetch`, or fetch the branches
  it names.

Run `--all` once a week, after the weekly train is cut, so that every PR
still open moves onto the new train.

A shallow clone can't find merge bases: deepen it first
(`git fetch --deepen=500 origin <branch>`).

## Measuring the rule: scripts/stack-limit.mjs

pr:check judges one PR. `npm run stack:limit` measures the rule over
every open PR, against the plan's targets:

- **New PRs on `main` or a train: 100%.** "New" means opened since the
  rule started (12 November 2026; `--since` picks another day). Any
  `verify/train-N` counts here, not only the current one.
- **Stack depth at most 1.** A PR on `main` or a train has depth 1. A PR
  on another PR is one deeper than that PR. A PR on a branch that has no
  PR of its own (such as `chore/dod`) has depth 2. Each PR over the limit
  is listed with its stack, bottom first, and the `restack.mjs --pr`
  command that moves it.
- **`--drift`** also holds each new PR to pr:check's drift rules against
  the current train: behind it warns, and a merge base older than 7 days
  or a criss-cross fails. The PR's head must be fetched (`--fetch`).

Older PRs are counted but not judged: the report prints their deepest
stack, so the weekly `restack.mjs --all` can be seen to bring it down.
The script only reads (git, GitHub REST). It exits 1 when a new PR breaks
the rule. On 14 November 2026: 450 open PRs, 185 of them new, 108 of
those (58%) on `main` or a train, and the deepest new stack 59.

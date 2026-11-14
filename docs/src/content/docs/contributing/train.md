---
title: The weekly train
description: How Lumen's integration trains are built, checked and promoted, every week. npm run train:build merges the PRs and resolves what it can, npm run train:status shows the ledger and the gates, and main moves at least once a week.
---

A train is an integration branch, `verify/train-N`. It starts from the
previous train's head and merges the PRs that are ready, in ascending
PR number. Vercel builds it with every gate, and once those pass, `main`
moves to it. Trains 1 and 2 were built by hand. Train 2 had 110 PRs,
and `main` didn't move for 26 days. From train 3 on (plan W6.42), the
procedure is scripted, and the train is small and weekly.

## The rules

- **At most 15 PRs per weekly train.** A catch-up train (train 3, with
  31) says so with `--max`.
- **Every PR is based on the train head** (see
  [Every PR on the train head](/contributing/train-base/)), so it merges
  without stacking.
- **At most 10 hand resolutions per train.** The ledger counts them.
- **Push the train once** when it is complete. Allow at most one fix
  push: Vercel Hobby allows 100 deployments a day.
- Every commit subject has `[skip ci]`. PR #109 (the old domain) is
  never merged. Only Tal merges into `main`.

## The week

| When (Israel time) | What | Command |
|---|---|---|
| Sunday | Cut the train: status, then build | `npm run train:status`, `npm run train:build -- --train verify/train-N --onto origin/verify/train-<N-1> --from-api` |
| Sunday | Push it once. Open the train PR `verify/train-N → verify/train-<N-1>` | `git push -u origin verify/train-N` |
| Monday–Tuesday | Read the Vercel result (build, budget, vitest, e2e, i18n, hygiene, docs, licences, secrets). Fix in at most one push. Run the nightly receipt on the head and the data drill | `npm run nightly -- --commit` |
| Wednesday | Lower the budgets to what the train measured (the budget ratchet, plan W6.26). Restack every PR still open onto the new train (plan W6.22) | `node scripts/budget-ratchet.mjs --sizes-log <build log> --write`, `node scripts/restack.mjs --all` |
| Thursday | Tal promotes `main` to the train when `train:status` shows every gate ✓ | — |

When a gate is still red on Thursday, the PR that breaks it leaves the
train. Rebuild the train without it (`--exclude <n>`), and it goes into
next week's train. `main` doesn't wait for one PR.

## npm run train:build

```bash
npm run train:build -- --train verify/train-3 --onto origin/verify/train-2 --prs 464-494 --max 31
npm run train:build -- --train verify/train-4 --onto origin/verify/train-3 --from-api
npm run train:build -- --continue
```

Run it in a worktree of its own. It switches to `--train`, creating it
at `--onto` if needed. Then it merges each PR with `git merge --no-ff`
and the subject `Merge #N branch [skip ci]`, skipping the ones already
in. `--prs` takes numbers and ranges, `--list` a file of "number branch"
lines, and `--from-api` every open PR whose base is the previous train
or `main`, oldest first. `--dry-run` prints the queue only. It never
pushes.

On a conflict it runs the resolver (`scripts/train/resolve.mjs`):

| File | Resolution |
|---|---|
| `i18n/keys.json` | Regenerated from the merged sources |
| Theirs' change already in ours | Ours |
| `eval/baseline/*` | Theirs |
| `*.json` | A 3-way merge per key; arrays as a union |
| Named imports on both sides | Merged per module; a removal stays removed |
| Both sides only added lines | Ours, then theirs, with the shared closing lines put back where the parser needs them |
| Both sides changed the same lines | Theirs' hunks ported onto ours (`scripts/train/port.mjs`), also into a file ours moved the code to |
| Anything else | **MANUAL**: left with diff3 markers |

Then it runs `scripts/train/check.mjs` on the TypeScript the merge
touched. That check finds parse errors, a function declared twice by a
union, unused imports, a named import a module doesn't export, and a
name declared nowhere. When the resolver or the check needs a person,
the merge stays in progress and the MANUAL lines say which files.
Resolve them by meaning (read both sides, keep both behaviours;
`git checkout --conflict=diff3 <file>` restores the markers), `git add`
them, and run `--continue`.

Each merge commit ends with a trailer, `Train-Resolution: clean`, `auto`
or `manual`, with the files. That is the ledger.

## npm run train:status

```bash
npm run train:status
npm run train:status -- --train verify/train-3 --no-api
```

It reports the current train (the highest `verify/train-N`): its head,
its age and how far it is ahead of `main`. It reports the ledger since
the previous train (clean, by the resolver, by hand; target ≤ 10 by
hand) and when `main` last moved (target: within 7 days), with the next
cut. It shows the gates of the head: the Vercel status, a nightly
receipt committed for that commit, and the data drill, which is done by
hand. It also lists the queue (open PRs on the train or `main` that it
doesn't have yet) and the median age of the open PRs it carries
(target: ≤ 7 days to `main`). A warning line names each target that is
missed.

## What the cadence is measured by

- `main` moves at least once a week, four weeks in a row.
- The median time from a PR to `main` is at most 7 days.
- At most 10 hand resolutions per weekly train.

# Stacked pull requests

Most work on Lumen lands as a **chain of PRs**: each PR's base branch is the
head branch of the PR below it, and the bottom PR targets `main`. Reviewers
see one layer at a time; the cost is keeping every layer rebased when a
lower one changes. `scripts/stack.mjs` does the two jobs that matter here:
showing the chain with CI per layer, and restacking the layers above a
branch that changed.

## GitHub's `gh stack`

GitHub ships an official CLI extension for stacked PRs,
[`github/gh-stack`](https://github.com/github/gh-stack) (`gh extension install github/gh-stack`).
When it is installed, `scripts/stack.mjs` delegates to it:

| `scripts/stack.mjs` | runs |
| --- | --- |
| `list` | `gh stack view --short` (the locally tracked stack), then its own CI listing |
| `restack <branch>` | `gh stack rebase --upstack <branch>`; falls back to `git rebase --onto` when gh stack does not track the branch (exit code 2) |
| `restack <branch> --push` | then `gh stack push` |

Pass `--fallback` (or set `LUMEN_STACK_NO_GH_STACK=1`) to skip it.

**Status (18.10.2026): the extension could not be installed in the agent
sandbox,** so the delegation path has not been run. `gh extension install`
got HTTP 403 from the releases API, the release download was blocked, and
building from source needs Go 1.26 plus the Go module proxy (the sandbox has
Go 1.24 and no module proxy). The command list below is from the upstream
README at commit `29a36d3`, not from a run.

The main `gh stack` commands, for a machine where it installs:

| Command | What it does |
| --- | --- |
| `gh stack init [branches…]` | start a stack, or adopt existing branches bottom → top (`--base` for the trunk) |
| `gh stack add <branch>` | new branch on top (`-Am "msg"` stages, commits and names it) |
| `gh stack view [--short\|--json]` | the stack, its PRs and latest commits |
| `gh stack rebase [--upstack\|--downstack] [branch]` | fetch, then cascade-rebase; `--continue` / `--abort` after a conflict |
| `gh stack push` | push every branch with per-branch `--force-with-lease` |
| `gh stack submit [--auto] [--open]` | push, create the missing PRs and the Stack object on GitHub |
| `gh stack sync [--prune]` | fetch, fast-forward trunk, rebase, push and refresh PR state in one go |
| `gh stack link <pr\|branch>…` | make a Stack on GitHub from existing PRs, bottom → top, without local tracking |
| `gh stack merge [<stack>\|<pr>]` | merge the stack up to a PR, all-or-nothing |
| `gh stack checkout <stack\|pr\|branch>`, `up`, `down`, `top`, `bottom` | move around |
| `gh stack modify`, `unstack` | restructure or dissolve a stack |

On GitHub a Stack holds at most 100 PRs, and every pull request in the REST
API carries a `stack` object (`number`, `position`, `size`); `list` shows
it as `[stack N position/size]` when it is set. Our PRs have none yet
(`GET /repos/talstilkol/lumen-md/stacks` returns `[]`): the chain exists only
through base branches. `gh stack link 137 138 … 195` would turn it into a
Stack. It can push branches and change PR bases, so run it on purpose, not
from a script.

## `node scripts/stack.mjs list`

```sh
node scripts/stack.mjs list                  # every chain, then the standalone PRs
node scripts/stack.mjs list '#171'           # only the chain that contains #171
node scripts/stack.mjs list feat/vision      # …or the one with this head branch
node scripts/stack.mjs list --workflow ci.yml   # CI column from the CI workflow only
node scripts/stack.mjs list --no-ci          # no Actions calls
```

Read-only. It reads the open PRs (`gh api repos/<repo>/pulls?state=open`),
links each PR to the open PR whose head is its base, and prints each chain
bottom → top. A fork in the chain (two PRs on one base) is indented.

The CI column is the newest Actions run for the head branch
(`actions/runs?branch=<b>&per_page=1`):

| Mark | Meaning |
| --- | --- |
| `✓ success` | the newest run passed |
| `✗ failure` | it failed (also `timed_out`) |
| `… in_progress` / `queued` | still running |
| `∅ cancelled` | cancelled, usually by a newer push |
| `· skipped` | the newest run was skipped. It may belong to another workflow; use `--workflow ci.yml` |
| `– none` | no run at all for that branch |
| `(older commit)` | the run is for an earlier commit than the PR's head |

## `node scripts/stack.mjs restack <branch>`

After you change a branch in the middle of the chain (a review fix, an
amended commit), every PR above it still has the old commits. `restack`
replays each one onto its parent, parents first:

```sh
git rebase --onto <parent> <parent's old tip> <child>
```

```sh
node scripts/stack.mjs restack feat/hebrew-core --dry-run   # print the plan, change nothing
node scripts/stack.mjs restack feat/hebrew-core             # rebase, then print the pushes
node scripts/stack.mjs restack feat/hebrew-core --push      # …and run them
```

- **Pushing is opt-in.** Without `--push` it prints, and does not run,
  one `git push --force-with-lease=<branch>:<sha GitHub has> origin <branch>`
  per moved branch (and for `<branch>` itself when it differs from its PR).
  The lease fails if someone else pushed in the meantime. The lease does not
  protect commits only GitHub has, so a branch that is behind its PR head,
  or has diverged from a head it never had here (not in its reflog), stops
  the run before anything moves; an amend or rebase of the PR head is fine.
- **The old base** of the first layer is the commit the child was built on:
  `--old-base <sha>` if given, else whichever of `origin/<branch>` and the
  PR's head on GitHub is in the child's history and closest to it (a stale
  `origin/<branch>` would replay the parent's newer commits as the child's),
  else the fork point from the reflog, else the merge base. For higher
  layers it is the parent's tip recorded before the run, when the child
  contains it; a parent amended after its child branched is not in the
  child's history, so its old base is then found the same way as for the
  first layer.
- `--old-base` is honoured by the `git rebase --onto` fallback only: with it,
  `gh stack` is not used (it has no equivalent). `--remote` goes to both
  `gh stack rebase` and `gh stack push`.
- An amended top PR (nothing stacked on it) still gets its push; `--push`
  on a top PR whose branch is not local is an error.
- gh stack stacks are linear: when a PR above the branch has more than one
  PR on top, the fallback restacks the whole tree instead.
- **Worktrees.** A branch checked out in another worktree is rebased in that
  worktree (`git -C <path> rebase …`), which must be clean. Other branches
  are checked out in the current worktree, which must be clean too
  (untracked files count: a rebase aborts on one it would overwrite). Every
  worktree is checked before the first rebase, so a dirty one stops the run
  with nothing changed. Your original checkout is restored at the end.
- **Forks.** A PR from a fork that targets a stack branch is listed, not
  restacked: its head is in another repository, and a local branch of the
  same name is not it.
- **Conflicts** stop the run with exit code 3, the worktree to fix it in,
  and the exact commands for the layers that are left (with `git -C <path>`
  for branches checked out elsewhere). Resolve, stage,
  `git rebase --continue`, then run those commands.
- Layers already on their parent are skipped, so running it twice is safe.
- Branches must exist locally (`git fetch origin <b>:<b>` first).

`--prs <file.json>` reads the open PRs from a file (the REST shape) instead
of the API. The tests use it, and it works offline.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | done |
| 1 | usage error, missing branch, dirty worktree, `gh` / git failure |
| 2 | `list <key>`: no open PR matches |
| 3 | `restack`: a rebase stopped (conflict) |

The chain logic is in `scripts/lib/stack.mjs`. Its tests are in
`src/__tests__/stack.test.ts`: fixture PR JSON, plus a throw-away git
repository for `restack`.

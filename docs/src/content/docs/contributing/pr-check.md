---
title: The PR check
description: npm run pr:check is the local PR gate that replaces Danger.js and size-limit. It reports bundle size against the base, PR body sections, [skip ci] commits, unregistered network calls, licences and the domain rule.
---

Lumen runs no GitHub Actions on pull requests. Danger.js and size-limit
need Actions, so one local command replaces them (plan 0.19):

```bash
npm run build
npm run pr:check -- --base origin/main --body pr-body.md --build-base --out pr-check.md
```

The report is Markdown. Paste it into the pull request. The command exits
with 1 when a check fails. Warnings do not fail it.

## The checks

- **Bundle size.** The gzipped size of each chunk class (`npm run budget -- --json`),
  compared with the base, as a table. The bundle budget's own verdict
  decides pass or fail. The base's sizes come from one of:
  - `--base-sizes <file>`;
  - `--build-base`, which builds the merge base in a temporary worktree
    that links this checkout's `node_modules`.
- **Commits.** Every subject from the merge base to `HEAD` contains
  `[skip ci]`.
- **PR body.** The file passed with `--body` has every section, none
  empty:
  - What and why
  - Definition of done (plan 0.7)
  - Local verification
  - Not verified here
  - Owner commands
- **Network.** Every new call that sends a request (`fetch`, `WebSocket`,
  `EventSource`, `sendBeacon`, `importScripts`) goes to a host listed in
  the privacy ledger (`src/ai/privacyLedger.ts`). A call whose URL is
  computed instead needs a `// privacy-ledger: <rule>` comment.
- **Licences.** Every production package added or changed in the
  lockfile has an allowed licence (no copyleft, no non-commercial, not
  missing).
- **Domain.** No added line names the project's domain.
- **Human review (plan W4.28).** A change to a sensitive path — every path
  in `.github/CODEOWNERS`: cryptography, vault writes, the privacy ledger,
  CSP and security policy, native permissions — needs the `human-reviewed`
  label, added by a person after the last commit. With `--pr <n>` the label
  and its time are read from GitHub (`gh api`) and the check fails without
  them; without `--pr` it only warns. Tal runs it with `--pr` before every
  merge. See [Second maintainer](/contributing/second-maintainer/).

The same sensitive paths also need an independent review receipt for the
head commit, from a reviewer that did not write the change, with attack tests
and no critical or high finding open (plan W6.11). See
[Independent review](/contributing/independent-review/).
- **Budgets only go down** (plan W6.26). A diff that raises a bundle
  budget, the startup budget, an exception's expiry date, the ratchet
  margin, a performance-gate FCP/LCP limit or a Lighthouse assertion
  fails. So does a budget number written into `scripts/bundle-budget.mjs`
  itself. See [Budgets that only go down](/contributing/budgets/).

It also warns:
- when source changed and no test did;
- when an AI agent wrote the PR (add the `ai-written` label).

## The branch's base (plan W6.22)

Every PR is based on the current train (the highest-numbered
`verify/train-N` on the remote) or on `main`, not on another PR's branch.
The check:
- warns when the base is something else, and names the
  `scripts/restack.mjs` command that prints how to move it;
- warns when the branch is behind its base (the train head, for a
  stacked PR) and says by how many commits;
- fails when the merge base is more than 7 days old
  (`--max-age-days`), or when there is more than one merge base
  (a criss-cross).

See [Every PR on the train head](/contributing/train-base/).

## Options

| Option | Meaning |
|---|---|
| `--base <ref>` | The branch the PR goes into (default `origin/main`) |
| `--body <file>` | The PR description, to check its sections |
| `--base-sizes <file>`, `--head-sizes <file>` | Sizes already measured |
| `--build-base` | Build the base to measure it |
| `--no-size` | Skip the size check |
| `--pr <n>` | The pull request number: read its labels, label events, reviews and comments (human-review and independent-review rules) |
| `--review <file>` | A review receipt file to check against this checkout's HEAD, offline; repeatable ([Independent review](/contributing/independent-review/)) |
| `--repo <owner/name>` | The repository, when the `origin` remote does not name it |
| `--train <branch>` | The current train, when it isn't the highest `verify/train-N` on the remote |
| `--max-age-days <n>` | The age limit of the merge base (default 7) |
| `--out <file>` | Write the report |

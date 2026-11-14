---
title: Independent review
description: Every change to a sensitive path needs a review receipt for its head commit from a reviewer that did not write it, with attack tests, before it is merged — integration trains included.
---

A change to a sensitive path — the paths `.github/CODEOWNERS` lists:
cryptography, vault writes, the privacy ledger, CSP and security policy,
sanitisers, native permissions and updates — is reviewed by someone who did
not write it before it is merged. This holds for the fixes an integration
train (`verify/*`) makes while it resolves conflicts in that code: the
train's own PR needs a review too. A person still adds the `human-reviewed`
label as well (see [Second maintainer](/contributing/second-maintainer/));
this page is the reviewer's part.

## The rule

`npm run pr:check` has the check **Independent review of sensitive paths**.
When a sensitive file changed it needs a **review receipt** that:

1. names the PR's head commit (all 40 characters). A push after the review
   makes the receipt stale, and a new review is needed;
2. has a reviewer that is not the author (another lane or agent, or a
   person), with `"access": "read-only"`: the reviewer could not push to the
   branch;
3. covers every sensitive file in the diff (`files`: paths or CODEOWNERS
   patterns);
4. lists at least one attack test the reviewer wrote or ran, with its result;
5. has no finding of severity `critical` or `high` still `open`, and the
   verdict `approve`.

With `--pr <n>` the receipts are read from the PR's comments, and the check
fails without one that counts. With `--review <file>` (repeatable) a
receipt file is checked against this checkout's `HEAD`, offline. With
neither, the check only warns.

## The receipt

Post it as a PR comment with a fenced block whose language is
`lumen-review`, or keep it as a JSON file:

````md
```lumen-review
{
  "format": "lumen-review",
  "version": 1,
  "pr": 495,
  "head": "<40-character sha of the reviewed head>",
  "author": "train-2",
  "reviewer": "S",
  "access": "read-only",
  "date": "2026-11-12T18:00:00Z",
  "files": ["/src/sync/e2ee/lan/"],
  "attackTests": [
    { "path": "src/__tests__/lanPreAuthAttack.test.ts", "result": "6/6 pass", "failsWithoutFix": 3 }
  ],
  "findings": [
    { "id": "E56-1", "severity": "medium", "status": "fixed", "summary": "…", "fix": "<sha or patch>" }
  ],
  "verdict": "approve"
}
```
````

| Field | Meaning |
|---|---|
| `head` | The commit reviewed. Must be the PR's head when the check runs |
| `author`, `reviewer` | Who wrote the change and who reviewed it. Must differ |
| `access` | Always `read-only` |
| `files` | What was reviewed: every sensitive file of the diff must be covered |
| `attackTests` | `path`, `result`, and optionally `failsWithoutFix`: how many of them fail without the fix |
| `findings` | `id`, `severity` (`critical`, `high`, `medium`, `low`, `info`), `status` (`open`, `fixed`, `accepted`), `summary`, `fix` |
| `verdict` | `approve` or `changes-requested` |

## How a reviewer works

- Check out the head read-only (a detached worktree, or `git show`); never
  push to the branch under review.
- Write the threat model down: who the attacker is, what they can already
  do, and what the change adds.
- Write attack tests for it and run them; when you find a problem, show
  that the test fails without your fix.
- Put the fix in a patch or a separate PR for the author; then post the
  receipt for the head you reviewed.

## Who can post a receipt

Only a comment by an account with write access to the repository counts:
GitHub's `OWNER`, `MEMBER` or `COLLABORATOR`. On a public repository anyone
can comment, and a stranger's receipt doesn't open the gate. `pr:check`
lists it with the reason. A receipt's `files` must name what was read. An
entry such as `*`, `**` or `/` that covers the whole repository doesn't count.

The PR's author can't review it, and neither can anyone who wrote or
committed a commit in its range. `pr:check` refuses a receipt posted by the
PR's author, and a receipt whose reviewer matches the author, or any
commit's author or committer, by GitHub login, git name or email. The
registry entry may list the reviewer's `login` and `emails` for this.

## Signed receipts

Every agent lane posts as the same GitHub account, so the account can't show
that the reviewer isn't the author. A receipt counts only when it is signed
with the Ed25519 key that `security/reviewers.json` lists for the reviewer it
names. An unsigned receipt never counts:

```bash
# once per reviewer; the private key never goes into a repository
node scripts/review-sign.mjs keygen R --out ~/.lumen-review-keys
#   → add the printed entry under "reviewers" in security/reviewers.json
# for each review
node scripts/review-sign.mjs sign receipt.json --key ~/.lumen-review-keys/R.key.pem --comment
#   → post the printed comment on the PR
node scripts/review-sign.mjs verify receipt.json
```

The signature covers the whole receipt except `signature`, with keys sorted,
so changing any field after signing breaks it. With no key in
`security/reviewers.json` (or no file), no receipt counts, and the report says
so.

## A train's coverage

`npm run review:coverage -- --train origin/verify/train-2 --base origin/main`
lists every sensitive PR merged into the train (merge subjects
`Merge #N …`, trains merged into the train included) and the train's own
integration commits. For each, it says whether a receipt counts for the head
the train holds. The train's own commits need a receipt for the train's head
(`--train-pr <n>`). Receipts come from the PRs' comments (`--live`) and/or a
folder of receipt files (`--receipts <dir>`). The command exits with 1 below
100%. `--codeowners <file>` reads the sensitive list from a file, for a train
that doesn't carry `.github/CODEOWNERS` yet.

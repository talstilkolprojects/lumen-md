---
title: Owner session command
description: One command per owner session. It prints exactly what to do in the browser, runs the commands for you after asking, verifies the result through the APIs, records a signed receipt per step and resumes where you stopped.
---

Plan W6.20. The [owner sessions](/project/owner-sessions/) as a command:

```bash
npm run owner:session -- accounts    # session 1: accounts, keys and switches (any computer)
npm run owner:session -- gpu         # session 2: models and data (the cloud GPU, the Mac as fallback)
npm run owner:session -- devices     # session 3: devices, releases and the merge
npm run owner:session -- status      # what is done, estimated against actual minutes
npm run owner:session -- check       # only the automatic checks: no prompts, nothing recorded
npm run owner:session -- collect     # every owner command in the open PRs, deduplicated and assigned
```

Each step works like this:

1. It prints what you do, with the exact page to open.
2. It offers its commands (for example `gh label create …`, or the Vercel setting) and runs each one only after you answer yes. `--yes` runs them without asking.
3. When you press Enter, it checks the result:
   - automatically where an API, a file or a command can tell: GitHub through `gh api`, Vercel's REST API with your `VERCEL_TOKEN`, Hugging Face, BrowserStack, Kaggle, `wrangler`, `gcloud`, ssh or `oci` to the factory VM, the release on GitHub
   - by asking you yes or no where only your eyes can tell. That answer is recorded as attested.
4. It writes a signed receipt for the step.

A step with an open check is recorded as open. The next run starts again at that step and adds the minutes. A finished step is skipped (`--redo <step>` runs it again). Hebrew: `--lang he`, or a Hebrew `LANG`.

## The steps

14 owner items in three sessions (plan W6.20 asks for at most 15). Every step has at least one automatic check: 41 automatic checks and 18 yes/no answers.

| Step | Min | What | Automatic checks | Your yes/no |
|---|---|---|---|---|
| `accounts/github` | 15 | Merge #432, turn on GitHub's protections and Vercel's Ignored Build Step (W6.10, W6.12) | merged-432, label, private-vulnerability-reporting, secret-scanning, ignored-build-step | — |
| `accounts/vercel-hf` | 15 | Leaked VITE_ keys (15.18), the Hugging Face token and seed, dataset terms | no-secret-vite, hf-token, golden-seed, flores-terms | common-voice-terms |
| `accounts/signing` | 20 | Signing accounts and keys (store verification takes days: start it now) | updater-key, release-key, android-keystore, asc-key | apple-enrolled, play-console, windows-signing |
| `accounts/test-clouds` | 15 | Free test clouds: BrowserStack (Safari, iOS), Firebase Test Lab (Android), Kaggle (GPU) | browserstack, firebase, kaggle | — |
| `accounts/hosts` | 20 | Hosts: Cloudflare Pages + the model mirror, Fly signaling + the relay | wrangler, pages-project, pages-live, mirror-env, signaling, relay-env | — |
| `accounts/factory` | 25 | The verification factory on Oracle's free VM | vm-timer, receipts-repo, first-status | — |
| `gpu/models-day` | 20 | The real models day on Kaggle's free GPU (the Mac only as fallback), with the held-out sets | heldout-key, eval-branch | — |
| `gpu/golden` | 60 | Your part of the golden sets (an hour now, the rest over days) | recordings | text-sets, image-ratings |
| `gpu/archives` | 30 | Your own archives and libraries: mail, chats, Zotero | zotero-key | mail, chats, zotero |
| `gpu/cargo-zip` | 20 | The critical Cargo zip advisory and the npm updates that need a real install | zip-9, known-bad | — |
| `devices/manual-checks` | 60 | What only eyes and hands can check: Safari, Word, the phone, screen readers | safari-receipt | safari-checklist, word-rtl, share-sheet, phone, screen-readers |
| `devices/desktop-release` | 60 | Desktop: the native build, beta.1 and the update drill to beta.2, the store packages, the privacy audit | beta1, beta2, bundle, privacy-audit | update-drill, packages |
| `devices/mobile` | 45 | Mobile: signed Android and iOS builds to internal testing, and a Firebase robo run | aab, robo | internal-testing |
| `devices/live-and-merge` | 25 | Merge the trains last, then check the live site and ask for a re-crawl | train-merged, security-md, live-meta | recrawl |

Session 1 is estimated at 110 minutes. The step's real time goes into its receipt, and `status` shows the two side by side.

## What the checks need

Set these in the shell that runs the command. A check that is missing its token prints "cannot check" and leaves the step open. It is never counted as passed.

| Variable or tool | For |
|---|---|
| `gh auth login` | the GitHub checks and switches |
| `VERCEL_TOKEN` (vercel.com → Account Settings → Tokens; optional `VERCEL_TEAM_ID`, `VERCEL_PROJECT`) | the Ignored Build Step, the environment variables |
| `HF_TOKEN` | the FLORES+ terms (a gated file downloads) |
| `BROWSERSTACK_USERNAME`, `BROWSERSTACK_ACCESS_KEY` | BrowserStack Automate |
| `~/.kaggle/kaggle.json` (mode 600) or `KAGGLE_USERNAME` + `KAGGLE_KEY` | Kaggle |
| `gcloud`, `npx wrangler@4`, `cargo` | Firebase Test Lab, Cloudflare, the zip advisory |
| `LUMEN_FACTORY_VM=ubuntu@<ip>` (ssh), or `oci` + `OCI_COMPARTMENT` | the factory's nightly timer |
| `LUMEN_GOLDEN_DIR`, `ZOTERO_API_KEY` | the recordings count, the Zotero key |

## Receipts

Each step writes `reports/owner/<session>/<step>.json` in the sealed format of the nightly receipts and the plan's receipt reader: canonical JSON, sha256 and an Ed25519 signature.

- The receipt holds the commit you ran on, the start and finish times, the estimated and actual minutes, each command's exit code, and each check's result (attested answers are marked).
- The key is made on the first run at `~/.config/lumen-md/owner-ed25519.pem` (mode 600; `LUMEN_OWNER_KEY` overrides). Its public half is `reports/owner/PUBLIC_KEY.pem`.
- A receipt changed by hand no longer verifies and is ignored.
- At the end, the command prints the `git add -f reports/owner …` line that commits the receipts.

The works-for-the-user board (plan W6.44) reads them. For example, `accounts/github` → `secret-scanning` is evidence for privacy and security.

## Collecting owner commands

`collect` reads the owner sections of every open PR:
- the headings it reads are "Owner commands", "Owner steps", "Owner items" and "The owner's … step"
- each command is a line in a shell block, an inline command, or a to-do bullet
- it merges duplicates across PRs and assigns each one

Each command goes to one of these:

| Assigned to | Meaning |
|---|---|
| a step | the step that takes care of it |
| agent | a test or build run that agents do on the second host |
| recurring | a loop per train or merge (pr:check, restack, train builds) |
| coordinator | a change a lane makes in a PR |
| people | needs other people (raters, speakers, a second maintainer) |
| deferred | optional and deferred (15.5) |
| obsolete | a GitHub Actions run (the project doesn't use Actions) |
| none | the section says nothing is needed |

An unassigned command, or a plan owner item (15.x) that no step carries and that isn't listed as taken off, makes `collect` exit 1. A new owner command can't be missed that way. `collect --write` saves the result as `scripts/owner/inbox.json`.

On 12.11.2026: 375 open PRs, 79 with an owner section, 236 distinct items:
- 149 in the 14 steps
- 58 for agents
- 20 recurring
- 4 for the coordinator
- 2 needing other people
- 1 deferred, 1 obsolete, 1 "none"
- 0 unassigned

All 18 plan owner items are covered: 13 in steps and 5 taken off the list.

---
title: CI on Buildkite, without GitHub Actions
description: Buildkite Free schedules lumen-md's gates on our own machines (the verification factory's host and a Mac) and posts a commit status for every gate on every PR, plus a signed receipt.
---

Lumen doesn't use GitHub Actions. The verification factory
([its page](/self-hosting/verification-factory/)) tests the `verify/*` heads
every night, but a PR itself showed no ✓ or ✗. Plan W7.21 adds that:
**Buildkite Free** schedules the jobs, and our own agents run them:

- the factory's Ubuntu host runs every job in Playwright's own image (Docker)
- Tal's Mac runs **WebKit on macOS** on every build (queue `mac`)

Each gate posts its own GitHub commit status (`lumen/buildkite: <gate>`), and
the last job seals a **receipt** in the factory's format.

## What runs

`.buildkite/pipeline.yml` is generated from `.github/workflows/ci.yml`. The
gates are not typed twice: each Buildkite job runs the exact `run:` text of
ci.yml's steps.

| Job | ci.yml steps | Queue |
|---|---|---|
| `static` | typecheck, hygiene, headers, docs sync, plan, hard-coded strings, DoD, unused files, docs complete, i18n drift (all run, then it fails if any failed) | linux |
| `lint`, `licenses` | ESLint with its baseline; the licence gate | linux |
| `build` | build with the canary secrets, both secret scans, the bundle budget | linux |
| `vitest` ×4, `vitest-merge` | the whole suite in 4 shards balanced by time, merged, with ci.yml's 65% coverage gate | linux |
| `e2e-chromium`, `e2e-firefox` | every spec (Firefox under xvfb with software GL, as on GitHub) | linux |
| `e2e-webkit` | every spec, on macOS | **mac** |
| `e2e-prod`, `e2e-headers`, `local-ai`, `ocr-cer` | as in ci.yml | linux |
| `lighthouse` | main and PRs labelled `lighthouse` only, as in ci.yml | linux |
| `receipt` | the signed receipt, after every gate (pass or fail) | linux |

The steps ci.yml has that are not gates (installs, PR comments, the
main-only size cache, diagnostics) are listed with a reason in
`NOT_GATES` in `scripts/buildkite/lib.mjs`.

**No gate can go missing.** `npm run ci:pipeline` fails when:

- ci.yml has a step that the pipeline neither runs nor lists with a reason
- a step was renamed, or the e2e matrix gained a browser
- the committed `pipeline.yml` is not what ci.yml gives
- a job has `soft_fail`, or retries on a test failure (only a lost agent is retried)
- WebKit is off the Mac's queue, or skipped
- a gate posts no status, or the receipt doesn't wait for it

After changing ci.yml: `npm run ci:pipeline -- --write` and commit the file.

**One documented override.** ci.yml's i18n drift step counts English only in
`src/i18n/locales/en/`. The English of the lazily loaded domains
(`src/i18n/lazy/*.json`, kept out of the startup bundle) therefore looked like
drift: en 2270 vs he 2493, with no string missing. The pipeline runs
`npm run i18n:drift` in its place:

- English is counted as `locales/en` plus the lazy files
- ci.yml's 10-key limit applies to every locale, not only Hebrew
- a key with no English string fails

The step is equal to ci.yml's or stricter. `OVERRIDES` in
`scripts/buildkite/lib.mjs` pins the sha256 of the ci.yml text it replaces, so
a change to that step stops the generator until the override is reviewed again.

### Shards by time

`vitest --shard` splits by file count, so one shard can get all the slow files.
`vitest-plan` packs the files by their last measured time instead (longest
first, each to the lightest shard). The times come from the previous merge,
kept on the host. The first run packs by file size. `vitest-merge` fails
when:

- a planned file did not run, or ran twice
- a shard report is missing
- one of the suites the offline harnesses skip did not run or failed

The receipt records the actual spread between the longest and the shortest
shard.

### Why builds are started by the host, not by GitHub's webhook

Every commit and PR title here carries `[skip ci]` (that keeps GitHub Actions
off). Buildkite skips a build whose commit message or PR title contains
`[skip ci]`, `[ci skip]`, `[skip-ci]` or `[ci-skip]` ([Buildkite: skipping
builds](https://buildkite.com/docs/pipelines/skipping)). So the factory host
runs `scripts/buildkite/trigger.mjs` every 5 minutes (a systemd timer). It
creates a build through Buildkite's REST API for each new head of an open PR
from this repository, with a message without the marker.

- Heads from forks are never built: their code would run on our machines.
- A commit that already has a build is never queued again.
- PRs untouched since the timer started are left alone. Add them with `--backfill N`.

## Free tier (checked 14.11.2026 on buildkite.com/pricing)

- Up to 5 users and **up to 10 concurrent jobs on self-hosted agents**
- 2,000 hosted Linux minutes a month (we use none: our agents are self-hosted)
- 30-day build and artifact retention (the receipts live in `lumen-md-receipts`, so they outlast it)
- $0, no credit card

Commit statuses come from Buildkite's GitHub app. Its "Limited Access"
variant has no code access but can write commit statuses
([Buildkite: GitHub](https://buildkite.com/docs/pipelines/source-control/github)).
Our agents clone the public repository themselves.

## Owner setup (once, about 20 minutes)

1. Sign up at buildkite.com (the Free plan). Note the organization slug.
2. **Settings → Repository Providers → GitHub (Limited Access)**: install
   it on `talstilkol/lumen-md` only.
3. **Agents → the default cluster → Queues**: create two self-hosted queues,
   `linux` and `mac`. Under **Agent tokens**, create one token.
4. **Pipelines → New pipeline** `lumen-md`:
   - repository `https://github.com/talstilkol/lumen-md.git`
   - steps: `buildkite-agent pipeline upload`, on queue `linux`
   - under GitHub settings, leave **Update commit statuses** unticked: the
     pipeline sets its own statuses
   - don't add the GitHub webhook: those builds would be skipped anyway, and
     the host starts the builds
5. **Personal settings → API Access Tokens**: a token for this organization
   with **read_builds** and **write_builds** only.
6. The factory host (after its own setup, from the factory's page) and the Mac:

```bash
# on the Mac, with the factory host in VM=ubuntu@<ip>
printf 'Agent token: '; read -rs AGENT; echo; printf 'API token: '; read -rs API; echo
curl -fsSL https://raw.githubusercontent.com/talstilkol/lumen-md/ci/buildkite/scripts/buildkite/agent-bootstrap.sh -o /tmp/bk.sh
scp /tmp/bk.sh "$VM":/tmp/
printf '%s\n%s\n' "$AGENT" "$API" | ssh "$VM" 'sudo bash /tmp/bk.sh --secrets-stdin --org <org-slug>'
printf '%s\n' "$AGENT" | bash /tmp/bk.sh --secrets-stdin      # this Mac: queue mac
unset AGENT API
```

The script reads the tokens from stdin, never from the command line, and
stores them with mode 0600. The agent:

- runs as the factory's user
- clones only lumen-md (`allowed-repositories`)
- runs no plugins and no hooks from the checkout

`--dry-run` prints every action without changing anything. On the Mac, the
agent runs in your login session (a LaunchAgent), so the Mac must be logged
in and awake for `e2e-webkit` to run.

## Checking it

- `npm run ci:selftest`: the generated commands run through `run.sh`, with
  Docker, npm and the agent emulated. It also covers the shard plan on the
  real test files, the receipt (sealed, checked, a changed byte rejected),
  the trigger against local API stand-ins, and the bootstrap into a
  temporary root.
- `node scripts/buildkite/receipt.mjs --verify <receipt.json> --key keys/<host>.pem`:
  checks a receipt from a build or from `lumen-md-receipts`.

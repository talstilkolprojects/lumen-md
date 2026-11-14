---
title: Nightly runs and receipts
description: npm run nightly runs the flake hunt, the perf checks, the review triage and the weekly health on your own machine, and writes a signed report for each, without GitHub Actions.
---

Lumen doesn't use GitHub Actions, so the scheduled runs (plan 0.11) and the
measurements that depend on them (0.5: three nights with no flaky test; 0.14:
how many preview-build failures a local `ci:local` run would have caught) run
on the owner's machine. One command does it:

```bash
npm run nightly                  # what is due today
npm run nightly -- --dry-run     # print the plan, run nothing
```

| Kind | When | What runs |
|---|---|---|
| `flake` | every night | `npm run e2e:flake -- --all --times 5` (chromium, firefox, webkit, 5 runs each, no retries) |
| `perf` | every night | build, bundle budget, the `@nightly` perf project, Lighthouse when it is installed |
| `triage` | every night | review triage of the open PRs, the 0.14 count over the first 20 PRs since 12.11.2026, and `live:meta --self-test` (below) |
| `weekly` | Sundays (UTC) | dependency health (audit, outdated, licences), and mutation scores when `test:mutation` is there |

`--only flake,perf` picks kinds. The scheduler passes `--scheduled`, which
marks the reports as scheduled. Plan 0.11 counts only those.

## Reports and receipts

Each kind writes `reports/nightly/<date>-<kind>.json`. The report records:

- the commit, and whether the tree was clean
- the machine: platform, Node and CPU count, no host name
- every command with its exit code and duration
- the sha256 of each command's output, with its last lines
- the kind's numbers: flaky and always-failing tests per browser, perf
  annotations, review totals, audit counts

The report is **sealed**. It carries its sha256 and an Ed25519 signature
made with a key that never leaves the machine
(`~/.config/lumen-md/nightly-ed25519.pem`, mode 0600, created on the first
run; `LUMEN_NIGHTLY_KEY` overrides the path). The public half is committed as
`reports/nightly/PUBLIC_KEY.pem`. Anyone can check a committed report:

```bash
npm run nightly -- --verify reports/nightly/2026-11-13-flake.json
```

If any number in the report changed after the run, both the digest and the
signature fail.

`reports/nightly/status.json` (sealed too) is recomputed after every run
(`npm run nightly -- --status` does only that). It records:

- **0.5**: how many consecutive nights each had every browser 5 times, with
  no flaky and no always-failing test (3 are needed)
- **0.11**: which of the four kinds produced a scheduled report (all 4 are
  needed)
- **0.14**: in the first 20 PRs opened since 12.11.2026, the commits whose
  **Vercel** preview build failed. The preview build runs a subset of
  `ci:local`, so each such failure is one `ci:local` would have caught,
  except `docs:sync`, which `ci:local` doesn't run. `verify/*` integration
  branches aren't counted.

`--commit` commits `reports/nightly/` with a `[skip ci]` message. It never
pushes. A commit that changes only `reports/` doesn't start a Vercel build
(`scripts/vercel-ignore.sh`), so receipts don't use up the deployment quota.

## Scheduling it on a Mac (launchd)

Use a clone that is used only for the nightly, on its own branch, so a run
never mixes with your work:

```bash
git clone https://github.com/talstilkol/lumen-md ~/lumen-nightly
cd ~/lumen-nightly && git switch -c nightly/receipts && npm ci && npx playwright install
```

Save `~/Library/LaunchAgents/dev.lumen-md.nightly.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.lumen-md.nightly</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string><string>-lc</string>
    <string>cd ~/lumen-nightly &amp;&amp; git pull -q --rebase origin main &amp;&amp; npm ci --silent &amp;&amp; npm run nightly -- --scheduled --commit</string>
  </array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>2</integer><key>Minute</key><integer>17</integer></dict>
  <key>StandardOutPath</key><string>/tmp/lumen-nightly.log</string>
  <key>StandardErrorPath</key><string>/tmp/lumen-nightly.log</string>
</dict>
</plist>
```

Then load it with `launchctl load ~/Library/LaunchAgents/dev.lumen-md.nightly.plist`.
launchd runs a job that was missed while the Mac slept as soon as it wakes.
To publish the receipts, push the branch (`git push origin nightly/receipts`)
or open a PR from it. Linux uses cron instead:

```text
17 2 * * *  cd ~/lumen-nightly && git pull -q --rebase origin main && npm ci --silent && npm run nightly -- --scheduled --commit
```

## Why not Vercel Cron or a cloud scheduled task

- **Vercel Cron** only calls a function of a deployment on a schedule. It
  can't run three browsers five times over the e2e suite, and it would spend
  the shared deployment quota.
- **A Claude Code scheduled task** starts a fresh cloud session. That session
  has no browsers and can't install packages, so it can run only the
  `triage` kind (GitHub's REST API) and read the committed receipts. That is
  useful for a morning summary, not for the measurements themselves.

## Live metadata check (plan W6.2)

`npm run live:meta` fetches the production `index.html`, `robots.txt` and
`sitemap.xml` and fails unless the canonical link, `og:url`, `og:image`,
`twitter:image`, every URL in the JSON-LD, the `Sitemap:` line and every
sitemap `<loc>` point at `lumen-md.vercel.app`, and the domain the project
doesn't own appears nowhere in them. The pattern for that domain is built from
parts in `scripts/lib/liveMeta.mjs`, the same way the PR gate builds it, so
the repository never contains it.

```bash
npm run live:meta                                   # production, after every deploy
npm run live:meta -- --url https://<deployment>.vercel.app
npm run live:meta -- --dir dist                     # a build, before deploying it
npm run live:meta -- --self-test --json live-meta.json
```

`--self-test` first checks a clean copy of the pages. Then it plants a
foreign reference in each place (canonical, `og:image`, `og:url` on another
host, body text, `Sitemap:`, `<loc>`) and fails if the check misses any of
them.

Run it **after every production deploy**: the owner's merge session runs it
right after promoting. Every night the `triage` kind runs it too, so drift
shows up within a day. The command exits 1 on any problem. It fetches with
Node and falls back to `curl`, which follows `HTTPS_PROXY`.

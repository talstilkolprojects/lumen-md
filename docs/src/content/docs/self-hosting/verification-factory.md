---
title: The verification factory
description: A free second machine that runs every test of every verify/* head each night in Chromium, Firefox and WebKit, signs a receipt per commit and posts the result to GitHub as commit statuses, without GitHub Actions.
---

Lumen doesn't use GitHub Actions, and until now every real check depended on
one rented build slot (Vercel Hobby) and a sandbox that is blocked until
December. The verification factory (plan W6.5) is a machine of our own that
does the full run every night:

- the whole vitest suite in 2 shards, the slow nightly-only suites included
- every e2e spec on **chromium, firefox and webkit**, 4 shards each
- the data-safety drill (#470, its `drill:data-safety` script) and `cargo check` of the
  desktop shell, when the commit has them; the mutation run on Sundays
- the suites the offline harnesses can't run (`e2eeUi`, `pdfReader`,
  `dictationLocal`, `vaultEncryption`): the receipt names each one, and
  vitest fails if any of them did not run

Each head of `verify/*` gets one **sealed receipt** for its exact commit, in
the public repository `talstilkol/lumen-md-receipts`, and one GitHub commit
status per suite (`lumen/factory: e2e webkit`, …) that links to it. A head
that hasn't changed since its last run gets a heartbeat that names the
receipt of that same commit. Evidence is never carried over to another
commit. Every Sunday unchanged heads run again, to catch flaky tests.

## The host: Oracle Cloud Always Free, Ampere A1

Checked on 12 November 2026 against each provider's own pages.

| | What it gives for $0 | Verdict |
|---|---|---|
| **Oracle Cloud Always Free, Ampere A1** | 1,500 OCPU hours and 9,000 GB hours a month = **2 OCPUs (arm64) and 12 GB**, always on; 200 GB block storage; 10 TB a month outbound | **Chosen.** A permanent Ubuntu 24.04 VM with no time limit. Playwright publishes its Docker image for arm64, with all three browsers. |
| Buildkite Free | up to 5 users, **10 concurrent jobs on our own agents**, 2,000 hosted Linux vCPU minutes a month, 30 days retention | A scheduler, not a machine: its agents still need a host. It can be added later on top of this one (plan W7.21). 2,000 hosted minutes is about 66 minutes a night, less than one full run. |
| Tal's Mac (launchd) | whatever the Mac has | **The fallback.** The same script installs a LaunchAgent; it runs only while the Mac is on. |
| GitLab for Open Source | Ultimate with 50,000 compute minutes | Not chosen: needs an application, a GitLab group, a yearly renewal, and the namespace "can't seek to make a profit". |
| GitHub Actions | — | The owner's rule: not used. |

**Terms to know:**

- Oracle halved the Always Free Ampere allowance in June 2026, from 4 OCPUs
  and 24 GB to 2 OCPUs and 12 GB. Some guides still quote the old figures.
- Oracle reclaims an Always Free VM that is idle over 7 days: 95th-percentile
  CPU under 20%, network under 20% and, on A1, memory under 20%. A nightly
  run of about two hours keeps the CPU's 95th percentile above that.
- The Always Free Ampere shape lives only in the account's **home region**,
  which is chosen at sign-up and can't be changed. Popular regions often
  answer "Out of host capacity". Try another availability domain, or try
  again later.
- Stay on the Always Free tenancy. Upgrading to Pay As You Go protects the VM
  from reclamation, but anything above the free allowance is then billed.

Sources: docs.oracle.com/iaas/Content/FreeTier/resourceref.htm (Always Free
resources, idle reclamation), linuxiac.com (the June 2026 change),
buildkite.com/pricing, about.gitlab.com/solutions/open-source/join,
playwright.dev/docs/intro (Ubuntu 22.04/24.04/26.04 on x86-64 or arm64) and
Playwright's `utils/docker/publish_docker.sh` (images for amd64 and arm64).

**Speed, an estimate, not yet measured:** with 2 OCPUs, the full e2e run in
three browsers (about 330 tests each) is projected at 90–110 minutes. The
plan's target is under 60. If the first nights confirm that estimate, move
one browser to the Mac (`LUMEN_FACTORY_HOST=mac`, its own key), or add
Buildkite agents (W7.21).

## The owner's one step (about 25 minutes, once)

**In the browser:**

1. Sign up at Oracle Cloud (cloud.oracle.com, "Start for free"). It asks for
   a card to check your identity; Always Free resources are not charged.
2. *Compute → Instances → Create instance*: image **Canonical Ubuntu 24.04
   (aarch64)**, shape **VM.Standard.A1.Flex** with **2 OCPUs and 12 GB**,
   boot volume 100 GB, a public IPv4 address, and your `~/.ssh/id_ed25519.pub`.
   Note its public IP.
3. GitHub → *Settings → Developer settings → Fine-grained tokens → Generate
   new token*: name `lumen-factory`, resource owner `talstilkol`, expiration
   1 year, **Only select repositories: talstilkol/lumen-md**, repository
   permission **Commit statuses: Read and write**. Nothing else. Copy the token.

**Then one paste in the Mac's terminal** (gh is already logged in there):

```bash
VM=ubuntu@<the VM's public IP>
gh repo create talstilkol/lumen-md-receipts --public --add-readme --description "Signed nightly test receipts of lumen-md (plan W6.5)"
ssh-keygen -q -t ed25519 -N "" -C lumen-factory -f /tmp/lumen-factory-key
gh repo deploy-key add /tmp/lumen-factory-key.pub --repo talstilkol/lumen-md-receipts --allow-write --title lumen-factory
printf 'Paste the github_pat_ token: '; read -rs TOKEN; echo
curl -fsSL https://raw.githubusercontent.com/talstilkol/lumen-md/chore/verify-factory/scripts/factory/bootstrap.sh -o /tmp/lumen-bootstrap.sh
scp /tmp/lumen-bootstrap.sh "$VM":/tmp/
{ printf '%s\n' "$TOKEN"; cat /tmp/lumen-factory-key; } | ssh "$VM" 'sudo bash /tmp/lumen-bootstrap.sh --secrets-stdin --run-now'
rm -f /tmp/lumen-factory-key /tmp/lumen-factory-key.pub; unset TOKEN
```

Once the branch is merged, put `main` in place of `chore/verify-factory`
in the URL and pass `--branch main`.

The token and the key go over ssh's standard input, never as command-line
arguments. On the VM they are stored with mode 0600, readable only by the
`lumen` user. The deploy key can write to the receipts repository and
nothing else. The token can only post commit statuses to lumen-md. It can't
push code. That is why the receipts live in their own repository: a token
that can write receipts to lumen-md could also push to `main`, which has no
branch protection.

The bootstrap does the rest:

1. installs Docker (Ubuntu's `docker.io`), git, gh and Node 22
2. creates a `lumen` user, and on a 12 GB machine a 4 GB swap file
3. stores the token and the deploy key
4. clones the factory's code and the receipts repository, and creates the
   Ed25519 signing key (`~/.config/lumen-md/nightly-ed25519.pem`, mode 0600)
5. writes `/etc/lumen-factory/env`
6. installs a systemd timer for 01:17 Israel time. It is persistent, so a
   night missed while the VM was down runs at boot.
7. checks that the receipts remote answers, the token sees the repository,
   Docker runs, and the factory can plan a night

`--run-now` starts the first night right away. See it with
`journalctl -u lumen-factory -f`.

### On the Mac instead (the fallback)

Run the same script without sudo. Pipe in the same secrets:
`{ printf '%s\n' "$TOKEN"; cat /tmp/lumen-factory-key; } | bash /tmp/lumen-bootstrap.sh --secrets-stdin`.
On a Mac it checks for node, git and gh (`brew install node gh`). It runs the
steps natively, without Docker, and installs the LaunchAgent
`dev.lumen-md.factory`. launchd runs a night that was missed while the Mac
slept as soon as it wakes. The Mac signs with its own key, `keys/mac.pem`.

## What a night writes

In `talstilkol/lumen-md-receipts`:

| Path | What |
|---|---|
| `commits/<sha>/full-<time>.json` | the sealed receipt of one full run: every step with its exit code, duration, the sha256 of its output and its last lines; the result per suite; the must-run suites; the failing tests and the PR that last changed each failing file |
| `nights/<date>.json` | the sealed list of heads that night: ran, unchanged (with the receipt of the same commit), or left for later |
| `nights/<date>.md` | the morning report: what failed, from which PR, and what changed since the previous report of the same branch |
| `keys/<host>.pem` | the public half of each host's signing key |

Check a receipt anywhere:
`npm run nightly -- --verify commits/<sha>/full-….json`. The digest always
works. For the signature, copy that host's key to
`reports/nightly/PUBLIC_KEY.pem`. A changed number breaks both.

## Commands

```bash
npm run factory:run -- --dry-run            # list the heads and what would run tonight
npm run factory:run -- --only verify/train --rerun --max 1
npm run factory:run -- --no-push --no-status   # keep everything on this machine
npm run factory:selftest                    # the bootstrap and a whole night, with Docker, npm and gh emulated
```

The self-test runs the real bootstrap script and the real `run.mjs`,
signing and checking included, against local stand-in repositories. Docker,
npm, gh, systemd and launchd are small programs that record what they're
asked to do. So it shows that the scripts are wired correctly. It shows
nothing about the real image, browsers or test suite. Those run on the
first real night.

---
title: Before main, WebKit and Safari
description: npm run promote:check refuses to promote main to a commit without a signed WebKit receipt and a signed Safari receipt for that commit. WebKit runs on the verification factory, real Safari on BrowserStack's open-source plan.
---

The platform that lost notes in the data-safety drill (#470: 376 notes on
Safari's OPFS path) is the one the Vercel build image can't test: WebKit
needs a newer glibc than that image has. So the rule (plan W6.6) is:
**main is never promoted to a commit without a WebKit receipt and a Safari
receipt for that same commit.**

```bash
npm run promote:check                         # the commit you're on
npm run promote:check -- origin/verify/train  # the train you're about to merge
npm run promote:check -- <sha> --pin <key fingerprint>
```

It exits 0 only when both of these hold:

- **WebKit:** a full receipt of the [verification factory](/self-hosting/verification-factory/)
  for that commit, whose `e2e webkit` suite passed (every spec, 4 shards).
  If the data-safety drill ran in that receipt, it passed too.
- **Safari:** passing Safari runs on a real iPhone and on macOS for that
  commit, in a factory receipt or in a separate `safari` receipt.

A receipt counts only when its Ed25519 signature verifies with a host key
from the receipts repository (`keys/<host>.pem`). A receipt for another
commit counts only when that commit has exactly the same tree: a merge into
main that changes nothing else. Pass `--pin` (or set `LUMEN_RECEIPT_KEYS`)
with the fingerprints the factory printed at install time. Without it,
every key in the receipts repository is trusted, and the check says so.

Exit 1 means refused. The output names what is missing or failed. Exit 2
means it couldn't check: an unknown commit, no receipts, or no trusted key.

## WebKit: on the factory

The factory runs every spec in the `webkit` project of `playwright.config.ts`
(Playwright's WebKit, "Desktop Safari" settings) inside Playwright's own
Ubuntu 24.04 image. That image ships WebKit's libraries for amd64 and arm64.
Data safety runs there too: `e2e/data-safety.spec.ts` is part of the full
run, and so is the data-safety drill when the commit has it.

## Safari: BrowserStack's open-source plan

**What the plan gives** (browserstack.com/open-source, checked on 12
November 2026): free, "unlimited testing on desktop and mobile: Live,
Automate and Percy", for **5 users and 5 parallels**, for as long as the
project runs ("lifetime access"). The page names no minutes limit, and it
states no licence, attribution or renewal terms. The application form asks
for a name, an email, a password and the **project URL**.

**What runs:** `npm run safari:run` (the factory runs it for the trains
once credentials are set). It builds the app with the e2e hooks and runs
these specs through BrowserStack's Node SDK, with BrowserStack Local, so
the devices reach the app on the factory itself:

- `e2e/smoke.spec.ts`, `e2e/rtl.spec.ts`, `e2e/first-run.spec.ts`,
  `e2e/locale-switch.spec.ts`, and `e2e/data-safety.spec.ts`
- on **real Safari, iPhone 17 (iOS 26), iPhone 16 (iOS 18), iPhone 15
  (iOS 17)**. The two older versions lack parts of OPFS, and that is the path
  that lost notes.
- on **macOS Sequoia, browser `playwright-webkit`**: BrowserStack runs
  Playwright's WebKit build on a real Mac. That isn't the Safari app.
  Real Safari comes from the iPhones. BrowserStack supports Playwright on
  real iOS Safari since June 2025, with Playwright 1.50.1 or newer.

Each platform becomes its own result: the suite `safari ios 17 (iPhone 15)`,
a commit status, and its device and iOS version in the receipt. That is the
record of which Safari versions were tested.

**Not automated:** the Word (RTL) check and the desktop auto-update in 15.12
still need a person. The Safari part of 15.12 is these specs.

### The owner's step, once BrowserStack approves

1. Apply at **browserstack.com/open-source** with the project URL
   `https://github.com/talstilkol/lumen-md` (public, MIT).
2. Once approved, copy the **Username** and **Access Key** from the
   Automate dashboard, then from the Mac:

```bash
VM=ubuntu@<the factory's IP>
printf 'BrowserStack username: '; read -r BSU; printf 'Access key: '; read -rs BSK; echo
printf 'BROWSERSTACK_USERNAME=%s\nBROWSERSTACK_ACCESS_KEY=%s\n' "$BSU" "$BSK" | ssh "$VM" 'sudo install -m 600 -o root /dev/stdin /etc/lumen-factory/browserstack.env && sudo systemctl daemon-reload'
unset BSU BSK
```

The factory's systemd unit reads that file if it exists. The credentials
reach the test container as environment variables, never on a command line.
On the Mac fallback, write the same two lines to
`~/lumen-factory/etc/browserstack.env` with `chmod 600`.

Until BrowserStack approves, `promote:check` refuses every promotion of
main. That is the plan's rule, not an accident.

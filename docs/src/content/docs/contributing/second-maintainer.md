---
title: Second maintainer
description: Onboarding for Lumen's second maintainer — access, the local checks, how to review a sensitive change and add the human-reviewed label, security reports, and what only the owner holds today.
---

Lumen has one human maintainer (Tal) and AI agents that open most pull
requests. Code that protects users — cryptography, vault writes, the privacy
ledger, CSP — must not depend on one person or be merged without a person
reading it. This page is everything a second maintainer needs on day one.

## 1. Access (Tal does this, ≈10 minutes)

```sh
# Invite with the Maintain role (merge, labels, advisories; no settings or deletion).
gh api -X PUT repos/talstilkol/lumen-md/collaborators/<login> -f permission=maintain
```

Then Tal adds `@<login>` after `@talstilkol` on each line of
`.github/CODEOWNERS`, in a pull request that he reviews himself (the file is
itself a sensitive path). From then on GitHub requests your review on every
pull request that touches a sensitive path.

## 2. Run everything locally (no GitHub Actions)

The repository runs no GitHub Actions. Every check runs on your machine:

```sh
git clone https://github.com/talstilkol/lumen-md && cd lumen-md
npm ci
npm run typecheck && npx vitest run          # unit and component tests
npm run build && npm run budget              # production build + bundle budget
npx playwright test --project=chromium       # end-to-end
bash tools/native-check/run.sh               # Rust and Java, offline (if present on the branch)
npm run pr:check -- --base origin/<base> --pr <n> --no-size   # the PR gate, before a merge
```

## 3. Reviewing a sensitive change

`npm run pr:check -- --pr <n>` lists the sensitive files a pull request
changes and fails until the `human-reviewed` label is on it, **added after the
last commit**. Agents never add that label: it means "a person read this
diff". Read the diff with the questions for its area:

| Area (paths in `.github/CODEOWNERS`) | Ask |
|---|---|
| Cryptography (`src/sync/e2ee/`, `src/collab/encryption.ts`, `src/storage/vault/encrypted/`, `src/lib/crypto*`, keychain, signing) | Only WebCrypto / platform primitives, no hand-rolled crypto? A fresh random nonce/IV per encryption, never reused with one key? KDF parameters not lowered? Keys never logged, sent, or stored in plain text? Authenticated encryption (GCM) checked before use? |
| Vault writes (`src/storage/vault/`, `src-tauri/vault/`, `src-tauri/src/lib.rs`, the Android SAF plugin) | Every path checked to stay inside the vault (`..`, absolute paths, symlinks)? Writes atomic (temporary file + rename)? A failure leaves the old note intact? |
| Privacy (`src/ai/privacyLedger.ts`, worker ledger, `src/ai/policy.ts`, telemetry) | Does a new host, category or rule let note text, keys or personal data leave the device without a user action? Is the default still local-only? |
| CSP, headers, policy (`src/build/cspEndpoints.ts`, `public/_headers`, `deploy/`, `scripts/headers.mjs`, `security/`) | No new wildcard, `unsafe-*`, or third-party host without a ledger entry? COOP/COEP unchanged unless intended? |
| Sanitisers and plugin sandbox | Untrusted HTML still sanitised? The plugin iframe still without `allow-same-origin`? |
| Native permissions (`src-tauri/capabilities/`, `tauri.conf.json`, `updates.rs`) | No broader `fs:`/`shell:` permission? Updates still signed and from the release host only? |

When it is right: approve the pull request in GitHub (your approval on the
head commit shows in the pr:check report), then add the label:

```sh
gh api -X POST repos/talstilkol/lumen-md/issues/<n>/labels -f "labels[]=human-reviewed"
```

If commits arrive after your review, the check fails again: review the new
commits, remove the label and add it again.

## 4. Security reports

Reports arrive as private GitHub advisories (`SECURITY.md`). Both
maintainers receive them. If Tal has not answered within 48 hours, you own
the report: acknowledge, triage, fix in the advisory's private fork, release,
publish.

## 5. What only the owner holds today

These are single points of failure until they are shared or escrowed; each
is an owner step (plan W4.7):

- the Vercel project and its domain `lumen-md.vercel.app`;
- the desktop updater signing key (minisign) and its password;
- the Apple Developer and Google Play accounts and signing keys;
- the GitHub repository's admin rights.

Recommended: a sealed copy of each key in a password manager shared by both
maintainers (1Password or Bitwarden "emergency access"), and admin rights for
the second maintainer after six months of reviews.

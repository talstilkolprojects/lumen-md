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

## 6. A second signing key

Each signing key should have a second holder, or a second key that is just as
valid, so that one lost laptop or one absent person stops nothing.

| What is signed | Today | With two maintainers |
|---|---|---|
| Your review and your commits | — | Each maintainer signs commits and tags with their own SSH key: `git config gpg.format ssh`, `git config user.signingkey ~/.ssh/id_ed25519.pub`, `git config commit.gpgsign true`, and the key is added on GitHub as a **signing** key. Its fingerprint goes in the table in `SECURITY.md` ("Maintainers and keys"). |
| Registry plugins (Ed25519, [Plugin signing keys](/plugins/signing/)) | Tal's key, if set | **A second key, not a copy.** `VITE_PLUGIN_TRUSTED_KEYS` is a JSON map of fingerprint → key, so both maintainers' public keys are trusted side by side. Each signs with their own key (`openssl genpkey -algorithm ed25519`), and either can revoke the other's by removing one entry. |
| Desktop updates (minisign, `tauri.conf.json` `plugins.updater.pubkey`) | Tal's key and password | The updater trusts **one** public key, so a second key is not possible. The private key and its password go into the shared emergency vault (section 7). To rotate: ship one release signed with the old key whose config carries the new `pubkey`. After that, releases are signed with the new key. |
| Android and iOS | Tal's accounts | The second maintainer is added to Google Play Console and App Store Connect with a release role. Signing keys go into the emergency vault. |

When the second maintainer joins: generate the keys, put both fingerprints in
`SECURITY.md`, and add `@<login>` to `.github/CODEOWNERS`. Both changes are
sensitive paths, so the other maintainer reviews them.

## 7. Emergency access

If one maintainer disappears, the other must be able to keep users safe: ship
a security fix, revoke a key, keep the site up.

1. **A shared emergency vault.** Use a password manager with delegated
   emergency access, for example Bitwarden's Emergency Access. A premium
   account names a trusted contact (a free account is enough for the
   contact). The contact requests access, and it is granted automatically
   after a wait time the holder chooses, unless the holder rejects it
   ([Bitwarden](https://bitwarden.com/help/emergency-access/)). Use **view**
   access with a 7-day wait. It holds:
   - the minisign key and its password;
   - the Android upload key and its password;
   - the Apple credentials;
   - the Vercel and Cloudflare recovery codes;
   - the GitHub recovery codes.
2. **GitHub successor.** Tal names the second maintainer as the
   **successor** of his personal account (Settings → Account → Successor
   settings → Add successor), so that the repository can continue if the
   account cannot
   ([GitHub Docs](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/maintaining-ownership-continuity-of-your-personal-accounts-repositories)).
3. **Security reports.** Both maintainers get every advisory. If one does not
   answer within 48 hours, the other owns it (`SECURITY.md`).
4. **A yearly drill.** Once a year, the second maintainer opens the
   emergency vault in view mode, checks that every key decrypts, and signs a
   test file with the minisign key. Then the holder rotates whatever was
   opened.

## 8. The weekly review queue

Once a week, either maintainer runs:

```sh
npm run review:queue -- --base verify/train-2 --out queue.md
```

It lists at most **five** open pull requests that change a sensitive path
and have not been human-reviewed since their last commit. They are ordered by
area (cryptography first), then by age. For each one, the queue gives:

- the sensitive files, by area;
- the questions from section 3;
- the tests in `src/__tests__` that import the changed modules;
- **attack cases** to try (a flipped ciphertext byte, a reused nonce, a
  `../` note name, `javascript:` links…);
- the commands to run.

It only reads from GitHub. Nothing is labelled or commented.

The goal is a median review time of **3 days or less**. A PR still in the
queue after a week goes first at the next sitting.

**Cryptography needs someone else.** On a PR that changes a path in the
*Cryptography* section of `.github/CODEOWNERS`, `npm run pr:check -- --pr <n>`
counts the `human-reviewed` label only when it was added by someone who is
**neither the repository owner nor the PR's author**. Tal and the agents have
written and tested that code themselves, so the point is a second person.

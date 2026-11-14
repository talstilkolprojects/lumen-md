---
title: Mutation testing
description: How Lumen checks that the tests of its security-critical code, such as encryption, the keyring, sync merges and the privacy ledger, really catch bugs.
---

Coverage tells you which lines ran, not whether a test would notice if they
were wrong. Mutation testing checks that. It plants small bugs in the code,
one at a time, and runs the tests each time. A test suite that still passes
with a bug in place has missed it.

## What is tested

The pure modules whose bugs would hurt most:

- **Encryption primitives:** ChaCha20-Poly1305, BLAKE2b, scrypt and Argon2id.
- **age** file encryption, and the **keyring** that holds the vault keys and
  devices.
- The **sync engine**: conflict merging, the manifest and blob headers.
- The **privacy ledger**, which records and blocks anything that would leave
  the device.
- The **secret store** (API keys and tokens: encrypted in the browser, or in
  the OS keychain on desktop), the **raw-HTML sanitizer** of the preview,
  Hebrew **text matching**, file **encryption**, **ZIP** import limits, and
  the **agent runtime**.

The list is in `scripts/mutation/targets.json`.

## The bugs it plants

| Kind | Example |
|---|---|
| Operators | `+` ↔ `-`, `<` ↔ `<=`, `===` ↔ `!==`, `&&` ↔ `\|\|`, `<<` ↔ `>>`, `^` → `&` |
| Constants | `n` → `n + 1` (`1` → `0`) |
| Booleans | `true` ↔ `false` |
| Negation | `!x` → `x` |
| Conditions | `if (c)` → `if (!(c))` |

Only code is mutated, never types, imports or comments. A mutant that
doesn't parse is left out. A mutant counts as **caught** when a test that
passes on the real code fails, when the run crashes, or when it hangs.

## Running it

```sh
npm run test:mutation                          # all modules, fails under 80%
node scripts/mutation/run.mjs --module keyring # one module
node scripts/mutation/run.mjs --max 200        # a bigger sample per module (still an estimate)
```

The report, with the score per module and every surviving mutant's line, is
written to `reports/mutation/`. The floor is a score of at least
80% per module, on a full vitest run (a sample is only an estimate). A mutant that survives in a security module should get a
test that catches it.
---
title: Mutation testing
description: How Lumen checks that the tests of its security-critical code, such as encryption, the keyring, sync merges and the privacy ledger, really catch bugs.
---

Coverage tells you which lines ran, not whether a test would notice if they
were wrong. Mutation testing checks that. It plants small bugs in the code,
one at a time, and runs the tests each time. A test suite that still passes
with a bug in place has missed it.

## What is tested

The pure modules whose bugs would hurt most:

- **Encryption primitives:** ChaCha20-Poly1305, BLAKE2b, scrypt and Argon2id.
- **age** file encryption, and the **keyring** that holds the vault keys and
  devices.
- The **sync engine**: conflict merging, the manifest and blob headers.
- The **privacy ledger**, which records and blocks anything that would leave
  the device.
- The **secret store** (API keys and tokens: encrypted in the browser, or in
  the OS keychain on desktop), the **raw-HTML sanitizer** of the preview,
  Hebrew **text matching**, file **encryption**, **ZIP** import limits, and
  the **agent runtime**.

The list is in `scripts/mutation/targets.json`.

## The bugs it plants

| Kind | Example |
|---|---|
| Operators | `+` ↔ `-`, `<` ↔ `<=`, `===` ↔ `!==`, `&&` ↔ `\|\|`, `<<` ↔ `>>`, `^` → `&` |
| Constants | `n` → `n + 1` (`1` → `0`) |
| Booleans | `true` ↔ `false` |
| Negation | `!x` → `x` |
| Conditions | `if (c)` → `if (!(c))` |

Only code is mutated, never types, imports or comments. A mutant that
doesn't parse is left out. A mutant counts as **caught** when a test that
passes on the real code fails, when the run crashes, or when it hangs.

## Running it

```sh
npm run test:mutation                          # all modules, fails under 80%
node scripts/mutation/run.mjs --module keyring # one module
node scripts/mutation/run.mjs --max 200        # a bigger sample per module (still an estimate)
```

The report, with the score per module and every surviving mutant's line, is
written to `reports/mutation/`. The floor is a score of at least
80% per module, on a full vitest run (a sample is only an estimate). A mutant that survives in a security module should get a
test that catches it.

## The 80% floor in every preview build

The critical modules (the `critical` list in `targets.json`) must score at
least **80%**:

- encryption: the primitives, age, the keyring and `storage/encryption`
- sync: conflict, manifest and header
- the privacy ledger
- the raw-HTML sanitizer
- the secret store
- vault writes: `storage/vault/shared` and `handleBackend`

`npm run test:mutation` fails when any module is under 80%.

A full run takes too long for a preview build, so the build checks a
**receipt** instead. `scripts/mutation/receipt.json` records each critical
module's last score and the sha256 of the source it was measured on.
`npm run mutation:check`, a preview-build gate, fails when a critical module
on the branch:

- has no score in the receipt,
- scores under 80%,
- changed since its score was measured, or
- has only an **estimate**.

A score counts only when it comes from real vitest over **every** mutant
(`runner: "vitest"` and `sampled` equal to `mutants` in the receipt). A run
in the offline shim, or a sample such as 80 of 502 mutants, is shown as
`~90% estimated (80/502 mutants, runner shim)`, and the gate does not pass
it. Until a full vitest run is committed, the gate stays red.

After changing a critical module, measure it again under vitest, over every
mutant, and commit the receipt:

```sh
node scripts/mutation/run.mjs --critical --module privacyLedger --receipt --max 100000
```

A module that isn't on the branch yet (it comes with another pull request)
is listed and skipped.

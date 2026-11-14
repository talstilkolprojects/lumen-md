---
title: "Code checks: strings, coverage, vault backends"
description: Three checks a contributor meets in the code itself — no user-visible string outside t(), test coverage over all of src/, and one contract suite every vault backend passes.
---

These checks guard the code rather than a feature. Each one names the
command that runs it locally.

## No hard-coded strings

Every string a user can see goes through `t()`, so it can be translated.
`npm run i18n:hardcoded` (`scripts/check-i18n-hardcoded.mjs`) reads the
TypeScript syntax tree of `src/`, so code, comments and class names are
never mistaken for text, and fails on:

| Kind | Example |
|---|---|
| text between JSX tags | `<button>Save</button>` |
| a string literal as a JSX child | `<p>{"Saved"}</p>` |
| a literal in a visible prop | `aria-label="Close"`, `title`, `placeholder`, `alt`, `label` |
| a literal passed to a message | `showAiToast("Saved")`, `alert("…")` |

Only strings with words count: symbols, numbers, keys and product or
format names (Markdown, GitHub, JSON) are not translated. A real exception
carries `i18n-allow: <reason>` in a comment on its line or the line above.
The check is part of `npm run i18n:check`, which every
[branch build](/contributing/checks/) runs.

## Test coverage over all of src

`npm run test:coverage` measures every folder of `src/`. Only three kinds
of file are left out, each for a reason other than "hard to test": the
tests and their helpers, type-only declaration files, and the boot entry
`src/main.tsx`, whose import starts timers and mounts the app (everything
it wires up is covered on its own). `npm run ci:local -- --coverage`
applies the gate to a full local run: at least 65% of lines.

## One contract for every vault backend

Every place notes are stored, the browser's private storage (OPFS), a
folder picked in the browser, the desktop app's folder, the phone's
folders and the in-memory store, implements the same `VaultBackend`
interface. `src/__tests__/vaultBackend.contract.test.ts` runs one suite
over all of them, and over the encrypted layer on top of each: listing,
reading, writing, renames, removal, and the same errors for a
missing file or a conflict. A new backend joins by adding one line to the
suite's `backends` list, and is done when that suite passes. What users
see of it is described in [Your vault in a folder](/workspace/vault-folder/).

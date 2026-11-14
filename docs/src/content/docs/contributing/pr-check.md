---
title: The PR check
description: npm run pr:check is the local PR gate that replaces Danger.js and size-limit. It reports bundle size against the base, PR body sections, [skip ci] commits, unregistered network calls, licences and the domain rule.
---

Lumen runs no GitHub Actions on pull requests. Danger.js and size-limit
need Actions, so one local command replaces them (plan 0.19):

```bash
npm run build
npm run pr:check -- --base origin/main --body pr-body.md --build-base --out pr-check.md
```

The report is Markdown. Paste it into the pull request. The command exits
with 1 when a check fails. Warnings do not fail it.

## The checks

- **Bundle size.** The gzipped size of each chunk class (`npm run budget -- --json`),
  compared with the base, as a table. The bundle budget's own verdict
  decides pass or fail. The base's sizes come from one of:
  - `--base-sizes <file>`;
  - `--build-base`, which builds the merge base in a temporary worktree
    that links this checkout's `node_modules`.
- **Commits.** Every subject from the merge base to `HEAD` contains
  `[skip ci]`.
- **PR body.** The file passed with `--body` has every section, none
  empty:
  - What and why
  - Definition of done (plan 0.7)
  - Local verification
  - Not verified here
  - Owner commands
- **Network.** Every new call that sends a request (`fetch`, `WebSocket`,
  `EventSource`, `sendBeacon`, `importScripts`) goes to a host listed in
  the privacy ledger (`src/ai/privacyLedger.ts`). A call whose URL is
  computed instead needs a `// privacy-ledger: <rule>` comment.
- **Licences.** Every production package added or changed in the
  lockfile has an allowed licence (no copyleft, no non-commercial, not
  missing).
- **Domain.** No added line names the project's domain.
- **Snapshots.** A snapshot (`__snapshots__/`, `*.snap`, Playwright's `-snapshots/`) is never edited by hand. The commit that changes one changes nothing else and carries a trailer `Snapshot-Regenerated: npx vitest run <file> -u on <host>` (or `--update-snapshots`), naming the second host it was regenerated on (plan W6.15).

It also warns:
- when source changed and no test did;
- when an AI agent wrote the PR (add the `ai-written` label).

## Options

| Option | Meaning |
|---|---|
| `--base <ref>` | The branch the PR goes into (default `origin/main`) |
| `--body <file>` | The PR description, to check its sections |
| `--base-sizes <file>`, `--head-sizes <file>` | Sizes already measured |
| `--build-base` | Build the base to measure it |
| `--no-size` | Skip the size check |
| `--out <file>` | Write the report |

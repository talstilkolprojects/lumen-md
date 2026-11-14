# Parallel lanes

How several people or agents work on Lumen at the same time without stepping
on each other, and how their work comes back together. Two scripts carry the
mechanics: `scripts/lane.sh` opens a lane, `scripts/lane-merge.sh` brings lanes
home. This page is the protocol around them.

## The idea in one paragraph

Each piece of work runs in its own **lane**: one git worktree on one branch,
with its own dev-server port, so lanes can typecheck, test and run e2e side by
side. Lanes are grouped by area (D, S, A, U) so that two lanes running at once
rarely edit the same files. A **coordinator** — one person or agent — is the
only one who merges lanes, installs packages and pushes. Conflicts are planned
away up front (conflict groups, below) instead of fixed after the fact, and the
two files that conflict mechanically every time (`i18n/keys.json`,
`package-lock.json`) are regenerated, never hand-merged.

## Lanes

| Lane | Area | Paths it owns |
| --- | --- | --- |
| **D** | Dev tooling, CI, build | `scripts/`, `.github/`, `e2e/`, `src/build/`, `docs/dev/`, `vite.config.ts`, `playwright.config.ts`, `lighthouserc.json`, `package.json` + lockfile, `Dockerfile` |
| **S** | Storage and sync | `src/storage/`, `src/sync/`, `src/collab/`, `src/store/`, `sync-server/` |
| **A** | AI and agents | `src/ai/`, `src/agents/`, `src/research/` |
| **U** | UI and i18n | `src/ui/`, `src/components/`, `src/layouts/`, `src/views/`, `src/editor/`, `src/renderer/`, `src/plugins/`, `src/i18n/`, `i18n/` |

Everything else (`src/App.tsx`, `src/pwa/`, `src/lib/`, top-level docs) has no
default lane; the coordinator assigns it. `scripts/review-triage.mjs --lanes`
suggests a lane for each review finding from its path with this same split.

## Rules

1. **One worktree per lane.** Never two lanes in one checkout, never one lane
   in two checkouts. Open it with:

   ```sh
   scripts/lane.sh fix/sync-retry main
   # → ../w-fix-sync-retry on branch fix/sync-retry, node_modules symlinked,
   #   playwright.lane.config.ts on a free port, baseline tsc printed
   ```

   `LUMEN_NODE_MODULES` picks the node_modules to link (default: the main
   checkout's). The link shares the installed packages only: with a
   symlinked node_modules, vite.config.ts keeps Vite's cache (pre-bundled
   deps, vitest results) in the lane's own `.vite/`, so two lanes' dev
   servers never swap files under each other. `PW_CHROMIUM` a Chromium binary for e2e, `LANE_PORT` a fixed
   port. Run e2e in a lane with `npx playwright test -c playwright.lane.config.ts`.
   Note the baseline tsc result: errors it prints were there before you started.
2. **Stay inside your conflict groups.** Before starting, the coordinator
   assigns each lane its groups (below). Two lanes that run at the same time
   never share a group. If a lane needs a file from another group, it asks the
   coordinator, who either moves the work or serialises the two lanes.
3. **Hot shared files** — `src/App.tsx`, `package.json`, `vite.config.ts`,
   `src/i18n/index.ts` — take small, append-only edits (add an import, add
   keys at the end of their section). No reformatting, no reordering.
4. **No installs in a lane.** A lane that needs a new package adds it with
   `npm install <pkg> --package-lock-only` (package.json + lockfile only, no
   download into the shared node_modules) and says so in its hand-off. The
   coordinator installs after merging.
5. **Never push, never open PRs from a lane.** The coordinator does both.
6. **Generated files are regenerated, not edited:** `i18n/keys.json` with
   `node scripts/extract-i18n-keys.mjs` (it carries no timestamp, so two
   regenerations of the same strings are identical), `package-lock.json`
   with `npm install --package-lock-only`.
7. **Leave the lane green:** `npx tsc --noEmit -p .` no worse than the
   baseline, and the vitest files you touched passing.

## Conflict groups

A group is a set of files that changes together. Two concurrent lanes never
hold the same group.

| Group | Covers |
| --- | --- |
| **editor** | `src/editor/**` (CodeMirror + Milkdown: keymaps, extensions, WYSIWYG, suggesting) |
| **render** | `src/renderer/**`, `src/plugins/**` (blocks), `src/lib/markupSanitizer.ts`, `src/lib/urlSanitizer.ts` |
| **csp** | `vercel.json`, `netlify.toml`, `public/_headers`, `index.html` (CSP meta), `src/build/cspEndpoints.ts`, `src/lib/cspConnect.ts`, `src/lib/trustedTypes*.ts`, `src/plugins/sandbox.ts` |
| **store** | `src/store/**` (`useStore.ts`, `openDocs.ts`, toasts) |
| **search** | `src/ui/SearchDialog.tsx`, `src/ui/SearchReplace.tsx`, `src/ai/semanticSearch.ts`, `src/ai/neuralSearch.ts`, `src/ai/search.worker.ts`, `src/storage/workspaceIndex.ts`, `src/storage/searchHistory.ts`, `src/editor/searchHighlight.ts` |
| **settings** | `src/ui/*Settings*.tsx`, `src/ui/AiSettingsPanel.tsx`, `src/lib/themeSettings.ts`, `src/lib/orgSettings.ts`, `src/lib/configHealth.ts` |
| **ci** | `.github/**`, `scripts/**`, `playwright.config.ts`, `lighthouserc.json`, the build half of `vite.config.ts`, `Dockerfile`, `fly.toml` |
| **commands** | `src/commands/**`, `src/ui/CommandPalette.*`, `src/ui/KeyboardShortcuts.tsx`, `src/editor/slashCommands.ts`, `src/editor/keymapExtra.ts` |
| **i18n** | `src/i18n/**`, `i18n/keys.json` |
| **tree** | `src/ui/FileTree.*`, `src/ui/FileContextMenu.tsx`, `src/ui/TrashPanel.tsx`, `src/storage/workspace*.ts`, `src/storage/fileOps.ts`, `src/storage/trash.ts` |
| **history** | `src/storage/history.ts`, `src/ui/VersionHistory.tsx`, `src/collab/versionHistory.ts` |
| **sync** | `src/sync/**`, `src/collab/**` (except `versionHistory.ts`), `sync-server/**` |
| **agents** | `src/agents/**`, `src/ai/**` outside the search files, `src/research/**`, `scripts/agent-eval.mjs`, `scripts/fake-ollama.mjs` |

Files outside every group (for example `src/lib/` helpers not listed) go to
whichever lane asks first; tell the coordinator.

## Commits

Conventional Commits (see `CONTRIBUTING.md`), one logical change per commit,
and every commit message ends with the attribution lines of the session that
made it:

```
fix(sync): retry the push after a 409 from the remote

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_<id>
```

Merge commits made by `lane-merge.sh` get the same lines when they are put in
`LANE_TRAILER`.

## Merging (coordinator)

```sh
LANE_TRAILER="$(printf 'Co-Authored-By: …\nClaude-Session: …')" \
  scripts/lane-merge.sh fix/review-batch fix/sync-retry fix/ui-rtl chore/ci-cache
```

For each branch, in order: `git merge --no-ff`. If the only conflicts are in
`i18n/keys.json` or `package-lock.json`, they are regenerated from the merged
sources and the merge commits (with a "Generated files: …" line in its
message). A keys.json that merged cleanly but went stale — both sides bumped
`count` to the same number — is regenerated inside the merge as well, and a
merge that touches `package.json` or `package-lock.json` gets
`npm install --package-lock-only` before it commits (a clean textual merge
of two dependency changes can still leave the lockfile incomplete).
Any other conflict stops the run with the merge left in progress and prints
the command to continue with the remaining branches (for the last branch,
the same command again: it skips that branch and still runs the dependency
and i18n gates before the checks). If dependencies changed
on the target after node_modules was last installed (the last commit
touching package.json / package-lock.json is newer than
node_modules/.package-lock.json, so this also holds for a run resumed after
a conflict), or node_modules was installed from another lockfile (npm's
hidden node_modules/.package-lock.json lacks a package this lockfile needs
at its version, or has one it does not know: an install made on another
branch), the run stops before the checks (exit 2): run `npm install`
(lanes only touched the lockfile), then the same command again — merged
branches are skipped and the checks run. `LANE_INSTALL=1` does the install
itself (it changes the node_modules the lanes link to). The checks are
`npx tsc --noEmit -p .`, the i18n staleness check and `npx vitest run`; the
run prints one line per branch plus the check results. Then the coordinator
pushes and opens or updates the PR.

## Answering review comments

A lane that fixes review findings hands back a **decisions table**, one line
per review comment, tab-separated, no header:

```
comment_id<TAB>verdict<TAB>sha<TAB>reason
4305258504	fixed	1a2b3c4	share launches get a collision-free tab name
4305258507	already-fixed	9f8e7d6	launch queue keeps the file handles since the PWA rewrite
4305265210	wontfix	-	Untitled.md reuse is intended: the shortcut focuses the empty draft
```

- `comment_id` — the review comment's numeric id (from
  `node scripts/review-triage.mjs`).
- `verdict` — exactly one of `fixed`, `already-fixed`, `wontfix`.
- `sha` — the commit that fixes it (`fixed`), the commit that had already fixed
  it (`already-fixed`), or `-` (`wontfix`).
- `reason` — one line, shown to the reviewer.

The coordinator merges the lanes, then posts the replies with
`node scripts/review-reply.mjs decisions.tsv --pr-fix <N>` (dry run; add
`--go` to post). `fixed` and `already-fixed` threads are resolved, `wontfix`
threads are answered and left open for the reviewer.

## Handoff — `npm run handoff`

`npm run handoff -- --task "<what is in progress>" --next "<the next step>"` writes `docs/dev/HANDOFF.md`, which contains:

- the open PRs as a stack, with the latest CI result for each and its count of review comments that have no reply yet;
- the worktrees;
- the current task and the next step;
- a check that every branch and worktree it names exists. If any is missing, the script exits 1 and lists the problem.

Run it at the end of every PR. The file is gitignored on purpose: every lane would otherwise conflict on it. The coordinator copies it to the claude.ai project doc so the next session reads it there.

`--stdout` prints the file instead of writing it. `--no-github` skips the GitHub calls (no PRs).

## Stopping and resuming

A session can stop at any point. Each lane keeps a `STATE.md` (branches and
the heads origin has, tasks, pushes, what it waits on, the next step), and a
resumed lane starts with `node scripts/lane-state.mjs resume <STATE.md>`,
which says per branch whether to push, open a PR, or push nothing. The
template and the resume steps are in [lane-state.md](lane-state.md).

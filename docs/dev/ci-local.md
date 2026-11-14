# CI on your machine — `npm run ci:local`

`npm run ci:local` runs what CI's `check` job runs, then e2e on Chromium against the production build:

typecheck → hygiene → lint → i18n (keys + en/he drift) → licence gate → security headers → vitest → build → bundle budget → e2e.

A step whose tool doesn't exist on this branch (no `lint` script yet, no licence gate, no `scripts/headers.mjs`) shows up as "not here". It is not a failure.

| Command | What it runs |
|---|---|
| `npm run ci:local` | Everything (vitest without coverage). |
| `npm run ci:local -- --coverage` | Vitest with coverage, failing below CI's 65% lines gate (read from `coverage/coverage-summary.json`). Full runs only: with `--changed` the gate is not checked. |
| `npm run ci:local -- --changed` | Only what the diff can break: `vitest related` for the changed files. Changed means committed, staged, unstaged and new untracked files. Build, budget and e2e run only when app code changed (sources, specs, scripts, `public/`, any root `.html` entry, the build configs; deleted files count). A deleted code file, a changed module that something loads with a dynamic `import()` (`vitest related` follows static imports only), or a changed non-code input such as a locale or `public/_headers`, runs the whole vitest suite; a moved file counts by its old path too; e2e specs are not vitest inputs. e2e is the smoke test plus the changed specs. The base is the upstream branch, else `origin/main`. |
| `npm run ci:local -- --changed --base origin/fix/codex-backlog` | The same, against an explicit base (stacked branches). |
| `--skip e2e,build` / `--only typecheck,test` | Pick steps by id: `typecheck`, `hygiene`, `lint`, `i18n`, `licenses`, `headers`, `test`, `build`, `budget`, `e2e`. |
| `--bail` | Stop at the first failure. |
|  | An unknown flag or step id is an error (exit 2), and a run in which no step ran exits 1. |
| `npm run ci:local -- --install-hook` | Pre-push hook that runs `ci:local --changed --skip e2e --bail`. Bypass it once with `git push --no-verify`. An existing pre-push hook that isn't ours is left alone (exit 1); `--force` saves it as `pre-push.bak` first. |

For e2e, `ci:local` serves `dist/` with `vite preview` on a free port and runs Playwright's Chromium project. The build is the Build step's from the same run; otherwise (`--only e2e`, `--skip build`) e2e builds first, never trusting a `dist/` from earlier. The bundle budget works the same way. It uses a lane's `playwright.lane.config.ts` when there is one (see lanes.md). Set `PW_CHROMIUM` if Playwright's own Chromium isn't installed; `playwright.config.ts` reads it too.

It prints a summary table with the time each step took, and exits 1 if any step failed.

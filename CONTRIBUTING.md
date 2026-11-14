# Contributing to Lumen

Thanks for your interest in Lumen! This document explains how to set up the project, the conventions we follow, and how to submit changes.

## Setup

```bash
git clone <repo-url>
cd "md editor"
npm install
npm run dev        # http://localhost:5173
```

For desktop:

```bash
npm run tauri:dev
```

For mobile (after `npx cap add ios|android`):

```bash
npm run build
npx cap sync
npx cap run ios   # or android
```

## Architecture overview

```
src/
├── ai/           # AI prompts, grammar, fine-tune, agents
├── auth/         # Auth providers (local, Supabase)
├── billing/      # Stripe checkout, entitlement store
├── collab/       # Yjs/WebRTC real-time collaboration
├── commands/     # Command palette registry
├── components/   # Composite React components (overlays)
├── data/         # Smart-detect, embed detection
├── editor/       # CodeMirror editor, WYSIWYG (Milkdown)
├── hooks/        # React hooks (drag-drop, collab, Tauri)
├── i18n/         # Internationalization (8 locales)
├── layouts/      # EditorLayout (mode switching)
├── lib/          # Shared utilities (crypto, logger, audit)
├── plugins/      # Plugin system, sandbox, blocks (charts, maps, etc.)
├── renderer/     # Markdown → HTML pipeline, Shiki
├── storage/      # OPFS workspace, file formats, export
├── store/        # Zustand global state
├── sync/         # Cloud sync, publish
├── ui/           # All UI components (toolbar, dialogs, panels)
└── views/        # Specialized views (database, graph, louvain)
```

**Key design decisions:**

- **Local-first.** All data stays in the browser (OPFS) by default. Cloud features are opt-in.
- **No `any`.** TypeScript strict mode is enforced. Use `unknown` + narrowing.
- **No hardcoded English.** Every user-facing string uses `t("key")` from `src/i18n/index.ts`.
- **Lazy everything.** Heavy libraries (Mermaid, ECharts, tldraw, Graphviz) are `lazy()` imports.
- **Plugin sandbox.** Third-party plugins run in a sandboxed `<iframe>` with restricted CSP.

## Branches

- `main` — protected, always green.
- `track/<area>` — feature branches by area (e.g. `track/observability`, `track/types`).
- `fix/<short-desc>` — bug fixes.
- `chore/<short-desc>` — tooling, deps, docs.

## Commits

Use Conventional Commits:

- `feat(scope): summary`
- `fix(scope): summary`
- `chore(scope): summary`
- `docs(scope): summary`
- `test(scope): summary`
- `refactor(scope): summary`

Scopes are area names: `editor`, `renderer`, `collab`, `storage`, `ui`, `ai`, `i18n`, `infra`, `billing`, `auth`, `plugins`, etc.

## Pull Requests

1. Open against `main`.
2. Ensure CI passes: `npm run typecheck && npm run test && npm run build`.
3. Add a short description: what changed, why.
4. Link any related issue.
5. One of the maintainers will review.

### The PR check (replaces Danger)

GitHub Actions do not run on PRs, so Danger.js and size-limit, which need
them, are replaced by one local command (plan 0.19):

```bash
npm run build
npm run pr:check -- --base origin/main --body pr-body.md --build-base --out pr-check.md
```

It prints a Markdown report. Paste it into the PR, or use `--out`. It
exits 1 when a check fails:

| Check | Fails when |
|---|---|
| Bundle size | the bundle budget fails. The size table against the base comes from `--base-sizes <bundle-budget --json file>`, or `--build-base`, which builds the merge base in a temporary worktree |
| Commits | a subject in base..HEAD lacks `[skip ci]` |
| PR body | `--body <file>` lacks a section, or one is empty: What and why, Definition of done (plan 0.7), Local verification, Not verified here, Owner commands |
| Network | a new `fetch` / `WebSocket` / `EventSource` / `sendBeacon` goes to a host that is not in `src/ai/privacyLedger.ts`, or has a computed URL without `// privacy-ledger: <rule>` |
| Licences | a production package added or changed has a copyleft, non-commercial, or no licence |
| Human review | a path in `.github/CODEOWNERS` (crypto, vault writes, privacy ledger, CSP/policy, native permissions) changed and, with `--pr <n>`, the PR has no `human-reviewed` label added after its last commit (without `--pr`: a warning) |
| Domain | an added line names the project's domain |

It also warns (without failing):
- when source changed but no test did;
- when the PR was written by an AI agent: add the `ai-written` label.

**The `human-reviewed` label is a person's word that they read the diff.** An AI agent never adds it, never asks for it to be added without a review, and never removes and re-adds it. Before merging, Tal runs `npm run pr:check -- --base origin/<base> --pr <n> --no-size`; on a sensitive path it fails until the label is newer than the last commit. Reviewer checklist: docs page *Second maintainer* (`docs/src/content/docs/contributing/second-maintainer.md`).

## Testing

### Structure

- **Unit tests** live in `src/__tests/` and run with Vitest (jsdom environment).
- **E2E tests** live in `e2e/` and run with Playwright.
- Run unit tests: `npm run test` (single-shot) or `npm run test:watch`.
- Run E2E: `npx playwright test` (requires a running dev server).

### Local visual preview (every surface, LTR/RTL, dark/light)

No Vercel preview needed: build, then screenshot every main surface
(split, source, preview, WYSIWYG, palette, shortcuts, plugins, templates,
AI settings, AI doctor) in English and Hebrew, dark and light:

```bash
npm run build
npm run preview:visual                     # → visual-results/<run>/index.html
npm run preview:visual -- --baseline visual-results/<older-run>   # pixel diff, exit 1 on change
npm run preview:visual -- --only palette,wysiwyg --url http://localhost:5173
```

Each shot is also checked for horizontal overflow and for `<html dir>`
matching the locale. Take a baseline before a visual change and compare
after it; `--threshold` (default 0.5 %) sets how much may differ.

### Visual (pixel-diff) baselines

`e2e/visual-smoke.spec.ts` pins the Mermaid diagram with
`toHaveScreenshot()` (chromium only, `maxDiffPixelRatio: 0.02`). Baselines
live next to the spec in `e2e/visual-smoke.spec.ts-snapshots/` and are
per-platform (`…-chromium-linux.png`).

- **First run without a baseline** writes one and passes with a
  `baseline-created` annotation (so CI can produce it). Download it from
  the CI artifacts or regenerate locally, review it, and commit it.
- **Intentional visual change** (Mermaid theme, block CSS): regenerate with

  ```bash
  npx playwright test e2e/visual-smoke.spec.ts --project=chromium --update-snapshots
  ```

  and commit the updated PNG together with the change. Generate Linux
  baselines on Linux (or in CI) — macOS font rendering differs.

### Guidelines

- Add a test for any non-trivial change.
- Test **pure functions** in isolation — avoid testing React hooks/components unless they have significant logic.
- Use `vi.mock()` for browser APIs (OPFS, IndexedDB, WebCrypto) that don't exist in jsdom.
- For async tests involving `IndexedDB`, use the `fake-indexeddb` shim already wired in `setup.ts`.
- Match the naming convention: `src/__tests__/<module>.test.ts` (same basename as the source file).

### Coverage

- **Current:** 131 test files, 1074 passing tests, 97% line coverage.
- The CI gate requires `npm run typecheck && npm run test` to pass on every push.
- The i18n drift gate (`i18nDrift.test.ts`) ensures every key in the `en` bundle exists in all 8 locale files.

## Internationalization (i18n)

**Golden rule:** Never write a user-visible English string directly in JSX or TypeScript. Always use `t("key")`.

### Adding a new string

1. Add the English key to the `en` object in `src/i18n/index.ts`.
2. Add the Hebrew translation to the `he` object in the same file.
3. Add the key (with English fallback) to all 6 lazy locale files in `src/i18n/locales/*.json`.
4. Run `npm run test` — the `i18nDrift.test.ts` gate will fail if any locale is missing the key.

### RTL support

- The app supports RTL (Hebrew, Arabic). The `<html dir>` attribute is set automatically.
- Test your UI changes in both LTR and RTL by switching via `⌘K → Language: עברית`.

## Code Style

- TypeScript strict mode is enabled — fix type errors, do not suppress them.
- Avoid `any`; prefer `unknown` + narrowing.
- Prefer existing utilities (`src/lib/`) before adding new ones.
- For UI changes, keep components small and composable.
- Use `t("key")` from `src/i18n/index.ts` for any user-facing string.
- Use `log.info()` / `log.warn()` / `log.error()` from `src/lib/logger.ts` — never bare `console.*`.
- Use `randomId()` from `src/lib/cryptoRandom.ts` — never `Math.random()` for IDs or tokens.

## Plugin Development

Lumen plugins run in a sandboxed iframe. To create a plugin:

1. Implement the `LumenPlugin` interface (see `src/plugins/pluginSystem.ts`).
2. Export an `activate(api)` function — the API gives you `getContent()`, `setContent()`, `getFileName()`, `showToast()`.
3. Sign your plugin with Ed25519 if distributing publicly (see `src/plugins/signing.ts`).
4. Test locally by dropping the plugin JSON into the Plugin Gallery.

## CI Pipeline

The GitHub Actions workflow (`.github/workflows/ci.yml`) runs on every push:

1. **`npm run typecheck`** — Zero TypeScript errors required.
2. **`npm run test`** — All unit tests must pass (including the i18n drift gate).
3. **`npm run build`** — Production bundle must build without errors.
4. **`npm run lint`** — ESLint (typescript-eslint, react-hooks, jsx-a11y). Violations that predate it are recorded in `eslint-suppressions.json`; a new one fails. Notable rules: `react-hooks/rules-of-hooks`, `@typescript-eslint/no-floating-promises` (mark fire-and-forget calls with `void`), and `lumen/empty-catch-why` (an empty `catch` needs a `// why: …` comment). When you fix a recorded violation, run `npm run lint:prune` and commit the smaller baseline. Never add to the baseline with `--suppress-all`.

## Security

See [SECURITY.md](SECURITY.md) for the vulnerability reporting process and the project's security architecture.

## Questions

Open a discussion on the repo, or comment on the relevant issue.

By contributing, you agree your contributions will be licensed under the project's [MIT License](LICENSE).

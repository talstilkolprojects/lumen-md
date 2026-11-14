# Unused-file gate (plan 0.16)

CI step **"Unused files"** (`npm run unused` = `node scripts/check-unused-files.mjs`)
fails when a production file under `src/` is not reachable from any entry point.

**Entry points:** the module scripts of the root `*.html` pages and `public/*.html`,
plus every test in `src/` (`__tests__/`, `*.test.*`, `*.spec.*`, `*.eval.*`) and every code
file outside `src/` — `e2e/`, `scripts/`, `eval/`, the root configs, and the executables and
packages that reuse `src/` (`bin/`, `api-server/`, `mcp-server/`, `packages/`, `extension/` …). **Edges:** static and dynamic imports, re-exports,
`require`, `vi.mock`, `new URL("…", import.meta.url)` workers and `import.meta.glob`,
resolved relative to the file or through the `@/` alias.

The scan is textual, so it can only err towards "used". Today's orphans are listed in
`scripts/unused-files.baseline.json`; the list only shrinks:

| Situation | What to do |
| --- | --- |
| ✗ `src/x.ts — nothing imports it` | import it where it's used, or delete it |
| ✗ `… is no longer an orphan` | `node scripts/check-unused-files.mjs --prune` and commit the baseline |

`--json` prints the counts; `--write` rebuilds the baseline from scratch and is an
owner decision (it can hide new dead code).

Unused **exports** and **dependencies** — the rest of knip — need the `knip` package,
which is added on a machine with registry access (`npm install -D knip --package-lock-only`).

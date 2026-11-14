# Dependabot PRs: one decision each (plan W6.14, W10.D10)

The decision table for every dependabot PR opened against `main`. It started in
#499's description (lane NC4, 14.11). The six PRs opened since then are added
at the end. Dependabot PRs target `main`, which is frozen, and are generated
from `main`'s lockfiles, so none can be merged as-is into a train without a lock
conflict. The path is **one dependency train**: apply the "safe" rows with a
real `npm install` or `cargo update` on a host that reaches the registry, in
`verify/deps`, then close the PRs it covers. Closing and merging are the
owner's.

Decisions: **Superseded** (the update is already in a train, or a newer PR
replaces it), **Close, not used**, **Safe → deps train**, **Major migration**
(its own task) and **Major: decline**.

| PR | Update | Decision | Reason |
|---|---|---|---|
| #324 | zod 4.3.6 → 4.6.7 (mcp-server) | **Superseded by #494** | already 4.6.7 in #494 |
| #323 | body-parser 2.3.0 → 2.4.0 (mcp-server) | **Superseded by #499** | folded (high fix) |
| #317 | fast-uri 3.1.8 → 3.1.9 (mcp-server) | **Superseded by #499** | folded |
| #318 | fast-uri 3.1.8 → 3.1.9 (root, dev) | **Superseded by #499** | folded |
| #319 | @modelcontextprotocol/sdk 1.32.1 → 1.32.2 | **Superseded by #499** | folded |
| #326 | ws 8.22.0 → 8.22.1 (sync-server) | **Superseded by #499** | folded. Its lock also drops `@y/websocket-server`, which is an artefact of `main`'s older sync-server lock; not taken |
| #151 | actions/cache 5 → 6 | **Close, not used** | no GitHub Actions in this repo (owner rule) |
| #152 | actions/download-artifact 7 → 8 | **Close, not used** | same |
| #329 | isomorphic-git 1.37.5 → 1.38.6 | **Safe → deps train** | minor, in `^1.37.5`. The safe-git path (3.3) is sensitive: run `safeGit` tests + the git e2e |
| #328 | @astrojs/starlight 0.42.6 → 0.42.8 (docs) | **Safe → deps train** | patch, docs site only |
| #327 | astro 7.4.0 → 7.4.5 (docs) | **Safe → deps train** | patch, docs site only; with #328 |
| #325 | renderer-vendors: @hpcc-js/wasm 2.36.0, abcjs 6.7.2, katex **0.19.1**, shiki 4.6.0 | **Safe → deps train, katex checked** | katex 0.18 → 0.19 is a 0.x minor (it may break): run the math render tests and visual specs. The others are in-range minors. Bundle budget after |
| #320 | tauri-plugin-dialog 2.8.3 → 2.8.4 | **Safe → deps train (cargo)** | patch; do it with the zip `cargo update` |
| #296 | tauri-build 2.7.3 → 2.7.4 | **Safe → deps train (cargo)** | patch; same |
| #294 | tauri 2.12.4 → 2.12.5 | **Safe → deps train (cargo)** | patch; same |
| #167 | @tauri-apps/cli 2.10.1 → 2.12.2 | **Safe → deps train** | minor, in `^2.10.1`; it aligns the CLI with the `tauri` 2.12 crate |
| #264 | dev-tools: @playwright/test 1.64.1, @testing-library/* patches, axe-core 4.14.0, fake-indexeddb 6.2.6 | **Safe → deps train, with care** | in range. Playwright 1.59 → 1.64 brings new browser builds: re-run e2e on 3 browsers, and the WebKit note of W6.6 applies |
| #168 | vue 3.5.43 → 3.5.44 | **Safe → deps train** | patch. vue is pinned exactly (dev), so the manifest changes |
| #162 | yjs 13.6.33, y-codemirror.next 0.3.6 | **Safe → deps train** | patches with identical dependencies (checked: lib0 `^0.2.99` / `^0.2.42` both satisfied). Not folded here because yjs is in the app bundle, and the budget is at 459–460 KB and can't be measured offline |
| #161 | milkdown group 7.20.0 → 7.22.3 (13 pkgs) | **Safe → deps train** | in-range minors of the WYSIWYG core: run the editor e2e + Markdown round-trip |
| #160 | codemirror group (9 pkgs, minors) | **Safe → deps train** | in-range minors of the source editor: run editor + RTL e2e |
| #154 | @y/websocket-server 0.1.1 → 0.1.5 (sync-server, optional, exact pin) | **Safe → deps train** | 0.x patch of an optional legacy relay; run the sync-server tests |
| #164 | react-dom 18.3.1 → **19.3.1**, @types/react-dom 19 | **Major migration** | react-dom 19 needs react 19 (this PR leaves react at 18), and the plugin API exposes React. That's its own task: React 19 migration (W-task; owner opens it) |
| #165 | @sentry/react 10.50.0 → **11.7.0** | **Major migration** | major. Sentry is opt-in telemetry (privacy ledger, sensitive). Migrate with the privacy review |
| #166 | jsdom 29.1.1 → **30.1.2** (dev) | **Major migration** | major test-env change; run the whole vitest suite on the second host |
| #153 | @types/node 22.20.5 → **26.6.5** (mcp-server) | **Major: decline** | mcp-server runs on Node 22 (`engines`). Types should match the runtime, so close it and add a dependabot `ignore` for `@types/node` majors |
| #612 | ws 8.22.0 → 8.22.2 (sync-server) | **Safe → deps train** | patch; newer than #326 (folded at 8.22.1 by #499). Run the sync-server tests |
| #613 | astro 7.4.0 → 7.4.10 (docs) | **Superseded by #534** | #534 is the newer patch of the same package |
| #534 | astro 7.4.0 → 7.4.12 (docs) | **Safe → deps train** | patch, docs site only; replaces #327 and #613 |
| #614 | @astrojs/starlight 0.42.6 → 0.42.10 (docs) | **Safe → deps train** | patch, docs site only; replaces #328; with #534 |
| #533 | hono 4.13.13 → 4.13.18 (mcp-server) | **Safe → deps train** | patch of the MCP server's HTTP layer; run the mcp-server tests |
| #532 | @hono/node-server 2.1.5 → 2.1.8 (mcp-server) | **Safe → deps train** | patch; with #533 |

**Count:** 32 PRs.

| Decision | PRs |
|---|---|
| Superseded | 7 |
| Close, not used | 2 |
| Safe for the dependency train | 19 |
| Major | 4 (3 migrations, 1 decline) |

After the train and the closes, **0 dependabot PRs are open**. The acceptance limit is ≤ 5.

`npm run audit:lock` checks every lockfile offline against
`security/known-bad.json`. In npm's locks no high or critical advisory is
open, only moderate and low ones, each with an expiry date and an owner step.

## בעברית

טבלת ההחלטות לכל PR של dependabot. היא התחילה בתיאור של #499, ושישה PR-ים חדשים נוספו בסוף.

| החלטה | מספר PR-ים |
|---|---|
| הוחלף | 7 |
| לסגור, לא בשימוש | 2 |
| בטוח, לרכבת התלויות | 19 |
| גרסה ראשית | 4 |

הפריטים הבטוחים נכנסים ברכבת תלויות אחת (`verify/deps`), עם `npm install` או `cargo update` אמיתיים במחשב שמגיע ל-registry. אחר כך הבעלים סוגר את ה-PR-ים שהרכבת מכסה.

`npm run audit:lock` בודק את כל קובצי הנעילה בלי רשת. ב-lock של npm אין ייעוץ פתוח בחומרה גבוהה או קריטית.

# Lumen — Launch readiness scorecard (2026-05-26, post-round-25 + audit)

Updated after the round-25 PR #54 merge and the round-4 honest audit
pass. Numbers reflect what's *actually verified*, not what's claimed.

## Snapshot

| Metric | Value |
|---|---|
| Production bugs fixed across rounds | 13+ |
| Unit tests | 1270 passing (149 files) |
| E2E specs | 22 files × 3 browsers (chromium / firefox / webkit) |
| First-party LOC | ~58,700 |
| Locales | 8 (en, he, ar, de, fr, ja, ru, zh-CN) |
| Main bundle (gzipped) | 227 KB / 230 budget |
| Total bundle (gzipped) | ~4 MB across all chunks |
| TypeScript strict errors | 0 |
| CI on `main` | ✅ all gates green |

## Category scoring (1–10) vs the market

Scores re-graded post round-25. Where round-12's LAUNCH.md inflated a
number, this one drops it back. Where round-12 undershot (test coverage
notably), this raises it.

| Category | Lumen | Obsidian | Notion | Typora | iA Writer | Logseq | HackMD |
|---|---:|---:|---:|---:|---:|---:|---:|
| Markdown core (CM6 + remark) | **9** | 8 | 6 | 9 | 9 | 7 | 7 |
| Dynamic blocks (Mermaid + Chart + CSV + Live-JS + SVG + Code Doctor + Insights + 13 more) | **10** | 7 | 7 | 6 | 4 | 7 | 7 |
| AI integration (cloud GPT + WebGPU local) | **9** | 6 | 9 | 0 | 0 | 5 | 0 |
| Collab real-time (Yjs / WebRTC) | **7** | 4 | 10 | 0 | 0 | 4 | 9 |
| Local-first / privacy (OPFS + opt-in cloud) | **10** | 10 | 2 | 8 | 10 | 9 | 4 |
| i18n + RTL (8 locales, strict zero-drift CI) | **9** | 6 | 7 | 5 | 4 | 6 | 5 |
| Performance — first paint | **8** | 9 | 5 | 9 | 9 | 6 | 7 |
| PWA / installable | **9** | n/a | 7 | n/a | n/a | 7 | 6 |
| Plugin ecosystem | **6** | 10 | 4 | 0 | 0 | 8 | 0 |
| Templates marketplace | **7** | 8 | 8 | 0 | 0 | 7 | 5 |
| Export quality (PDF + DOCX + HTML) | **8** | 7 | 7 | 10 | 8 | 6 | 7 |
| Accessibility (17 axe surfaces, no critical/serious) | **8** | 6 | 6 | 5 | 7 | 6 | 6 |
| Mobile (Capacitor wired, **not shipped**) | **3** | 8 | 9 | 0 | 9 | 6 | 7 |
| Desktop (Tauri wired, **not shipped**) | **3** | 10 | 8 | 9 | 9 | 8 | 0 |
| Onboarding (tour + welcome doc) | **8** | 8 | 9 | 7 | 8 | 6 | 6 |
| Test coverage (1270 unit + 22 × 3 e2e) | **10** | ? | ? | ? | ? | ? | ? |
| Code quality (TS clean, mutation-tested guards) | **9** | ? | ? | ? | ? | ? | ? |
| Marketing / brand | **3** | 9 | 10 | 8 | 9 | 7 | 6 |
| Pricing / distribution | **2** | 9 | 10 | 8 | 8 | 6 | 8 |
| Community | **2** | 10 | 10 | 7 | 6 | 8 | 7 |
| **Weighted average** | **6.95** | **7.7** | **7.1** | **5.6** | **6.1** | **6.6** | **5.6** |

### Where Lumen leads today

1. **Dynamic blocks** — 20+ fence languages with first-class rendering
   (mermaid, dot, plantuml, chart, csv, tsv, json-table, database, map,
   geojson, abc, model3d, embed, html-preview, live-css, live-js,
   live-svg, live-glsl, bibtex, code-doctor, insights, eink). The next
   competitor (Obsidian) handles maybe 4 of those natively; the rest
   need community plugins.
2. **AI architecture** — only editor with both cloud LLM streaming AND
   on-device WebGPU LLM as first-class peers, with a unified prompt UI.
3. **i18n + RTL** — 8 locales × 638 keys, strict zero-drift CI guard,
   native RTL layout with LTR code/math islands. Best in class.
4. **Local-first posture** — OPFS workspace + opt-in cloud + AES-256
   secrets vault + opt-out telemetry. Tied with Obsidian and iA Writer.
5. **Test discipline** — 1270 unit + 66 e2e tests with mutation-table
   proof for security-critical guards. Highest verified coverage in the
   comparison set.

### Where Lumen still trails

| # | Gap | Severity |
|---|---|---|
| 1 | No mobile binary in app stores | 🔴 blocks half the market |
| 2 | No desktop binary on releases page | 🔴 blocks Obsidian-style users |
| 3 | No production web address pointed at the production build | 🔴 blocks any organic traffic |
| 4 | 0 GitHub stars (private repo), 0 Discord, 0 external plugin authors | 🟧 community network effect |
| 5 | No demo video, no comparison page, no hero screenshot | 🟧 zero share-link traffic |
| 6 | Stripe billing wired but no live keys; entitlement claims rely on env vars | 🟧 monetisation blocked |
| 7 | OAuth round-trips (Dropbox, Google Drive) untested in real browser | 🟧 cloud-sync claim unverified |
| 8 | Yjs WebRTC collab between 2 real sessions never lab-tested | 🟧 collab claim unverified |
| 9 | Native-speaker review for ar/de/fr/ja/ru/zh-CN | 🟧 i18n accuracy |
| 10 | Milkdown lifecycle race — filtered, not fixed | 🟨 noise |

## Open issues by category

### 🔴 Blocking issues (5)

These prevent a real public launch. Each must be resolved before going
to anything broader than a beta cohort.

1. **No production deployment.** The Dockerfile + fly.toml exist; the
   domain is registered (per LAUNCH.md history); nothing's deployed
   tonight. `fly deploy` from `sync-server/` is one command; the web
   app needs a separate target.
2. **No mobile build.** Capacitor configured (`ios/` and `android/`
   directories exist), never published to App Store / Play.
3. **No desktop build.** Tauri configured (`tauri:build` script
   exists), no release artefact published.
4. **Stripe live keys absent.** Free tier works; Pro/Team purchase
   path falls through.
5. **Signaling server unverified.** Fly.io config exists; no record of
   a successful deploy + health check from this session.

### 🟧 Severe non-blocking (7)

1. Lighthouse audit not run since the round-25 build.
2. Real-user testing — none.
3. Plugin author CLI / docs (the `mcp-server/` exists, the Lumen plugin
   API doesn't have a public CLI).
4. Stripe billing screens render but the live flow is untested.
5. WebGPU AI fallback path on Safari (no WebGPU) — should gracefully
   route to cloud.
6. Print export quality — round-23 audit noted possible page-break
   issues; never re-verified.
7. Sentry DSN absent in env; errors aren't being collected.

### 🟨 Polish / paper cuts (10)

1. Onboarding tour copy could use a brand-voice pass.
2. Workspace file tree drag-drop edge cases (cross-folder, nested rename).
3. CSV → chart suggestions could be smarter (currently picks by type).
4. Search-result count badge in Smart Search ("3 of 247").
5. Inline AI prompt history (current: 1-shot only).
6. Mobile keyboard bar's symbol set could be customisable.
7. Pageview pagination accuracy on very-long docs (>50 pages).
8. Graph view performance on workspaces with >500 docs.
9. Theme customisation surface (currently dark/light only).
10. Vim keymap polish (basic implemented, advanced features missing).

### 🟦 Already done well

- Markdown rendering (CM6 + unified pipeline + KaTeX + Shiki)
- File system (OPFS + workspace)
- Onboarding tour
- Cmd palette
- A11y baseline (17 axe surfaces, 0 critical/serious violations)
- Test coverage
- TypeScript strictness
- Bundle budget enforcement

## Path to #1 in markdown editors

### Phase A — Make it real (must, before any launch)

| # | Task | Owner | ETA |
|---|---|---|---|
| A1 | Deploy the production web app (`fly deploy` web target) | infra | 1 day |
| A2 | Deploy signaling server to fly.io + add to status page | infra | 1 day |
| A3 | Sentry DSN provisioned + e2e error-funnel verified | infra | 0.5 day |
| A4 | iOS TestFlight build via `npm run ios:build` + signing cert | mobile | 5 days (Apple cert wait) |
| A5 | Android Play Console internal release via `npm run android:build` | mobile | 3 days |
| A6 | Tauri desktop builds for macOS + Windows + Linux, attached to GitHub Releases | desktop | 2 days |
| A7 | Lighthouse interactive audit + fix anything < 90 in perf/a11y/SEO | qa | 2 days |
| A8 | Real-browser 2-session collab test (Yjs WebRTC end-to-end) | qa | 1 day |
| A9 | Real-browser Stripe checkout test (test mode) | qa | 1 day |
| A10 | Native-speaker locale review (6 langs × 638 keys = ~3800 strings) | i18n | 2 weeks |
| A11 | Lumen plugin authoring CLI (`npx create-lumen-plugin`) | platform | 3 days |
| A12 | Demo video (60 s screen-capture, no narration) + hero screenshot | marketing | 1 day |

**Phase A delivers an actually-shippable v1.0 across web + mobile + desktop.**

### Phase B — Make it differentiated (3–6 months)

| # | Task | Beats whom |
|---|---|---|
| B1 | Plugin gallery web UI with search + ratings + install metrics | parity w/ Obsidian |
| B2 | Signed plugin distribution + sandboxed iframe sandboxing | beats Obsidian |
| B3 | WebLLM model browser inside settings (drop-in model swap, GGUF support) | unique |
| B4 | CRDT-backed cross-session history (time-travel any doc) | unique vs all |
| B5 | Semantic-tag clustering in graph view (BERT-style embeddings) | beats Obsidian's brute-force graph |
| B6 | First-run sample workspace (10 polished docs showcasing every feature) | parity w/ Notion |
| B7 | Vim keymap polish (`set` config, marks, registers, macros) | power-user moat |
| B8 | Import-from-Obsidian / Notion / Bear / Roam in one click | adoption-friction kill |
| B9 | Telemetry dashboard (opt-in, anonymised) for product roadmap | data-driven |
| B10 | Public roadmap with voting (Cannonical / Linear) | community ownership |

### Phase C — Network effects (6–12 months)

| # | Task |
|---|---|
| C1 | Plugin author monetisation (revenue share for premium plugins) |
| C2 | Patron / sponsor tier with named recognition |
| C3 | Crowdin community localisation (50+ langs) |
| C4 | Real-time collab persistence backend (sync-server scaled) |
| C5 | Lumen Cloud (managed hosting for enterprise) |
| C6 | Academic partnerships (Markdown-first thesis writing) |
| C7 | Publishing partnerships (Notion-to-paper pipeline equivalents) |
| C8 | iOS app of the day pitch deck (Apple editorial) |
| C9 | Y Combinator / similar acceleration if pursuing monetisation |
| C10 | Bug bounty programme (HackerOne / similar) |

## "What I'd do tomorrow morning" — top 10 actions

In strict ROI order, ignoring dependencies between them:

1. **Deploy the production web app.** Without it, nothing else
   matters. ~1 hour. Highest leverage.
2. **Real-browser collab test.** The flagship claim hasn't been
   end-to-end verified. ~30 min in 2 incognito windows.
3. **Demo video.** Shareable artefact for HN / Reddit / Twitter.
   ~2 hours including edit.
4. **Tauri desktop builds + GitHub Releases page.** Obsidian users
   will try a desktop binary before a webapp. ~2 hours.
5. **iOS TestFlight build.** Halves the addressable market if missing.
   ~1 day including Apple submission wait.
6. **Lighthouse + axe full-app sweep with fixes.** Currently 17 axe
   surfaces and 0 critical/serious — extend to the whole app and fix
   any new findings. ~3 hours.
7. **Stripe live-mode checkout test.** Validate the Pro tier purchase
   flow with a real card in test mode. ~1 hour.
8. **Native-speaker locale review.** Start with Hebrew (highest user
   density for Lumen) then expand. Crowdin-style spreadsheet review.
9. **Public roadmap.** Even if simple GitHub Discussions, a roadmap
   makes the project look alive. ~30 min.
10. **Plugin authoring docs.** Currently there's an MCP server with
    docs but no equivalent for Lumen plugins. ~2 hours.

## Final brutally-honest answer

**The product is genuinely good** — 9/10 in core editing, dynamic
blocks, AI architecture, local-first, i18n, and tests. **Distribution
is the bottleneck.** No web deploy, no mobile, no desktop, no
community presence means a 0 user-acquisition floor regardless of
product quality.

The fastest path to "best markdown editor on the planet" goes through
**execution on Phase A**, not building more features. The features are
already top-tier. Now ship them where humans can find them.

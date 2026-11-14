# Lumen vs. world-class: scoring and gap-closing waves

*Research date: 9.11.2026. Scope: plan/plan.json (144 tasks, 15 phases) and MASTER_PLAN.md (§14 targets, appendices 12, 21), compared with 2025–2026 leaders. Nothing in the repo was changed.*

## TL;DR

| | main (552ea5b7, 17.10) | main + open PRs (#143–#347) | plan fully done | plan + waves W1–W3 |
|---|---|---|---|---|
| **Average (19 areas)** | **3.68** | **6.55** | **7.34** | **9.12** |

- **The biggest problem isn't the plan, it's delivery.** No PR has been merged since #134 (17.10). main is the pre-v5 product, and roughly 150 stacked PRs, including all of v5, are still open. A user who installs today gets the 3.7 column. That's why W1.1, the merge train, is the first task.
- With every plan task done to its acceptance criteria, Lumen would be best-in-class in **privacy**, **local AI** and **Hebrew depth**. It would still sit at 6–7.5 in reading/PDF, canvas, collaboration, plugins, mobile and polish.
- The waves add **65 tasks (~341 h)**: W1 = 29 (~173 h), W2 = 25 (~119 h), W3 = 11 (~49 h). They raise the average to **9.12**. Areas that stay below 9.5 have a ceiling explained under that area (ecosystem size, native apps, Google-Docs-grade collaboration), so the shortfall is not a missing task.

## Method

1. **Plan:** read every task of plan.json (id, steps, acceptance, status), MASTER_PLAN §14 (measurable targets), appendix 12 (the 17.10 weakness audit and competitor table), appendix 21 (gap analysis) and the status note dated 9.11.
2. **Today:** (a) *main* = commit 552ea5b7 (17.10.2026). I read its file tree via the GitHub API and scored it against the 17.10 audit (appendix 12). (b) *main + PRs* = the open PR list (titles and branches from `gh api repos/talstilkol/lumen-md/pulls?state=open`), plus the measured results recorded in the plan statuses (e.g. WER 8.9%/23.6%, OCR CER, startup 385.7 KB, 10k-note open < 1 s). PRs whose CI is red or that are unverified count at about 70–80% of their plan value. The app was not run.
3. **Benchmark:** for each area, 2–4 current leaders, taken from primary sources (official changelogs, help docs, papers) where possible. Leaders are scored on the same 1–10 scale. 10 means clearly best on measured criteria, not just "has the feature".
4. **Waves:** for each gap, one task with measurable acceptance. Every task is checked against the existing 144 to avoid duplicates; where an existing task is weak, the wave task names it in `dep`. Constraints respected: local-first, cloud only on opt-in, Hebrew first, no paid services, **no GitHub Actions** (acceptance runs locally or in Vercel Sandbox).
5. **Calibration:** these scores are informed judgement, not lab measurements. Leaders' scores reflect their strongest public evidence. Lumen's "planned" scores assume each acceptance criterion is met as written.

## Scores per area

| Area | main | +PRs | planned | after waves | leaders |
|---|---|---|---|---|---|
| Editor & Markdown fidelity | 6.0 | 7.0 | 7.5 | **9.3** | Obsidian 9.5, Typora 9.0, iA Writer 9.0, Notion 7.5 |
| RTL / Hebrew | 4.0 | 8.0 | 8.5 | **9.6** | Microsoft Word 9.0, Google Docs 8.0, Obsidian 1.14 8.0, Notion (RTL since 1.2026) 7.0 |
| Files / vault & data safety | 3.0 | 7.5 | 8.5 | **9.5** | Obsidian 9.0, iA Writer 8.5, Notion 7.0 |
| Sync & E2EE | 3.0 | 6.5 | 7.5 | **9.2** | Obsidian Sync 9.0, Anytype 8.5, Notion (not E2EE) 8.0, Logseq DB sync (beta) 6.0 |
| Search, linking, graph & knowledge management | 5.0 | 7.5 | 8.0 | **9.4** | Obsidian 9.0, Tana 8.5, Logseq 8.0, Capacities 8.0 |
| Databases / properties | 3.0 | 6.5 | 7.0 | **9.0** | Notion 9.5, Tana 8.5, Obsidian Bases 8.5, Anytype 8.0 |
| Capture (clipper, quick capture, daily notes) | 4.0 | 6.5 | 7.0 | **9.2** | Obsidian (Web Clipper + mobile Quick Capture) 9.0, Readwise Reader 9.0, Tana 8.5, Heptabase 8.0 |
| PDF & reading / annotation | 2.0 | 6.0 | 6.5 | **9.0** | Zotero 8 9.5, Readwise Reader 9.5, Heptabase 8.5, Obsidian 7.0 |
| Canvas / whiteboard | 5.0 | 5.5 | 6.5 | **8.8** | tldraw 9.0, Excalidraw+ 9.0, Heptabase 9.0, Obsidian Canvas 8.0 |
| Local AI & agents | 4.0 | 7.5 | 8.5 | **9.5** | Notion AI (cloud) 9.0, Heptabase (cloud) 8.5, Reor (local) 6.0, Obsidian + plugins 6.0 |
| Speech, OCR, translation, nikud | 2.0 | 6.5 | 7.0 | **9.0** | Dicta (nikud) 9.5, ivrit.ai (Hebrew ASR) 9.0, Google Translate / Lens 9.0, Apple Live Text / dictation 8.5 |
| Collaboration | 5.0 | 6.0 | 6.0 | **8.5** | Google Docs 9.5, Notion 9.0, AFFiNE 8.0, Anytype 7.5 |
| Plugins / extensibility & security | 2.0 | 6.0 | 6.5 | **8.5** | VS Code 9.5, Obsidian 9.0, Logseq 7.0 |
| Performance | 3.0 | 6.0 | 8.0 | **9.3** | Linear 9.5, Obsidian 9.0, Bear 9.0, Notion 6.0 |
| Accessibility | 3.0 | 6.5 | 7.5 | **9.2** | Google Docs 9.0, iA Writer 8.5, Notion 7.5, Obsidian 6.5 |
| Mobile & desktop apps | 3.0 | 5.5 | 6.5 | **8.8** | Bear 9.5, Craft 9.5, Obsidian 9.0, Notion 8.5 |
| Onboarding & UX polish | 4.0 | 6.0 | 7.0 | **9.0** | Linear 9.5, Craft 9.5, Notion 9.0, Obsidian 7.0 |
| Privacy & security | 5.0 | 8.0 | 9.0 | **9.6** | Standard Notes 9.5, Anytype 9.0, Obsidian 8.5, Notion 6.0 |
| Docs, support, community & launch | 4.0 | 5.5 | 6.5 | **8.8** | Obsidian 9.5, Notion 9.5, Zotero 9.0, Logseq 7.5 |
| **Average** | **3.68** | **6.55** | **7.34** | **9.12** | |

## The biggest gaps (vs. leaders, after the current plan)

1. **Delivery and merge backlog (cross-cutting).** main hasn't moved in 3+ weeks, and every ✅ in v5 is still on a branch. Missing lockfile entries (hash-wasm, @noble, excalidraw, web-llm, typage) block crypto, canvas and models. → W1.1
2. **Reading and research (PDF 6.5 vs. Zotero 8 / Readwise 9.5).** No EPUB reader, no reading mode, annotations aren't first-class, no Zotero-grade citations, no highlight import or review. → W1.14, W1.15, W2.15, W2.16, W3.3
3. **Interoperability with Obsidian's newest formats.** Bases (`.base`), callouts, colour highlights and Dataview blocks: a vault arriving from Obsidian loses its views. → W1.3, W1.11, W2.12, W1.26
4. **Measured responsiveness and real accessibility.** The plan measures load (Lighthouse) but not interaction (INP, keypress→paint), and runs axe but no real Hebrew screen reader, even though Israeli regulation applies. → W1.22, W2.21, W1.23
5. **Sharing and extensibility as products.** Collab has no roles, threads or expiring links. Plugins have a strong sandbox but no permission disclosure, themes or developer experience. → W1.19, W2.20, W1.20, W1.21, W3.10

Next in line: sync usability (selective sync, per-file status, auto-merge, a public crypto spec with test vectors; W1.7–W1.9), Hebrew speech quality (ivrit.ai Whisper, mixed-script OCR, Dicta-grade nikud, neural TTS; W1.17, W1.18, W2.5, W2.6), and the human loop (usability tests, launch; W1.29, W2.25).

## Per-area analysis

### Editor & Markdown fidelity — main 6.0 → +PRs 7.0 → planned 7.5 → after waves 9.3

| Product | Score |
|---|---|
| Obsidian | 9.5 |
| Typora | 9.0 |
| iA Writer | 9.0 |
| Notion | 7.5 |
| **Lumen (planned → after waves)** | **7.5 → 9.3** |

Main has two editors (CodeMirror + Milkdown), suggesting mode, live code blocks, but no [[ completion and the editor is forced LTR. PRs add link completion, embeds, block refs and a properties editor. The plan has no spec-conformance metric, no Obsidian-syntax corpus (callouts, %%, colour highlights, image resize), no paste-fidelity test and no outliner ops. W1.2–W1.4, W2.13, W2.23 close it.

**Wave tasks:** W1.2, W1.3, W1.4, W2.13, W2.23

### RTL / Hebrew — main 4.0 → +PRs 8.0 → planned 8.5 → after waves 9.6

| Product | Score |
|---|---|
| Microsoft Word | 9.0 |
| Google Docs | 8.0 |
| Obsidian 1.14 | 8.0 |
| Notion (RTL since 1.2026) | 7.0 |
| **Lumen (planned → after waves)** | **8.5 → 9.6** |

The 17.10 audit found RTL broken on main (forced LTR, Hebrew anchors and backlinks wrong). PRs deliver per-line direction, bidi editing on 30 golden lines × 3 browsers, Hebrew slug, spelling, DOCX RTL, Hebrew date, nikud. Already ahead of Obsidian/Notion in depth; missing what Word does (Hebrew auto-typography, print), keyboard-layout handling, holidays/parashot, Hebrew morphology in search.

**Wave tasks:** W2.8, W2.9, W2.10, W3.5

### Files / vault & data safety — main 3.0 → +PRs 7.5 → planned 8.5 → after waves 9.5

| Product | Score |
|---|---|
| Obsidian | 9.0 |
| iA Writer | 8.5 |
| Notion | 7.0 |
| **Lumen (planned → after waves)** | **8.5 → 9.5** |

Main keeps notes in hidden OPFS, no persist(), empty history, git pull overwrites. PRs: VaultBackend, real folders (web/desktop/mobile), watcher, trash+undo, compressed history, safe git, G1–G11 matrix. Missing: atomic writes under crash, vault integrity check, off-device scheduled backup + restore drill (W1.5, W1.6).

**Wave tasks:** W1.5, W1.6

### Sync & E2EE — main 3.0 → +PRs 6.5 → planned 7.5 → after waves 9.2

| Product | Score |
|---|---|
| Obsidian Sync | 9.0 |
| Anytype | 8.5 |
| Notion (not E2EE) | 8.0 |
| Logseq DB sync (beta) | 6.0 |
| **Lumen (planned → after waves)** | **7.5 → 9.2** |

Main: fast-forward-only git and Gist. PRs: E2EE core with encrypted manifest, opaque names, rollback guard, 10k-round test, WebDAV/S3/Dropbox/Drive — but Argon2id and age are not in the lockfile and nothing is merged. Missing: public spec + test vectors, key rotation/device revoke, selective sync and per-file status, automatic text merge, LAN sync.

**Wave tasks:** W1.7, W1.8, W1.9, W2.19

### Search, linking, graph & knowledge management — main 5.0 → +PRs 7.5 → planned 8.0 → after waves 9.4

| Product | Score |
|---|---|
| Obsidian | 9.0 |
| Tana | 8.5 |
| Logseq | 8.0 |
| Capacities | 8.0 |
| **Lumen (planned → after waves)** | **8.0 → 9.4** |

Main: graph view, backlinks, hybrid search that breaks Hebrew. PRs: real BM25 (Hebrew-aware), [[ completion <50ms, hover preview, unlinked mentions, embeds, block refs, operators, reranker measured. Missing: graph at 10k nodes/local graph, related-notes/suggested links, embedded/saved queries (Dataview-class), Hebrew morphology and full/defective spelling.

**Wave tasks:** W1.10, W2.2, W2.11, W2.12

### Databases / properties — main 3.0 → +PRs 6.5 → planned 7.0 → after waves 9.0

| Product | Score |
|---|---|
| Notion | 9.5 |
| Tana | 8.5 |
| Obsidian Bases | 8.5 |
| Anytype | 8.0 |
| **Lumen (planned → after waves)** | **7.0 → 9.0** |

Main: read-only DB views. PRs: editable cells, kanban, AND/OR filters, formulas without eval, map view. Missing: compatibility with Obsidian .base files (the de-facto Markdown DB format), relations/rollups, calendar/timeline, 10k-row performance, CSV.

**Wave tasks:** W1.11, W1.12

### Capture (clipper, quick capture, daily notes) — main 4.0 → +PRs 6.5 → planned 7.0 → after waves 9.2

| Product | Score |
|---|---|
| Obsidian (Web Clipper + mobile Quick Capture) | 9.0 |
| Readwise Reader | 9.0 |
| Tana | 8.5 |
| Heptabase | 8.0 |
| **Lumen (planned → after waves)** | **7.0 → 9.2** |

Main: templates, an iOS share extension, a clipper that posts to a non-existent /api/clip. PRs: daily notes + Hebrew date, inbox quick capture, clipper v2 (Defuddle, templates, highlights). Missing: voice capture (Obsidian Mobile 1.15), on-device interpreter templates, highlight import from Kindle/Kobo/Readwise/Zotero, widgets/Siri.

**Wave tasks:** W1.13, W2.14, W2.15

### PDF & reading / annotation — main 2.0 → +PRs 6.0 → planned 6.5 → after waves 9.0

| Product | Score |
|---|---|
| Zotero 8 | 9.5 |
| Readwise Reader | 9.5 |
| Heptabase | 8.5 |
| Obsidian | 7.0 |
| **Lumen (planned → after waves)** | **6.5 → 9.0** |

Main: PDF import only. PRs: pdf.js reader with W3C Web Annotation highlights, ask-a-PDF with checked quotes, citations block. Missing: EPUB and reading mode, annotations as searchable/taggable entities, Zotero-class citation dialog, spaced review of highlights.

**Wave tasks:** W1.14, W1.15, W2.16, W3.3

### Canvas / whiteboard — main 5.0 → +PRs 5.5 → planned 6.5 → after waves 8.8

| Product | Score |
|---|---|
| tldraw | 9.0 |
| Excalidraw+ | 9.0 |
| Heptabase | 9.0 |
| Obsidian Canvas | 8.0 |
| **Lumen (planned → after waves)** | **6.5 → 8.8** |

Main uses tldraw, which needs a paid licence key in production (1.9). PRs have the converter only; the Excalidraw swap itself waits on the lockfile. Even done, the plan lacks note cards on canvas, verified Hebrew export, presentations, Mermaid/AI diagrams. Capped below 9.5: whiteboards are core products of dedicated teams.

**Wave tasks:** W1.16, W2.17, W2.18

### Local AI & agents — main 4.0 → +PRs 7.5 → planned 8.5 → after waves 9.5

| Product | Score |
|---|---|
| Notion AI (cloud) | 9.0 |
| Heptabase (cloud) | 8.5 |
| Reor (local) | 6.0 |
| Obsidian + plugins | 6.0 |
| **Lumen (planned → after waves)** | **8.5 → 9.5** |

Main: cloud AI with caching, a research agent, an Ollama provider. PRs: 14 agents on one runtime with tools, critic, review screen, eval harness, model manager, injection guard, FIM, PII redaction. That is already the strongest local AI stack of any PKM. Missing: KB-organizing agent, related notes, MCP/CLI access (now standard: Obsidian, Bear, Logseq, Heptabase), DictaLM 3.0.

**Wave tasks:** W2.1, W2.3, W2.4

### Speech, OCR, translation, nikud — main 2.0 → +PRs 6.5 → planned 7.0 → after waves 9.0

| Product | Score |
|---|---|
| Dicta (nikud) | 9.5 |
| ivrit.ai (Hebrew ASR) | 9.0 |
| Google Translate / Lens | 9.0 |
| Apple Live Text / dictation | 8.5 |
| **Lumen (planned → after waves)** | **7.0 → 9.0** |

Main: almost nothing local. PRs: streaming Hebrew dictation (FLEURS dev WER 8.9%, validation 23.6%), OCR (Hebrew CER 2.66% but English-in-Hebrew 12–40%), Nakdimon nikud (target 90%), 3-layer MT, language ID. Missing: ivrit.ai Whisper, mixed-script OCR, Dicta-level nikud, neural Hebrew TTS, diarization.

**Wave tasks:** W1.17, W1.18, W2.5, W2.6, W2.7

### Collaboration — main 5.0 → +PRs 6.0 → planned 6.0 → after waves 8.5

| Product | Score |
|---|---|
| Google Docs | 9.5 |
| Notion | 9.0 |
| AFFiNE | 8.0 |
| Anytype | 7.5 |
| **Lumen (planned → after waves)** | **6.0 → 8.5** |

Main: Yjs rooms, comments panel, WYSIWYG suggesting mode. PRs: persistent Hocuspocus rooms with tokens. The plan stops there: no roles, no managed comment threads, no expiring links, no E2EE-at-server, no suggestions in live sessions. Local-first collab will not beat Google Docs; 8.5 is the honest ceiling.

**Wave tasks:** W1.19, W2.20, W3.11

### Plugins / extensibility & security — main 2.0 → +PRs 6.0 → planned 6.5 → after waves 8.5

| Product | Score |
|---|---|
| VS Code | 9.5 |
| Obsidian | 9.0 |
| Logseq | 7.0 |
| **Lumen (planned → after waves)** | **6.5 → 8.5** |

Main: a fake gallery (install = toast). PRs: QuickJS sandbox with capabilities denied by default, iframe UI with strict CSP, API, two examples — a stronger security model than Obsidian (which only now adds per-version scanning and permission disclosure). Ecosystem size cannot be planned; themes/snippets, install-time disclosure, dev experience can.

**Wave tasks:** W1.20, W1.21, W3.10

### Performance — main 3.0 → +PRs 6.0 → planned 8.0 → after waves 9.3

| Product | Score |
|---|---|
| Linear | 9.5 |
| Obsidian | 9.0 |
| Bear | 9.0 |
| Notion | 6.0 |
| **Lumen (planned → after waves)** | **8.0 → 9.3** |

Main: Lighthouse ~55, LCP 9.6s desktop. PRs: startup 456→386 KB gz, index in a worker, 10k-note open <1s and search <100ms. The plan targets load (Lighthouse, 250 KB) but not interaction latency (INP, keypress→paint), cold start of the app shell, or 100k vaults.

**Wave tasks:** W1.22, W2.22

### Accessibility — main 3.0 → +PRs 6.5 → planned 7.5 → after waves 9.2

| Product | Score |
|---|---|
| Google Docs | 9.0 |
| iA Writer | 8.5 |
| Notion | 7.5 |
| Obsidian | 6.5 |
| **Lumen (planned → after waves)** | **7.5 → 9.2** |

Main: unmeasured; 3/18 dialogs trapped focus. PR #290: one focus trap, AA contrast, reduced motion, axe e2e. Automated axe covers a fraction of issues: missing real screen-reader runs in Hebrew (NVDA/VoiceOver/TalkBack), 400% reflow, forced-colors, Israeli IS 5568 statement, ACR.

**Wave tasks:** W1.23, W3.8

### Mobile & desktop apps — main 3.0 → +PRs 5.5 → planned 6.5 → after waves 8.8

| Product | Score |
|---|---|
| Bear | 9.5 |
| Craft | 9.5 |
| Obsidian | 9.0 |
| Notion | 8.5 |
| **Lumen (planned → after waves)** | **6.5 → 8.8** |

Main: PWA without touch, Tauri without updater, nothing in stores. PRs: touch, vault folder on phone, updater, mobile builds (but via GitHub Actions, now banned). Missing: native-feel mobile editing, voice/widgets/Siri, package-manager distribution, multi-window/tray/file associations. Capacitor/Tauri cap the ceiling vs native Bear/Craft.

**Wave tasks:** W1.24, W1.25, W2.21, W3.4, W3.9

### Onboarding & UX polish — main 4.0 → +PRs 6.0 → planned 7.0 → after waves 9.0

| Product | Score |
|---|---|
| Linear | 9.5 |
| Craft | 9.5 |
| Notion | 9.0 |
| Obsidian | 7.0 |
| **Lumen (planned → after waves)** | **7.0 → 9.0** |

Main: tour and templates. PRs: first-run setup, sample vaults, first note in ~3.5s, one settings screen. No user testing anywhere in the plan, no design-system/motion audit, no import wizard beyond Obsidian/Notion, weak empty/error states.

**Wave tasks:** W1.26, W1.29, W3.1, W3.2, W3.6

### Privacy & security — main 5.0 → +PRs 8.0 → planned 9.0 → after waves 9.6

| Product | Score |
|---|---|
| Standard Notes | 9.5 |
| Anytype | 9.0 |
| Obsidian | 8.5 |
| Notion | 6.0 |
| **Lumen (planned → after waves)** | **9.0 → 9.6** |

Main: some CSP; live-js unsandboxed; secrets in plain storage. PRs: privacy ledger with network-layer local-only, tight Tauri CSP, sandboxed live-js, secret store/keychain, injection guard, PII redactor, security scanners. Plan is near best-in-class; missing threat model, parser fuzzing, signed reproducible releases, SBOM, externally verifiable privacy report.

**Wave tasks:** W1.27, W2.24

### Docs, support, community & launch — main 4.0 → +PRs 5.5 → planned 6.5 → after waves 8.8

| Product | Score |
|---|---|
| Obsidian | 9.5 |
| Notion | 9.5 |
| Zotero | 9.0 |
| Logseq | 7.5 |
| **Lumen (planned → after waves)** | **6.5 → 8.8** |

Main: Astro docs site. PRs: page per feature in he/en, issue-triage agent, public roadmap, feedback without a server. Missing: searchable Hebrew docs and migration guides, in-app offline help, community space, a launch/beta plan. Community size takes time; 8.8 after waves is honest.

**Wave tasks:** W1.28, W2.25, W3.7

**Cross-cutting:** W1.1 (merge train)

## Why some areas stay below 9.5 after the waves

- **Canvas (8.8):** tldraw, Excalidraw+ and Heptabase each have a full team working only on whiteboards. Lumen embeds Excalidraw, so it can match them on cards, Hebrew and AI diagrams, but not lead.
- **Collaboration (8.5):** Google Docs and Notion are server-first, so permissions, presence and comments are their core. Lumen's edge is E2EE and local-first sharing, not breadth.
- **Plugins (8.5):** an ecosystem of 4,000+ projects (Obsidian) can't be built in a plan. Security model and developer experience can be best-in-class; size can't.
- **Mobile and desktop (8.8):** Capacitor and Tauri trail native Bear and Craft in feel. The waves close the measurable part (taps, cold start, widgets, distribution).
- **Docs, community and launch (8.8):** community comes from time and users, not tasks.

## Notes on existing plan tasks that the waves strengthen

- **13.3 / 13.4** are written around CI on every PR, which contradicts the 9.11 decision to stop using GitHub Actions. W1.24 rewrites the path as local or Vercel Sandbox builds.
- **4.12** leaves Hebrew holidays and parashot out (because of @hebcal's GPL licence). W2.10 adds them with our own MIT implementation.
- **6.1** misses its 15%% WER target (23.6%% on validation). W1.17 adds ivrit.ai Whisper (Apache-2.0) as the quality tier.
- **7.5** fails on English inside Hebrew lines (12.3%%/40.5%% CER). W1.18 targets that case.
- **6.3**'s 90%% nikud target is below Dicta. W2.5 sets 95%%.
- **8.1–8.4** measure load, not interaction. W1.22 adds INP and keypress→paint.
- **10.1** relies on axe only. W1.23 adds real screen readers and IS 5568.
- **#176** (import from Obsidian/Notion) is extended by W1.26, which builds on Obsidian Importer (MIT).
- **4.19** is incomplete in the PRs (no dependency, tldraw still in the bundle). W1.16 finishes it and adds note cards and Hebrew export checks.

## Sources

**Obsidian:** [1.14.0 desktop changelog (RTL workspace, Bases kanban, colour highlights, Temml)](https://obsidian.md/changelog/2026-09-02-desktop-v1.14.0/) · [1.12.0 (CLI, Bases search, image resize)](https://obsidian.md/changelog/2026-02-10-desktop-v1.12.0) · [Mobile 1.15.0 (voice Quick Capture, Siri/Spotlight, PDF export)](https://obsidian.md/es/changelog/2026-10-22-mobile-v1.15.0/) · [1.10.0](https://obsidian.md/changelog/2025-10-01-desktop-v1.10.0/) · [Bases launch (AlternativeTo 8.2025)](https://alternativeto.net/news/2025/8/obsidian-launches-new-bases-plugin-for-database-workflows-and-property-format-changes) · [1.9.5 formula editor](https://alternativeto.net/news/2025/7/obsidian-1-9-5-introduces-formula-editor-and-bases-improvements) · [Future of plugins (5.2026: 4,000+ projects, per-version scanning, permission disclosure)](https://obsidian.md/blog/future-of-plugins/) · [Web Clipper Interpreter](https://obsidian.md/help/web-clipper/interpreter) · [Obsidian Sync](https://obsidian.md/sync)

**Logseq:** [What's new with Logseq DB, 16.5.2026 (sync beta, E2EE, Graph View V2, CLI)](https://discuss.logseq.com/t/whats-new-with-logseq-db-may-16th-2026/35020) · [DB changelog](https://discuss.logseq.com/t/logseq-db-changelog/30013/37)

**Notion:** [2.53 offline mode (8.2025)](https://www.notion.com/releases/2025-08-19) · [Arabic and Hebrew support, 26.1.2026](https://www.createwith.com/tool/notion/updates/notion-adds-arabic-and-hebrew-support)

**Heptabase:** [Changelog 2026 (PDF on mobile, AI agent, MCP/CLI, Zotero, whiteboard minimap)](https://wiki.heptabase.com/changelog)

**Tana:** [Changelog: voice agent and sharing (5.2026)](https://tana.inc/changelog/2026-05-17-sharing) · [Changelog](https://tana.inc/changelog)

**Capacities:** [Release 67 (7.2026: API 2.0, reader, presentation mode)](https://capacities.io/whats-new/release-67) · [Offline support](https://docs.capacities.io/misc/offline-support)

**Anytype:** [Blog](https://blog.anytype.io/)

**Bear:** [Bear 2.8: CLI and MCP (4.2026)](https://alternativeto.net/news/2026/4/bear-2-8-released-with-bear-cli-claude-connector-and-mcp-server-for-advanced-workflows/)

**iA Writer:** [See what AI wrote (Authorship)](https://ia.net/topics/see-what-ai-wrote)

**Zotero:** [Zotero 8 announcement](https://www.zotero.org/blog/zotero-8/) · [8.0 changelog](https://www.zotero.org/support/8.0_changelog)

**Readwise Reader:** [Reader](https://readwise.io/read)

**Excalidraw:** [Excalidraw+ changelog 2026 (presentations, Mermaid, AI, RTL export fix)](https://plus.excalidraw.com/changelog)

**Reor:** [Reor (local AI notes)](https://github.com/reorproject/reor)

**Linear:** [How is Linear so fast (performance.dev, 6.2026)](https://performance.dev/how-is-linear-so-fast-a-technical-breakdown)

**Chrome built-in AI:** [Built-in AI APIs status (Translator, Summarizer, Language Detector stable since Chrome 138)](https://developer.chrome.com/docs/ai/built-in-apis)

**Hebrew tools:** [Dicta-LM 3.0 (arXiv 2602.02104)](https://arxiv.org/abs/2602.02104) · [ivrit.ai models (Apache-2.0; Whisper turbo ct2/ggml/onnx, Zipformer streaming)](https://huggingface.co/ivrit-ai) · [Phonikud (arXiv 2506.12311)](https://arxiv.org/abs/2506.12311) · [Phonikud](https://phonikud.github.io/)

**Lumen repo state:** GitHub REST API (open PRs, merged PRs, tree of 552ea5b7), plan/plan.json statuses (updated 9.11.2026 23:45), MASTER_PLAN.md appendices 12, 14, 21

## Files

- `waves.json`: 65 tasks in 3 waves (Hebrew title/steps/acceptance, lane, priority, minutes, deps, why, source, area).
- `scores.json`: one record per area (main, withPRs, planned, afterWaves, leaders, why).

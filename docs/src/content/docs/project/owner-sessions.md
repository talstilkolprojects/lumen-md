---
title: Owner sessions
description: Everything only the owner can do — accounts, GPU runs, golden data, devices — in three sittings ordered by dependency, with the time and the exact command for each, and free cloud devices instead of owning test phones.
---

**Run it as a command:** `npm run owner:session -- accounts|gpu|devices` prints each step, runs and verifies it, and records a signed receipt ([Owner session command](/project/owner-session-command/), plan W6.20). It regroups the items below into 14 steps.

Plan W4.7. Gathered 12.11.2026 from `plan.json` → `owner` (15.1–15.18) and the
"## Owner commands" sections of all 300 open pull requests (37 have one).
Every item is either here, with its time and command, or listed under
"Taken off the owner's list" with who does it instead.

**Order:** Session 1 (accounts) first — store verification takes days and
several later steps need its tokens. Session 2 (GPU Mac) and session 3
(devices) can then go in either order. 15.1 (merging) comes last.

Commands that come with an open pull request are written as the script they run (the PR is named next to them), so they work on that PR's branch before it is merged: `node scripts/models-day.mjs` is #443's `models:day`, `bash scripts/pages-deploy.sh` is #484's `pages:deploy`.

## The count

| | Before | After |
|---|---|---|
| Plan items 15.1–15.18 | 18 | **11** (−39%): 15.2, 15.10, 15.16 decided; 15.5 and 15.6 deferred (optional); 15.14 and 15.17 run inside 15.3's one command. **10 (−44%)** once BrowserStack approves the open-source plan and an agent runs 15.12's Safari part on BrowserStack Automate |
| All owner items (15.x + PR owner sections, duplicates merged) | 40 | **28** (−30%): 14 PRs' test runs, 3 data downloads and 4 model pins moved to agents |
| Owner time in the 15.x estimates | ≈ 21 h 40 min | ≈ 2 h 10 min (session 1) + ≈ 2 h 55 min attended and ≈ 2 h unattended (session 2) + 5 h 30 min of golden data (2.8, over several days) + ≈ 3 h 35 min (session 3) ≈ 14 h of your time |
| Devices Tal must own for Safari / iOS / Android checks | iPhone, Mac Safari, Android phone | none for Safari/iOS (BrowserStack open-source plan) and Android smoke runs (Firebase Test Lab, no-cost quota); a phone stays needed for share-sheet, widget and Files-app checks |

## Session 1 — accounts, keys and switches (≈ 2 h 10 min, + 20 min for the optional 1.10; any computer)

| # | Item (source) | Time | Command / where |
|---|---|---|---|
| 1.1 | **15.18 (P0)** `VITE_*` secrets that leaked into bundles before #243 | 20 min | `npx vercel@latest env ls` (and Netlify: `netlify env:list`). Any token or key among them: revoke at the provider, create a new one, store it server-side only (`vercel env add <NAME> production` without the `VITE_` prefix). None found → note "15.18: none" in the plan. |
| 1.2 | 15.9 remainder: Hugging Face token + golden-set seed | 3 min | `vercel env add HF_TOKEN preview` · `openssl rand -hex 32 \| vercel env add GOLDEN_SEED preview` |
| 1.3 | 15.11 part: dataset terms | 5 min | Logged in to Hugging Face with the `HF_TOKEN` account: accept the terms of `openlanguagedata/flores_plus`; accept Common Voice's dataset terms where 7.1's download fetches it from. |
| 1.4 | W4.28 activation (#481) | 5 min | `gh label create human-reviewed --repo talstilkol/lumen-md --color 0E8A16 --description "A person reviewed the diff after the last commit"` · `gh api -X PUT repos/talstilkol/lumen-md/private-vulnerability-reporting` · secret scanning + push protection: Settings → Code security → enable both (free for public repos; both are off today). |
| 1.5 | **15.7** signing accounts — start now, verification takes days | 30 min + waiting | Apple Developer Program ($99/yr, D-U-N-S not needed as an individual) · Google Play Console ($25 once, identity check) · Windows: Azure Trusted Signing, or apply to SignPath's free code signing for open-source projects (check its current terms) · desktop updater key: `npx tauri signer generate -w ~/.tauri/lumen-updater.key`, then set `LUMEN_UPDATER_PUBKEY` (public) and `TAURI_SIGNING_PRIVATE_KEY` + its password in the shell that runs release builds (scripts/tauri-signing.mjs reads them); keep the private key + password in your password manager (second copy: docs *Second maintainer* §5). |
| 1.6 | Free cloud devices (replaces owning test phones) | 10 min | **BrowserStack open-source plan:** apply at browserstack.com/open-source with the public repo URL (MIT); the program has given open-source projects Live, Automate, App Live and App Automate with 5 users / 5 parallels on real iOS and Android devices — the current terms are on that page (could not be fetched from the sandbox). **Firebase Test Lab (Spark, no cost):** `firebase projects:create lumen-md-test` (or the console), then Test Lab is on: 5 runs/day on physical and 10/day on virtual Android devices. Note: Google deprecated Test Lab; it shuts down on 30.9.2027. |
| 1.7 | W4.27 second host (#484) | 15 min | `npx wrangler@4 login` · `npx wrangler@4 pages project create lumen-md --production-branch main` · `git checkout chore/second-host && npm ci && bash scripts/pages-deploy.sh --prod` |
| 1.8 | Model mirror worker (#476 step 3; the agent does steps 1, 2, 4, 5) | 10 min | `cd edge-workers/model-mirror && npx wrangler@4 deploy` (set `account_id`) · `vercel env add VITE_MODEL_MIRROR_URL production` = `https://lumen-model-mirror.<account>.workers.dev` |
| 1.9 | **15.4** servers + the sync relay (#483) | 30 min | Signaling: `cd sync-server && fly launch --copy-config --no-deploy --name lumen-signal && fly deploy` · relay on the same host: `fly secrets set VAULT_RELAY=1 VAULT_RELAY_DIR=/data && fly deploy` · `vercel env add VITE_SYNC_RELAY_URL production`. Git CORS proxy: per 15.4 in the plan. |
| 1.10 | *Optional* — **15.5** Drive and Dropbox OAuth apps (#483); deferred, do it only to offer those two providers | 20 min | Google Cloud Console → OAuth client (Web), redirect `https://lumen-md.vercel.app/oauth/gdrive`, scope `drive.file` · Dropbox App Console → scoped app (App folder), redirect `https://lumen-md.vercel.app/oauth/dropbox` · `vercel env add VITE_GDRIVE_CLIENT_ID production` · `vercel env add VITE_DROPBOX_APP_KEY production` |

## Session 2 — models and data, on the GPU Mac (≈ 2 h 55 min attended + ≈ 2 h unattended; 2.8's golden-set work is 5 h 30 min more, over several days)

Prerequisites: session 1.2–1.3; Ollama installed; a checkout with #443 (`models:day`).

| # | Item (source) | Time | Command |
|---|---|---|---|
| 2.1 | **15.3 + 15.14 + 15.17** real models, browser engines, phase-6 checks; also #449 (tool calls) and #454 (web dictation) | 15 min + ≈ 2 h unattended | `npm ci && node scripts/models-day.mjs check` (install what is ✗) · `node scripts/models-day.mjs` · then push the run folder as it prints (`git switch -c eval/day-<run> && git add -f eval/results/day/<run> && git commit -m "eval: real models day <run> [skip ci]" && git push -u origin HEAD`) |
| 2.2 | DictaLM-3 eval (#379; the agent fills `models/dictalm3.json` from the HF API first) | 20 min | `ollama pull hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF && ollama pull qwen3:4b` · `node scripts/dictalm3.mjs eval --size 1.7B` · `node scripts/dictalm3.mjs decide --json eval/results/dictalm3-decision.json` |
| 2.3 | ivrit.ai Whisper on the desktop (#383, W1.17; the agent pins the model first) | 25 min | `brew install whisper-cpp` · download the pinned file to `~/Library/Application Support/app.lumen.editor/whisper/` (URL printed by the pin) · `node scripts/whisper-desktop.mjs wer --split test=<golden>/asr-he/test --model <file>` (targets: WER ≤ 10%, < 10 min per audio hour) |
| 2.4 | Speaker diarization speed (#398; the agent pins both networks) | 15 min | dev build on the M1: transcribe a 1-hour recording, read "RTF" in the console (target < 0.25); `node scripts/meetings/der.mjs --golden <dir> --out der-scores.json` once 2.8's meetings are labelled |
| 2.5 | Literature-review and canvas-draw evals (#438, #404) | 10 min | `ollama pull qwen2.5:7b && LUMEN_EVAL_LIT=1 npx vitest run --config vitest.eval.config.ts src/agents/eval/litReview.eval.ts` · `node scripts/canvas-draw-eval.mjs --model qwen2.5:7b` |
| 2.6 | 15.13 parts on the Mac: local LoRA (6.12), data analyst vs a real model (6.15, 20 golden questions) | 30 min | per the 6.12 / 6.15 PR owner sections (`node scripts/models-day.mjs` covers the data-analyst eval when 6.15 is merged) |
| 2.7 | Your own archives (#482 mail, #478 chats) | 30 min | ~50 old Hebrew `.eml` (windows-1255 / ISO-8859-8) + a Gmail Takeout → ⌘K *Import mail…*; 10 chats (WhatsApp Android + iPhone, Telegram JSON) → ⌘K *Import a WhatsApp or Telegram chat…*; send redacted first lines of anything misread |
| 2.8 | **15.11** your part of the golden sets | 5 h 30 min (split over days) | 20 voice recordings + CC0 consent (30 min — record them once: they also serve #458's voice commands and #398's 5 short meetings, 20 min) · 60 niqqud sentences + 50 error pairs proofread (1 h 30) · 20 image reference descriptions (45 min) · 30 personal queries labelled (1 h) · 30 Hebrew injection attacks (45 min) · 15 photographed pages (20 min) · 50 translations rated (45 min) |
| 2.9 | **15.15** rate the local image descriptions (after 6.6) | 30 min | the rating sheet the 6.6 PR prints, 1–5 per image, 50 images |

## Session 3 — devices and manual checks (≈ 3 h 35 min)

| # | Item (source) | Time | How (free cloud first) |
|---|---|---|---|
| 3.1 | **15.12** Safari + W2.8 Hebrew keyboard layout + W4.21 WebKit | 30 min | BrowserStack Live (session 1.6): Safari on macOS and iPhone, open https://lumen-md.vercel.app, run the 15.12 checklist with the Hebrew input source; no device of yours |
| 3.2 | 15.12 Word (RTL) and the automatic update | 30 min | Open the exported `.docx` from #263 in Word, check direction and lists · install build N, publish N+1 as a prerelease (needs 1.5's updater key), *Check for updates* → installs and restarts |
| 3.3 | **15.8** desktop release checks + the native build (#479) + store packages (#423) | 60 min | Mac: `npm ci && npm run tauri:build`; Linux: `sudo apt-get install -y libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev && cargo check --locked --manifest-path src-tauri/Cargo.toml && npm run tauri:build`; then CSP, Graphviz / Python / OCR, a vault folder, the same vault opened in Obsidian · `node scripts/release.mjs packages` and the `brew audit` / `winget validate` / `flatpak-builder` / `makepkg` lines of #423 on each OS |
| 3.4 | iOS and Android native parts (#425 W3.4, Xcode for every `.swift`) | 30 min | Xcode: add the new Swift and `.lproj` files, the `LumenWidgets` target, signing (1.5), Product → Build; Android: `cd android && ./gradlew assembleDebug`, then **Firebase Test Lab** robo run (no phone needed): `gcloud firebase test android run --type robo --app app/build/outputs/apk/debug/app-debug.apk --device model=<id>,version=<api>` (pick a physical model from `gcloud firebase test android models list`) |
| 3.5 | Phone-only checks: widget + Siri (#425), share sheet (#478), voice note < 1 s (#376), Files-app vault folder (15.13 / 4.20), LAN sync between two devices (W2.19) | 30 min | your phone (BrowserStack App Live covers the widget and share sheet if you prefer: upload the APK / IPA) |
| 3.6 | Screen readers (W1.23 via W4.21's Guidepup) | 20 min | the Guidepup commands in #467's owner section on the Mac (VoiceOver) and a Windows machine (NVDA); TalkBack on the phone |
| 3.7 | **15.1** merge — last | 15 min | after the e2e run on verify/train is green (Vercel Sandbox is back on 1.12): merge #431, then the rest per the plan |

## Needs other people (schedule; not in a sitting)

- W1.29 usability sessions: 5–8 Hebrew-speaking users per round (#419's kit).
- #388 TTS listening test: 5 raters (`node scripts/tts-mos.mjs sheet --raters <5 names>`).
- A second maintainer / reviewer (W4.28, docs *Second maintainer*).

## Taken off the owner's list

| Item | Instead |
|---|---|
| 15.2 Codex + Renovate | decided 10.11: neither (Dependabot is on) |
| 15.10 licensing | decided 10.11, items 1–9 |
| 15.16 product decisions | delegated to Claude ("decide every decision yourself"): the coordinator decides and records them |
| 15.6 monitoring DSN | deferred: error reports are off by default and optional; revisit when there are users |
| 15.5 Drive / Dropbox client IDs | deferred (optional line 1.10): the two providers appear in the sync list once the IDs are set; nothing else waits for them |
| 15.14, 15.17 | run inside 2.1's `node scripts/models-day.mjs` |
| 15.9, the decision part | decided 10.11 (public repo, GitHub Releases); the token is still yours: line 1.2 (counted among the 11) |
| Test runs in 14 PRs' owner sections (#401 #404 #408 #411 #413 #418 #424 #426 #429 #434 #437 #440 #441 #473) | agents, in the Vercel Sandbox from 1.12, or anyone with Docker: `bash scripts/ci-docker.sh` (#484) |
| #391 EPUB golden books, #394 FSRS fixture, #453 Wiktionary lexicon | agents in the Sandbox (public-domain downloads, `npm install --no-save`) |
| Model pins: #379 licences, #383 ggml file, #398 diarization networks, #476 mirror steps 1, 2, 4, 5 | agents in the Sandbox (public HF API, `gh` releases); Tal keeps only the GPU runs (2.2–2.4) and the worker deploy (1.8) |
| Safari / iOS checks on Tal's devices (15.12, W2.8) | BrowserStack open-source plan (3.1) |
| Android smoke on a phone | Firebase Test Lab robo runs (3.4) |

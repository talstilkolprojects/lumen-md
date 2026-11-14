---
title: Open PR triage
description: One decision table for every open pull request — in main, in a train, superseded, dependabot, or still needed — and the commands that close each category with a comment.
---

Most pull requests here are stacked: each one is built on the branch of the
one before. When a train (`verify/train`, `verify/train-2`, …) is merged, GitHub
does not mark the PRs inside it as merged, so they stay open. 356 open PRs
hide the few that are really open work (plan W6.21).

`scripts/pr-triage.mjs` sorts every open PR into one category, so the owner
approves a **category** once instead of each PR:

| Category | Rule | What happens |
|---|---|---|
| `in-main` | `git merge-base --is-ancestor <head> origin/main`: every commit of the PR is in main | Close now, with a comment |
| `in-train` | the head is an ancestor of a train (`verify/train`, `verify/train-2`, `verify/train-3`) but not of main | Close once that train is promoted to main: it then becomes `in-main` |
| `superseded` | a later PR says "Supersedes #N" (or "Replaces" / "Obsoletes"), or a later PR of the same plan task contains every commit of this one | Close with the reason, after the owner reads the list |
| `dependabot` | opened by dependabot | Lane S triages them in the dependency train (W6.14) |
| `train` | the head is `verify/*`: the train itself | Merged or closed with the promotion, by hand |
| `needed` | anything else | Stays open |

The order matters: a PR is put in the first category that fits.

## What it does not do

- It never closes anything unless it is run with `--close <category> --go`, and
  then only `in-main` or `superseded`. An `in-train` PR is closed only after its
  train is in main, because the close step re-checks main.
- It never deletes a branch. A closed PR's branch is kept for 30 days, so the PR
  can be reopened.
- A PR whose commits reached a train only after a rebase or squash has a
  different head, so it counts as `needed`, not contained. The script errs
  towards keeping a PR open.
- PR titles and bodies are matched against patterns; they are never executed.

## Running it

```sh
node scripts/pr-triage.mjs                    # the table, nothing written
node scripts/pr-triage.mjs --write            # also rewrites the generated part below (and the Hebrew page)
node scripts/pr-triage.mjs --json rows.json   # every row as JSON
node scripts/pr-triage.mjs --close in-main    # what it would close (dry run)
node scripts/pr-triage.mjs --close in-main --go
```

It needs `gh` signed in and a clone with full history (a shallow clone cannot
answer "is this an ancestor?"); `--git-dir <path>` points at another clone, for
example `git clone --bare --filter=tree:0 …`, which has every commit but no
files. Run it after every promotion of main.

## Today's table

<!-- pr-triage:start -->

*Generated 2026-11-12 16:09 UTC by `node scripts/pr-triage.mjs --write`. 361 open PRs; main at `552ea5b70`; trains: `verify/train`, `verify/train-2`.*

| Category | PRs | What happens |
|---|---|---|
| `in-main` | 0 | In main: close now |
| `in-train` | 288 | In a train: close once it is promoted |
| `superseded` | 0 | Superseded: close with the reason (approve the list) |
| `dependabot` | 26 | Dependabot: lane S triages (W6.14) |
| `train` | 2 | Integration trains: merged or closed with the promotion |
| `needed` | 45 | Still needed: stays open |

### `in-train` (288)

- `verify/train` (184): #135 #137 #138 #139 #140 #141 #142 #143 #144 #145 #146 #147 #148 #149 #150 #155 #156 #157 #158 #169 #170 #171 #172 #173 #174 #175 #176 #177 #178 #179 #180 #181 #182 #183 #184 #185 #186 #187 #188 #189 #190 #191 #192 #193 #194 #195 #196 #197 #198 #199 #200 #201 #202 #203 #205 #206 #207 #208 #209 #210 #211 #212 #213 #214 #215 #216 #217 #218 #219 #220 #221 #222 #223 #224 #225 #226 #227 #228 #229 #230 #231 #232 #233 #234 #235 #236 #237 #238 #239 #240 #241 #242 #243 #244 #245 #246 #247 #248 #249 #250 #251 #252 #253 #254 #255 #256 #257 #258 #259 #260 #261 #262 #263 #266 #267 #268 #269 #270 #271 #272 #273 #274 #275 #276 #277 #278 #279 #280 #281 #282 #283 #284 #285 #286 #287 #288 #289 #290 #292 #293 #297 #298 #299 #300 #301 #302 #303 #304 #305 #306 #307 #308 #309 #310 #311 #312 #313 #314 #315 #316 #330 #331 #332 #333 #334 #335 #336 #337 #338 #339 #341 #342 #343 #344 #345 #346 #347 #348 #349 #350 #351 #352 #353 #354
- `verify/train-2` (104): #355 #356 #357 #358 #359 #360 #361 #362 #363 #364 #365 #366 #367 #368 #369 #370 #371 #372 #373 #374 #375 #376 #377 #378 #379 #380 #381 #382 #383 #384 #385 #386 #387 #388 #389 #390 #391 #392 #393 #394 #395 #396 #397 #398 #400 #401 #402 #403 #404 #405 #406 #407 #408 #409 #410 #411 #412 #413 #414 #415 #416 #417 #418 #419 #420 #421 #423 #424 #425 #426 #427 #428 #429 #430 #433 #434 #435 #436 #437 #438 #439 #440 #441 #442 #443 #444 #445 #446 #447 #449 #450 #452 #453 #454 #455 #456 #457 #458 #459 #460 #462 #463 #491 #494

### `dependabot` (26)

#151 #152 #153 #154 #160 #161 #162 #164 #165 #166 #167 #168 #264 #294 #296 #317 #318 #319 #320 #323 #324 #325 #326 #327 #328 #329

Lane S triages these in W6.14 (the dependency train); no close command here.

### `train` (2)

#431 #495

The trains are merged or closed by hand with the promotion of main.

### `needed` (45)

| PR | Branch → base | Title |
|---|---|---|
| #109 | `chore/domain-lumen-md-app` → `main` | chore: host on Vercel and default service hostnames (no custom domain) |
| #204 | `chore/ci-doctor` → `fix/codex-backlog` | chore(dev): ci-doctor — is this CI failure real or flaky? (plan 0.9) |
| #265 | `chore/dod` → `chore/plan-data` | chore(plan): definition-of-done checker — no ✅ without the commands that prove it (plan 0. |
| #291 | `feat/e2ee-sync-providers` → `feat/e2ee-sync-core` | feat(sync): WebDAV, S3, Dropbox and Drive providers for encrypted sync, plain-text migrati |
| #340 | `chore/catch-split` → `fix/known-limits` | chore: every swallowed error says why, no file over 800 lines (plan 12.1) |
| #399 | `feat/sync-crypto` → `feat/e2ee-sync-core` | feat(sync): close the sync crypto: Argon2id, age interop, key rotation, device revocation, |
| #422 | `feat/desktop-native` → `feat/desktop-release` | feat(desktop): windows with movable tabs, tray quick capture, file associations and lumen: |
| #432 | `fix/live-domain-meta` → `main` | fix(seo): live metadata points at lumen-md.vercel.app (W4.3) |
| #448 | `feat/share-link-fragment` → `verify/train` | feat(share): encrypted share link with no server — note and key in the #fragment, read-onl |
| #451 | `feat/airplane-mode` → `verify/train` | feat(privacy): provable airplane mode — every network path stopped, live monitor with code |
| #461 | `feat/local-usage-metrics` → `verify/train` | feat(metrics): usage counted on this device only; a weekly report you send yourself, 0 req |
| #464 | `feat/academic-docx` → `verify/train` | feat(export): Israeli academic submission templates in DOCX — title page, TOC, page number |
| #465 | `feat/book-mode` → `verify/train` | feat(book): book-writing mode — chapters, word goals, streak, Hebrew EPUB 3 (epubcheck 0 e |
| #466 | `feat/arabic-first` → `feat/locale-beta` | feat(arabic): Arabic as a first-class language — tashkeel, local spelling, three-language  |
| #467 | `feat/sr-automation` → `verify/train` | test(a11y): VoiceOver and NVDA through Guidepup, Hebrew aria snapshots in the e2e gate (W4 |
| #468 | `feat/latex-academic` → `verify/train` | feat(latex): academic LaTeX export with Hebrew — babel bidi, math, [@key] citations, 10 go |
| #469 | `feat/collab-relay-free` → `verify/train` | feat(collab): a free public live-share server that only ever holds encrypted rooms (plan W |
| #470 | `test/data-safety-drill` → `verify/train` | test(vault): data-safety drill on the merged code — phones and old Safari lose notes until |
| #471 | `feat/automations` → `verify/train` | feat(automations): no-code when… then… rules — dry run with 0 writes, byte-exact undo, loo |
| #472 | `feat/vault-argon2id` → `verify/train` | feat(vault): encryption at rest with Argon2id, this device's cost within 1 s; PBKDF2 vault |
| #473 | `feat/journalist-mode` → `verify/train` | feat(journalist): journalist mode — photo metadata, true redaction in every export, notes  |
| #474 | `test/mutation-80` → `verify/train` | test(mutation): critical modules at 80% or more, enforced in the preview build by a commit |
| #475 | `feat/ink-notes` → `verify/train` | feat(ink): handwriting in a note — pen/Apple Pencil ink saved as SVG in the Markdown (W5.2 |
| #476 | `feat/model-mirrors` → `verify/train` | feat(models): model hosting without depending on Hugging Face — verified source chain, Git |
| #477 | `feat/plugin-ecosystem` → `feat/plugin-dx` | feat(plugins): ecosystem bootstrap — 10 sandboxed plugins, a built static registry, instal |
| #478 | `feat/chat-import` → `verify/train` | feat(capture): WhatsApp and Telegram chats into notes — per day or per chat, with media, H |
| #479 | `chore/native-check` → `verify/train` | feat(native): compile the Rust and Java code offline; tauri glue checked against tauri 2 s |
| #480 | `docs/finish-pagefind-gifs` → `docs/hebrew-first` | docs: real Pagefind on the build, 30 Hebrew GIFs from one command, GitHub Discussions setu |
| #481 | `chore/bus-factor` → `chore/pr-check` | feat(governance): sensitive paths need a human-reviewed label before merge (pr:check), COD |
| #482 | `feat/mail-import` → `feat/chat-import` | feat(capture): mail (.eml, .mbox) and Google Takeout (Keep, Docs) into notes — windows-125 |
| #483 | `feat/sync-two-clicks` → `feat/sync-explained` | feat(sync): sync in two clicks — desktop sync folder, encrypted relay or WebDAV, a 13-word |
| #484 | `chore/second-host` → `verify/train` | feat(hosting): Cloudflare Pages as the second host by Direct Upload, research and decision |
| #485 | `feat/zotero-web-api` → `feat/citations-zotero` | feat(citations): Zotero sync through the Web API, without Zotero Desktop — read-only, incr |
| #486 | `docs/owner-sessions` → `verify/train` | docs(project): owner sessions — every owner item in three sittings by dependency, with tim |
| #487 | `research/usability-unmoderated` → `research/usability-hebrew` | feat(research): unmoderated usability round — an opt-in self-guided test mode, Hebrew prot |
| #488 | `feat/private-classroom` → `feat/sync-two-clicks` | feat(classroom): private classroom — the teacher shares a template, students hand in seale |
| #489 | `chore/plan-verified` → `chore/dod` | feat(plan): structured verified level + pr per task; fix parseTime hang (W4.24) [skip ci] |
| #490 | `feat/sustainability` → `feat/collab-relay-free` | feat(support): sustainability — script-free support and costs page, FUNDING.yml, an option |
| #492 | `chore/release-beta1` → `verify/train-2` | feat(release): npm run release -- 0.2.0-beta.1 --dry-run \| --publish — signed auto-update |
| #493 | `feat/mobile-one-command` → `verify/train-2` | feat(mobile): npm run mobile:android / mobile:ios — signed AAB, archive to internal TestFl |
| #496 | `docs/hebrew-parity` → `verify/train-2` | docs(he): Hebrew parity — docs-parity check, local agents in full, and every gap it found  |
| #497 | `feat/review-required` → `chore/bus-factor` | feat(governance): independent review receipt for every sensitive PR, and the lanSync PRE_A |
| #498 | `feat/live-meta-check` → `chore/nightly-receipts` | feat(seo): npm run live:meta — production metadata names only lumen-md.vercel.app, after e |
| #499 | `fix/vuln-deps-fold` → `fix/vuln-deps` | fix(deps): body-parser 2.4.0 (high), fast-uri, MCP SDK, ws folded offline + decision table |
| #500 | `chore/max-lines-gate` → `verify/train-2` | feat(hygiene): max-lines gate with a baseline that only goes down, and App.tsx 1,622 → 773 |

### Owner commands

Never run by an agent. Each loop re-checks before every close, and no branch is deleted.

**In a train** — after the train is promoted to main (a PR not in main yet stays open):

```sh
git fetch -q origin main
for n in 135 137 138 139 140 141 142 143 144 145 146 147 148 149 150 155 156 157 158 169 170 171 172 173 174 175 176 177 178 179 180 181 182 183 184 185 186 187 188 189 190 191 192 193 194 195 196 197 198 199 200 201 202 203 205 206 207 208 209 210 211 212 213 214 215 216 217 218 219 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 259 260 261 262 263 266 267 268 269 270 271 272 273 274 275 276 277 278 279 280 281 282 283 284 285 286 287 288 289 290 292 293 297 298 299 300 301 302 303 304 305 306 307 308 309 310 311 312 313 314 315 316 330 331 332 333 334 335 336 337 338 339 341 342 343 344 345 346 347 348 349 350 351 352 353 354 355 356 357 358 359 360 361 362 363 364 365 366 367 368 369 370 371 372 373 374 375 376 377 378 379 380 381 382 383 384 385 386 387 388 389 390 391 392 393 394 395 396 397 398 400 401 402 403 404 405 406 407 408 409 410 411 412 413 414 415 416 417 418 419 420 421 423 424 425 426 427 428 429 430 433 434 435 436 437 438 439 440 441 442 443 444 445 446 447 449 450 452 453 454 455 456 457 458 459 460 462 463 491 494; do
  sha=$(gh pr view "$n" -R talstilkol/lumen-md --json headRefOid -q .headRefOid)
  git merge-base --is-ancestor "$sha" origin/main || { echo "#$n: not in main yet, kept"; continue; }
  gh pr close "$n" -R talstilkol/lumen-md --comment 'Every commit of this PR is in main. Closing as done (plan W6.21); the branch is kept for 30 days.

כל הקומיטים של ה-PR הזה כבר ב-main. נסגר כגמור (W6.21); הענף נשמר 30 יום.'
done
```

Or through the script, which re-checks the rule live: `node scripts/pr-triage.mjs --close in-main --go`, `--close superseded --go`.

<!-- pr-triage:end -->

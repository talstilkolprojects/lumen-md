---
title: Public roadmap
description: The roadmap page at /roadmap — generated from plan/plan.json, titles and status only, and checked in CI so it cannot drift.
---

Every Lumen deployment serves an open roadmap at `/roadmap.html` (and at
`/roadmap` on Cloudflare Pages, Netlify and the Docker image). The status bar's
**Roadmap** link opens it.

## Where it comes from

The page is the third output of `npm run plan`, next to the board in
`MASTER_PLAN.md` and `plan/board.html`. All three are rendered from one file,
`plan/plan.json`, and `npm run plan:check` fails CI when any of them differs
from it. So the roadmap changes in the same commit as the plan, every time.

## What it shows — and what it does not

| Shown | Not shown |
|---|---|
| every phase, with its number and title | the steps of a task and its acceptance line |
| every task's number and title | estimates, dates and the schedule |
| its state: **done** (✅), **in progress** (⏳) or **planned** | branches, PR numbers and the owner's items (phase 15) |
| the counts and a progress bar | anything from issues or notes |

The full plan, with every measured acceptance criterion, is in the repository.

## How it renders

`public/roadmap.html` carries the data as a JSON block; `public/roadmap.js`
builds the cards with `textContent`. The script is external because the app's
Content-Security-Policy allows no inline script, and it needs no Trusted Types
policy because it never writes HTML. The page is Hebrew and right-to-left,
laid out with logical CSS properties.

## Updating it

```bash
npm run plan        # rewrites MASTER_PLAN.md's board, plan/board.html and public/roadmap.html
npm run plan:check  # what CI runs: exit 1 when any of them is out of date
```

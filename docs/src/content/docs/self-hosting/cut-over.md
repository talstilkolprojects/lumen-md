---
title: Moving production to another host
description: The runbook for moving Lumen's production from Vercel Hobby to Cloudflare Pages in under an hour, before the first payment. It covers the new address, the users' notes that stay with the old one, the redirect, the checks and the way back.
---

Vercel's Hobby plan is for **non-commercial use only**
([fair-use guidelines](https://vercel.com/docs/limits/fair-use-guidelines)).
Lumen takes its first payment with the paid relay (plan W5.25). Before that,
production must move to a host that allows commercial use, or Vercel must
be upgraded to Pro ($20 a seat a month). This page is the move. It takes
about 45 minutes and can be undone in 5 (plan W6.9).

**The gate.** `deploy/hosting.json` names the production host and its plan.
`npm run hosting:gate` fails any build that takes payments while production
is on a plan without commercial use. It runs first in every Vercel build
(`scripts/vercel-build.mjs`) and in `pages:deploy`. The payment variables are
`VITE_BILLING_ENDPOINT`, `VITE_ENTITLEMENT_ENDPOINT`, the price IDs, and
`LUMEN_COMMERCIAL=1`. So the first payment cannot ship on Hobby by accident.

## Why the address changes

`lumen-md.vercel.app` belongs to Vercel. Its DNS can't point anywhere else.
The new production address is therefore a new free one:
**`https://lumen-md.pages.dev`**, Cloudflare's subdomain for the Pages
project. A custom domain can be added later, the same way (Cloudflare
dashboard → the project → Custom domains). That makes a third move, so pick
the domain before users have notes on `pages.dev`, if you can.

## The users' notes stay with the old address

Lumen is local-first. The notes live in this browser's storage **for one
address** (OPFS and IndexedDB are per origin). A browser opening
`lumen-md.pages.dev` starts empty, even if it used `lumen-md.vercel.app`
yesterday. A plain redirect would hide everyone's notes. So the old address
keeps serving the app, built with `VITE_MOVED_TO`
(`src/pwa/hostMoveBoot.ts`), and it does two things:

- **A browser that never used the app there** (empty `localStorage`, checked
  before the app starts) goes straight to the same path, query and hash on
  the new address.
- **A browser with notes there** keeps the app and gets a banner (English
  and Hebrew). It downloads every note and attachment as one `.zip` (the vault
  export), then opens the new address, where the user imports the file
  (Import vault). Sync and Git users can instead connect the same provider
  again at the new address.

The old address keeps no payment code (the gate enforces this), so it stays
within Hobby's terms. It just hands people over.

## The move (about 45 minutes)

On the Mac, in the repository, from `main`:

```sh
# 1. Once: the Cloudflare account and project (5 min)
npx wrangler@4 login
npx wrangler@4 pages project create lumen-md --production-branch main

# 2. The same commit on both hosts, checked (10 min)
git checkout main && git pull && npm ci
npm run pages:deploy -- --prod        # hosting gate, build, pages:check --prepare, host parity, upload
npm run hosts:parity -- --live https://lumen-md.vercel.app https://lumen-md.pages.dev
```

The live parity must end with `0 failing`. Its one accepted difference is
`/missing-image.png`: Vercel answers 404, Pages answers the app (see
`ACCEPTED` in `scripts/lib/hostParity.mjs`). Open the new address. Check the
editor, the PDF reader and a playground block (its runner page has its own
policy), and look for `Content-Security-Policy` errors in the console.

```sh
# 3. Make the new host production (5 min)
#    deploy/hosting.json: "production": "cloudflare-pages"; commit it to main.
#    Payments are allowed from this commit on (on the Pages build only).

# 4. The old address hands over (Vercel dashboard → lumen-md → Settings →
#    Environment Variables, Production) (10 min)
#    VITE_MOVED_TO = https://lumen-md.pages.dev
#    then redeploy main on Vercel. No payment variables there, ever.

# 5. Check the handover (5 min)
#    A private window on https://lumen-md.vercel.app/notes/x → lands on
#    https://lumen-md.pages.dev/notes/x. A normal window that has notes →
#    the banner; "Download my notes" saves a .zip; import it on pages.dev.
```

Then update the address everywhere it is written: the README, the store
listings, `public/sitemap.xml`, `og:url` in `index.html`, and the OAuth
redirect URIs of the sync providers (Google, Dropbox, GitHub). The OAuth
providers check the exact origin, so sign-in fails at the new address until
it is added.

## The way back (5 minutes)

Clear `VITE_MOVED_TO` on Vercel and redeploy. Set `"production": "vercel"`
in `deploy/hosting.json` again. Nothing is deleted at either step. Notes a
user made on `pages.dev` in the meantime stay there; the banner flow works in
the other direction too (build the Pages copy with
`VITE_MOVED_TO=https://lumen-md.vercel.app`).

## Drill: under an hour

The acceptance of W6.9 is a timed drill: steps 2 to 5 on a branch
deployment (`npm run pages:deploy` without `--prod`, and a Vercel preview
with `VITE_MOVED_TO` set for that branch only). Write down the minutes per
step in the PR of the drill.

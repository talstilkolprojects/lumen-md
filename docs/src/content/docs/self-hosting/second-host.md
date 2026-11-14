---
title: A second host and tests without Vercel
description: Why Cloudflare Pages is Lumen's second host next to Vercel Hobby, what each free tier allows, how to deploy the same build there, what to do when a quota runs out, and how to run the whole test pipeline in Docker.
---

Vercel's Hobby plan builds every branch, one build at a time, 100
deployments a day, and is for **non-commercial, personal use only**. In
November 2026 its usage limit and one build slot held Lumen's checks up for
weeks. This page records the decision for a second host and a way to test
without any host (plan W4.27).

## The free tiers, compared

Checked on 12 November 2026 against each provider's own pages.

| | Vercel Hobby | Cloudflare Pages Free | Netlify Free | GitHub Pages |
|---|---|---|---|---|
| Commercial use | ✗ personal, non-commercial only | ✓¹ | ✓¹ | ✗ not for running a business or SaaS |
| Builds | 100 deployments/day, 1 at a time | 500 builds/month, 1 at a time, 20 min each; **Direct Upload uses none** | 300 credits/month, a production deploy costs 15 (≈ 20/month); previews and branch deploys 0 | 10/hour (soft), 10 min each |
| Traffic | 100 GB, 1 M requests | not metered | 20 credits per GB, 2 per 10,000 requests, from the same 300 | 100 GB/month (soft), 1 GB site |
| Per file / files | — | 25 MiB per file, 20,000 files | — | — |
| Custom headers (CSP, runner pages) | ✓ `vercel.json` | ✓ `_headers`, with `! Header` to detach | ✓ `_headers` + an edge function for the runners | ✗ none: the CSP falls back to `<meta>`, no `frame-ancestors`, HSTS from GitHub only |
| Over the limit | features stop for 30 days | builds stop; the site stays up | **every site is paused** ("Site not available") until next month | warnings, then possible suspension |
| Without GitHub Actions | ✓ | ✓ | ✓ | ✗ branch publishing runs a `pages-build-deployment` workflow |
| Monthly cost | $0 (Pro: $20 per developer seat) | $0 | $0 | $0 |

¹ No restriction on the provider's plan and limits pages, and a third-party comparison (hostfleet.pages.dev, April 2026) lists both as allowed; the owner should still read the terms of service before relying on it.

Sources: vercel.com/docs/plans/hobby, developers.cloudflare.com/pages/platform/limits,
docs.netlify.com (billing for credit-based plans, "How credits work"),
docs.github.com/pages (GitHub Pages limits).

## The decision: Cloudflare Pages, by Direct Upload

- **Cloudflare Pages** is the second host. Its traffic is not metered, the site
  stays up when a quota runs out, commercial use is allowed, and
  `public/_headers` is already written in its grammar: the runner pages detach
  the app's policy with `! Content-Security-Policy`, so the Web Playground and
  live-js work there without an edge function.
- **Direct Upload** (`npm run pages:deploy`): the build runs on your machine,
  so it uses none of Cloudflare's 500 builds and none of Vercel's 100
  deployments. Connecting the repository in the Cloudflare dashboard is
  optional; it gives a second build slot for branches (build command
  `npm run build && npm run pages:check -- --drop-oversize`, output `dist`,
  `NODE_VERSION=22`).
- **Not Netlify** for a mirror: running out of credits pauses every site, and
  20 production deploys a month is too few. `netlify.toml` stays for anyone
  who self-hosts there.
- **Not GitHub Pages**: no custom headers (the CSP would lose
  `frame-ancestors` and the runner pages their own policy) and its publishing
  runs on GitHub Actions, which this project does not use.
- **Vercel Pro ($20 a month)** removes the 100-a-day limit and is required
  anyway once Lumen is used commercially. That is the owner's decision; the
  second host does not depend on it.

### One limit to know: 25 MiB per file

`ruby+stdlib.wasm` (ruby.wasm, about 30.6 MB) is larger than Cloudflare's
25 MiB per file. `npm run pages:check` reports every such file;
`--drop-oversize` (which `pages:deploy` uses) removes them from that upload
and lists them in `dist/pages-dropped.json`. On the Cloudflare copy, live-ruby
blocks then say their runtime is not installed — like the Docker image's
`slim` variant. Everything else is the same build.

## Deploy the same build

```bash
npx wrangler@4 login                                   # once
npx wrangler@4 pages project create lumen-md --production-branch main   # once
npm run pages:deploy                    # a preview named after the current branch
npm run pages:deploy -- --prod          # production: https://lumen-md.pages.dev
```

Each deployment carries the commit hash. To check that both hosts serve the
same build of a commit, compare the entry chunk's content hash (Vite names
it after its content):

```bash
for h in https://lumen-md.vercel.app https://lumen-md.pages.dev; do
  curl -s "$h/" | grep -o 'assets/index-[A-Za-z0-9_-]*\.js'
done
```

The two lines are equal when both builds had the same `VITE_*` settings.

## When a quota runs out

| What ran out | What to do |
|---|---|
| Vercel deployments (100 a day) or usage (30-day pause) | Previews: `npm run pages:deploy` from the branch. Checks: `npm run ci:docker`. Production stays on the last Vercel deployment; switch traffic to `lumen-md.pages.dev` only if Vercel stops serving it. |
| Cloudflare builds (500 a month, Git integration only) | Keep using Direct Upload, which does not count. |
| Both hosts unavailable | The Docker image (`docker build -t lumen .`, see [Where Lumen runs](/self-hosting/hosting/)) serves the same app anywhere. |

## The test pipeline in Docker

When no host can build, run everything the Vercel preview build runs, on your
machine, with no GitHub Actions:

```bash
npm run ci:docker                         # every ci:local step, e2e on Chromium
npm run ci:docker -- --only typecheck,test
npm run ci:docker -- --skip e2e
```

`Dockerfile.ci` starts from Playwright's own image for the exact
`@playwright/test` version in `package-lock.json`, so the browsers match and
nothing is downloaded during the tests. It installs with `npm ci`, copies the
checkout (git history included: `Dockerfile.ci.dockerignore`) and runs
`npm run ci:local`. The log and the Playwright report land in
`ci-docker-out/`. It works with Podman too: `DOCKER=podman npm run ci:docker`.

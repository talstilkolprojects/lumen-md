---
title: Built the same on two infrastructures
description: Every commit to main is built on Vercel and again on Cloudflare Workers Builds, from the same lockfile, and every file of the two builds is compared.
---

A build that only reproduces on the same machine proves little. Lumen's main
branch is built by two different infrastructures:

- **Vercel**, which serves the app at lumen-md.vercel.app;
- **Cloudflare Workers Builds**, on its free plan. It only builds and serves
  the result for comparison, and users never go there.

Both builds use the same commit and the same `package-lock.json`. If every
file comes out with the same SHA-256, nothing hidden went into the build on
either side.

## How it works

1. Each build writes `/.well-known/lumen-build.json`, the SHA-256 of every
   file in `dist`, with the commit, the lockfile's hash, the Node version and
   the builder. On Vercel this is the `manifest` gate; on Cloudflare it is
   `npm run build:repro`.
2. Every night, the second host runs

   ```sh
   npm run repro:two-hosts -- --a https://lumen-md.vercel.app --b https://lumen-md-repro.<account>.workers.dev --verify-fetch --diffoscope
   ```

   It compares the two manifests file by file. It also downloads every file
   from each site and checks it against that site's own manifest, so a host
   that serves different bytes from what it built is caught too. Each file
   that differs gets a diffoscope report.
3. An identical build gets an in-toto statement ("built identically on two
   infrastructures") for the release attestation (W7.22). The history file
   keeps the count of consecutive identical commits.

## Targets

- 10 consecutive commits with 100% of files identical, `.map` files included
  (a release has none).
- The Cloudflare build takes 15 minutes at most, against its 20-minute limit.
- $0: Workers Builds' free plan gives 3,000 build minutes a month.

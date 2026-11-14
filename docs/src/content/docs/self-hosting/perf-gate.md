---
title: Performance gate
description: npm run perf:gate measures FCP, LCP, TBT, TTI and CLS of a production build in Chromium, on desktop and a throttled phone, and fails on the error thresholds, without GitHub Actions.
---

The gate (plan 8.3) checks that a build loads fast enough before it ships.
It runs on your machine or against a preview deployment. GitHub Actions
are not needed.

```bash
npm run build && npm run perf:gate            # serves dist/ with vite preview
npm run perf:gate -- --url https://<preview>.vercel.app
```

## What it measures

Lighthouse CI is not in the lockfile, so the gate measures the same
numbers itself, with Playwright and Chromium's own performance entries:

- **FCP**: first contentful paint.
- **LCP**: largest contentful paint.
- **CLS**: layout shifts not caused by input.
- **TBT**: for each long task after FCP, the time beyond 50 ms, as
  Lighthouse counts it.
- **TTI**: the end of the last long task before a quiet window.
- The time until the editor takes input, reported as well.

Every load is cold: a fresh browser context, with no cache, no storage
and no service worker. There are 5 loads per profile, and the gate
reports the **median run**: the single load closest to the median FCP
and TTI. This matches Lighthouse's `median-run`, not its optimistic
default.

| Profile | Emulation |
|---|---|
| desktop | 1350 × 940, no throttling |
| mobile | Pixel 7, CPU 4× slower, 150 ms latency, 1.6 Mbps down |

## Thresholds

The thresholds are in `perf-gate.config.json`:

- **`error`** fails the gate (exit code 1).
- **`warn`** is reported.
- **`target`** is the plan's goal, shown next to the result until the
  runner meets it.

Desktop errors at the runner level set by decision 15.16 (20)/(21): FCP
1200 ms and LCP 3500 ms, with targets of 1000 ms and 2500 ms. Plans 8.1
and 8.2 tighten them. The mobile profile only warns until it has been
measured on the runner.

## Options

| Option | Meaning |
|---|---|
| `--url <url>` | Measure a running server or deployment instead of `vite preview` |
| `--profiles desktop` | Only these profiles |
| `--runs 3` | Loads per profile (default 5) |
| `--out gate.md` | Write the Markdown summary, for a PR comment |
| `--json gate.json` | All runs, every metric |

`npm run lighthouse` (LHCI) still works when you install it with `npx`.
The gate does not depend on it.

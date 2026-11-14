---
title: The e2e test surface
description: window.__lumen.agentReview exists only in development and tests.
---

The end-to-end tests drive a few app functions through `window.__lumen`.
One of them, `window.__lumen.agentReview`, stages a change for the
[agent review screen](/ai/agents/) the way an agent's write tool does. A
page script that could call it could put changes in front of you that no
agent proposed, so it is **not part of the app you install**.

## Where it exists

| Build | `window.__lumen.agentReview` |
|---|---|
| `npm run dev` (Vite dev server) | yes |
| `npx vitest` (unit tests) | yes |
| `VITE_LUMEN_TEST_SURFACE=1 npm run build` (the e2e-prod job only) | yes |
| `npm run build` (every release, the PWA, desktop and mobile) | **no** — the code is removed from the bundle |

The release build replaces `import.meta.env.DEV` and
`VITE_LUMEN_TEST_SURFACE` with constants, so the surface and the function
behind it are dropped when the bundle is minified.

## Checking a build

```sh
npm run build
npm run check:test-surface
```

`check:test-surface` reads every JavaScript file under `dist/` and fails if
one still sets or reads `.agentReview` (the translation keys such as
`agentReview.title` are text and do not count). CI runs it after the
production build.

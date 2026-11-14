---
title: Secret scan of the build
description: Why no secret may be a VITE_* variable, the gate that fails a build that sets one, and the scan of the live deployments.
---

Vite copies the value of every `VITE_*` variable the app reads into the
public JavaScript. Anyone who opens the site can read it. So a token, an
API key or a password must never be a `VITE_*` variable. Lumen enforces
this in three places.

| Where | What it checks | What fails |
|---|---|---|
| The build (`vite build`) | Every `VITE_*` variable set in the environment or in an `.env` file | A name not on `security/vite-env-allowlist.json` |
| The Vercel preview gate (`npm run secrets:dist`) | Every file in `dist/` | A token shape, or an inlined `VITE_*` value not on the allowlist |
| The live scan (`npm run secrets:scan-live`) | Production, the 3 newest previews, and the `VITE_*` names set in Vercel | The same, plus a `VITE_*` name in Vercel that is not on the allowlist |

The code rules in `npm run hygiene` keep secret-named reads (`…TOKEN`,
`…SECRET`, `…KEY`) and reads of `import.meta.env` as a whole object out of
`src/`. Before #243 such a whole-object read put **every** `VITE_*`
variable of the build into the bundle, even ones the app never used. The
allowlist gate covers that case too: a build cannot set a name that is not
listed.

## The allowlist

`security/vite-env-allowlist.json` lists each name a build may set, with
the reason it is public: a worker URL, an OAuth client id, a price id, a
public key. Names that start with `VITE_VERCEL_` are Vercel's system
variables (the deployment id, the git branch and commit). They are not
secrets, and the app reads none of them. A value that starts with
`ci-canary-` is a test canary and is allowed under any name.

To add a variable, add its name and the reason it is public. If it is a
secret, it does not belong here: keep it in the secret store
(`src/lib/secretStore.ts`) or on the server.

## What the scan looks for

- **Secret** (the scan fails): OpenAI and Anthropic keys (`sk-`), GitHub
  tokens (`ghp_`, `github_pat_` …), Google API keys (`AIza`), AWS access
  keys, Stripe live keys, Slack tokens, private-key bodies, JWTs other
  than a public anon key, and inlined `VITE_*` values not on the allowlist.
- **For review** (listed only): hex strings of 32 or more characters, and
  anon JWTs. Content hashes and embed ids look the same.

A report never shows a whole value. It shows the first 4 characters and
the length.

## Running it

```bash
npm run secrets:self-test        # plants a token of each kind in a temporary build and finds it
npm run secrets:dist             # scans dist/ after npm run build
VERCEL_TOKEN=… VERCEL_PROJECT_ID=prj_… VERCEL_TEAM_ID=team_… \
  npm run secrets:scan-live -- --report scan.md
node scripts/secrets-scan-live.mjs --url https://lumen-md.vercel.app
```

The live scan reads the **names** of the project's environment variables
from the Vercel API. It never asks for a value to be decrypted. For a
protected preview, set `VERCEL_AUTOMATION_BYPASS_SECRET`.

## If a secret was a VITE_* variable (15.18)

1. Treat it as public. Any build that ran while it was set may have put it
   in the bundle, and old deployments stay online.
2. Revoke it with the provider and create a new one.
3. Delete the `VITE_*` variable in Vercel (and in Netlify or CI, if used).
4. Put the new value where it belongs: the secret store for a user's key,
   or a server-side secret for a worker.
5. Run `npm run secrets:scan-live` and keep the report.

If no secret was ever set as `VITE_*`, record that, and 15.18 is done.

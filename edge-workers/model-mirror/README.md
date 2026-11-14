# lumen-model-mirror

A read-only CORS proxy in front of the GitHub releases that hold Lumen's
copy of every model file (plan W4.14). See
`docs/src/content/docs/ai/model-hosting.md` for the whole chain.

```sh
cd edge-workers/model-mirror
npx wrangler deploy            # → https://lumen-model-mirror.<account>.workers.dev
```

Then build the app with `VITE_MODEL_MIRROR_URL` set to that URL (the build
adds its origin to the CSP `connect-src`, src/build/cspEndpoints.ts).

- Only release tags that start with `models-` are reachable.
- Nothing is stored; responses are cacheable (`immutable`): a release asset
  never changes under the same name, and the app checks every file's sha256.
- Free tier: 100,000 requests a day. A model is one request per file.
